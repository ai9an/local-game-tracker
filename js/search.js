/* js/search.js
 *
 * SEARCH PRIORITY (Section 2.1):
 *   IGDB connected → IGDB only (faster, all platforms, better accuracy)
 *   No IGDB         → Steam only
 *
 * PROXY STRATEGY: Race three CORS proxies via Promise.any — fastest wins.
 * Auto-warms on import so first search is snappy.
 *
 * IGDB QUERY (Section 2.2): includes ports, remasters, DLC-expansions
 *   via category filter: categories = (0,8,9,10,11) — main/port/remaster/remake/DLC
 */

import { getCached, putCached } from './db.js';

/* ── Parallel proxy race ──────────────────────────── */
async function proxiedFetch(targetUrl, timeoutMs = 10000) {
  const enc = encodeURIComponent(targetUrl);

  async function tryProxy(proxyUrl, isWrapped) {
    const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (isWrapped) {
      const outer = JSON.parse(text);
      return JSON.parse(outer.contents);
    }
    return JSON.parse(text);
  }

  return Promise.any([
    tryProxy(`https://corsproxy.io/?${enc}`,                        false),
    tryProxy(`https://api.allorigins.win/get?url=${enc}`,           true),
    tryProxy(`https://api.codetabs.com/v1/proxy?quest=${enc}`,      false),
  ]);
}

/* ── Warm-up ──────────────────────────────────────── */
let _warmed = false;
export function warmProxies() {
  if (_warmed) return; _warmed = true;
  proxiedFetch('https://store.steampowered.com/api/storesearch/?term=zelda&l=english&cc=GB', 6000)
    .catch(() => {});
}
warmProxies();

