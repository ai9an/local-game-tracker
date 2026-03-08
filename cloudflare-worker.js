/**
 * LocalLogger — Cloudflare Worker
 * Sync relay + IGDB proxy + HLTB proxy
 *
 * DEPLOY STEPS (takes about 5 minutes, free forever)
 *
 * 1. Sign up free at https://workers.cloudflare.com and navigate to Workers & Pages
 * 2. Create application → Start with hello world → Deploy → Edit code and paste this file in, then deploy
 * 3. Navigate to Storage & Databases → Workers KV → Create instance called "GameTrackerSync"
 * 4. Navigate back to Workers & Pages → goto the binding tab Add binding: Variable name = SYNC_STORE, and namespace name "GameTrackerSync"
 * 5. Optionally change your workers URL
 * 6. Copy your worker URL (e.g. https://projectname.yourname.workers.dev)
 * 7. Paste it in Game Tracker → Settings → Sync → Worker URL → Save *
 * Free tier limits: 100,000 requests/day, 1GB KV storage — more than enough.
 *
 * ENDPOINTS
 * ─────────────────────────────────────────────────
 * GET  /ping              — health check
 * POST /igdb/:endpoint    — IGDB API proxy
 * POST /igdb-token        — Twitch OAuth token proxy
 * POST /hltb              — HowLongToBeat proxy (auto-discovers hash)
 * GET  /pull?user=NAME    — read KV payload
 * POST /push              — write KV payload
 * GET  /list              — list known users
 */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-IGDB-Client-ID, X-IGDB-Token',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const path = url.pathname;

    // ── GET /ping ───────────────────────────────────────────────────────────
    if (path === '/ping') {
      return json({ ok: true, ts: new Date().toISOString() }, 200, cors);
    }

    // ── POST /igdb/:endpoint — IGDB API proxy ───────────────────────────────
    if (request.method === 'POST' && path.startsWith('/igdb/')) {
      const endpoint = path.slice(6);
      const clientId = request.headers.get('X-IGDB-Client-ID');
      const token    = request.headers.get('X-IGDB-Token');
      if (!clientId || !token) return json({ error: 'missing igdb credentials' }, 400, cors);
      try {
        const body    = await request.text();
        const igdbRes = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
          method:  'POST',
          headers: {
            'Client-ID':     clientId,
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'text/plain',
          },
          body,
        });
        const data = await igdbRes.text();
        return new Response(data, {
          status:  igdbRes.status,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch(e) {
        return json({ error: `igdb proxy: ${e.message}` }, 502, cors);
      }
    }

    // ── POST /igdb-token — Twitch OAuth token proxy ──────────────────────────
    if (request.method === 'POST' && path === '/igdb-token') {
      try {
        const { client_id, client_secret } = await request.json();
        if (!client_id || !client_secret) return json({ error: 'missing credentials' }, 400, cors);
        const r = await fetch(
          `https://id.twitch.tv/oauth2/token?client_id=${client_id}&client_secret=${client_secret}&grant_type=client_credentials`,
          { method: 'POST' }
        );
        const d = await r.json();
        return json(d, r.status, cors);
      } catch(e) { return json({ error: e.message }, 502, cors); }
    }

    // ── POST /hltb — HowLongToBeat proxy ────────────────────────────────────
    //
    // HLTB's search API is a POST to:
    //   https://howlongtobeat.com/api/search/[HASH]
    //
    // The HASH is a short alphanumeric string embedded in their JavaScript
    // bundle that rotates whenever they redeploy. It is NOT in the HTML —
    // it lives inside one of their Next.js static chunk files.
    //
    // This endpoint:
    //   1. Fetches HLTB homepage to find chunk script URLs
    //   2. Scans chunks for the /api/search/[hash] pattern
    //   3. Caches the hash in KV for 6h
    //   4. POSTs the search with correct headers (Referer, Origin, User-Agent)
    //   5. Auto-invalidates cached hash if HLTB returns 404
    //
    if (request.method === 'POST' && path === '/hltb') {
      try {
        const { searchTerms } = await request.json();
        if (!searchTerms || !Array.isArray(searchTerms)) {
          return json({ error: 'searchTerms array required' }, 400, cors);
        }

        const HASH_KV_KEY = '__hltb_hash__';
        const BROWSER_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

        // ── Step 1: Get hash (KV cache → fresh discovery) ─────────────────
        let hash = null;

        if (env.SYNC_STORE) {
          try {
            const cached = await env.SYNC_STORE.getWithMetadata(HASH_KV_KEY);
            if (cached?.value) {
              const age = Date.now() - (cached.metadata?.ts || 0);
              if (age < 6 * 3600 * 1000) hash = cached.value;
            }
          } catch(_) {}
        }

        if (!hash) {
          hash = await discoverHLTBHash(BROWSER_UA);

          if (hash && env.SYNC_STORE) {
            try {
              await env.SYNC_STORE.put(HASH_KV_KEY, hash, {
                metadata:      { ts: Date.now() },
                expirationTtl: 6 * 3600,
              });
            } catch(_) {}
          }
        }

        if (!hash) {
          return json({
            error: 'Could not discover HLTB API hash. HLTB may have restructured their site.'
          }, 503, cors);
        }

        // ── Step 2: Call HLTB search API ──────────────────────────────────
        const hltbPayload = {
          searchType: 'games',
          searchTerms,
          searchPage: 1,
          size: 8,
          searchOptions: {
            games: {
              userId: 0, platform: '', sortCategory: 'popular',
              rangeCategory: 'main', rangeTime: { min: null, max: null },
              gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
              rangeYear: { min: '', max: '' }, modifier: '',
            },
            users: { sortCategory: 'postcount' },
            filter: '', sort: 0, randomizer: 0,
          },
        };

        const hltbRes = await fetch(`https://howlongtobeat.com/api/search/${hash}`, {
          method:  'POST',
          headers: {
            'Content-Type':    'application/json',
            'Referer':         'https://howlongtobeat.com/',
            'Origin':          'https://howlongtobeat.com',
            'User-Agent':      BROWSER_UA,
            'Accept':          'application/json, */*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          body: JSON.stringify(hltbPayload),
        });

        // Hash rotated — clear cache so next request re-discovers
        if (hltbRes.status === 404 && env.SYNC_STORE) {
          try { await env.SYNC_STORE.delete(HASH_KV_KEY); } catch(_) {}
          // Try once more with a fresh hash
          const freshHash = await discoverHLTBHash(BROWSER_UA);
          if (freshHash && freshHash !== hash) {
            if (env.SYNC_STORE) {
              try {
                await env.SYNC_STORE.put(HASH_KV_KEY, freshHash, {
                  metadata: { ts: Date.now() }, expirationTtl: 6 * 3600,
                });
              } catch(_) {}
            }
            const retry = await fetch(`https://howlongtobeat.com/api/search/${freshHash}`, {
              method:  'POST',
              headers: {
                'Content-Type': 'application/json', 'Referer': 'https://howlongtobeat.com/',
                'Origin': 'https://howlongtobeat.com', 'User-Agent': BROWSER_UA,
                'Accept': 'application/json, */*', 'Accept-Language': 'en-US,en;q=0.9',
              },
              body: JSON.stringify(hltbPayload),
            });
            if (retry.ok) {
              const data = await retry.text();
              return new Response(data, {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'X-HLTB-Hash': freshHash, ...cors },
              });
            }
          }
          return json({ error: `HLTB hash stale (404). Re-discovery attempted.` }, 503, cors);
        }

        if (!hltbRes.ok) {
          return json({ error: `HLTB returned HTTP ${hltbRes.status}` }, hltbRes.status, cors);
        }

        const data = await hltbRes.text();
        return new Response(data, {
          status:  200,
          headers: { 'Content-Type': 'application/json', 'X-HLTB-Hash': hash, ...cors },
        });

      } catch(e) {
        return json({ error: `hltb proxy: ${e.message}` }, 502, cors);
      }
    }

    // ── GET /hltb-debug — show hash discovery diagnostics ───────────────────
    // Visit: https://your-worker.workers.dev/hltb-debug in a browser
    if (request.method === 'GET' && path === '/hltb-debug') {
      const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
      const log = [];
      const BASE = 'https://howlongtobeat.com';
      const HASH_RE = /\/api\/search\/([a-zA-Z0-9]{8,32})/;
      const hdrs = { 'User-Agent': UA, 'Accept': '*/*', 'Referer': BASE + '/' };

      try {
        const homeRes = await fetch(BASE + '/', { headers: hdrs });
        log.push(`Homepage: HTTP ${homeRes.status}`);
        if (!homeRes.ok) { return new Response(log.join('\n'), { headers: { 'Content-Type': 'text/plain', ...cors } }); }

        const html = await homeRes.text();
        log.push(`HTML length: ${html.length}`);

        const bd = html.match(/"buildId"\s*:\s*"([^"]+)"/);
        log.push(`buildId: ${bd ? bd[1] : 'NOT FOUND'}`);
        log.push(`Direct hash in HTML: ${html.match(HASH_RE)?.[1] || 'NOT FOUND'}`);

        // List all script chunks
        const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map(m => m[1]);
        log.push(`Script tags: ${scripts.length}`);

        // Scan each script chunk and report findings
        for (const src of scripts) {
          const url = BASE + src;
          try {
            const r = await fetch(url, { headers: hdrs });
            if (!r.ok) { log.push(`  ${src} → HTTP ${r.status}`); continue; }
            const text = await r.text();
            const h = text.match(HASH_RE);
            // Count inner chunk refs
            const inner16 = [...text.matchAll(/"([a-f0-9]{16})"/g)].length;
            const innerPaths = [...text.matchAll(/\/_next\/static\/chunks\/([a-zA-Z0-9/_.-]+\.js)/g)].length;
            log.push(`  ${src} → ${text.length} chars, hash=${h?.[1]||'none'}, hex16refs=${inner16}, chunkPaths=${innerPaths}`);
            if (h) log.push(`    *** FOUND HASH: ${h[1]} ***`);
          } catch(e) { log.push(`  ${src} → ERROR: ${e.message}`); }
        }

        // Try buildManifest
        if (bd) {
          const mUrl = `${BASE}/_next/static/${bd[1]}/_buildManifest.js`;
          try {
            const mr = await fetch(mUrl, { headers: hdrs });
            log.push(`buildManifest: HTTP ${mr.status}`);
            if (mr.ok) {
              const mt = await mr.text();
              const mh = mt.match(HASH_RE);
              const chunkCount = [...mt.matchAll(/"([a-f0-9]{16})"/g)].length;
              log.push(`  manifest length=${mt.length}, hash=${mh?.[1]||'none'}, hex16refs=${chunkCount}`);
              // Dump full manifest content so we can see its structure
              log.push(`--- MANIFEST CONTENT START ---`);
              log.push(mt.slice(0, 4000));
              log.push(`--- MANIFEST CONTENT END ---`);
            }
          } catch(e) { log.push(`buildManifest error: ${e.message}`); }
        }

        // Also dump 1da8a2b58a8410f4.js first 2000 chars (has hex16refs)
        try {
          const chunkR = await fetch(`${BASE}/_next/static/chunks/1da8a2b58a8410f4.js`, { headers: hdrs });
          if (chunkR.ok) {
            const ct = await chunkR.text();
            log.push(`--- 1da8a2b58a8410f4.js SAMPLE (first 500 chars) ---`);
            log.push(ct.slice(0, 500));
            // Show all hex16 values found
            const hexVals = [...ct.matchAll(/"([a-f0-9]{16})"/g)].map(m=>m[1]);
            log.push(`hex16 values: ${hexVals.join(', ')}`);
          }
        } catch(e) { log.push(`chunk dump error: ${e.message}`); }

        // Full discovery attempt
        const finalHash = await discoverHLTBHash(UA);
        log.push(`\nFull discovery result: ${finalHash || 'NULL'}`);

      } catch(e) { log.push(`Fatal error: ${e.message}`); }

      return new Response(log.join('\n'), { headers: { 'Content-Type': 'text/plain', ...cors } });
    }

    // ── GET /pull?user=NAME ─────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/pull') {
      const user = url.searchParams.get('user');
      if (!user) return json({ error: 'user required' }, 400, cors);
      try {
        const raw     = await env.SYNC_STORE.get(`user:${sanitize(user)}`);
        const payload = raw ? JSON.parse(raw) : null;
        return json({ ok: true, payload }, 200, cors);
      } catch(e) { return json({ error: 'store error' }, 500, cors); }
    }

    // ── POST /push ──────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/push') {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'invalid json' }, 400, cors); }
      const { user, payload } = body;
      if (!user) return json({ error: 'user required' }, 400, cors);
      try {
        await env.SYNC_STORE.put(`user:${sanitize(user)}`, JSON.stringify(payload), {
          expirationTtl: 30 * 24 * 3600,
        });
        const listRaw = await env.SYNC_STORE.get('__users__');
        const users   = listRaw ? JSON.parse(listRaw) : [];
        if (!users.includes(user)) {
          users.push(user);
          await env.SYNC_STORE.put('__users__', JSON.stringify(users), { expirationTtl: 30 * 24 * 3600 });
        }
        return json({ ok: true }, 200, cors);
      } catch(e) { return json({ error: 'store error' }, 500, cors); }
    }

    // ── GET /list ───────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/list') {
      try {
        const raw   = await env.SYNC_STORE.get('__users__');
        const users = raw ? JSON.parse(raw) : [];
        return json({ ok: true, users }, 200, cors);
      } catch(e) { return json({ ok: true, users: [] }, 200, cors); }
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

