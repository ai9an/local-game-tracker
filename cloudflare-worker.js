/**
 * Game Tracker — Cloudflare Worker (sync relay)
 *
 * DEPLOY STEPS (takes about 5 minutes, free forever)
 *
 * 1. Sign up free at https://workers.cloudflare.com and navigate to Workers & Pages
 * 2. Create application → Start with hello world → Deploy → Edit code and paste this file in, then deploy
 * 3. Navigate to Storage & Databases → Workers KV → Create instance called "GameTrackerSync"
 * 4. Navigate back to Workers & Pages → goto the binding tab Add binding: Variable name = SYNC_STORE, and namespace name "GameTrackerSync"
 * 5. Optionally change your workers URL
 * 6. Copy your worker URL (e.g. https://projectname.yourname.workers.dev)
 * 7. Paste it in Game Tracker → Settings → Sync → Worker URL → Save
 * *
 * Free tier limits: 100,000 requests/day, 1GB KV storage
 */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const path = url.pathname;

    // GET /ping — health check
    if (path === '/ping') {
      return json({ ok: true, ts: new Date().toISOString() }, 200, cors);
    }

    // GET /pull?user=NAME — fetch latest payload for a user
    if (request.method === 'GET' && path === '/pull') {
      const user = url.searchParams.get('user');
      if (!user) return json({ error: 'user required' }, 400, cors);
      try {
        const raw = await env.SYNC_STORE.get(`user:${sanitize(user)}`);
        const payload = raw ? JSON.parse(raw) : null;
        return json({ ok: true, payload }, 200, cors);
      } catch(e) { return json({ error: 'store error' }, 500, cors); }
    }

    // POST /push — store payload for a user
    if (request.method === 'POST' && path === '/push') {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'invalid json' }, 400, cors); }
      const { user, payload } = body;
      if (!user) return json({ error: 'user required' }, 400, cors);
      try {
        await env.SYNC_STORE.put(`user:${sanitize(user)}`, JSON.stringify(payload), {
          expirationTtl: 30 * 24 * 3600, // 30 days
        });
        // Track username in list
        const listRaw = await env.SYNC_STORE.get('__users__');
        const users   = listRaw ? JSON.parse(listRaw) : [];
        if (!users.includes(user)) {
          users.push(user);
          await env.SYNC_STORE.put('__users__', JSON.stringify(users), { expirationTtl: 30 * 24 * 3600 });
        }
        return json({ ok: true }, 200, cors);
      } catch(e) { return json({ error: 'store error' }, 500, cors); }
    }

    // GET /list — list known usernames (used on login screen)
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