/* ═══════════════════════════════════════════════════
   STEAM
═══════════════════════════════════════════════════ */
async function steamSearch(query) {
  const data = await proxiedFetch(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=GB`
  );
  return (data.items || []).slice(0, 8).map(g => ({
    title:        g.name || '',
    cover_url:    g.id ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/library_600x900.jpg` : '',
    cover_alts: g.id ? [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/library_600x900.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/header.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/capsule_616x353.jpg`,
    ] : [],
    release_year: '', description: '', developer: '', publisher: '', genres: '',
    platform: 'PC',
    slug: `steam:${g.id}`, source: 'steam', steam_appid: String(g.id),
  }));
}

async function steamDetail(appid) {
  const raw   = await proxiedFetch(
    `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=GB`
  );
  const entry = raw?.[String(appid)];
  if (!entry?.success) return {};
  const d    = entry.data;
  const desc = (d.short_description || d.detailed_description || '').replace(/<[^>]+>/g, '').slice(0, 500);
  const yrm  = (d.release_date?.date || '').match(/\b(19|20)\d{2}\b/);
  const shots = (d.screenshots || []).slice(0, 4).map(s => s.path_full);
  return {
    title:         d.name || '',
    cover_url:     `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    cover_alts: [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
      ...shots,
    ],
    release_year:  yrm ? yrm[0] : '',
    release_date:  d.release_date?.date || '',
    description:   desc,
    developer:     (d.developers || []).slice(0, 2).join(', '),
    publisher:     (d.publishers || []).slice(0, 2).join(', '),
    genres:        (d.genres || []).slice(0, 3).map(x => x.description).join(', '),
    platform:      'PC',
    steam_appid:   String(appid),
    price_current: d.price_overview ? `£${(d.price_overview.final / 100).toFixed(2)}` : null,
    price_discount: d.price_overview?.discount_percent || 0,
  };
}

/* ── Steam price ──────────────────────────────────── */
export async function fetchSteamPrice(appid) {
  const key    = `price:steam:${appid}`;
  const cached = await getCached(key, 2 * 3600 * 1000);
  if (cached) return cached;
  try {
    const raw = await proxiedFetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=price_overview&cc=GB`, 8000
    );
    const po = raw?.[String(appid)]?.data?.price_overview;
    if (!po) return null;
    const result = {
      current:    (po.final    / 100).toFixed(2),
      original:   (po.initial  / 100).toFixed(2),
      discount:   po.discount_percent,
      on_sale:    po.discount_percent > 0,
      currency:   po.currency,
      fetched_at: new Date().toISOString(),
    };
    await putCached(key, result);
    return result;
  } catch(e) { return null; }
}

/* ── Steam browse / trending ──────────────────────── */
export async function fetchTrending() {
  const key    = 'browse:trending';
  const cached = await getCached(key, 3 * 3600 * 1000);
  if (cached) return cached;
  try {
    const raw = await proxiedFetch(
      'https://store.steampowered.com/api/featuredcategories?l=english&cc=GB', 14000
    );
    const toCards = items => (items || []).slice(0, 12).map(steamCardFromItem);
    const sections = [];
    const top  = toCards(raw.top_sellers?.items);
    if (top.length)  sections.push({ label: '🔥 Top Sellers',  games: top });
    const newR = toCards(raw.new_releases?.items);
    if (newR.length) sections.push({ label: '✨ New Releases', games: newR });
    const sale = toCards(raw.specials?.items);
    if (sale.length) sections.push({ label: '💸 On Sale',      games: sale });
    const soon = toCards((raw.coming_soon?.items || []).slice(0, 8));
    if (soon.length) sections.push({ label: '📅 Coming Soon',  games: soon });
    if (sections.length) await putCached(key, sections);
    return sections;
  } catch(e) {
    console.warn('fetchTrending:', e.message);
    return [];
  }
}

function steamCardFromItem(item) {
  return {
    title:       item.name || '',
    steam_appid: String(item.id || ''),
    cover_url:   item.id ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/library_600x900.jpg` : '',
    header_url:  item.header_image || (item.id ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/header.jpg` : ''),
    slug:        `steam:${item.id}`,
    source:      'steam',
    discount:    item.discount_percent || 0,
    price_final: item.final_price    ? (item.final_price / 100).toFixed(2)    : null,
    price_orig:  item.original_price ? (item.original_price / 100).toFixed(2) : null,
  };
}

/* ═══════════════════════════════════════════════════
   IGDB — WHY SEARCH SHOWS 0 RESULTS
   ─────────────────────────────────────────────────
   The fundamental problem is CORS. IGDB's API requires
   two custom HTTP headers on every request:
     Client-ID: <your id>
     Authorization: Bearer <token>

   Public CORS proxies (corsproxy.io, allorigins) only
   forward GET requests cleanly. For POST with custom
   headers they either strip the headers or reject the
   request entirely — IGDB returns [] or 401.

   THE ONLY RELIABLE SOLUTION for a static site is to
   route IGDB calls through YOUR Cloudflare Worker, which
   makes the request server-side with full header control.

   HOW IT WORKS:
   1. Browser  →  POST /igdb/games  →  Your CF Worker
                  (headers: X-IGDB-Client-ID, X-IGDB-Token)
   2. CF Worker →  POST api.igdb.com/v4/games
                  (headers: Client-ID, Authorization)
   3. IGDB results flow back through Worker → Browser

   If no worker URL is saved, we fall back to corsproxy.io
   which may work some of the time for the Twitch token
   fetch but is unreliable for IGDB queries.

   SETUP: Settings → Cloud Sync → enter your Worker URL.
   The updated cloudflare-worker.js already includes the
   /igdb/* proxy endpoint and /igdb-token endpoint.
═══════════════════════════════════════════════════ */

let _token = null, _tokenExp = 0;
let _workerUrl    = null; // injected by app.js after login
let _workerHasIGDB = null; // null=untested, true=confirmed, false=not available

/** Called by app.js immediately after reading settings */
export function setIGDBWorkerUrl(url) {
  const newUrl = url ? String(url).trim().replace(/\/+$/, '') : null;
  if (newUrl !== _workerUrl) {
    _workerHasIGDB = null; // re-test on next search when URL changes
  }
  _workerUrl = newUrl;
}

/**
 * Get a cached Twitch/IGDB OAuth token.
 * Tries the worker proxy first (most reliable), then falls back to
 * a direct CORS proxy of the Twitch token endpoint (no custom headers
 * needed for the token request itself, so proxies work fine here).
 */
async function igdbToken(id, secret) {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;

  let data = null;

  // Path 1: via worker /igdb-token (preferred — works everywhere)
  if (_workerUrl) {
    try {
      const r = await fetch(`${_workerUrl}/igdb-token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ client_id: id, client_secret: secret }),
        signal:  AbortSignal.timeout(9000),
      });
      if (r.ok) { data = await r.json(); }
    } catch(e) { /* fall through */ }
  }

  // Path 2: direct CORS proxy of Twitch endpoint
  // The Twitch token URL uses query-params, no custom headers → proxies work
  if (!data?.access_token) {
    const twitchUrl = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`;
    const proxied   = `https://corsproxy.io/?${encodeURIComponent(twitchUrl)}`;
    try {
      const r = await fetch(proxied, { method: 'POST', signal: AbortSignal.timeout(9000) });
      if (r.ok) { data = await r.json(); }
    } catch(e) { /* fall through */ }
  }

  if (!data?.access_token) {
    throw new Error(
      data?.message ||
      'IGDB auth failed. Make sure your Worker URL is set in Settings → Cloud Sync.'
    );
  }

  _token    = data.access_token;
  _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

