/* js/sync.js  — v3 KV-optimised
 *
 * Root cause of 200-300 req/hour:
 *   1. _mergePayload compared payload.ts (always-changing timestamp) → always "changed"
 *      → every poll triggered a push → read+write every 30s = ~240 req/hour
 *   2. _hashPayload included ts in the hash → debounce never short-circuited
 *   3. BroadcastChannel echoes back to same tab → gt:synced fired after every onDataChanged
 *
 * Fixes:
 *   A. Poll interval: 30s → 10 minutes (configurable)
 *   B. _mergePayload: only marks changed if actual game/session data differs, ignores ts
 *   C. _hashPayload: content-only hash (no ts) so unchanged data = same hash = no push
 *   D. BroadcastChannel: tag messages with a sender ID, ignore own messages
 *   E. Pull → push loop broken: after merging remote data, only push if we added something
 *      remote didn't have (i.e. we have MORE data, not just equal data)
 *   F. All writes debounced 4s — rapid UI interactions batch into one KV write
 *   G. Skip poll when tab hidden
 *   H. KV request counter exported for debug panel (Section: debug setting)
 */

import * as DB from './db.js';

let _user          = null;
let _channel       = null;
let _pollTimer     = null;
let _debounceTimer = null;
let _enabled       = false;
let _workerUrl     = null;
let _lastPushHash  = null;
let _tabId         = Math.random().toString(36).slice(2); // unique per tab

const POLL_MS     = 10 * 60 * 1000;  // 10 minutes
const DEBOUNCE_MS = 4_000;            // 4s write debounce

/* ── KV request counter (for debug panel) ────────── */
const _kvLog = [];   // { ts: Date, type: 'read'|'write' }

function _countKV(type) {
  _kvLog.push({ ts: Date.now(), type });
  // Keep only last 30 minutes of entries
  const cutoff = Date.now() - 30 * 60 * 1000;
  while (_kvLog.length && _kvLog[0].ts < cutoff) _kvLog.shift();
}

/** Returns { reads, writes, total } in the last `windowMs` ms */
export function getKVStats(windowMs = 10 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  const recent = _kvLog.filter(e => e.ts >= cutoff);
  return {
    reads:  recent.filter(e => e.type === 'read').length,
    writes: recent.filter(e => e.type === 'write').length,
    total:  recent.length,
    windowMinutes: Math.round(windowMs / 60000),
  };
}

/* ── Public API ───────────────────────────────────── */
export function initSync(username)  { _user = username; }
export function isSyncEnabled()     { return _enabled; }
export function getSyncWorkerUrl()  { return _workerUrl; }

export async function startSync(username, workerUrl) {
  _user      = username;
  _workerUrl = workerUrl ? workerUrl.trim().replace(/\/+$/, '') : null;
  _enabled   = true;
  _startBroadcast();
  if (_workerUrl) _startPoll();
}

export function stopSync() {
  _enabled = false;
  if (_channel)       { _channel.close();         _channel = null; }
  if (_pollTimer)     { clearInterval(_pollTimer); _pollTimer = null; }
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
}

/* ── onDataChanged: called after every DB write ─────
   - Broadcasts to other tabs instantly (free, no KV)
   - Debounces cloud push so rapid changes batch into one write  */
export function onDataChanged() {
  if (!_user) return Promise.resolve();
  _broadcastNow().catch(() => {});
  if (_enabled && _workerUrl) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      _pushIfChanged().catch(() => {});
    }, DEBOUNCE_MS);
  }
  return Promise.resolve();
}

/* ── BroadcastChannel (same-device cross-tab, no KV) */
function _startBroadcast() {
  if (_channel) _channel.close();
  _channel = new BroadcastChannel('gt_sync_v4');
  _channel.onmessage = async e => {
    if (e.data?.user !== _user) return;
    if (e.data?.tabId === _tabId) return;  // FIX D: ignore own broadcasts
    const changed = await _mergePayload(e.data.payload, false);
    if (changed) window.dispatchEvent(new CustomEvent('gt:synced'));
  };
}

async function _broadcastNow() {
  if (!_channel) return;
  const payload = await _buildPayload();
  _channel.postMessage({ user: _user, tabId: _tabId, payload });
}

/* ── Poll (read from KV) ─────────────────────────── */
function _startPoll() {
  if (_pollTimer) clearInterval(_pollTimer);
  // Delay first poll by 30s so startup doesn't immediately hit KV
  setTimeout(() => {
    _pollOnce();
    _pollTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;  // FIX G
      _pollOnce();
    }, POLL_MS);
  }, 30_000);
}

