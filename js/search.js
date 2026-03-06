/* js/search.js
 * PROXY STRATEGY: Race three CORS proxies in parallel with Promise.any().
 * First one to respond wins — no sequential fallback delay.
 * On iOS Safari allorigins often fails; corsproxy.io typically wins fastest.
 * A warm-up fetch is triggered at import time so connections are pre-established.
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
      // allorigins wraps response: {"contents":"...","status":{}}
      const outer = JSON.parse(text);
      return JSON.parse(outer.contents);
    }
    return JSON.parse(text);
  }

  return Promise.any([
    tryProxy(`https://corsproxy.io/?${enc}`,                             false),
    tryProxy(`https://api.allorigins.win/get?url=${enc}`,                true),
    tryProxy(`https://api.codetabs.com/v1/proxy?quest=${enc}`,           false),
  ]);
}

/* ── Warm-up: pre-establish proxy connections ─────── */
// Called at import so the TCP handshake is already done by first search
let _warmed = false;
export function warmProxies() {
  if (_warmed) return; _warmed = true;
  // Tiny Steam endpoint — just to establish the connection
  proxiedFetch(
    'https://store.steampowered.com/api/storesearch/?term=zelda&l=english&cc=GB',
    6000
  ).catch(() => {});
}
warmProxies(); // auto-warm on import

/* ── Steam search ─────────────────────────────────── */
async function steamSearch(query) {
  const data = await proxiedFetch(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=GB`
  );
  return (data.items || []).slice(0, 7).map(g => ({
    title:        g.name || '',
    cover_url:    g.id ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/library_600x900.jpg` : '',
    cover_alts: g.id ? [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/library_600x900.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/header.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/capsule_616x353.jpg`,
    ] : [],
    release_year: '', description: '', developer: '', publisher: '', genres: '',
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
    title:        d.name || '',
    cover_url:    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    cover_alts: [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
      ...shots,
    ],
    release_year: yrm ? yrm[0] : '',
    description:  desc,
    developer:    (d.developers || []).slice(0, 2).join(', '),
    publisher:    (d.publishers || []).slice(0, 2).join(', '),
    genres:       (d.genres || []).slice(0, 3).map(x => x.description).join(', '),
    platform:     'PC',
    steam_appid:  String(appid),
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

/* ── Browse / trending ────────────────────────────── */
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
    const top  = toCards(raw.top_sellers?.items);   if (top.length)  sections.push({ label: '🔥 Top Sellers',  games: top });
    const newR = toCards(raw.new_releases?.items);  if (newR.length) sections.push({ label: '✨ New Releases', games: newR });
    const sale = toCards(raw.specials?.items);      if (sale.length) sections.push({ label: '💸 On Sale',      games: sale });
    const soon = toCards(raw.coming_soon?.items).slice(0, 8); if (soon.length) sections.push({ label: '📅 Coming Soon', games: soon });
    if (sections.length) await putCached(key, sections);
    return sections;
  } catch(e) {
    console.warn('fetchTrending failed:', e.message);
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

/* ── IGDB ─────────────────────────────────────────── */
let _token = null, _tokenExp = 0;

async function igdbToken(id, secret) {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const r = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`,
    { method: 'POST', signal: AbortSignal.timeout(8000) }
  );
  const d = await r.json();
  if (!d.access_token) throw new Error(d.message || 'IGDB auth failed');
  _token = d.access_token;
  _tokenExp = Date.now() + (d.expires_in || 3600) * 1000;
  return _token;
}

async function igdbPost(endpoint, body, clientId, clientSecret) {
  const token = await igdbToken(clientId, clientSecret);
  // Use corsproxy.io directly for IGDB — it supports POST reliably
  const r = await fetch(
    `https://corsproxy.io/?${encodeURIComponent('https://api.igdb.com/v4/' + endpoint)}`,
    {
      method:  'POST',
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body,
      signal:  AbortSignal.timeout(9000),
    }
  );
  if (!r.ok) throw new Error(`IGDB ${r.status}`);
  return r.json();
}

function parseIGDBGame(g) {
  const imgId = g.cover?.image_id;
  const year  = g.first_release_date ? String(new Date(g.first_release_date * 1000).getFullYear()) : '';
  const ics   = g.involved_companies || [];
  const arts  = (g.artworks || []).map(a => `https://images.igdb.com/igdb/image/upload/t_cover_big/${a.image_id}.jpg`);
  const cover = imgId ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imgId}.jpg` : '';
  return {
    title:        g.name || '',
    cover_url:    cover,
    cover_alts:   cover ? [cover, ...arts] : arts,
    release_year: year,
    description:  (g.summary || '').slice(0, 500),
    developer:    ics.find(i => i.developer)?.company?.name || '',
    publisher:    ics.find(i => i.publisher)?.company?.name || '',
    genres:       (g.genres || []).slice(0, 3).map(x => x.name).join(', '),
    platform:     (g.platforms || []).slice(0, 3).map(x => x.name).join(', '),
    slug:         `igdb:${g.id}`,
    source:       'igdb',
  };
}

async function igdbSearch(query, clientId, clientSecret) {
  const fields = 'name,cover.image_id,artworks.image_id,first_release_date,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,summary,id';
  const body   = `search "${query.replace(/"/g, '')}"; fields ${fields}; where version_parent = null; limit 8;`;
  return (await igdbPost('games', body, clientId, clientSecret)).map(parseIGDBGame);
}

async function igdbDetail(id, clientId, clientSecret) {
  const fields = 'name,cover.image_id,artworks.image_id,first_release_date,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,summary,platforms.name';
  const body   = `fields ${fields}; where id = ${id};`;
  const games  = await igdbPost('games', body, clientId, clientSecret);
  return games.length ? parseIGDBGame(games[0]) : {};
}

/* ── Public API ───────────────────────────────────── */
export async function searchGames(query, settings = {}) {
  const key    = `search:${query.toLowerCase().trim()}`;
  const cached = await getCached(key);
  if (cached) return { results: cached, fromCache: true };

  const all = [], errs = {};
  await Promise.allSettled([
    steamSearch(query).then(r => all.push(...r)).catch(e => { errs.steam = e.message; }),
    (settings.igdb_client_id && settings.igdb_client_secret
      ? igdbSearch(query, settings.igdb_client_id, settings.igdb_client_secret)
          .then(r => all.push(...r)).catch(e => { errs.igdb = e.message; })
      : Promise.resolve()),
  ]);

  // Deduplicate by title
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
  const cached = await getCached(key);
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

export async function testIGDB(clientId, clientSecret) {
  try {
    const r = await igdbSearch('Fortnite', clientId, clientSecret);
    return { ok: true, count: r.length };
  } catch(e) { return { ok: false, error: e.message }; }
}