/**
 * POST to IGDB API endpoint with Apicalypse body.
 *
 * Strategy:
 *   1. If worker URL set AND worker has /igdb endpoint → use worker (best)
 *   2. Otherwise → CORS proxy (same path that works when sync is disabled)
 *
 * _workerHasIGDB tracks whether the worker supports /igdb.
 * On first call it tests the endpoint; if it gets a 404 (old worker not yet
 * redeployed) it falls back to CORS proxies for the rest of the session.
 * This means sync can be enabled WITHOUT redeploying the worker and search
 * keeps working exactly as it did before sync was turned on.
 */
async function igdbPost(endpoint, body, clientId, clientSecret) {
  const token = await igdbToken(clientId, clientSecret);

  // ── Path 1: Worker proxy (only if worker has the /igdb endpoint) ──────────
  if (_workerUrl && _workerHasIGDB !== false) {
    try {
      const r = await fetch(`${_workerUrl}/igdb/${endpoint}`, {
        method:  'POST',
        headers: {
          'Content-Type':     'text/plain',
          'X-IGDB-Client-ID': clientId,
          'X-IGDB-Token':     token,
        },
        body,
        signal: AbortSignal.timeout(12000),
      });
      if (r.status === 404) {
        // Old worker — /igdb endpoint not deployed yet. Use CORS proxies.
        _workerHasIGDB = false;
        console.info('[IGDB] Worker missing /igdb endpoint — falling back to CORS proxy. Redeploy cloudflare-worker.js to use worker-based search.');
        // fall through to Path 2
      } else if (!r.ok) {
        // Other worker error — also fall through
        console.warn(`[IGDB] Worker error ${r.status} — falling back to CORS proxy`);
        // fall through to Path 2
      } else {
        _workerHasIGDB = true;
        const raw = await r.json();
        if (Array.isArray(raw)) return raw;
        if (raw?.error) throw new Error(raw.error);
        return raw;
      }
    } catch(e) {
      // Network error or timeout — fall through to CORS proxy
      console.warn('[IGDB] worker fetch failed:', e.message);
    }
  }

  // ── Path 2: CORS proxy — the proven-working path used when sync is off ────
  // corsproxy.io forwards POST bodies and custom headers to IGDB.
  const target = `https://api.igdb.com/v4/${endpoint}`;
  const hdrs   = {
    'Client-ID':     clientId,
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'text/plain',
  };

  try {
    const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`,
      { method: 'POST', headers: hdrs, body, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const raw = await r.json();
      if (Array.isArray(raw)) return raw;
      if (typeof raw?.contents === 'string') {
        try { return JSON.parse(raw.contents); } catch(_) {}
      }
      return raw;
    }
  } catch(e) { /* try next proxy */ }

  // Second CORS proxy as last resort
  try {
    const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
      { method: 'POST', headers: hdrs, body, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const raw = await r.json();
      if (Array.isArray(raw)) return raw;
      return raw;
    }
  } catch(e) { /* give up */ }

  throw new Error(
    `IGDB search failed via all methods. ` +
    (_workerUrl && _workerHasIGDB === false
      ? 'Worker is running but needs the updated cloudflare-worker.js redeployed for IGDB proxy support.'
      : 'Check your internet connection and IGDB credentials.')
  );
}

function parseIGDBGame(g) {
  const imgId = g.cover?.image_id;
  const year  = g.first_release_date ? String(new Date(g.first_release_date * 1000).getFullYear()) : '';
  const ics   = g.involved_companies || [];
  const arts  = (g.artworks || []).slice(0, 4).map(a =>
    `https://images.igdb.com/igdb/image/upload/t_cover_big/${a.image_id}.jpg`
  );
  const cover = imgId ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imgId}.jpg` : '';
  const plats = (g.platforms || []).slice(0, 6).map(x => x.name).join(', ');
  return {
    title:        g.name || '',
    cover_url:    cover,
    cover_alts:   cover ? [cover, ...arts] : arts,
    release_year: year,
    release_date: g.first_release_date
      ? new Date(g.first_release_date * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : '',
    description:  (g.summary || '').slice(0, 500),
    developer:    ics.find(i => i.developer)?.company?.name || '',
    publisher:    ics.find(i => i.publisher)?.company?.name || '',
    genres:       (g.genres || []).slice(0, 3).map(x => x.name).join(', '),
    platform:     plats,
    slug:         `igdb:${g.id}`,
    source:       'igdb',
    igdb_id:      g.id,
    igdb_rating:  g.total_rating ? Math.round(g.total_rating) : null,   // 0-100
    igdb_rating_count: g.total_rating_count || 0,
    header_url:   cover, // for browse card compat
  };
}

const IGDB_FIELDS = 'name,cover.image_id,artworks.image_id,first_release_date,genres.name,' +
  'involved_companies.company.name,involved_companies.developer,involved_companies.publisher,' +
  'summary,id,platforms.name,total_rating,total_rating_count';

// Section 2.2: broaden query to catch ports, remasters, console editions
async function igdbSearch(query, clientId, clientSecret) {
  // Run two queries in parallel:
  //   1. Title search (gets main game + any version matching the title)
  //   2. Alternative name search for oddly named ports
  const cleanQ = query.replace(/"/g, '');
  const body1 = `search "${cleanQ}"; fields ${IGDB_FIELDS}; limit 12;`;
  // Also fetch by alternative names for ports that have different IGDB entries
  const body2 = `fields ${IGDB_FIELDS}; where alternative_names.name ~ *"${cleanQ}"*; limit 6;`;
  const [r1, r2] = await Promise.allSettled([
    igdbPost('games', body1, clientId, clientSecret),
    igdbPost('games', body2, clientId, clientSecret),
  ]);
  const seen = new Set();
  const out  = [];
  const merge = (games) => {
    for (const g of games) {
      if (!seen.has(g.id)) { seen.add(g.id); out.push(parseIGDBGame(g)); }
    }
  };
  if (r1.status === 'fulfilled') merge(r1.value);
  if (r2.status === 'fulfilled') merge(r2.value);
  return out;
}

async function igdbDetail(id, clientId, clientSecret) {
  const fields = IGDB_FIELDS + ',screenshots.image_id';
  const body   = `fields ${fields}; where id = ${id};`;
  const games  = await igdbPost('games', body, clientId, clientSecret);
  if (!games.length) return {};
  const g = games[0];
  const parsed = parseIGDBGame(g);
  // Add screenshots to cover_alts
  const shots = (g.screenshots || []).slice(0, 4)
    .map(s => `https://images.igdb.com/igdb/image/upload/t_screenshot_big/${s.image_id}.jpg`);
  parsed.cover_alts = [...(parsed.cover_alts || []), ...shots];
  return parsed;
}

