/* js/sync.js
 * Sync via:
 *   1. BroadcastChannel — instant cross-tab (same device, always on)
 *   2. Cloudflare Worker — cross-device (optional, configured in Settings)
 *
 * Section 11 fix: favorites and profile pictures now included in payload
 * and properly merged with last-write-wins logic.
 */

import * as DB from './db.js';

let _user      = null;
let _channel   = null;
let _timer     = null;
let _enabled   = false;
let _workerUrl = null;

const POLL_MS = 30_000;

/* ── Public API ───────────────────────────────────── */
export function initSync(username) { _user = username; }

export async function startSync(username, workerUrl) {
  _user      = username;
  _workerUrl = workerUrl ? workerUrl.trim().replace(/\/+$/, '') : null;
  _enabled   = true;
  _startBroadcast();
  if (_workerUrl) _startPoll();
}

export function stopSync() {
  _enabled = false;
  if (_channel) { _channel.close(); _channel = null; }
  if (_timer)   { clearInterval(_timer); _timer = null; }
}

export function isSyncEnabled()    { return _enabled; }
export function getSyncWorkerUrl() { return _workerUrl; }

/* ── Call after every DB write ────────────────────── */
export async function onDataChanged() {
  if (!_user) return;
  const payload = await _buildPayload();
  if (_channel) _channel.postMessage({ user: _user, payload });
  if (_enabled && _workerUrl) _pushNow().catch(() => {});
}

/* ── BroadcastChannel (cross-tab) ─────────────────── */
function _startBroadcast() {
  if (_channel) _channel.close();
  _channel = new BroadcastChannel('gt_sync_v4');
  _channel.onmessage = async e => {
    if (e.data?.user !== _user) return;
    const changed = await _mergePayload(e.data.payload);
    if (changed) window.dispatchEvent(new CustomEvent('gt:synced'));
  };
}

/* ── Cloudflare Worker polling ─────────────────────── */
function _startPoll() {
  if (_timer) clearInterval(_timer);
  _pollOnce();
  _timer = setInterval(_pollOnce, POLL_MS);
}

async function _pollOnce() {
  if (!_enabled || !_workerUrl) return;
  try {
    const r = await fetch(`${_workerUrl}/pull?user=${encodeURIComponent(_user)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return;
    const { payload } = await r.json();
    if (!payload) return;
    const changed = await _mergePayload(payload);
    if (changed) {
      await _pushNow();
      window.dispatchEvent(new CustomEvent('gt:synced'));
    }
  } catch(e) { /* offline / worker not configured */ }
}

async function _pushNow() {
  if (!_workerUrl) return;
  try {
    await fetch(`${_workerUrl}/push`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ user: _user, payload: await _buildPayload() }),
      signal:  AbortSignal.timeout(10000),
    });
  } catch(e) {}
}

/* ── Payload builder — includes favorites + pic ────── */
async function _buildPayload() {
  const [games, sessions, wishlist, favorites, settings, profile] = await Promise.all([
    DB.getGames(_user),
    DB.getSessions(_user),
    DB.getWishlist(_user),
    DB.getFavorites(_user),      // Section 11: favorites now synced
    DB.getAllSettings(_user),
    DB.getProfile(_user),
  ]);
  return {
    v: 2,                        // payload version so old clients degrade gracefully
    games,
    sessions,
    wishlist,
    favorites,                   // Section 11
    settings,
    pic:       profile?.pic  || null,
    pic_ts:    profile?.pic_ts || null,   // timestamp so newer pic wins
    ts:        new Date().toISOString(),
  };
}

/* ── Merge (last-write-wins on updatedAt / ts) ─────── */
async function _mergePayload(remote) {
  if (!remote) return false;
  let changed = false;

  // Games
  for (const rg of (remote.games || [])) {
    const local = await DB.getGame(_user, rg.id);
    if (!local || new Date(rg.updatedAt || 0) > new Date(local.updatedAt || 0)) {
      await DB.putGame(_user, { ...rg, username: _user });
      changed = true;
    }
  }

  // Sessions (add missing)
  const localSessions = await DB.getSessions(_user);
  const localSessionIds = new Set(localSessions.map(s => s.id));
  for (const rs of (remote.sessions || [])) {
    if (!localSessionIds.has(rs.id)) {
      await DB.putSession(_user, { ...rs, username: _user });
      changed = true;
    }
  }

  // Wishlist (add missing)
  const localWish = await DB.getWishlist(_user);
  const localWishIds = new Set(localWish.map(w => w.id));
  for (const rw of (remote.wishlist || [])) {
    if (!localWishIds.has(rw.id)) {
      await DB.putWishlistItem(_user, { ...rw, username: _user });
      changed = true;
    }
  }

  // Section 11: Favorites — merge by slot, remote wins if more recent
  for (const rf of (remote.favorites || [])) {
    const localFavs = await DB.getFavorites(_user);
    const lf = localFavs.find(f => String(f.slot) === String(rf.slot));
    if (!lf || new Date(rf.updatedAt || 0) > new Date(lf.updatedAt || 0)) {
      await DB.setFavorite(_user, rf.slot, rf.game_id);
      changed = true;
    }
  }

  // Section 11: Profile picture — use pic_ts to decide which is newer
  if (remote.pic) {
    const p = await DB.getProfile(_user);
    const remoteTs = new Date(remote.pic_ts || remote.ts || 0);
    const localTs  = new Date(p?.pic_ts || 0);
    if (!p?.pic || remoteTs > localTs) {
      await DB.updateProfilePic(_user, remote.pic, remote.pic_ts);
      changed = true;
    }
  }

  return changed;
}

/* ── Discover profiles on worker ──────────────────── */
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

/* ── Test a worker URL ────────────────────────────── */
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
