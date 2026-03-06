/* js/db.js — IndexedDB abstraction, namespaced per username */

const DB_NAME    = 'GameTrackerV4';
const DB_VERSION = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('profiles')) {
        const ps = db.createObjectStore('profiles', { keyPath: 'username' });
        ps.createIndex('lastLogin', 'lastLogin');
      }
      if (!db.objectStoreNames.contains('game_cache')) {
        const cs = db.createObjectStore('game_cache', { keyPath: 'cacheKey' });
        cs.createIndex('fetched', 'fetched');
      }
      for (const name of ['games','sessions','wishlist','favorites','settings','sync_log']) {
        if (!db.objectStoreNames.contains(name)) {
          const st = db.createObjectStore(name, { keyPath: ['username','id'] });
          st.createIndex('byUser', 'username');
        }
      }
    };
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = e => rej(e.target.error);
  });
}

function wrap(req) {
  return new Promise((res, rej) => {
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
function store(name, mode = 'readonly') {
  return _db.transaction(name, mode).objectStore(name);
}
function byUser(storeName, username) {
  return wrap(store(storeName).index('byUser').getAll(username));
}

/* ── PROFILES ─────────────────────────────────────── */
export async function getProfiles() { return wrap(store('profiles').getAll()); }
export async function getProfile(username) { return wrap(store('profiles').get(username)); }
export async function createProfile(username) {
  const now = new Date().toISOString();
  return wrap(store('profiles','readwrite').put({ username, created: now, lastLogin: now, pic: null }));
}
export async function touchProfile(username) {
  const s = store('profiles','readwrite');
  const p = await wrap(s.get(username));
  if (p) { p.lastLogin = new Date().toISOString(); await wrap(s.put(p)); }
}
export async function updateProfilePic(username, pic) {
  const s = store('profiles','readwrite');
  const p = await wrap(s.get(username));
  if (p) { p.pic = pic; await wrap(s.put(p)); }
}
export async function deleteProfile(username) {
  for (const name of ['games','sessions','wishlist','favorites','settings','sync_log']) {
    const s = store(name,'readwrite');
    const keys = await wrap(s.index('byUser').getAllKeys(username));
    for (const k of keys) await wrap(s.delete(k));
  }
  return wrap(store('profiles','readwrite').delete(username));
}

/* ── SETTINGS ─────────────────────────────────────── */
export async function getSetting(username, key, fallback = null) {
  const r = await wrap(store('settings').get([username, key]));
  return r ? r.value : fallback;
}
export async function setSetting(username, key, value) {
  return wrap(store('settings','readwrite').put({ username, id: key, value }));
}
export async function getAllSettings(username) {
  const rows = await byUser('settings', username);
  return Object.fromEntries(rows.map(r => [r.id, r.value]));
}

/* ── GAMES ────────────────────────────────────────── */
export async function getGames(username) { return byUser('games', username); }
export async function getGame(username, id) { return wrap(store('games').get([username, id])); }
export async function putGame(username, game) {
  if (!game.id) game.id = crypto.randomUUID();
  game.username  = username;
  game.updatedAt = new Date().toISOString();
  return wrap(store('games','readwrite').put(game));
}
export async function deleteGame(username, id) {
  const sessions = await getSessions(username);
  for (const s of sessions.filter(s => s.game_id === id))
    await wrap(store('sessions','readwrite').delete([username, s.id]));
  return wrap(store('games','readwrite').delete([username, id]));
}

/* ── SESSIONS ─────────────────────────────────────── */
export async function getSessions(username) { return byUser('sessions', username); }
export async function putSession(username, s) {
  if (!s.id) s.id = crypto.randomUUID();
  s.username = username;
  return wrap(store('sessions','readwrite').put(s));
}
export async function deleteSession(username, id) {
  return wrap(store('sessions','readwrite').delete([username, id]));
}
export async function recalcGame(username, gameId) {
  const sessions = (await getSessions(username)).filter(s => s.game_id === gameId);
  const calc = sessions.reduce((t, s) => t + (Number(s.duration) || 0), 0);
  const last = [...sessions].sort((a,b) =>
    (b.date+'T'+b.start_time).localeCompare(a.date+'T'+a.start_time)
  )[0];
  const game = await getGame(username, gameId);
  if (!game) return;
  game.calculated_hours = +calc.toFixed(4);
  game.total_hours = +((Number(game.manual_hours)||0) + calc).toFixed(4);
  game.last_played = last ? last.date + 'T' + last.start_time : null;
  await putGame(username, game);
  return game;
}

/* ── WISHLIST ─────────────────────────────────────── */
export async function getWishlist(username) { return byUser('wishlist', username); }
export async function putWishlistItem(username, item) {
  if (!item.id) item.id = crypto.randomUUID();
  item.username = username;
  return wrap(store('wishlist','readwrite').put(item));
}
export async function deleteWishlistItem(username, id) {
  return wrap(store('wishlist','readwrite').delete([username, id]));
}

/* ── FAVORITES ────────────────────────────────────── */
export async function getFavorites(username) { return byUser('favorites', username); }
export async function setFavorite(username, slot, gameId) {
  return wrap(store('favorites','readwrite').put({ username, id: String(slot), slot, game_id: gameId || null }));
}

/* ── GAME METADATA CACHE ──────────────────────────── */
export async function getCached(key, ttlMs = 48*3600*1000) {
  const r = await wrap(store('game_cache').get(key));
  if (!r) return null;
  if (Date.now() - new Date(r.fetched).getTime() > ttlMs) return null;
  return r.data;
}
export async function putCached(key, data) {
  return wrap(store('game_cache','readwrite').put({ cacheKey: key, data, fetched: new Date().toISOString() }));
}
export async function bustCache(key) {
  try { await wrap(store('game_cache','readwrite').delete(key)); } catch(e) {}
}

/* ── EXPORT / IMPORT ──────────────────────────────── */
export async function exportProfile(username) {
  const [games, sessions, wishlist, favorites, settings] = await Promise.all([
    getGames(username), getSessions(username), getWishlist(username),
    getFavorites(username), getAllSettings(username),
  ]);
  const profile = await getProfile(username);
  return { version:4, exportedAt: new Date().toISOString(), username, pic: profile?.pic||null, games, sessions, wishlist, favorites, settings };
}
export async function importProfile(data) {
  const { username, games=[], sessions=[], wishlist=[], favorites=[], settings={}, pic=null } = data;
  await createProfile(username);
  if (pic) await updateProfilePic(username, pic);
  for (const g of games)     await putGame(username, g);
  for (const s of sessions)  await putSession(username, s);
  for (const w of wishlist)  await putWishlistItem(username, w);
  for (const f of favorites) await setFavorite(username, f.slot, f.game_id);
  for (const [k,v] of Object.entries(settings)) await setSetting(username, k, v);
}