/* ═══════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════ */
export async function searchGames(query, settings = {}) {
  const key    = `search:${query.toLowerCase().trim()}`;
  const cached = await getCached(key, 24 * 3600 * 1000);
  if (cached) return { results: cached, fromCache: true };

  const all = [], errs = {};
  const hasIGDB = settings.igdb_client_id && settings.igdb_client_secret;

  if (hasIGDB) {
    // IGDB only — disable Steam when IGDB is connected (Section 2.1)
    await igdbSearch(query, settings.igdb_client_id, settings.igdb_client_secret)
      .then(r => all.push(...r))
      .catch(e => { errs.igdb = e.message; });
    // Fallback to Steam only if IGDB totally fails
    if (!all.length && errs.igdb) {
      await steamSearch(query).then(r => all.push(...r)).catch(e => { errs.steam = e.message; });
    }
  } else {
    await steamSearch(query).then(r => all.push(...r)).catch(e => { errs.steam = e.message; });
  }

  // Deduplicate
  const seen = new Set(), merged = [];
  for (const item of all) {
    const k = (item.title || '').toLowerCase().trim();
    if (k && !seen.has(k)) { seen.add(k); merged.push(item); }
  }

  if (merged.length) await putCached(key, merged);
  return { results: merged, errors: errs };
}

