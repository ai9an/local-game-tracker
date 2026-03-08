/**
 * Game Tracker — Cloudflare Worker (sync relay + IGDB proxy)
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
 * IGDB PROXY (/igdb)
 * The worker also acts as a transparent IGDB proxy. This solves the CORS
 * header problem: browsers cannot send custom headers (Client-ID, Authorization)
 * through public CORS proxies. The worker forwards them server-side where CORS
 * does not apply. No credentials are stored — they are forwarded per-request.
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

    // ── GET /ping — health check ────────────────────────────────────────────
    if (path === '/ping') {
      return json({ ok: true, ts: new Date().toISOString() }, 200, cors);
    }

    // ── POST /igdb/:endpoint — IGDB API proxy ───────────────────────────────
    // The browser sends:
    //   POST /igdb/games
    //   Headers: X-IGDB-Client-ID, X-IGDB-Token
    //   Body: Apicalypse query string (e.g. search "Halo"; fields name,cover; limit 10;)
    //
    // The worker forwards to IGDB with proper Client-ID + Authorization headers.
    if (request.method === 'POST' && path.startsWith('/igdb/')) {
      const endpoint  = path.slice(6); // strip leading /igdb/
      const clientId  = request.headers.get('X-IGDB-Client-ID');
      const token     = request.headers.get('X-IGDB-Token');
      if (!clientId || !token) return json({ error: 'missing igdb credentials' }, 400, cors);
      try {
        const body = await request.text();
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
        return json({ error: `igdb proxy error: ${e.message}` }, 502, cors);
      }
    }

    // ── POST /igdb-token — get IGDB OAuth token ──────────────────────────────
    // Proxies the Twitch token endpoint so credentials stay out of browser logs.
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
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-. ]/g, '').slice(0, 64);
}