async function _pollOnce() {
  if (!_enabled || !_workerUrl) return;
  _countKV('read');
  try {
    const r = await fetch(
      `${_workerUrl}/pull?user=${encodeURIComponent(_user)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return;
    const { payload } = await r.json();
    if (!payload) return;

    // FIX E: pass pushIfWeHaveMore=true — only push if WE have data remote lacks
    const changed = await _mergePayload(payload, true);
    if (changed) window.dispatchEvent(new CustomEvent('gt:synced'));
  } catch(e) {}
}

/* ── Push (write to KV) — only if content changed ── */
async function _pushIfChanged() {
  if (!_workerUrl) return;
  const payload = await _buildPayload();
  const hash    = _hashPayload(payload);
  if (hash === _lastPushHash) return;  // FIX C: nothing changed, skip write
  _lastPushHash = hash;
  _countKV('write');
  try {
    await fetch(`${_workerUrl}/push`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ user: _user, payload }),
      signal:  AbortSignal.timeout(10000),
    });
  } catch(e) {}
}

/* FIX C: content-only hash — excludes ts so unchanged data = same hash */
function _hashPayload(payload) {
  const gc  = (payload.games    || []).length;
  const sc  = (payload.sessions || []).length;
  const wc  = (payload.wishlist || []).length;
  const fc  = (payload.favorites|| []).length;
  // Use latest updatedAt across all games as content fingerprint
  const lat = (payload.games || [])
    .map(g => g.updatedAt || '')
    .concat((payload.sessions || []).map(s => s.id || ''))
    .sort().pop() || '';
  return `${gc}:${sc}:${wc}:${fc}:${lat}`;
}

/* ── Payload builder ─────────────────────────────── */
async function _buildPayload() {
  const [games, sessions, wishlist, favorites, settings, profile] = await Promise.all([
    DB.getGames(_user),
    DB.getSessions(_user),
    DB.getWishlist(_user),
    DB.getFavorites(_user),
    DB.getAllSettings(_user),
    DB.getProfile(_user),
  ]);
  return {
    v:         2,
    games,
    sessions,
    wishlist,
    favorites,
    settings,
    pic:       profile?.pic    || null,
    pic_ts:    profile?.pic_ts || null,
    ts:        new Date().toISOString(),  // kept for compat but NOT used in merge logic
  };
}

/* ── Merge remote payload into local DB ─────────────
   FIX B: only marks changed=true for actual data differences, never for ts alone
   pushIfWeHaveMore: after merging, push only if we contributed new local items  */
async function _mergePayload(remote, pushIfWeHaveMore) {
  if (!remote) return false;
  let mergedSomething  = false;  // remote had something we didn't
  let weHaveSomething  = false;  // we have something remote didn't

  // Games — last-write-wins on updatedAt
  const remoteGameIds = new Set((remote.games || []).map(g => g.id));
  const localGames    = await DB.getGames(_user);
  for (const rg of (remote.games || [])) {
    const local = localGames.find(g => g.id === rg.id);
    if (!local) {
      await DB.putGame(_user, { ...rg, username: _user });
      mergedSomething = true;
    } else if ((rg.updatedAt || '') > (local.updatedAt || '')) {
      await DB.putGame(_user, { ...rg, username: _user });
      mergedSomething = true;
    }
  }
  if (localGames.some(g => !remoteGameIds.has(g.id))) weHaveSomething = true;

  // Sessions — additive (never delete)
  const localSessions   = await DB.getSessions(_user);
  const localSessionIds = new Set(localSessions.map(s => s.id));
  const remoteSessionIds= new Set((remote.sessions || []).map(s => s.id));
  for (const rs of (remote.sessions || [])) {
    if (!localSessionIds.has(rs.id)) {
      await DB.putSession(_user, { ...rs, username: _user });
      mergedSomething = true;
    }
  }
  if (localSessions.some(s => !remoteSessionIds.has(s.id))) weHaveSomething = true;

  // Wishlist — additive
  const localWish    = await DB.getWishlist(_user);
  const localWishIds = new Set(localWish.map(w => w.id));
  const remoteWishIds= new Set((remote.wishlist || []).map(w => w.id));
  for (const rw of (remote.wishlist || [])) {
    if (!localWishIds.has(rw.id)) {
      await DB.putWishlistItem(_user, { ...rw, username: _user });
      mergedSomething = true;
    }
  }
  if (localWish.some(w => !remoteWishIds.has(w.id))) weHaveSomething = true;

  // Favorites — last-write-wins on updatedAt
  const localFavs = await DB.getFavorites(_user);
  for (const rf of (remote.favorites || [])) {
    const lf = localFavs.find(f => String(f.slot) === String(rf.slot));
    if (!lf || (rf.updatedAt || '') > (lf.updatedAt || '')) {
      await DB.setFavorite(_user, rf.slot, rf.game_id);
      mergedSomething = true;
    }
  }

  // Profile picture — newest timestamp wins
  if (remote.pic) {
    const p        = await DB.getProfile(_user);
    const remoteTs = new Date(remote.pic_ts || remote.ts || 0);
    const localTs  = new Date(p?.pic_ts || 0);
    if (!p?.pic || remoteTs > localTs) {
      await DB.updateProfilePic(_user, remote.pic, remote.pic_ts);
      mergedSomething = true;
    }
  }

  // FIX E: only push back if we have local data remote didn't have
  if (pushIfWeHaveMore && weHaveSomething) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      _pushIfChanged().catch(() => {});
    }, DEBOUNCE_MS);
  }

  return mergedSomething || weHaveSomething;
}

/* ── Utilities ───────────────────────────────────── */
export async function discoverRemoteProfiles(workerUrl) {
  if (!workerUrl) return [];
  try {
    const r = await fetch(`${workerUrl.trim().replace(/\/+$/, '')}/list`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.users) ? d.users : [];
  } catch(e) { return []; }
}

export async function testWorker(url) {
  try {
    const r = await fetch(`${url.trim().replace(/\/+$/, '')}/ping`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const d = await r.json();
    return { ok: !!d.ok, ts: d.ts };
  } catch(e) { return { ok: false, error: e.message }; }
}