export async function getGameDetail(slug, settings = {}) {
  const key    = `detail:${slug}`;
  const cached = await getCached(key, 48 * 3600 * 1000);
  if (cached) return cached;
  let detail = {};
  try {
    if (slug.startsWith('steam:'))
      detail = await steamDetail(slug.split(':')[1]);
    else if (slug.startsWith('igdb:') && settings.igdb_client_id)
      detail = await igdbDetail(slug.split(':')[1], settings.igdb_client_id, settings.igdb_client_secret);
  } catch(e) { console.warn('getGameDetail:', e.message); }
  if (detail.title) await putCached(key, detail);
  return detail;
}

/* ── Search by title → return description (for re-import tool) ── */
export async function fetchDescriptionForGame(game, settings = {}) {
  const hasIGDB = settings.igdb_client_id && settings.igdb_client_secret;

  // 1. If game already has a steam_appid, use Steam directly
  if (game.steam_appid) {
    try {
      const d = await steamDetail(String(game.steam_appid));
      if (d?.description) return d.description;
    } catch(e) {}
  }

  // 2. Try IGDB by title search
  if (hasIGDB) {
    try {
      const results = await igdbSearch(game.title, settings.igdb_client_id, settings.igdb_client_secret);
      const match   = results.find(r => r.title?.toLowerCase() === game.title.toLowerCase()) || results[0];
      if (match?.slug?.startsWith('igdb:')) {
        const detail = await igdbDetail(match.slug.split(':')[1], settings.igdb_client_id, settings.igdb_client_secret);
        if (detail?.description) return detail.description;
      }
    } catch(e) {}
  }

  // 3. Try Steam search by title as fallback
  try {
    const results = await steamSearch(game.title);
    const match   = results.find(r => r.title?.toLowerCase() === game.title.toLowerCase()) || results[0];
    if (match?.steam_appid) {
      const detail = await steamDetail(String(match.steam_appid));
      if (detail?.description) return detail.description;
    }
  } catch(e) {}

  return null;
}

export async function testIGDB(clientId, clientSecret) {
  try {
    const r = await igdbSearch('Halo', clientId, clientSecret);
    return { ok: true, count: r.length };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ── Steam-first search for wishlist (always gets steam_appid for price tracking) ── */
export async function searchGamesSteamFirst(query, settings = {}) {
  const key    = `search_sf:${query.toLowerCase()}`;
  const cached = await getCached(key, 10 * 60 * 1000);
  if (cached) return { results: cached };

  const all = [], errs = {};

  // Always run Steam first (gets appid for price tracking)
  await steamSearch(query).then(r => all.push(...r)).catch(e => { errs.steam = e.message; });

  // Also run IGDB if available, but only for games Steam didn't find
  const hasIGDB = settings.igdb_client_id && settings.igdb_client_secret;
  if (hasIGDB && !settings.wishlist_search_source || settings.wishlist_search_source === 'igdb') {
    await igdbSearch(query, settings.igdb_client_id, settings.igdb_client_secret)
      .then(r => all.push(...r)).catch(e => { errs.igdb = e.message; });
  } else if (hasIGDB && settings.wishlist_search_source === 'both') {
    await igdbSearch(query, settings.igdb_client_id, settings.igdb_client_secret)
      .then(r => all.push(...r)).catch(e => { errs.igdb = e.message; });
  }

  // Deduplicate by title
  const seen = new Set(), merged = [];
  for (const item of all) {
    const k = (item.title || '').toLowerCase().trim();
    if (k && !seen.has(k)) { seen.add(k); merged.push(item); }
  }

  if (merged.length) await putCached(key, merged);
  return { results: merged, errors: errs };
}

/* ── Browse search (Section 2.3 — uses IGDB or Steam) */
export async function searchBrowse(query, settings = {}) {
  const hasIGDB = settings.igdb_client_id && settings.igdb_client_secret;
  if (hasIGDB) {
    try {
      return (await igdbSearch(query, settings.igdb_client_id, settings.igdb_client_secret))
        .map(g => ({ ...g, header_url: g.cover_url, discount: 0, price_final: null, price_orig: null }));
    } catch(e) {}
  }
  try { return await steamSearch(query); } catch(e) { return []; }
}