/**
 * Discover the current HLTB search API hash.
 *
 * HLTB uses Next.js App Router. The hash lives in one of the JS chunk files
 * loaded by the page — it's never in the HTML itself.
 *
 * From the debug output we know:
 *  - buildId is present in __NEXT_DATA__
 *  - 13 script chunks are listed in HTML <script src="..."> tags
 *  - None of those 13 contain the hash directly
 *  - The hash is in a chunk referenced *from within* those chunks or via
 *    the buildManifest's chunk map
 *
 * Strategy:
 * 1. Scan all 13 HTML script chunks directly
 * 2. From each chunk, extract any hex-named chunk references (e.g. "abcd1234.js")
 *    and scan those too (one level deep)
 * 3. Fetch buildManifest → extract all chunk paths → scan them
 *
 * Returns the hash string or null.
 */
async function discoverHLTBHash(userAgent) {
  const BASE    = 'https://howlongtobeat.com';
  const HASH_RE = /\/api\/search\/([a-zA-Z0-9]{8,32})/;
  const hdrs    = { 'User-Agent': userAgent, 'Accept': '*/*', 'Referer': BASE + '/' };

  const fetchText = async url => {
    try {
      const r = await fetch(url, { headers: hdrs });
      return r.ok ? await r.text() : null;
    } catch(_) { return null; }
  };
  const scanText = text => { const m = text.match(HASH_RE); return m ? m[1] : null; };

  // Extract all /_next/static/chunks/*.js references from a JS file
  // These appear as hex-named chunk IDs in webpack chunk maps, e.g.:
  //   "abc123":"def456"  where def456.js is a lazy-loaded chunk
  const extractChunkUrls = text => {
    const urls = new Set();
    // Explicit /_next/static/chunks/... paths
    const re1 = /\/_next\/static\/chunks\/([a-zA-Z0-9/_.-]+\.js)/g;
    let m;
    while ((m = re1.exec(text)) !== null) urls.add(`${BASE}/_next/static/chunks/${m[1]}`);
    // Webpack chunk map: hex values that become [value].js chunk files
    // Pattern: "chunkId":"hexValue" in chunk manifests
    const re2 = /"([a-f0-9]{16})"/g;
    while ((m = re2.exec(text)) !== null) urls.add(`${BASE}/_next/static/chunks/${m[1]}.js`);
    return [...urls];
  };

  // ── Step 1: Fetch homepage HTML ────────────────────────────────────────
  const homeHtml = await fetchText(BASE + '/');
  if (!homeHtml) return null;

  // Direct scan (unlikely but free)
  const direct = scanText(homeHtml);
  if (direct) return direct;

  // ── Step 2: Extract buildId ────────────────────────────────────────────
  let buildId = null;
  const bdMatch = homeHtml.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (bdMatch) buildId = bdMatch[1];

  // ── Step 3: Collect all script chunk URLs from HTML ────────────────────
  const htmlChunkUrls = [];
  const scriptRe = /src="(\/_next\/static\/[^"]+\.js)"/g;
  let m;
  while ((m = scriptRe.exec(homeHtml)) !== null) htmlChunkUrls.push(BASE + m[1]);

  // ── Step 4: Add buildManifest-derived chunks ───────────────────────────
  const manifestChunkUrls = [];
  if (buildId) {
    const manifest = await fetchText(`${BASE}/_next/static/${buildId}/_buildManifest.js`);
    if (manifest) {
      const h = scanText(manifest);
      if (h) return h;
      // buildManifest contains a map of route → [chunkIds]
      // Extract all hex chunk IDs from it
      manifestChunkUrls.push(...extractChunkUrls(manifest));
    }
  }

  // ── Step 5: Scan all HTML chunks + collect their inner chunk references ──
  const level1Results = await Promise.all(
    htmlChunkUrls.map(async url => {
      const text = await fetchText(url);
      if (!text) return { hash: null, innerUrls: [] };
      return { hash: scanText(text), innerUrls: extractChunkUrls(text) };
    })
  );

  // Return immediately if found in a level-1 chunk
  for (const r of level1Results) {
    if (r.hash) return r.hash;
  }

  // ── Step 6: Scan manifest chunks + level-2 chunks from HTML chunks ───────
  const level2Urls = new Set([
    ...manifestChunkUrls,
    ...level1Results.flatMap(r => r.innerUrls),
  ]);
  // Remove URLs we already scanned
  htmlChunkUrls.forEach(u => level2Urls.delete(u));

  const level2Results = await Promise.all(
    [...level2Urls].slice(0, 40).map(async url => {
      const text = await fetchText(url);
      return text ? scanText(text) : null;
    })
  );

  return level2Results.find(h => h !== null) ?? null;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-. ]/g, '').slice(0, 64);
}
