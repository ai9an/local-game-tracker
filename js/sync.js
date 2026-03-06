/* js/sync.js
 * Sync via:
 *   1. BroadcastChannel — instant cross-tab (same device, always on)
 *   2. Cloudflare Worker — cross-device, works on GitHub Pages (optional)
 *
 * Worker URL is saved in Settings and loaded on login.
 */

import * as DB from './db.js';

let _user      = null;
let _channel   = null;
let _timer     = null;
let _enabled   = false;
let _workerUrl = null;  // https://your-worker.workers.dev

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
  if (!_enabled) return;
  const payload = await _buildPayload();
  if (_channel) _channel.postMessage({ user: _user, payload });
  _pushNow().catch(() => {});
}

/* ── BroadcastChannel (cross-tab, instant) ────────── */
function _startBroadcast() {
  if (_channel) _channel.close();
  _channel = new BroadcastChannel('gt_sync_v3');
  _channel.onmessage = async e => {
    if (!_enabled || e.data?.user !== _user) return;
    const changed = await _mergePayload(e.data.payload);
    if (changed) window.dispatchEvent(new CustomEvent('gt:synced'));
  };
}

/* ── Cloudflare Worker polling (cross-device) ─────── */
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
      signal:  AbortSignal.timeout(8000),
    });
  } catch(e) {}
}

/* ── Payload builder ──────────────────────────────── */
async function _buildPayload() {
  const [games, sessions, wishlist, settings, profile] = await Promise.all([
    DB.getGames(_user), DB.getSessions(_user), DB.getWishlist(_user),
    DB.getAllSettings(_user), DB.getProfile(_user),
  ]);
  return {
    games, sessions, wishlist, settings,
    pic: profile?.pic || null,
    ts:  new Date().toISOString(),
  };
}

/* ── Merge (last-write-wins on updatedAt) ─────────── */
async function _mergePayload(remote) {
  if (!remote) return false;
  let changed = false;

  for (const rg of (remote.games || [])) {
    const local = await DB.getGame(_user, rg.id);
    if (!local || new Date(rg.updatedAt || 0) > new Date(local.updatedAt || 0)) {
      await DB.putGame(_user, { ...rg, username: _user });
      changed = true;
    }
  }
  for (const rs of (remote.sessions || [])) {
    const all = await DB.getSessions(_user);
    if (!all.find(s => s.id === rs.id)) {
      await DB.putSession(_user, { ...rs, username: _user });
      changed = true;
    }
  }
  for (const rw of (remote.wishlist || [])) {
    const all = await DB.getWishlist(_user);
    if (!all.find(w => w.id === rw.id)) {
      await DB.putWishlistItem(_user, { ...rw, username: _user });
      changed = true;
    }
  }
  if (remote.pic) {
    const p = await DB.getProfile(_user);
    if (!p?.pic) { await DB.updateProfilePic(_user, remote.pic); changed = true; }
  }
  return changed;
}

/* ── Discover profiles on worker (for login screen) ── */
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
