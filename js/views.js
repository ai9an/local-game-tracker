/* js/views.js — All page renderers */

import * as DB from './db.js';
import { searchGames, searchGamesSteamFirst, getGameDetail, fetchDescriptionForGame, testIGDB, fetchSteamPrice, fetchTrending, searchBrowse, fetchTimeToBeat, fetchIGDBRatingForGame } from './search.js';
import { h, fmtHours, fmtStars, fmtDate, fmtPrice, todayISO, nowTimeHHMM, parseDuration, parsePlaytimeInput,
         toast, confirm, openModal, closeModal, closeAllModals,
         Autocomplete, attachDurationCalc, setupCoverPreview,
         renderStarRating, openCropModal, renderPlatformCheckboxes, getSelectedPlatforms,
         PLATFORM_OPTIONS } from './ui.js';
import { onDataChanged, getKVStats } from './sync.js';

let _user    = null;
let _nav     = null;
let _viewOnly = false; // Section 7 — read-only mode

export function init(username, navigateFn, viewOnly = false) {
  _user     = username;
  _nav      = navigateFn;
  _viewOnly = viewOnly;
}

/* ═══════════════════════════════════════════════════════
   UI CUSTOMIZATION SYSTEM
   Reads saved settings and applies CSS classes + variables
═══════════════════════════════════════════════════════ */
export function applyUICustomization(s) {
  const root = document.documentElement;
  const body = document.body;

  // Font
  const fontMap = {
    'dm-sans':  "'DM Sans', sans-serif",
    'syne':     "'Syne', sans-serif",
    'inter':    "'Inter', sans-serif",
    'manrope':  "'Manrope', sans-serif",
    'geist':    "'Geist', sans-serif"
  };
  const fontStack = fontMap[s.ui_font] || fontMap['dm-sans'];
  root.style.setProperty('--font-body', fontStack);
  // Lazy-load font if not default
  if (s.ui_font && s.ui_font !== 'dm-sans') {
    const fontUrls = {
      syne:    'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&display=swap',
      inter:   'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
      manrope: 'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap',
      geist:   'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&display=swap'
    };
    if (fontUrls[s.ui_font] && !document.querySelector(`link[href*="${s.ui_font}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = fontUrls[s.ui_font];
      document.head.appendChild(link);
    }
  }

  // Card style
  body.classList.remove('card-glass','card-solid','card-minimal','card-neon');
  if (s.ui_card_style === 'solid')   body.classList.add('card-solid');
  else if (s.ui_card_style === 'minimal') body.classList.add('card-minimal');
  else if (s.ui_card_style === 'neon')    body.classList.add('card-neon');
  else                               body.classList.add('card-glass');

  // Background
  const bgMap = {
    default: ['#0a0a0d','#111116','rgba(16,16,22,0.75)'],
    nebula:  ['#0d0a14','#140f20','rgba(16,12,28,0.75)'],
    ocean:   ['#080d12','#0a1420','rgba(10,16,24,0.75)'],
    forest:  ['#080d09','#0a1410','rgba(10,16,12,0.75)'],
    pure:    ['#000000','#080808','rgba(8,8,8,0.82)'],
    noise:   ['#0a0a0d','#111116','rgba(16,16,22,0.75)']
  };
  const bgs = bgMap[s.ui_bg_style] || bgMap.default;
  root.style.setProperty('--bg',  bgs[0]);
  root.style.setProperty('--bg2', bgs[1]);
  root.style.setProperty('--bg-glass', bgs[2]);
  body.classList.remove('bg-default','bg-nebula','bg-ocean','bg-forest','bg-pure','bg-noise');
  body.classList.add(`bg-${s.ui_bg_style || 'default'}`);

  // Density
  body.classList.remove('density-compact','density-balanced','density-spacious');
  body.classList.add(`density-${s.ui_density || 'balanced'}`);

  // Poster size
  const posterMap = { small:'130px', medium:'160px', large:'200px', xl:'240px' };
  root.style.setProperty('--poster-size', posterMap[s.ui_poster_size] || '160px');

  // Shadow
  const shadowMap = {
    none:   '0 0 0 rgba(0,0,0,0)',
    soft:   '0 2px 12px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)',
    medium: '0 4px 20px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)',
    deep:   '0 8px 40px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.5)'
  };
  root.style.setProperty('--shadow', shadowMap[s.ui_shadow] || shadowMap.medium);

  // Animations
  const animsOn = s.ui_anims !== 'false';
  body.classList.toggle('reduce-motion', !animsOn);

  // Animation speed
  const speedMap = { fast:'80ms', normal:'150ms', slow:'260ms' };
  root.style.setProperty('--ui-anim', speedMap[s.ui_anim_speed] || '150ms');
}

export async function loadAndApplyUISettings(username) {
  const s = await DB.getAllSettings(username);
  applyUICustomization(s);
}

function main() { return document.getElementById('app'); }

/* ── Library state — persists across game detail views ── */
// Section 2: scroll + filter restoration
// Section 3: ordered game list for prev/next navigation
const _libState = {
  scrollY:    0,
  filter:     'all',
  sortBy:     null,
  query:      '',
  orderedIds: [],
};

// Called by app.js navigate() before leaving a game page
export function saveLibraryScroll(y) { _libState.scrollY = y; }

/* ── Section 13: Auto-status change ─────────────────
   If enabled in settings, games with status 'playing' that have
   had no session logged in the last 30 days are changed to 'played'.
   Guard: only runs if the user has at least 5 sessions total AND has
   been logging for at least 14 days — avoids false-positives for new users. */
async function _autoStatusCheck() {
  try {
    const settings = await DB.getAllSettings(_user);
    if (settings.auto_status_inactive !== 'true') return;

    const sessions = await DB.getSessions(_user);
    if (sessions.length < 5) return; // not enough history

    // Earliest session date — must be logging for at least 14 days
    const earliest = sessions.map(s => s.date).sort()[0];
    if (!earliest) return;
    const daysSinceFirst = (Date.now() - new Date(earliest)) / 86400000;
    if (daysSinceFirst < 14) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffISO = cutoff.toISOString().slice(0, 10);

    // Build a map: game_id → latest session date
    const latestByGame = {};
    for (const s of sessions) {
      if (!latestByGame[s.game_id] || s.date > latestByGame[s.game_id]) {
        latestByGame[s.game_id] = s.date;
      }
    }

    const games = await DB.getGames(_user);
    let changed = 0;
    for (const g of games) {
      if (normStatus(g.status) !== 'playing') continue;
      const last = latestByGame[g.id];
      if (!last || last < cutoffISO) {
        await DB.putGame(_user, { ...g, status: 'played', updatedAt: new Date().toISOString() });
        changed++;
      }
    }
    if (changed > 0) {
      await onDataChanged();
      toast(`${changed} game${changed!==1?'s':''} moved from Playing → Played (inactive 30+ days)`, 'info');
    }
  } catch(e) { /* silently ignore */ }
}

/* ── Section 12: High-res cover URL for favourites ─── */
function hiResCover(game) {
  const url = game.cover_url || '';
  // IGDB: upgrade t_cover_big → t_cover_big_2x
  if (url.includes('images.igdb.com') && url.includes('t_cover_big/')) {
    return url.replace('t_cover_big/', 't_cover_big_2x/');
  }
  // Steam: library_600x900.jpg is already high-res; try _2x variant, fall back to original
  if (url.includes('cdn.cloudflare.steamstatic.com') && url.includes('library_600x900.jpg')) {
    return url; // Steam 600x900 is already crisp at typical display sizes
  }
  return url;
}

/* ── Status helpers ───────────────────────────────── */
// Section 1: 'played' added, 'completed' label restored, backwards compat for old label
const ALL_STATUSES = ['playing','played','completed','100%','backlog','paused','dropped'];

const STATUS_LABELS = {
  'playing':   'Playing',
  'played':    'Played',
  'completed': 'Completed',
  '100%':      '100% Completed',    // Section 8: removed 💯 emoji
  'backlog':   'Backlog',
  'paused':    'Paused',
  'dropped':   'Dropped',
};

// Section 6: migrate legacy 'no-ending' status to 'played'
function normStatus(s) {
  if (!s) return 'backlog';
  if (s === 'no-ending' || s === 'Game has no ending') return 'played';
  if (s === 'Completed your main goal') return 'completed';
  return s;
}

function statusLabel(status) {
  const s = normStatus(status);
  return STATUS_LABELS[s] || s;
}

function statusBadge(status) {
  const s   = normStatus(status);
  const cls = s === '100%' ? 'badge-100' : `badge-${s}`;
  return `<span class="badge ${cls}">${statusLabel(status)}</span>`;
}

function completionIcon(status) {
  const s = normStatus(status);
  if (s === '100%')      return '✔';
  if (s === 'completed') return '✅';
  if (s === 'played')    return '🎮';
  return '';
}

/* ═══════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════ */
export async function renderDashboard() {
  // Section 13: auto-change stale "playing" games to "played" (if setting enabled)
  await _autoStatusCheck();

  const games    = await DB.getGames(_user);
  const sessions = await DB.getSessions(_user);
  const lib      = games.filter(g => g.status !== 'wishlist');
  const total_hours  = lib.reduce((t,g) => t+(Number(g.total_hours)||0), 0);
  const completed    = lib.filter(g => g.status==='completed'||g.status==='100%').length;
  const perfect      = lib.filter(g => g.status==='100%').length;
  const playing_now  = lib.filter(g => g.status==='playing').length;

  const recent_sessions = sessions
    .sort((a,b) => (b.date+'T'+b.start_time).localeCompare(a.date+'T'+a.start_time))
    .slice(0,10)
    .map(s => ({ ...s, game: games.find(g=>g.id===s.game_id) }));

  const most_played      = [...lib].sort((a,b)=>(Number(b.total_hours)||0)-(Number(a.total_hours)||0)).slice(0,6);
  const recently_played  = lib.filter(g=>g.last_played).sort((a,b)=>b.last_played.localeCompare(a.last_played)).slice(0,6);

  main().innerHTML = `
    <div class="stat-tiles">
      <div class="stat-tile"><div class="stat-tile-val">${fmtHours(total_hours)}</div><div class="stat-tile-label">Total hours played</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${lib.length}</div><div class="stat-tile-label">Games in library</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${completed}</div><div class="stat-tile-label">Completed</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${perfect > 0 ? `<span style="color:var(--gold)">💯 ${perfect}</span>` : playing_now}</div><div class="stat-tile-label">${perfect > 0 ? '100% Completed' : 'Playing now'}</div></div>
    </div>

    ${recently_played.length ? `
    <div class="card mb-lg">
      <div class="card-head"><h3>Recently Played</h3></div>
      <div class="card-body">
        <div class="cover-row">
          ${recently_played.map(g => `
            <div class="cover-row-item" data-nav="game/${g.id}">
              ${g.cover_url
                ? `<img src="${h(g.cover_url)}" class="cover-row-img" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="cover-row-ph" style="display:none">${h((g.title||'').slice(0,2).toUpperCase())}</div>`
                : `<div class="cover-row-ph">${h((g.title||'').slice(0,2).toUpperCase())}</div>`}
              <div class="cover-row-title">${h(g.title)}</div>
              ${completionIcon(g.status)?`<div class="cover-completion-badge">${completionIcon(g.status)}</div>`:''}
            </div>`).join('')}
        </div>
      </div>
    </div>` : ''}

    ${recent_sessions.length ? `
    <div class="card mb-lg">
      <div class="card-head"><h3>Recent Sessions</h3><button class="btn-xs" data-nav="log">View all</button></div>
      <div class="card-body">
        ${recent_sessions.map(s => `
          <div class="log-session-card">
            <div class="log-session-game" data-nav="game/${s.game_id}">${h(s.game?.title||'Unknown')}</div>
            <span class="log-session-time">${h(s.date)} ${h(s.start_time)}–${h(s.end_time)}</span>
            <span class="log-session-dur">${fmtHours(s.duration)}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}

    ${most_played.length ? `
    <div class="card">
      <div class="card-head"><h3>Most Played</h3></div>
      <div class="card-body">
        <div class="stat-bar-row">
          ${most_played.map(g => {
            const max = Number(most_played[0].total_hours)||1;
            const pct = Math.round(((Number(g.total_hours)||0)/max)*100);
            return `<div class="bar-item">
              <span class="bar-label" data-nav="game/${g.id}" style="cursor:pointer">${h(g.title)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-val">${fmtHours(g.total_hours)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>` : `
    <div class="empty-state">
      <div class="empty-icon">🎮</div>
      <h3>Your journal is empty</h3>
      <p>Add your first game to get started.</p>
      <button class="btn-primary mt-md" data-nav="add">Add a Game</button>
    </div>`}`;

  setTimeout(() => {
    document.querySelectorAll('.bar-fill').forEach(b => {
      const w = b.style.width; b.style.width='0'; b.style.transition='none';
      requestAnimationFrame(() => requestAnimationFrame(() => { b.style.transition='width .9s cubic-bezier(.4,0,.2,1)'; b.style.width=w; }));
    });
  }, 80);
}

/* ═══════════════════════════════════════════════════
   LIBRARY
═══════════════════════════════════════════════════ */
export async function renderLibrary(restoreState = false) {
  const games = (await DB.getGames(_user)).filter(g=>g.status!=='wishlist');

  // Section 2: restore or init filter/sort state
  const savedSort = localStorage.getItem(`gt_lib_sort_${_user}`) || 'title';
  if (!restoreState) {
    _libState.filter  = 'all';
    _libState.query   = '';
    _libState.sortBy  = savedSort;
    _libState.scrollY = 0;
  }
  let filter = _libState.filter;
  let sortBy = _libState.sortBy || savedSort;
  let query  = _libState.query;

  main().innerHTML = `
    <div class="page-header">
      <h1>Library</h1>
      <button class="btn-primary" data-nav="add">+ Add Game</button>
    </div>
    <div class="filter-bar">
      ${['all',...ALL_STATUSES,'🔁replay'].map(s=>{
        const isReplay = s==='🔁replay';
        const label = isReplay ? '🔁 Replay' : (s==='all'?'All':statusLabel(s));
        const active = isReplay ? filter==='🔁replay' : s===filter;
        return `<button class="filter-pill${active?' active':''}" data-status="${s}">${label}</button>`;
      }).join('')}
      <input type="search" class="input filter-search" id="libSearch" placeholder="Search…" value="${h(query)}">
      <select class="input" id="libSort" style="max-width:160px">
        <option value="title">A–Z</option>
        <option value="hours">Most played</option>
        <option value="recent">Recently played</option>
        <option value="your_rating">Your Rating</option>
        <option value="igdb_rating">IGDB Rating</option>
        <option value="added">Date added</option>
        <option value="replay">Want to Replay</option>
      </select>
    </div>
    <div class="game-grid" id="gameGrid"></div>`;

  const sortSelect = document.getElementById('libSort');
  if (sortSelect) sortSelect.value = sortBy;

  function sortGames(arr) {
    return [...arr].sort((a,b)=>{
      if (sortBy==='hours')       return (Number(b.total_hours)||0)-(Number(a.total_hours)||0);
      if (sortBy==='recent')      return (b.last_played||'').localeCompare(a.last_played||'');
      if (sortBy==='rating')      return (Number(b.rating)||0)-(Number(a.rating)||0);       // legacy key compat
      if (sortBy==='your_rating') return (Number(b.rating)||0)-(Number(a.rating)||0);
      if (sortBy==='igdb_rating') return (Number(b.igdb_rating)||0)-(Number(a.igdb_rating)||0);
      if (sortBy==='added')       return (b.date_added||'').localeCompare(a.date_added||'');
      if (sortBy==='replay')      return (b.want_to_replay?1:0)-(a.want_to_replay?1:0);
      return (a.title||'').localeCompare(b.title||'');
    });
  }

  function render() {
    let list = games;
    if (filter==='🔁replay') {
      list = list.filter(g=>g.want_to_replay);
    } else if (filter!=='all') {
      list = list.filter(g=>normStatus(g.status)===filter);
    }
    if (query) list = list.filter(g=>(g.title||'').toLowerCase().includes(query.toLowerCase()));
    list = sortGames(list);

    // Section 3: keep ordered ids in sync for prev/next navigation
    _libState.orderedIds = list.map(g => g.id);

    const grid = document.getElementById('gameGrid');
    if (!list.length) {
      grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><h3>No games found</h3><p>Try a different filter.</p></div>`;
      return;
    }
    grid.innerHTML = list.map(g => {
      const titleAbbr = h((g.title||'??').slice(0,2).toUpperCase());
      const coverHtml = g.cover_url
        ? `<img src="${h(g.cover_url)}" class="game-card-poster" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="game-card-ph" style="display:none">${titleAbbr}</div>`
        : `<div class="game-card-ph">${titleAbbr}</div>`;
      return `
      <div class="game-card" data-nav="game/${g.id}">
        ${coverHtml}
        <div class="game-card-badges">
          ${statusBadge(g.status)}
          ${g.via_subscription?'<span class="sub-badge">📦 Sub</span>':''}
        </div>
        ${g.status==='100%'?'<div class="card-100-badge">💯</div>':''}
        <div class="game-card-info">
          <div class="game-card-title">${h(g.title||'Unknown')}</div>
          <div class="game-card-meta">${fmtHours(g.total_hours)}${g.rating?` · ${fmtStars(g.rating)}`:''}</div>
          ${g.want_to_replay?'<div class="replay-badge">🔁 Replay</div>':''}
        </div>
      </div>`;
    }).join('');
  }

  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.status;
      _libState.filter = filter;
      render();
    });
  });
  document.getElementById('libSearch').addEventListener('input', e => {
    query = e.target.value;
    _libState.query = query;
    render();
  });
  document.getElementById('libSort').addEventListener('change', e => {
    sortBy = e.target.value;
    _libState.sortBy = sortBy;
    localStorage.setItem(`gt_lib_sort_${_user}`, sortBy);
    render();
  });

  render();

  // ── Section 3: Scroll restoration ──────────────────────────────────────────
  // Save scroll on mousedown (fires before navigate clears the page).
  // Using mousedown instead of click prevents the scroll position being
  // overwritten by the new page's scrollY=0 during the click event bubble.
  document.getElementById('gameGrid')?.addEventListener('mousedown', () => {
    _libState.scrollY = window.scrollY;
  }, { passive: true });
  // Also save on touchstart for mobile
  document.getElementById('gameGrid')?.addEventListener('touchstart', () => {
    _libState.scrollY = window.scrollY;
  }, { passive: true });

  if (restoreState && _libState.scrollY > 0) {
    const targetY = _libState.scrollY;
    // Use two rAF passes to ensure the browser has painted the full grid
    // before we attempt to scroll. Cards have fixed aspect-ratio so heights
    // are deterministic even with lazy images — two passes is enough.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.scrollTo({ top: targetY, behavior: 'instant' });
    }));
  }
}
/* ═══════════════════════════════════════════════════
   GAME DETAIL
═══════════════════════════════════════════════════ */
export async function renderGameDetail(id) {
  const game = await DB.getGame(_user, id);
  if (!game) { _nav('library'); return; }
  const sessions = (await DB.getSessions(_user)).filter(s=>s.game_id===id)
    .sort((a,b)=>(b.date+'T'+b.start_time).localeCompare(a.date+'T'+a.start_time));

  const coverAlts = game.cover_alts || (game.cover_url ? [game.cover_url] : []);

  // Section 2: save scroll before we left the library
  // (already saved when navigating away from library in app.js navigate())

  // Section 3: prev/next from ordered library list
  const orderedIds = _libState.orderedIds;
  const currentIdx = orderedIds.indexOf(id);
  const prevId     = currentIdx > 0 ? orderedIds[currentIdx - 1] : null;
  const nextId     = currentIdx >= 0 && currentIdx < orderedIds.length - 1 ? orderedIds[currentIdx + 1] : null;

  // Section 5: average rating display (stored as igdb_rating on game)
  const avgRating = game.igdb_rating ? (game.igdb_rating / 20).toFixed(1) : null; // IGDB is 0-100 → 0-5

  main().innerHTML = `
    <!-- Back button + Prev/Next nav -->
    <div class="game-nav-bar">
      <button class="btn-outline game-nav-back" id="backToLibraryBtn">← Back to Library</button>
      <div class="game-nav-arrows">
        <button class="btn-outline game-nav-arrow${prevId?'':' disabled'}" id="prevGameBtn" title="Previous game (Q)" ${prevId?'':'disabled'}>‹ Prev</button>
        <span class="game-nav-position">${currentIdx >= 0 ? `${currentIdx+1} / ${orderedIds.length}` : ''}</span>
        <button class="btn-outline game-nav-arrow${nextId?'':' disabled'}" id="nextGameBtn" title="Next game (E)" ${nextId?'':'disabled'}>Next ›</button>
      </div>
    </div>

    <div class="game-hero">
      <div class="game-hero-cover-col">
        <div class="game-hero-cover-wrap">
          ${game.cover_url
            ? `<img src="${h(game.cover_url)}" class="game-hero-cover" id="heroCover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="game-hero-cover-ph" style="display:none">${h((game.title||'').slice(0,2).toUpperCase())}</div>`
            : `<div class="game-hero-cover-ph">${h((game.title||'').slice(0,2).toUpperCase())}</div>`}
          ${coverAlts.length > 1 ? `<button class="cover-change-btn" id="changeCoverBtn" title="Change poster">🖼</button>` : ''}
        </div>

        <!-- Ratings + HLTB block below poster -->
        <div class="game-ratings-block">
          <div class="game-hours-display">⏱ ${fmtHours(game.total_hours)}</div>
          ${game.rating ? `
          <div class="game-rating-row">
            <span class="game-rating-label">Your Rating</span>
            <span class="game-rating-stars">${fmtStars(game.rating)}</span>
            <span class="game-rating-num">${game.rating} / 5</span>
          </div>` : ''}
          ${avgRating ? `
          <div class="game-rating-row game-rating-row-avg">
            <span class="game-rating-label">IGDB Avg</span>
            <span class="game-rating-stars">${fmtStars(avgRating)}</span>
            <span class="game-rating-num">${avgRating} / 5</span>
          </div>` : ''}
        </div>
        <!-- Crop poster button — always visible -->
        <button class="cover-crop-btn" id="cropCoverBtn">✂&nbsp; Crop / Reframe Poster</button>

        <!-- Section 1: Time to Beat — loaded async after render -->
        <div class="hltb-block" id="hltbBlock" style="display:none">
          <div class="hltb-title">⏳ Time to Beat</div>
          <div class="hltb-rows" id="hltbRows"></div>
        </div>
      </div>

      <div class="game-hero-meta">
        <h1>${h(game.title)}</h1>
        <div class="game-meta-row">
          ${statusBadge(game.status)}
          ${game.want_to_replay?'<span class="badge badge-replay">🔁 Replay</span>':''}
          ${game.via_subscription?'<span class="sub-badge">📦 Played via Subscription</span>':''}
          ${game.platform||game.platforms?`<span class="game-meta-item">📱 ${h(game.platforms||game.platform)}</span>`:''}
          ${game.release_year?`<span class="game-meta-item">📅 ${h(game.release_year)}</span>`:''}
          ${game.developer?`<span class="game-meta-item">🛠 ${h(game.developer)}</span>`:''}
          ${game.genre?`<span class="game-meta-item">🎭 ${h(game.genre)}</span>`:''}
        </div>
        ${game.description?`<p class="game-desc">${h(game.description)}</p>`:''}
        <div class="game-meta-row" style="margin-top:.5rem">
          ${game.date_completed?`<span class="game-meta-item">✅ Completed ${fmtDate(game.date_completed)}</span>`:''}
          ${game.progress_pct!=null&&game.status==='paused'?`<span class="game-meta-item">⏸ Progress: <strong>${game.progress_pct}%</strong></span>`:''}
        </div>
        ${game.review?`<blockquote class="game-review-block">${h(game.review)}</blockquote>`:''}
        <div class="game-actions">
          <button class="btn-primary" data-nav="game/${id}/edit">Edit Game</button>
          <button class="btn-outline" id="addSessionBtn">+ Log Session</button>
          ${normStatus(game.status)!=='completed'&&normStatus(game.status)!=='100%'
            ? `<button class="btn-outline" id="markCompleteBtn">Mark Complete</button>`:''}
          <button class="btn-xs btn-xs-danger" id="deleteGameBtn">Delete</button>
        </div>
      </div>
    </div>

    <!-- Cover picker modal -->
    ${coverAlts.length > 1 ? `
    <div class="modal-overlay" id="coverModal">
      <div class="modal modal-lg">
        <div class="modal-head"><h3>Choose Poster</h3><button class="modal-close" id="closeCoverModal">×</button></div>
        <div class="cover-picker-grid">
          ${coverAlts.map((url,i)=>`
            <div class="cover-pick-item${url===game.cover_url?' selected':''}" data-cover-url="${h(url)}">
              <img src="${h(url)}" loading="lazy" onerror="this.parentElement.style.display='none'">
              ${url===game.cover_url?'<div class="cover-pick-check">✓</div>':''}
            </div>`).join('')}
        </div>
      </div>
    </div>` : ''}

    <!-- Log session modal — Section 5/9: end time defaults to now, playtime shortcut -->
    <div class="modal-overlay" id="sessionModal">
      <div class="modal">
        <div class="modal-head"><h3>Log Session</h3><button class="modal-close" id="closeSessionModal">×</button></div>
        <form id="sessionForm">
          <div class="two-col mb-md">
            <div class="form-group"><label>Date</label><input type="date" name="date" class="input" value="${todayISO()}" required></div>
            <div class="form-group">
              <label>How long did you play?</label>
              <input type="text" id="playtimeShortcut" class="input" placeholder="e.g. 2h 30m or 1.5h">
              <span class="duration-hint" id="playtimeHint"></span>
            </div>
          </div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Start time <span style="font-size:.7rem;color:var(--text3)">(auto-calculated)</span></label><input type="time" name="start_time" class="input"></div>
            <div class="form-group"><label>End time <span style="font-size:.7rem;color:var(--accent)">(defaults to now)</span></label><input type="time" name="end_time" class="input"></div>
          </div>
          <div class="form-group mb-md"><label>Notes</label><input type="text" name="notes" class="input" placeholder="Optional notes…"></div>
          <div class="modal-actions">
            <button type="button" class="btn-outline" id="cancelSession">Cancel</button>
            <button type="submit" class="btn-primary">Log</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Mark complete modal -->
    <div class="modal-overlay" id="completeModal">
      <div class="modal">
        <div class="modal-head"><h3>Mark as Completed</h3><button class="modal-close" id="closeCompleteModal">×</button></div>
        <form id="completeForm">
          <div class="form-group mb-md">
            <label>Completion type</label>
            <div class="complete-type-group">
              <label class="complete-type-opt">
                <input type="radio" name="completion_type" value="completed" checked>
                <span>✅ Completed your main goal</span>
              </label>
              <label class="complete-type-opt">
                <input type="radio" name="completion_type" value="100%">
                <span>💯 100% Completed</span>
              </label>
              <label class="complete-type-opt">
                
                <span>♾️ Game has no ending</span>
              </label>
            </div>
          </div>
          <div class="form-group mb-md"><label>Rating (0.5–5)</label><input type="number" name="rating" class="input" min=".5" max="5" step=".5" placeholder="e.g. 4.5"></div>
          <div class="form-group mb-md"><label>Review</label><textarea name="review" class="input" rows="3" placeholder="Your thoughts…"></textarea></div>
          <div class="form-group mb-md"><label>Date completed</label><input type="date" name="date_completed" class="input" value="${todayISO()}"></div>
          <div class="modal-actions">
            <button type="button" class="btn-outline" id="cancelComplete">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Sessions list -->
    <div class="card mt-lg">
      <div class="card-head"><h3>Play Sessions (${sessions.length})</h3></div>
      <div class="card-body" id="sessionsList">
        ${sessions.length ? `
        <table class="session-table">
          <thead><tr><th>Date</th><th>Time</th><th>Duration</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            ${sessions.map(s=>`
            <tr>
              <td>${h(s.date)}</td>
              <td class="log-time">${h(s.start_time)}–${h(s.end_time)}</td>
              <td><span style="font-family:var(--font-mono);color:var(--accent)">${fmtHours(s.duration)}</span></td>
              <td style="color:var(--text2);font-size:.82rem">${h(s.notes||'')}</td>
              <td><button class="btn-xs btn-xs-danger" data-delete-session="${s.id}">×</button></td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<p style="color:var(--text3);font-size:.9rem">No sessions logged yet.</p>'}
      </div>
    </div>`;

  // Crop poster button — fully self-contained, no external helper needed
  document.getElementById('cropCoverBtn').addEventListener('click', async () => {
    // Find the current cover image element
    const imgEl = document.getElementById('heroCover');
    if (!imgEl || imgEl.style.display === 'none') {
      toast('No poster to crop — add a cover image first', 'error');
      return;
    }

    // Get image src — works for data URLs and http URLs
    const src = imgEl.src;
    if (!src || src === window.location.href) {
      toast('No poster loaded', 'error');
      return;
    }

    // Convert any image to a data URL for the crop canvas.
    // Key insight: the <img> element already has the pixels loaded in the browser.
    // Drawing it to a canvas works even for IGDB/Steam URLs that block fetch() via CORS,
    // because same-origin canvas tainting only matters if we try to *read* pixels from
    // a canvas that had a cross-origin image drawn WITHOUT crossOrigin attribute set.
    // The already-displayed imgEl has no crossOrigin attr, so we just draw it directly.
    function getDataUrlFromImgEl(el) {
      return new Promise((resolve, reject) => {
        const c = document.createElement('canvas');
        c.width  = el.naturalWidth  || el.width  || 400;
        c.height = el.naturalHeight || el.height || 600;
        // Wait for image to be fully decoded
        if (el.complete && el.naturalWidth > 0) {
          try {
            c.getContext('2d').drawImage(el, 0, 0);
            resolve(c.toDataURL('image/jpeg', 0.95));
          } catch (e) {
            reject(e);
          }
        } else {
          el.onload = () => {
            try {
              c.getContext('2d').drawImage(el, 0, 0);
              resolve(c.toDataURL('image/jpeg', 0.95));
            } catch (e) { reject(e); }
          };
          el.onerror = () => reject(new Error('Image failed to load'));
        }
      });
    }

    let cropSrc;
    try {
      if (src.startsWith('data:')) {
        cropSrc = src; // already a data URL, use directly
      } else {
        // Draw the already-displayed <img> to canvas — bypasses CORS for display-only images
        cropSrc = await getDataUrlFromImgEl(imgEl);
      }
    } catch (e) {
      toast('Could not prepare poster for cropping: ' + e.message, 'error');
      return;
    }

    // Build the crop modal inline — no import needed
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(8px)';
    overlay.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius-xl);padding:1.5rem;max-width:500px;width:100%;box-shadow:var(--shadow-lg)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
          <h3 style="font-size:1rem;font-weight:600">✂ Crop Poster <span style="font-size:.75rem;color:var(--text3);font-weight:400">— drag to reposition</span></h3>
          <button id="cropClose" style="background:none;border:none;color:var(--text3);font-size:1.4rem;cursor:pointer;line-height:1;padding:.2rem">×</button>
        </div>
        <div id="cropFrame" style="position:relative;width:100%;height:360px;background:#000;overflow:hidden;cursor:grab;border-radius:var(--radius);user-select:none">
          <img id="cropImg" src="${cropSrc}" draggable="false" style="position:absolute;top:0;left:0;max-width:none;max-height:none;transform-origin:0 0">
          <div id="cropGuide" style="position:absolute;top:50%;left:50%;width:160px;height:240px;transform:translate(-50%,-50%);border:2px solid var(--accent);box-shadow:0 0 0 9999px rgba(0,0,0,.6);pointer-events:none;border-radius:4px"></div>
        </div>
        <div style="display:flex;align-items:center;gap:.75rem;margin:.85rem 0">
          <span style="font-size:.78rem;color:var(--text2);min-width:2.5rem">Zoom</span>
          <input type="range" id="cropZoom" min="0.5" max="4" step="0.05" value="1" style="flex:1;accent-color:var(--accent)">
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button id="cropCancel" class="btn-outline">Cancel</button>
          <button id="cropConfirm" class="btn-primary">Use Cropped Poster</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const img   = overlay.querySelector('#cropImg');
    const frame = overlay.querySelector('#cropFrame');
    const guide = overlay.querySelector('#cropGuide');
    const zoom  = overlay.querySelector('#cropZoom');

    let scale = 1, ox = 0, oy = 0, dragging = false, startX = 0, startY = 0;

    function clamp() {
      const fw = frame.offsetWidth, fh = frame.offsetHeight;
      const iw = img.naturalWidth * scale, ih = img.naturalHeight * scale;
      // If image smaller than frame, allow it to float freely (don't clamp to edges)
      if (iw <= fw) {
        // centre horizontally, allow slight drag
        ox = Math.max(-(iw * 0.1), Math.min(fw - iw * 0.9, ox));
      } else {
        ox = Math.min(0, Math.max(fw - iw, ox));
      }
      if (ih <= fh) {
        oy = Math.max(-(ih * 0.1), Math.min(fh - ih * 0.9, oy));
      } else {
        oy = Math.min(0, Math.max(fh - ih, oy));
      }
    }
    function applyTransform() {
      img.style.transform = `translate(${ox}px,${oy}px) scale(${scale})`;
    }

    // Auto-fit: scale image so it fills the frame comfortably (whole image visible)
    // Then the user zooms in to crop — intuitive and not zoomed-in by default
    function initCrop() {
      const fw = frame.offsetWidth, fh = frame.offsetHeight;
      const iw = img.naturalWidth,  ih = img.naturalHeight;
      if (!iw || !ih) return;

      // Fit the whole image inside the frame with a small margin
      const fitScale = Math.min((fw * 0.95) / iw, (fh * 0.95) / ih);
      scale = fitScale;

      // Zoom range: from fit-view down to 50% fit, up to 4x fit
      zoom.min   = (fitScale * 0.5).toFixed(3);
      zoom.max   = (fitScale * 4.0).toFixed(3);
      zoom.step  = (fitScale * 0.05).toFixed(4);
      zoom.value = scale.toFixed(3);

      // Centre the image in the frame
      ox = (fw - iw * scale) / 2;
      oy = (fh - ih * scale) / 2;
      applyTransform(); // don't clamp on init so image is centred even if smaller than frame
    }

    img.onload = () => initCrop();
    // If image is already loaded (data URL sets src synchronously), call immediately
    if (img.complete && img.naturalWidth > 0) initCrop();

    zoom.addEventListener('input', () => { scale = parseFloat(zoom.value); clamp(); applyTransform(); });

    frame.addEventListener('mousedown',  e => { dragging=true; startX=e.clientX-ox; startY=e.clientY-oy; frame.style.cursor='grabbing'; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!dragging) return; ox=e.clientX-startX; oy=e.clientY-startY; clamp(); applyTransform(); });
    document.addEventListener('mouseup',   () => { dragging=false; frame.style.cursor='grab'; });
    frame.addEventListener('touchstart', e => { dragging=true; startX=e.touches[0].clientX-ox; startY=e.touches[0].clientY-oy; }, {passive:true});
    frame.addEventListener('touchmove',  e => { if (!dragging) return; ox=e.touches[0].clientX-startX; oy=e.touches[0].clientY-startY; clamp(); applyTransform(); e.preventDefault(); }, {passive:false});
    frame.addEventListener('touchend',   () => dragging=false);

    const cleanup = () => { overlay.remove(); };
    overlay.querySelector('#cropClose').onclick  = cleanup;
    overlay.querySelector('#cropCancel').onclick = cleanup;

    overlay.querySelector('#cropConfirm').onclick = async () => {
      // Crop to the guide rectangle
      const gRect = guide.getBoundingClientRect();
      const fRect = frame.getBoundingClientRect();
      const gx = (gRect.left - fRect.left - ox) / scale;
      const gy = (gRect.top  - fRect.top  - oy) / scale;
      const gw = gRect.width  / scale;
      const gh = gRect.height / scale;

      const OUT_W = 400, OUT_H = 600;
      const canvas = document.createElement('canvas');
      canvas.width = OUT_W; canvas.height = OUT_H;
      canvas.getContext('2d').drawImage(img, gx, gy, gw, gh, 0, 0, OUT_W, OUT_H);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

      game.cover_url = dataUrl;
      await DB.putGame(_user, game);
      await onDataChanged();
      imgEl.src = dataUrl;

      // Update all thumbnails of this game on the page
      document.querySelectorAll(`[data-game-id="${game.id}"] img`).forEach(i => i.src = dataUrl);

      cleanup();
      toast('Poster cropped & saved!', 'success');
    };
  });

  // Cover picker
  document.getElementById('changeCoverBtn')?.addEventListener('click', () => openModal('coverModal'));
  document.getElementById('closeCoverModal')?.addEventListener('click', () => closeModal('coverModal'));
  document.getElementById('coverModal')?.addEventListener('click', async e => {
    const item = e.target.closest('.cover-pick-item');
    if (!item) return;
    const url = item.dataset.coverUrl;
    game.cover_url = url;
    await DB.putGame(_user, game);
    await onDataChanged();
    toast('Poster updated!','success');
    closeModal('coverModal');
    document.getElementById('heroCover').src = url;
    document.querySelectorAll('.cover-pick-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.coverUrl === url);
    });
  });

  // Section 2: Back to library — restore scroll + filter state
  document.getElementById('backToLibraryBtn').addEventListener('click', () => {
    _nav('library:restore');
  });

  // Time to Beat: Fetch from IGDB asynchronously — never blocks render
  (async () => {
    const block = document.getElementById('hltbBlock');
    const rows  = document.getElementById('hltbRows');
    if (!block || !rows) return;

    const devMode = localStorage.getItem('ll_dev_mode') === '1';
    const devLogs = [];
    const devLog  = devMode ? msg => devLogs.push(msg) : null;

    const settings = await DB.getAllSettings(_user);
    const hasIGDB  = !!(settings.igdb_client_id && settings.igdb_client_secret);

    block.style.display = 'block';

    if (!hasIGDB) {
      rows.innerHTML = '<div class="hltb-no-data">Set IGDB credentials in Settings to enable time-to-beat data</div>';
      return;
    }

    rows.innerHTML = '<div class="hltb-loading">Looking up…</div>';

    try {
      const ttb  = await fetchTimeToBeat(game, settings, { devLog });
      const fmtH = v => v ? `${v}h` : '—';

      if (!ttb || (!ttb.hastily && !ttb.normally && !ttb.completely)) {
        rows.innerHTML = '<div class="hltb-no-data">No time-to-beat data on IGDB for this game</div>';
        if (devMode && devLogs.length) {
          rows.innerHTML += `<details class="hltb-dev-log"><summary>Debug log (${devLogs.length})</summary><pre>${devLogs.map(l=>h(l)).join('\n')}</pre></details>`;
        }
        return;
      }

      const rowsHtml = [
        ttb.hastily    != null ? `<div class="hltb-row"><span class="hltb-label">Rushed</span><span class="hltb-val">${fmtH(ttb.hastily)}</span></div>`       : '',
        ttb.normally   != null ? `<div class="hltb-row"><span class="hltb-label">Normally</span><span class="hltb-val">${fmtH(ttb.normally)}</span></div>`     : '',
        ttb.completely != null ? `<div class="hltb-row"><span class="hltb-label">Completionist</span><span class="hltb-val">${fmtH(ttb.completely)}</span></div>` : '',
      ].filter(Boolean).join('');

      rows.innerHTML = rowsHtml || '<div class="hltb-no-data">No completion data available</div>';
      if (devMode && devLogs.length) {
        rows.innerHTML += `<details class="hltb-dev-log"><summary>Debug log</summary><pre>${devLogs.map(l=>h(l)).join('\n')}</pre></details>`;
      }
    } catch(e) {
      rows.innerHTML = '<div class="hltb-no-data">Could not load completion data</div>';
      if (devMode) rows.innerHTML += `<div class="hltb-dev-log" style="font-size:.7rem;color:var(--red);margin-top:.3rem">Error: ${h(e.message)}</div>`;
    }
  })();

  // Section 3: Prev/next game navigation
  document.getElementById('prevGameBtn')?.addEventListener('click', () => {
    if (prevId) _nav(`game/${prevId}`);
  });
  document.getElementById('nextGameBtn')?.addEventListener('click', () => {
    if (nextId) _nav(`game/${nextId}`);
  });

  // Section 3: Keyboard shortcuts Q (prev) and E (next)
  // Store handler on element so we can remove it when navigating away
  const _keyHandler = e => {
    // Only fire when not typing in an input/textarea
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'q' || e.key === 'Q') { if (prevId) _nav(`game/${prevId}`); }
    if (e.key === 'e' || e.key === 'E') { if (nextId) _nav(`game/${nextId}`); }
  };
  document.addEventListener('keydown', _keyHandler);
  // Clean up listener when we leave this page
  const _cleanupKeyHandler = () => {
    document.removeEventListener('keydown', _keyHandler);
    window.removeEventListener('gt:navigate', _cleanupKeyHandler);
  };
  window.addEventListener('gt:navigate', _cleanupKeyHandler, { once: true });

  document.getElementById('addSessionBtn').onclick = () => {
    // Section 5/9: default end time to now when modal opens
    const endEl = document.querySelector('#sessionForm [name="end_time"]');
    if (endEl) endEl.value = nowTimeHHMM();
    openModal('sessionModal');
  };
  document.getElementById('closeSessionModal').onclick = () => closeModal('sessionModal');
  document.getElementById('cancelSession').onclick     = () => closeModal('sessionModal');

  // Section 5/9: playtime shortcut wiring
  const playtimeInput = document.getElementById('playtimeShortcut');
  const playtimeHint  = document.getElementById('playtimeHint');
  const sessionForm   = document.getElementById('sessionForm');
  if (playtimeInput) {
    playtimeInput.addEventListener('input', () => {
      const hrs = parsePlaytimeInput(playtimeInput.value);
      const endEl   = sessionForm.querySelector('[name="end_time"]');
      const startEl = sessionForm.querySelector('[name="start_time"]');
      if (hrs !== null && hrs > 0 && endEl?.value) {
        const [eh, em] = endEl.value.split(':').map(Number);
        let startMin = (eh * 60 + em) - Math.round(hrs * 60);
        if (startMin < 0) startMin += 1440;
        const sh = Math.floor(startMin / 60), sm = startMin % 60;
        startEl.value = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
        const h2 = Math.floor(hrs), m2 = Math.round((hrs - h2) * 60);
        playtimeHint.textContent = `= ${h2}h ${m2}m`;
      } else {
        playtimeHint.textContent = '';
      }
    });
  }
  document.getElementById('markCompleteBtn')?.addEventListener('click', () => openModal('completeModal'));
  const closeCompleteEl = document.getElementById('closeCompleteModal');
  if (closeCompleteEl) closeCompleteEl.onclick = () => closeModal('completeModal');
  const cancelCompleteEl = document.getElementById('cancelComplete');
  if (cancelCompleteEl) cancelCompleteEl.onclick = () => closeModal('completeModal');

  attachDurationCalc(document.getElementById('sessionForm'));

  document.getElementById('sessionForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd  = new FormData(e.target);
    const endTime = fd.get('end_time') || nowTimeHHMM();
    let startTime = fd.get('start_time');

    // Section 5/9: if playtime shortcut was used, calculate start from end
    const playtimeHrs = parsePlaytimeInput(document.getElementById('playtimeShortcut')?.value || '');
    if ((!startTime || !startTime.trim()) && playtimeHrs) {
      const [eh, em] = endTime.split(':').map(Number);
      let sm2 = (eh * 60 + em) - Math.round(playtimeHrs * 60);
      if (sm2 < 0) sm2 += 1440;
      startTime = `${String(Math.floor(sm2/60)).padStart(2,'0')}:${String(sm2%60).padStart(2,'0')}`;
    }
    if (!startTime || !startTime.trim()) { toast('Enter a start time or playtime duration', 'error'); return; }

    const dur = parseDuration(startTime, endTime);
    await DB.putSession(_user, { game_id:id, date:fd.get('date'), start_time:startTime, end_time:endTime, duration:dur, notes:fd.get('notes')||'' });
    await DB.recalcGame(_user, id);
    await onDataChanged();
    toast(`Session logged: ${fmtHours(dur)}`, 'success');
    closeAllModals();
    renderGameDetail(id);
  });

  document.getElementById('completeForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd   = new FormData(e.target);
    const type = fd.get('completion_type') || 'completed';
    const g    = await DB.getGame(_user, id);
    g.status         = type;
    g.rating         = fd.get('rating')||null;
    g.review         = fd.get('review')||'';
    g.date_completed = fd.get('date_completed')||todayISO();
    await DB.putGame(_user, g);
    await onDataChanged();
    toast(type==='100%'?'💯 100% Completed!':'Game marked as completed!', 'success');
    closeAllModals();
    renderGameDetail(id);
  });

  document.getElementById('deleteGameBtn').addEventListener('click', async () => {
    const ok = await confirm(`Delete "${game.title}"? This will also delete all sessions.`);
    if (ok) { await DB.deleteGame(_user, id); await onDataChanged(); toast(`"${game.title}" deleted`, 'info'); _nav('library'); }
  });

  document.getElementById('sessionsList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-delete-session]');
    if (!btn) return;
    const sid = btn.dataset.deleteSession;
    const ok  = await confirm('Delete this session?');
    if (ok) {
      await DB.deleteSession(_user, sid);
      await DB.recalcGame(_user, id);
      await onDataChanged();
      toast('Session deleted','info');
      renderGameDetail(id);
    }
  });
}

/* ═══════════════════════════════════════════════════
   ADD / EDIT GAME FORM
   Section 1: description autofill
   Section 2: review when adding
   Section 3: platform checkboxes
   Section 6: star rating widget
   Section 7: renamed "Total Hours in Library"
═══════════════════════════════════════════════════ */
export async function renderGameForm(id) {
  const isEdit  = !!id;
  const game    = isEdit ? await DB.getGame(_user, id) : null;
  const settings = await DB.getAllSettings(_user);

  // Section 3: get current platforms as array
  const currentPlatforms = game?.platforms || (game?.platform ? game.platform : '');

  main().innerHTML = `
    <div class="page-header">
      <h1>${isEdit ? 'Edit Game' : 'Add Game'}</h1>
      ${isEdit ? `<button class="btn-xs btn-xs-danger" id="deleteGameTopBtn">Delete</button>` : ''}
    </div>

    <div class="form-layout">
      <div class="form-left">
        <div class="autocomplete-wrap mb-md">
          <label class="form-label">Search game database</label>
          <input type="text" id="gameSearch" class="input" placeholder="Search Steam &amp; IGDB…" autocomplete="off">
          <div class="autocomplete-dropdown" id="gameAcDrop"></div>
        </div>
        <p class="search-status" id="searchStatus"></p>

        <form id="gameForm">
          <div class="two-col mb-md">
            <div class="form-group"><label>Title *</label><input type="text" name="title" class="input" value="${h(game?.title||'')}" required placeholder="Game title…"></div>
            <div class="form-group">
              <label>Status</label>
              <select name="status" class="input">
                ${ALL_STATUSES.map(s=>`<option value="${s}"${(game?.status||'backlog')===s?' selected':''}>${statusLabel(s)}</option>`).join('')}
              </select>
            </div>
          </div>

          <!-- Section 3: Platform checkboxes -->
          <div class="form-group mb-md">
            <label>Platforms owned</label>
            <div class="platform-checkboxes" id="platformCheckboxes"></div>
          </div>

          <div class="two-col mb-md">
            <div class="form-group"><label>Genre</label><input type="text" name="genre" class="input" value="${h(game?.genre||'')}" placeholder="RPG, FPS…"></div>
            <div class="form-group"><label>Release Year</label><input type="text" name="release_year" class="input" value="${h(game?.release_year||'')}" placeholder="2024"></div>
          </div>

          <!-- Section 7: Renamed to "Total Hours in Library" -->
          <div class="two-col mb-md">
            <div class="form-group">
              <label>Total Hours in Library</label>
              <input type="number" name="manual_hours" class="input" value="${game?.manual_hours||0}" min="0" step="0.5">
              <p style="font-size:.72rem;color:var(--text3);margin-top:.2rem">Your total playtime across all platforms</p>
            </div>
            <div class="form-group"><label>Developer</label><input type="text" name="developer" class="input" value="${h(game?.developer||'')}" placeholder="Studio name…"></div>
          </div>

          <div class="form-group mb-md"><label>Publisher</label><input type="text" name="publisher" class="input" value="${h(game?.publisher||'')}" placeholder="Publisher name…"></div>

          <!-- Section 1: Description (auto-filled from IGDB/Steam) -->
          <div class="form-group mb-md">
            <label>Description <span style="font-size:.72rem;color:var(--text3)">(auto-fills from search)</span></label>
            <textarea name="description" id="descriptionField" class="input" rows="3" placeholder="Auto-filled from game database, or write your own…">${h(game?.description||'')}</textarea>
          </div>

          <div class="form-group mb-md">
            <label class="checkbox-row"><input type="checkbox" name="via_subscription" ${game?.via_subscription?'checked':''}> <span>Played via subscription (Game Pass, PS Plus, etc.)</span></label>
          </div>

          <!-- Section 7: Want to Replay -->
          <div class="form-group mb-md">
            <label class="checkbox-row"><input type="checkbox" name="want_to_replay" id="wantReplayCheck" ${game?.want_to_replay?'checked':''}> <span>Want to replay</span></label>
          </div>

          <!-- Section 11: Progress (shown for Paused games) -->
          <div class="form-group mb-md" id="progressPctGroup" style="${(game?.status||'backlog')==='paused'?'':'display:none'}">
            <label>Progress <span style="font-size:.72rem;color:var(--text3)">(for paused games)</span></label>
            <div style="display:flex;align-items:center;gap:.5rem">
              <input type="number" name="progress_pct" id="progressPctInput" class="input" style="max-width:90px" min="0" max="100" value="${game?.progress_pct||''}" placeholder="0">
              <span style="color:var(--text3)">%</span>
            </div>
          </div>

          <!-- Section 2: Review — shown for both add AND edit -->
          <div class="form-group mb-md">
            <label>Review / Notes <span style="font-size:.72rem;color:var(--text3)">(optional)</span></label>
            <textarea name="review" class="input" rows="3" placeholder="Your thoughts on this game…">${h(game?.review||'')}</textarea>
          </div>

          ${isEdit ? `
          <div class="two-col mb-md">
            <div class="form-group">
              <label>Rating</label>
              <div class="star-rating-widget" id="starRatingWidget"></div>
              <input type="hidden" name="rating" id="ratingHidden" value="${h(game?.rating||'')}">
            </div>
            <div class="form-group"><label>Date Completed</label><input type="date" name="date_completed" class="input" value="${h(game?.date_completed||'')}"></div>
          </div>` : `
          <div class="form-group mb-md">
            <label>Rating <span style="font-size:.72rem;color:var(--text3)">(optional)</span></label>
            <div class="star-rating-widget" id="starRatingWidget"></div>
            <input type="hidden" name="rating" id="ratingHidden" value="">
          </div>`}

          <div class="modal-actions" style="margin-top:1.5rem">
            <button type="button" class="btn-outline" onclick="history.back()">Cancel</button>
            <button type="submit" class="btn-primary">${isEdit ? 'Save Changes' : 'Add to Library'}</button>
          </div>
        </form>
      </div>

      <div class="form-right">
        <label class="form-label">Cover / Poster</label>
        <div class="cover-preview" id="coverPreview">
          <div class="cover-preview-ph">🎮</div>
        </div>
        <input type="url" name="cover_url" id="coverUrlInput" class="input mt-sm" placeholder="https://…" value="${h(game?.cover_url||'')}">
        <div class="cover-upload-row mt-sm">
          <label class="btn-outline" style="cursor:pointer;font-size:.8rem;padding:.35rem .75rem">
            📁 Upload image
            <input type="file" id="coverFileInput" accept="image/*" style="display:none">
          </label>
          ${game?.cover_url ? `<button type="button" class="btn-xs btn-xs-danger" id="clearCoverBtn">Clear</button>` : ''}
        </div>
        ${game?.cover_alts?.length > 1 ? `
        <div class="cover-alts-scroll" id="coverAltsRow">
          ${game.cover_alts.map(url=>`
            <img src="${h(url)}" class="cover-alt-thumb${url===game.cover_url?' selected':''}" data-url="${h(url)}" loading="lazy" title="Select this poster">`).join('')}
        </div>` : '<div id="coverAltsRow" class="cover-alts-scroll" style="display:none"></div>'}
      </div>
    </div>`;

  // Section 3: Render platform checkboxes
  renderPlatformCheckboxes('platformCheckboxes', currentPlatforms);

  // Section 11: Show/hide progress_pct based on status
  const statusSelect = document.querySelector('[name="status"]');
  const progressGroup = document.getElementById('progressPctGroup');
  if (statusSelect && progressGroup) {
    statusSelect.addEventListener('change', () => {
      progressGroup.style.display = statusSelect.value === 'paused' ? '' : 'none';
    });
  }

  // Section 6: Star rating widget
  const starWidget = renderStarRating('starRatingWidget', game?.rating || 0, val => {
    document.getElementById('ratingHidden').value = val > 0 ? val : '';
  });

  // Cover preview
  const coverInput = document.getElementById('coverUrlInput');
  setupCoverPreview(coverInput, document.getElementById('coverPreview'));
  if (game?.cover_url) {
    document.getElementById('coverPreview').innerHTML = `<img src="${h(game.cover_url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='<div class=cover-preview-ph>🎮</div>'">`;
  }

  // Custom poster upload
  document.getElementById('coverFileInput')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    // Section 2: open poster crop modal instead of directly using the file
    const reader = new FileReader();
    reader.onload = ev => {
      const src = ev.target.result;
      // Use the poster crop modal (2:3 ratio) from ui.js
      import('./ui.js').then(({ openPosterCropModal }) => {
        openPosterCropModal(src, croppedDataUrl => {
          coverInput.value = croppedDataUrl;
          coverInput.dispatchEvent(new Event('input'));
        });
      });
    };
    reader.readAsDataURL(file);
  });

  const clearCoverBtn = document.getElementById('clearCoverBtn');
  if (clearCoverBtn) clearCoverBtn.addEventListener('click', () => {
    coverInput.value = '';
    coverInput.dispatchEvent(new Event('input'));
  });

  document.getElementById('coverAltsRow')?.addEventListener('click', e => {
    const thumb = e.target.closest('.cover-alt-thumb');
    if (!thumb) return;
    coverInput.value = thumb.dataset.url;
    coverInput.dispatchEvent(new Event('input'));
    document.querySelectorAll('.cover-alt-thumb').forEach(t=>t.classList.toggle('selected', t.dataset.url===thumb.dataset.url));
  });

  // Autocomplete — Section 1: auto-fill description
  const acInput = document.getElementById('gameSearch');
  const acDrop  = document.getElementById('gameAcDrop');
  const acStat  = document.getElementById('searchStatus');
  new Autocomplete({
    input: acInput, dropdown: acDrop, status: acStat,
    onSearch: q => searchGames(q, settings),
    onSelect: async item => {
      acInput.value = '';
      acStat.textContent = 'Loading details…';
      const detail = await getGameDetail(item.slug, settings);
      const merged = { ...item, ...detail };

      document.querySelector('[name="title"]').value       = merged.title || '';
      document.querySelector('[name="genre"]').value       = merged.genres || merged.genre || '';
      document.querySelector('[name="developer"]').value   = merged.developer || '';
      document.querySelector('[name="publisher"]').value   = merged.publisher || '';
      if (merged.release_year) document.querySelector('[name="release_year"]').value = merged.release_year;

      // Section 1: auto-fill description
      const descField = document.getElementById('descriptionField');
      if (descField && merged.description) descField.value = merged.description;

      // Section 3: auto-fill platforms from IGDB
      if (merged.platform) renderPlatformCheckboxes('platformCheckboxes', merged.platform);

      // Update cover
      if (merged.cover_url) {
        coverInput.value = merged.cover_url;
        coverInput.dispatchEvent(new Event('input'));
      }

      // Show cover alts
      const alts = merged.cover_alts || [];
      const altsRow = document.getElementById('coverAltsRow');
      if (alts.length > 1) {
        altsRow.style.display = 'flex';
        altsRow.innerHTML = alts.map(url =>
          `<img src="${h(url)}" class="cover-alt-thumb${url===merged.cover_url?' selected':''}" data-url="${h(url)}" loading="lazy" title="Select poster">`
        ).join('');
        altsRow.addEventListener('click', ev => {
          const thumb = ev.target.closest('.cover-alt-thumb');
          if (!thumb) return;
          coverInput.value = thumb.dataset.url;
          coverInput.dispatchEvent(new Event('input'));
          altsRow.querySelectorAll('.cover-alt-thumb').forEach(t=>t.classList.toggle('selected', t.dataset.url===thumb.dataset.url));
        });
      }
      acStat.textContent = `✓ Loaded: ${merged.title}`;
      // Section 5: store igdb_rating in hidden field for saving with game
      if (merged.igdb_rating) {
        let igdbRatingInput = document.getElementById('igdbRatingHidden');
        if (!igdbRatingInput) {
          igdbRatingInput = document.createElement('input');
          igdbRatingInput.type = 'hidden';
          igdbRatingInput.id   = 'igdbRatingHidden';
          igdbRatingInput.name = 'igdb_rating';
          document.getElementById('gameForm').appendChild(igdbRatingInput);
        }
        igdbRatingInput.value = merged.igdb_rating;
      }
    }
  });

  // Delete button
  document.getElementById('deleteGameTopBtn')?.addEventListener('click', async () => {
    const ok = await confirm(`Delete "${game.title}"? This will also remove all sessions.`);
    if (ok) { await DB.deleteGame(_user, id); await onDataChanged(); toast(`"${game.title}" deleted`,'info'); _nav('library'); }
  });

  // Form submit
  document.getElementById('gameForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd  = new FormData(e.target);
    const now = todayISO();

    // Section 3: collect selected platforms
    const platforms = getSelectedPlatforms('platformCheckboxes');

    const altThumbs = [...document.querySelectorAll('.cover-alt-thumb')].map(t=>t.dataset.url).filter(Boolean);

    const obj = {
      title:        fd.get('title').trim(),
      status:       fd.get('status'),
      platforms:    platforms,           // Section 3: multi-platform
      platform:     platforms,           // keep old field for compatibility
      genre:        fd.get('genre').trim(),
      release_year: fd.get('release_year').trim(),
      cover_url:    coverInput.value.trim(),
      cover_alts:   altThumbs.length ? altThumbs : (coverInput.value ? [coverInput.value] : []),
      developer:    fd.get('developer').trim(),
      publisher:    fd.get('publisher').trim(),
      description:  fd.get('description').trim(),  // Section 1
      manual_hours: parseFloat(fd.get('manual_hours')||0),
      via_subscription: fd.get('via_subscription')==='on',
      rating:       fd.get('rating') || null,      // Section 6
      review:       fd.get('review') || '',         // Section 2
      date_completed: fd.get('date_completed') || null,
      date_added:   game?.date_added || now,
      igdb_rating:  fd.get('igdb_rating') ? parseInt(fd.get('igdb_rating')) : (game?.igdb_rating || null),
      want_to_replay: fd.get('want_to_replay') === 'on',
      progress_pct:   fd.get('status') === 'paused' ? (parseInt(fd.get('progress_pct')) || null) : null,
    };

    if (!obj.title) { toast('Title is required','error'); return; }

    if (isEdit) {
      obj.id               = id;
      obj.calculated_hours = game.calculated_hours || 0;
      obj.total_hours      = obj.manual_hours + (game.calculated_hours || 0);
      obj.last_played      = game.last_played || null;
    } else {
      obj.total_hours      = obj.manual_hours;
      obj.calculated_hours = 0;
    }

    await DB.putGame(_user, obj);
    await onDataChanged();
    toast(isEdit ? 'Game updated!' : 'Game added to library!', 'success');
    _nav(isEdit ? `game/${id}` : 'library');
  });

  // Section 9: Q/E keyboard shortcuts also work in edit view
  // (only fire when not typing in a field)
  if (isEdit) {
    const orderedIds = _libState.orderedIds;
    const currentIdx = orderedIds.indexOf(id);
    const prevId     = currentIdx > 0 ? orderedIds[currentIdx - 1] : null;
    const nextId     = currentIdx >= 0 && currentIdx < orderedIds.length - 1 ? orderedIds[currentIdx + 1] : null;

    const _editKeyHandler = e => {
      if (e.target.matches('input,textarea,select')) return;
      if (e.key === 'q' || e.key === 'Q') { if (prevId) _nav(`game/${prevId}/edit`); }
      if (e.key === 'e' || e.key === 'E') { if (nextId) _nav(`game/${nextId}/edit`); }
    };
    document.addEventListener('keydown', _editKeyHandler);
    window.addEventListener('gt:navigate', () => {
      document.removeEventListener('keydown', _editKeyHandler);
    }, { once: true });
  }
}

/* ═══════════════════════════════════════════════════
   BROWSE (Trending / Steam Featured + Search)
═══════════════════════════════════════════════════ */
export async function renderBrowse() {
  const settings = await DB.getAllSettings(_user);
  const hasIGDB  = !!(settings.igdb_client_id && settings.igdb_client_secret);

  main().innerHTML = `
    <div class="page-header">
      <h1>Browse</h1>
      <button class="btn-outline" id="refreshBrowse">↻ Refresh</button>
    </div>
    <div class="browse-search-bar">
      <input type="search" id="browseSearchInput" class="input" placeholder="Search ${hasIGDB ? 'IGDB' : 'Steam'}…" autocomplete="off">
      <button class="btn-primary" id="browseSearchBtn">Search</button>
    </div>
    <p class="search-status" id="browseSearchStatus" style="margin-bottom:1rem"></p>
    <div id="browseContent">
      <div class="browse-loading">
        <div class="spinner"></div>
        <p>Loading trending games…</p>
      </div>
    </div>`;

  document.getElementById('refreshBrowse').onclick = async () => {
    const { bustCache } = await import('./db.js');
    await bustCache('browse:trending');
    renderBrowse();
  };

  // Browse search
  const browseInput = document.getElementById('browseSearchInput');
  const browseBtn   = document.getElementById('browseSearchBtn');
  const browseStatus = document.getElementById('browseSearchStatus');

  async function doSearch() {
    const q = browseInput.value.trim();
    if (!q) { _loadBrowse(settings); return; }
    browseStatus.textContent = 'Searching…';
    const container = document.getElementById('browseContent');
    container.innerHTML = `<div class="browse-loading"><div class="spinner"></div><p>Searching…</p></div>`;
    try {
      const results = await searchBrowse(q, settings);
      browseStatus.textContent = `${results.length} result${results.length !== 1 ? 's' : ''} for "${q}"`;
      if (!results.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><h3>No results found</h3><p>Try a different search term.</p></div>`;
        return;
      }
      const games    = await DB.getGames(_user);
      const wishlist = await DB.getWishlist(_user);
      container.innerHTML = `
        <div class="browse-section">
          <div class="browse-grid">
            ${results.map(g => _browseCardHtml(g, games, wishlist)).join('')}
          </div>
        </div>`;
      _attachBrowseHandlers(container, settings);
    } catch(e) {
      browseStatus.textContent = 'Search failed — check your connection';
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">📡</div><h3>Search unavailable</h3></div>`;
    }
  }

  browseBtn.addEventListener('click', doSearch);
  browseInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  await _loadBrowse(settings);
}

function _browseCardHtml(g, games, wishlist) {
  const inLib  = games.find(lg => lg.title.toLowerCase() === g.title.toLowerCase());
  const inWish = wishlist.find(w => w.title.toLowerCase() === g.title.toLowerCase());
  const disc   = g.discount > 0 ? `<div class="browse-discount">-${g.discount}%</div>` : '';
  const price  = g.price_final ? `<div class="browse-price${g.discount>0?' on-sale':''}">£${g.price_final}${g.discount>0&&g.price_orig?` <s style="opacity:.5;font-size:.75em">£${g.price_orig}</s>`:''}</div>` : '';
  const coverSrc = h(g.header_url || g.cover_url);
  const fallback = h(g.cover_url || '');
  return `
    <div class="browse-card">
      <div class="browse-card-img-wrap">
        <img src="${coverSrc}" class="browse-card-img" loading="lazy"
          onerror="this.src='${fallback}';this.onerror=function(){this.parentElement.innerHTML='<div class=browse-card-ph>${h((g.title||'').slice(0,2).toUpperCase())}</div>'}">
        ${disc}
      </div>
      <div class="browse-card-body">
        <div class="browse-card-title">${h(g.title)}</div>
        ${g.release_date ? `<div class="browse-card-meta">📅 ${h(g.release_date)}</div>` : g.release_year ? `<div class="browse-card-meta">📅 ${h(g.release_year)}</div>` : ''}
        ${g.platform ? `<div class="browse-card-meta">📱 ${h(g.platform)}</div>` : ''}
        ${price}
        <div class="browse-card-actions">
          ${inLib
            ? `<span class="btn-xs btn-xs-muted">✓ In Library</span>`
            : `<button class="btn-xs btn-primary browse-add-lib" data-slug="${h(g.slug||'')}" data-title="${h(g.title)}" data-cover="${h(g.cover_url)}" data-appid="${h(g.steam_appid||'')}">+ Library</button>`}
          ${inWish
            ? `<span class="btn-xs btn-xs-muted">♥ Wishlisted</span>`
            : `<button class="btn-xs browse-add-wish" data-slug="${h(g.slug||'')}" data-title="${h(g.title)}" data-cover="${h(g.cover_url)}" data-price="${h(g.price_final||'')}" data-discount="${g.discount||0}" data-appid="${h(g.steam_appid||'')}">♡ Wishlist</button>`}
        </div>
      </div>
    </div>`;
}

function _attachBrowseHandlers(container, settings) {
  container.addEventListener('click', async e => {
    const libBtn  = e.target.closest('.browse-add-lib');
    const wishBtn = e.target.closest('.browse-add-wish');
    if (libBtn) {
      const title = libBtn.dataset.title, cover = libBtn.dataset.cover, appid = libBtn.dataset.appid;
      await DB.putGame(_user, { title, cover_url: cover, steam_appid: appid||null, status: 'backlog', date_added: todayISO(), manual_hours:0, calculated_hours:0, total_hours:0 });
      await onDataChanged();
      toast(`"${title}" added to library!`,'success');
      libBtn.outerHTML = `<span class="btn-xs btn-xs-muted">✓ In Library</span>`;
    }
    if (wishBtn) {
      const title = wishBtn.dataset.title, cover = wishBtn.dataset.cover;
      const price = wishBtn.dataset.price, discount = parseInt(wishBtn.dataset.discount)||0;
      await DB.putWishlistItem(_user, { title, cover_url: cover, priority: 2, price_current: price?`£${price}`:null, on_sale: discount>0, price_updated: todayISO() });
      await onDataChanged();
      toast(`"${title}" added to wishlist!`,'success');
      wishBtn.outerHTML = `<span class="btn-xs btn-xs-muted">♥ Wishlisted</span>`;
    }
  });
}

async function _loadBrowse(settings) {
  const container = document.getElementById('browseContent');
  if (!container) return;

  const sections = await fetchTrending();

  if (!sections.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📡</div>
      <h3>Couldn't load trending games</h3>
      <p>Check your internet connection and try again.</p>
    </div>`;
    return;
  }

  const games    = await DB.getGames(_user);
  const wishlist = await DB.getWishlist(_user);

  container.innerHTML = sections.map(section => `
    <div class="browse-section">
      <div class="card-head"><h2 class="browse-section-title">${h(section.label)}</h2></div>
      <div class="browse-grid">
        ${section.games.map(g => _browseCardHtml(g, games, wishlist)).join('')}
      </div>
    </div>`).join('');

  _attachBrowseHandlers(container, settings);
}

/* ═══════════════════════════════════════════════════
   DAILY LOG
═══════════════════════════════════════════════════ */
export async function renderLog() {
  const games    = await DB.getGames(_user);
  const sessions = await DB.getSessions(_user);
  const libGames = games.filter(g=>g.status!=='wishlist');

  // Section 8: sort sessions newest first within each day, days newest first
  const byDate = {};
  for (const s of sessions) {
    if (!byDate[s.date]) byDate[s.date]=[];
    const gm = games.find(g=>g.id===s.game_id);
    byDate[s.date].push({ ...s, game: gm });
  }
  // Sort sessions within each day newest first
  for (const day of Object.keys(byDate)) {
    byDate[day].sort((a,b) => (b.start_time||'').localeCompare(a.start_time||''));
  }
  // Sort days newest first
  const sortedDays = Object.entries(byDate).sort((a,b)=>b[0].localeCompare(a[0]));

  main().innerHTML = `
    <div class="page-header">
      <h1>Play Log</h1>
      <button class="btn-primary" id="openLogModal">+ Log Session</button>
    </div>

    <!-- Section 5/9: Log modal with end-time default + playtime shortcut -->
    <div class="modal-overlay" id="logModal">
      <div class="modal">
        <div class="modal-head"><h3>Log Session</h3><button class="modal-close" id="closeLogModal">×</button></div>
        <form id="logForm">
          <div class="form-group mb-md">
            <label>Game</label>
            <div class="autocomplete-wrap">
              <input type="text" id="logGameSearch" class="input" placeholder="Type to search your library or any game…" autocomplete="off">
              <div class="autocomplete-dropdown" id="logGameDrop"></div>
            </div>
            <input type="hidden" id="logGameId" name="game_id">
            <p id="logGameStatus" class="search-status" style="font-size:.78rem"></p>
          </div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Date</label><input type="date" name="date" class="input" value="${todayISO()}" required></div>
            <div class="form-group">
              <label>How long did you play?</label>
              <input type="text" id="logPlaytime" class="input" placeholder="e.g. 2h 30m">
              <span class="duration-hint" id="logPlaytimeHint"></span>
            </div>
          </div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Start time <span style="font-size:.7rem;color:var(--text3)">(auto-calculated)</span></label><input type="time" name="start_time" class="input"></div>
            <div class="form-group"><label>End time <span style="font-size:.7rem;color:var(--accent)">(defaults to now)</span></label><input type="time" name="end_time" class="input"></div>
          </div>
          <div class="form-group mb-md"><label>Notes</label><input type="text" name="notes" class="input" placeholder="Optional…"></div>
          <div class="modal-actions">
            <button type="button" class="btn-outline" id="cancelLog">Cancel</button>
            <button type="submit" class="btn-primary">Log</button>
          </div>
        </form>
      </div>
    </div>

    <div id="logDays">
      ${!sortedDays.length ? '<div class="empty-state"><div class="empty-icon">📅</div><h3>No sessions logged</h3><p>Log your first gaming session.</p></div>' :
        sortedDays.map(([date, slist]) => `
          <div class="log-day">
            <div class="log-day-header">${fmtDate(date)} · ${fmtHours(slist.reduce((t,s)=>t+(Number(s.duration)||0),0))}</div>
            ${slist.map(s=>`
              <div class="log-entry">
                <div class="log-game" data-nav="${s.game_id?'game/'+s.game_id:''}" style="cursor:${s.game_id?'pointer':'default'}">${h(s.game?.title||'Unknown game')}</div>
                <span class="log-time">${h(s.start_time)}–${h(s.end_time)}</span>
                <span style="font-family:var(--font-mono);font-size:.78rem;color:var(--accent)">${fmtHours(s.duration)}</span>
                <button class="btn-xs btn-xs-danger" data-del-session="${s.id}" data-game-id="${s.game_id||''}">×</button>
              </div>`).join('')}
          </div>`).join('')}
    </div>`;

  document.getElementById('openLogModal').onclick  = () => {
    // Section 5/9: default end time to now
    const endEl = document.querySelector('#logForm [name="end_time"]');
    if (endEl) endEl.value = nowTimeHHMM();
    openModal('logModal');
  };
  document.getElementById('closeLogModal').onclick = () => closeModal('logModal');
  document.getElementById('cancelLog').onclick     = () => closeModal('logModal');
  attachDurationCalc(document.getElementById('logForm'));

  // Section 5/9: playtime shortcut for log page
  const logPlaytimeEl   = document.getElementById('logPlaytime');
  const logPlaytimeHint = document.getElementById('logPlaytimeHint');
  const logFormEl       = document.getElementById('logForm');
  if (logPlaytimeEl) {
    logPlaytimeEl.addEventListener('input', () => {
      const hrs    = parsePlaytimeInput(logPlaytimeEl.value);
      const endEl  = logFormEl.querySelector('[name="end_time"]');
      const startEl= logFormEl.querySelector('[name="start_time"]');
      if (hrs !== null && hrs > 0 && endEl?.value) {
        const [eh, em] = endEl.value.split(':').map(Number);
        let sm = (eh * 60 + em) - Math.round(hrs * 60);
        if (sm < 0) sm += 1440;
        startEl.value = `${String(Math.floor(sm/60)).padStart(2,'0')}:${String(sm%60).padStart(2,'0')}`;
        const h2 = Math.floor(hrs), m2 = Math.round((hrs - h2) * 60);
        logPlaytimeHint.textContent = `= ${h2}h ${m2}m`;
      } else { logPlaytimeHint.textContent = ''; }
    });
  }

  // Log game search — searches library first, then fallback to game DB
  const settings = await DB.getAllSettings(_user);
  let _logGameId  = null;
  let _logGameTitle = '';

  const logInput = document.getElementById('logGameSearch');
  const logDrop  = document.getElementById('logGameDrop');
  const logStat  = document.getElementById('logGameStatus');
  const logHidden = document.getElementById('logGameId');

  new Autocomplete({
    input: logInput, dropdown: logDrop, status: logStat,
    onSearch: async q => {
      // First search local library
      const localMatches = libGames
        .filter(g => g.title.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 5)
        .map(g => ({ ...g, source: 'library', slug: `local:${g.id}` }));
      // Also search online
      const online = await searchGames(q, settings);
      return { results: [...localMatches, ...(online.results||[])] };
    },
    onSelect: item => {
      if (item.source === 'library') {
        _logGameId    = item.id;
        _logGameTitle = item.title;
        logHidden.value = item.id;
        logStat.textContent = `✓ ${item.title} (from your library)`;
      } else {
        _logGameId    = null; // will create or prompt
        _logGameTitle = item.title;
        logHidden.value = '';
        logStat.textContent = `✓ ${item.title} — not in your library, will log without adding`;
      }
      logInput.value = item.title;
    }
  });

  document.getElementById('logForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd    = new FormData(e.target);
    let gameId  = fd.get('game_id');
    const title = logInput.value.trim() || _logGameTitle;

    if (!title) { toast('Select or type a game name','error'); return; }

    // If game not in library, prompt to add
    if (!gameId) {
      const addToLib = await _promptAddToLibrary(title);
      if (addToLib) {
        const newGame = {
          title, status: 'playing', date_added: todayISO(),
          manual_hours: 0, calculated_hours: 0, total_hours: 0,
        };
        await DB.putGame(_user, newGame);
        const allGames = await DB.getGames(_user);
        const found = allGames.find(g => g.title === title);
        gameId = found?.id;
      }
    }

    // Section 5/9: resolve times from shortcut or explicit fields
    const endTime   = fd.get('end_time') || nowTimeHHMM();
    let   startTime = fd.get('start_time');
    const ptHrs     = parsePlaytimeInput(logPlaytimeEl?.value || '');
    if ((!startTime || !startTime.trim()) && ptHrs) {
      const [eh, em] = endTime.split(':').map(Number);
      let sm = (eh * 60 + em) - Math.round(ptHrs * 60);
      if (sm < 0) sm += 1440;
      startTime = `${String(Math.floor(sm/60)).padStart(2,'0')}:${String(sm%60).padStart(2,'0')}`;
    }
    if (!startTime || !startTime.trim()) { toast('Enter a start time or playtime duration','error'); return; }

    const dur = parseDuration(startTime, endTime);
    await DB.putSession(_user, {
      game_id: gameId||null, title_fallback: gameId?null:title,
      date: fd.get('date'), start_time: startTime, end_time: endTime, duration: dur,
      notes: fd.get('notes')||'',
    });
    if (gameId) await DB.recalcGame(_user, gameId);
    await onDataChanged();
    toast(`Session logged: ${fmtHours(dur)}`,'success');
    closeAllModals();
    renderLog();
  });

  document.getElementById('logDays').addEventListener('click', async e => {
    const btn = e.target.closest('[data-del-session]');
    if (!btn) return;
    const ok = await confirm('Delete this session?');
    if (ok) {
      await DB.deleteSession(_user, btn.dataset.delSession);
      if (btn.dataset.gameId) await DB.recalcGame(_user, btn.dataset.gameId);
      await onDataChanged();
      toast('Session deleted','info');
      renderLog();
    }
  });
}

async function _promptAddToLibrary(title) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.style.display = 'flex';
    ov.innerHTML = `<div class="modal modal-sm">
      <div class="modal-head"><h3>Add to Library?</h3></div>
      <p style="color:var(--text2);font-size:.9rem;margin-bottom:1rem"><strong>${h(title)}</strong> is not in your library. Would you like to add it?</p>
      <div class="modal-actions">
        <button class="btn-outline" id="_pno">Log only</button>
        <button class="btn-primary" id="_pyes">Add to Library</button>
      </div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('#_pyes').onclick = () => { ov.remove(); resolve(true); };
    ov.querySelector('#_pno').onclick  = () => { ov.remove(); resolve(false); };
  });
}

/* ═══════════════════════════════════════════════════
   SESSION LOGGER (Section 6 — Live play tracker)
═══════════════════════════════════════════════════ */
const ACTIVE_SESSION_KEY = 'gt_active_session';

export async function renderSessionLogger() {
  const games    = await DB.getGames(_user);
  const settings = await DB.getAllSettings(_user);
  const libGames = games.filter(g => g.status !== 'wishlist');
  const recent   = [...libGames]
    .filter(g => g.last_played)
    .sort((a,b) => b.last_played.localeCompare(a.last_played))
    .slice(0, 4);

  // Check if a session is already running
  let activeSession = null;
  try {
    const raw = localStorage.getItem(`${ACTIVE_SESSION_KEY}_${_user}`);
    if (raw) activeSession = JSON.parse(raw);
  } catch(e) {}

  main().innerHTML = `
    <div class="page-header">
      <h1>Session Logger</h1>
    </div>

    ${activeSession ? `
    <!-- Active session in progress -->
    <div class="session-logger-active card mb-lg">
      <div class="card-head">
        <h3>⏱ Session in progress</h3>
        <span class="session-live-badge">LIVE</span>
      </div>
      <div class="card-body">
        <div class="session-logger-game-name">${h(activeSession.title)}</div>
        <div class="session-logger-timer" id="sessionTimer">Calculating…</div>
        <div class="session-logger-started">Started: ${new Date(activeSession.startTime).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</div>
        <div class="modal-actions" style="margin-top:1.25rem">
          <button class="btn-danger" id="endSessionBtn">⏹ End Session</button>
        </div>
      </div>
    </div>` : `
    <!-- No session — start one -->
    <div class="card mb-lg">
      <div class="card-head"><h3>Start a session</h3></div>
      <div class="card-body">
        ${recent.length ? `
        <div class="form-group mb-md">
          <label>Recently played</label>
          <div class="session-quick-picks">
            ${recent.map(g => `
              <button class="session-quick-pick" data-game-id="${g.id}" data-title="${h(g.title)}">
                ${g.cover_url ? `<img src="${h(g.cover_url)}" class="session-quick-cover" loading="lazy" onerror="this.style.display='none'">` : ''}
                <span>${h(g.title)}</span>
              </button>`).join('')}
          </div>
        </div>` : ''}
        <div class="form-group mb-md">
          <label>Or search for a game</label>
          <div class="autocomplete-wrap">
            <input type="text" id="sessionGameSearch" class="input" placeholder="Search your library…" autocomplete="off">
            <div class="autocomplete-dropdown" id="sessionGameDrop"></div>
          </div>
          <p id="sessionGameStatus" class="search-status"></p>
        </div>
        <div id="sessionSelectedGame" style="display:none" class="session-selected-banner mb-md">
          Selected: <strong id="sessionSelectedTitle"></strong>
        </div>
        <button class="btn-primary" id="startSessionBtn" disabled>▶ Start Playing</button>
      </div>
    </div>`}

    <!-- Break / end session modal -->
    <div class="modal-overlay" id="endSessionModal">
      <div class="modal modal-sm">
        <div class="modal-head"><h3>End Session</h3><button class="modal-close" id="closeEndModal">×</button></div>
        <p style="color:var(--text2);font-size:.9rem;margin-bottom:1rem">Did you take any breaks?</p>
        <div class="form-group mb-md">
          <label>Total break time (minutes)</label>
          <input type="number" id="breakMinutes" class="input" value="0" min="0" placeholder="0">
        </div>
        <div id="sessionCalcPreview" style="font-size:.85rem;color:var(--text3);margin-bottom:1rem"></div>
        <div class="modal-actions">
          <button class="btn-outline" id="cancelEndSession">Cancel</button>
          <button class="btn-primary" id="confirmEndSession">Save Session</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>What is Session Logger?</h3></div>
      <div class="card-body" style="color:var(--text2);font-size:.9rem;line-height:1.7">
        <p>Session Logger automatically tracks how long you play a game in real time.</p>
        <ol style="margin:1rem 0 0 1.25rem;display:flex;flex-direction:column;gap:.5rem">
          <li>Select a game from your recently played list or search.</li>
          <li>Press <strong>Start Playing</strong> — the timer starts.</li>
          <li>When you're done, press <strong>End Session</strong>.</li>
          <li>Enter any break time (e.g. 15 minutes for a lunch break).</li>
          <li>Your actual playtime is calculated and added to the game's total.</li>
        </ol>
        <p style="margin-top:1rem">⚡ The session persists across page refreshes — you can safely navigate away and come back.</p>
      </div>
    </div>`;

  // Live timer update
  if (activeSession) {
    function updateTimer() {
      const el = document.getElementById('sessionTimer');
      if (!el) { clearInterval(_timerInterval); return; }
      const elapsed = (Date.now() - activeSession.startTime) / 1000 / 3600;
      el.textContent = fmtHours(elapsed);
    }
    updateTimer();
    const _timerInterval = setInterval(updateTimer, 10000);

    document.getElementById('endSessionBtn').onclick = () => {
      // Update preview on break input
      const breakEl = document.getElementById('breakMinutes');
      function updatePreview() {
        const breaks = parseFloat(breakEl.value) || 0;
        const totalMs = Date.now() - activeSession.startTime;
        const totalHrs = totalMs / 1000 / 3600;
        const actualHrs = Math.max(0, totalHrs - breaks / 60);
        document.getElementById('sessionCalcPreview').textContent =
          `Total time: ${fmtHours(totalHrs)} − ${breaks}min breaks = ${fmtHours(actualHrs)} logged`;
      }
      updatePreview();
      breakEl.addEventListener('input', updatePreview);
      openModal('endSessionModal');
    };

    document.getElementById('closeEndModal').onclick = () => closeModal('endSessionModal');
    document.getElementById('cancelEndSession').onclick = () => closeModal('endSessionModal');

    document.getElementById('confirmEndSession').onclick = async () => {
      const breaks  = parseFloat(document.getElementById('breakMinutes').value) || 0;
      const endTime = new Date();
      const startTime = new Date(activeSession.startTime);
      const totalMs = endTime - startTime;
      const totalHrs = totalMs / 1000 / 3600;
      const actualHrs = Math.max(0.016, totalHrs - breaks / 60); // min 1 min

      // Build start/end time strings
      const st = startTime.toTimeString().slice(0,5);
      const et = endTime.toTimeString().slice(0,5);
      const dt = startTime.toISOString().slice(0,10);

      await DB.putSession(_user, {
        game_id: activeSession.gameId || null,
        title_fallback: activeSession.gameId ? null : activeSession.title,
        date: dt, start_time: st, end_time: et,
        duration: +actualHrs.toFixed(4),
        notes: `Auto-logged via Session Logger${breaks > 0 ? ` (${breaks}min break)` : ''}`,
      });
      if (activeSession.gameId) await DB.recalcGame(_user, activeSession.gameId);
      await onDataChanged();

      // Clear active session
      localStorage.removeItem(`${ACTIVE_SESSION_KEY}_${_user}`);
      toast(`Session saved: ${fmtHours(actualHrs)} played!`, 'success');
      clearInterval(_timerInterval);
      closeAllModals();
      renderSessionLogger();
    };
    return;
  }

  // No active session — setup game picker
  let _selectedGameId = null, _selectedTitle = '';

  function setSelectedGame(id, title) {
    _selectedGameId = id;
    _selectedTitle  = title;
    const banner = document.getElementById('sessionSelectedGame');
    document.getElementById('sessionSelectedTitle').textContent = title;
    banner.style.display = 'block';
    document.getElementById('startSessionBtn').disabled = false;
  }

  // Quick picks
  document.querySelectorAll('.session-quick-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.session-quick-pick').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setSelectedGame(btn.dataset.gameId, btn.dataset.title);
    });
  });

  // Search autocomplete
  new Autocomplete({
    input: document.getElementById('sessionGameSearch'),
    dropdown: document.getElementById('sessionGameDrop'),
    status: document.getElementById('sessionGameStatus'),
    onSearch: async q => ({
      results: libGames
        .filter(g => g.title.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 8)
        .map(g => ({ ...g, source: 'library', slug: `local:${g.id}` }))
    }),
    onSelect: item => {
      document.getElementById('sessionGameSearch').value = item.title;
      setSelectedGame(item.id, item.title);
    }
  });

  document.getElementById('startSessionBtn').addEventListener('click', () => {
    if (!_selectedTitle) return;
    const session = {
      gameId: _selectedGameId,
      title:  _selectedTitle,
      startTime: Date.now(),
    };
    localStorage.setItem(`${ACTIVE_SESSION_KEY}_${_user}`, JSON.stringify(session));
    toast(`Started session: ${_selectedTitle}`, 'success');
    renderSessionLogger();
  });
}

/* ═══════════════════════════════════════════════════
   STATISTICS
═══════════════════════════════════════════════════ */
export async function renderStats(period) {
  const games    = await DB.getGames(_user);
  const sessions = await DB.getSessions(_user);
  const lib      = games.filter(g=>g.status!=='wishlist');
  period = period || localStorage.getItem(`ll_stats_period_${_user}`) || 'lifetime';

  // Filter sessions by period
  // Use local-date string comparison (YYYY-MM-DD) to avoid UTC timezone shift bugs
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  function cutoffStrForPeriod(p) {
    if (p === 'weekly')  { const d=new Date(now); d.setDate(d.getDate()-7);           return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
    if (p === 'monthly') { const d=new Date(now); d.setMonth(d.getMonth()-1);          return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
    if (p === 'yearly')  { const d=new Date(now); d.setFullYear(d.getFullYear()-1);    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
    return null; // lifetime — no cutoff
  }
  const cutoffStr = cutoffStrForPeriod(period);
  // s.date is already "YYYY-MM-DD" — compare as strings (lexicographic = chronological)
  const filtSessions = cutoffStr ? sessions.filter(s => s.date >= cutoffStr) : sessions;

  // Hours per game in this period (from filtered sessions)
  const periodHoursMap = {};
  filtSessions.forEach(s => {
    if (!s.game_id) return;
    periodHoursMap[s.game_id] = (periodHoursMap[s.game_id]||0) + (Number(s.duration)||0);
  });
  const periodTotalHours = Object.values(periodHoursMap).reduce((a,b)=>a+b, 0);

  // Games active this period (had at least one session)
  const activeGameIds = new Set(Object.keys(periodHoursMap));
  const gamesThisPeriod = lib.filter(g => activeGameIds.has(g.id));

  // Top games — by period hours (not total_hours which is all-time)
  const top_games_period = period === 'lifetime'
    ? [...lib].filter(g=>Number(g.total_hours)>0).sort((a,b)=>Number(b.total_hours)-Number(a.total_hours)).slice(0,10)
    : gamesThisPeriod.sort((a,b)=>(periodHoursMap[b.id]||0)-(periodHoursMap[a.id]||0)).slice(0,10);

  const avg_rating  = lib.filter(g=>g.rating).length
    ? (lib.filter(g=>g.rating).reduce((t,g)=>t+Number(g.rating),0)/lib.filter(g=>g.rating).length).toFixed(2) : null;
  const status_counts = [...ALL_STATUSES].map(s=>({ status:s, cnt:lib.filter(g=>g.status===s).length }));

  // Sessions this period
  const sesCount = filtSessions.length;
  const avgPerSession = sesCount > 0 ? periodTotalHours / sesCount : 0;

  // Build time-axis chart data — using local date strings throughout
  function localDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function buildTimeChart(p) {
    const buckets = {};
    let labelFn;
    if (p === 'weekly') {
      // Last 7 days, one bucket per day
      labelFn = k => k.slice(5); // "MM-DD"
      for (let i=6; i>=0; i--) { const d=new Date(now); d.setDate(d.getDate()-i); buckets[localDateStr(d)]=0; }
    } else if (p === 'monthly') {
      // 4 weekly buckets (week start dates)
      labelFn = k => 'Wk ' + k.slice(5);
      for (let i=3; i>=0; i--) {
        const d=new Date(now); d.setDate(d.getDate()-i*7);
        const dow=(d.getDay()+6)%7; d.setDate(d.getDate()-dow);
        buckets[localDateStr(d)]=0;
      }
    } else if (p === 'yearly') {
      // Last 12 months, one bucket per month
      labelFn = k => k; // "YYYY-MM"
      for (let i=11; i>=0; i--) { const d=new Date(now); d.setMonth(d.getMonth()-i); d.setDate(1); buckets[`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`]=0; }
    } else {
      // Lifetime — group by month, show last 12 months of data
      labelFn = k => k;
      for (let i=11; i>=0; i--) { const d=new Date(now); d.setMonth(d.getMonth()-i); d.setDate(1); buckets[`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`]=0; }
    }

    // Accumulate sessions into buckets using local date strings
    const bucketKeys = Object.keys(buckets).sort();
    filtSessions.forEach(s => {
      if (!s.date) return;
      const dur = Number(s.duration)||0;
      if (p === 'weekly') {
        // Direct daily match
        if (buckets[s.date] !== undefined) buckets[s.date] += dur;
      } else if (p === 'monthly') {
        // Find nearest week-start bucket that is <= s.date
        const nearest = bucketKeys.slice().reverse().find(k => k <= s.date);
        if (nearest !== undefined) buckets[nearest] += dur;
      } else {
        // Group by month "YYYY-MM"
        const monthKey = s.date.slice(0,7);
        if (buckets[monthKey] !== undefined) buckets[monthKey] += dur;
      }
    });

    return Object.entries(buckets).sort().map(([k,v]) => [labelFn(k), v]);
  }
  const timeData = buildTimeChart(period);
  const chartLabel = { weekly:'Daily Playtime — last 7 days', monthly:'Daily Playtime — last 30 days', yearly:'Monthly Playtime — this year', lifetime:'Monthly Playtime — all time' }[period];

  main().innerHTML = `
    <div class="page-header"><h1>Statistics</h1></div>

    <!-- Time period tabs -->
    <div class="stats-period-tabs" id="statsPeriodTabs">
      <button class="stats-tab${period==='weekly'?' active':''}"   data-period="weekly">Week</button>
      <button class="stats-tab${period==='monthly'?' active':''}"  data-period="monthly">Month</button>
      <button class="stats-tab${period==='yearly'?' active':''}"   data-period="yearly">Year</button>
      <button class="stats-tab${period==='lifetime'?' active':''}" data-period="lifetime">All Time</button>
    </div>

    <div class="stat-tiles">
      <div class="stat-tile">
        <div class="stat-tile-val">${period==='lifetime' ? lib.length : gamesThisPeriod.length}</div>
        <div class="stat-tile-label">${period==='lifetime' ? 'Games tracked' : 'Games played'}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile-val">${fmtHours(periodTotalHours)}</div>
        <div class="stat-tile-label">${period==='lifetime'?'Total hours':'Hours this period'}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile-val">${sesCount}</div>
        <div class="stat-tile-label">${period==='lifetime'?'Total sessions':'Sessions'}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile-val">${sesCount > 0 ? fmtHours(avgPerSession) : '—'}</div>
        <div class="stat-tile-label">Avg session</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile-val">${lib.filter(g=>g.status==='completed'||g.status==='100%').length}</div>
        <div class="stat-tile-label">Completed (all time)</div>
      </div>
    </div>

    <div class="two-col mt-lg">
      <div class="card">
        <div class="card-head"><h3>${period==='lifetime'?'Most Played':'Top Games (period)'}</h3></div>
        <div class="card-body">
          ${top_games_period.length ? `<div class="chart-bars">
            ${top_games_period.map(g=>{
              const hrs = period==='lifetime' ? Number(g.total_hours)||0 : (periodHoursMap[g.id]||0);
              const max = period==='lifetime' ? Number(top_games_period[0].total_hours)||1 : Math.max(...top_games_period.map(x=>periodHoursMap[x.id]||0),1);
              const pct = Math.round((hrs/max)*100);
              return `<div class="bar-item"><span class="bar-label">${completionIcon(g.status)} ${h(g.title)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-val">${fmtHours(hrs)}</span></div>`;
            }).join('')}
          </div>` : `<p style="color:var(--text3);font-size:.9rem">No sessions in this period.</p>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Library by Status</h3></div>
        <div class="card-body">
          <div class="chart-bars">
            ${status_counts.map(sc=>{
              const max = Math.max(...status_counts.map(x=>x.cnt),1);
              const pct = Math.round((sc.cnt/max)*100);
              return `<div class="bar-item"><span class="bar-label badge badge-${normStatus(sc.status)==='100%'?'100':normStatus(sc.status)}">${statusLabel(sc.status)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-val">${sc.cnt}</span></div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="card mt-lg">
      <div class="card-head"><h3>${chartLabel}</h3></div>
      <div class="card-body">
        ${timeData.every(([,v])=>v===0) ? '<p style="color:var(--text3)">No sessions in this period.</p>' : `
        <div class="chart-bars">
          ${timeData.map(([lbl,hrs])=>{
            const max = Math.max(...timeData.map(([,v])=>v),1);
            const pct = Math.round((hrs/max)*100);
            return `<div class="bar-item"><span class="bar-label" style="min-width:80px;font-size:.72rem">${lbl}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-val">${fmtHours(hrs)}</span></div>`;
          }).join('')}
        </div>`}
      </div>
    </div>

    ${avg_rating ? `
    <div class="two-col mt-lg">
      <div class="card">
        <div class="card-head"><h3>Rating Distribution</h3></div>
        <div class="card-body">
          <div class="rating-curve">
            ${[1,1.5,2,2.5,3,3.5,4,4.5,5].map(r=>{
              const cnt = lib.filter(g=>Math.abs(Number(g.rating)-r)<0.26).length;
              const maxCnt = Math.max(...[1,1.5,2,2.5,3,3.5,4,4.5,5].map(x=>lib.filter(g=>Math.abs(Number(g.rating)-x)<0.26).length),1);
              const h2 = Math.max(Math.round((cnt/maxCnt)*80),2);
              return `<div class="rating-curve-col"><div class="rating-curve-bar-wrap"><div class="rating-curve-bar" style="height:${h2}px"></div></div><div class="rating-curve-count">${cnt||''}</div><div class="rating-curve-label">${r}</div></div>`;
            }).join('')}
          </div>
          <p style="margin-top:1rem;font-size:.82rem;color:var(--text2)">Avg: <strong style="color:var(--accent)">★ ${avg_rating}</strong> across ${lib.filter(g=>g.rating).length} rated games</p>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Session Stats</h3></div>
        <div class="card-body">
          <div class="chart-bars">
            <div class="bar-item"><span class="bar-label">Total sessions</span><div class="bar-track"><div class="bar-fill" style="width:100%"></div></div><span class="bar-val">${sessions.length}</span></div>
            <div class="bar-item"><span class="bar-label">Avg session</span><div class="bar-track"><div class="bar-fill" style="width:60%"></div></div><span class="bar-val">${sessions.length?fmtHours(sessions.reduce((a,s)=>a+(Number(s.duration)||0),0)/sessions.length):'—'}</span></div>
            <div class="bar-item"><span class="bar-label">Period sessions</span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,Math.round(sesCount/Math.max(sessions.length,1)*100))}%"></div></div><span class="bar-val">${sesCount}</span></div>
            <div class="bar-item"><span class="bar-label">Avg/session (period)</span><div class="bar-track"><div class="bar-fill" style="width:50%"></div></div><span class="bar-val">${sesCount?fmtHours(avgPerSession):'—'}</span></div>
          </div>
        </div>
      </div>
    </div>` : ''}`;

  // Animate bars
  setTimeout(()=>{
    document.querySelectorAll('.bar-fill').forEach(b=>{
      const w=b.style.width; b.style.width='0'; b.style.transition='none';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{ b.style.transition='width .9s cubic-bezier(.4,0,.2,1)'; b.style.width=w; }));
    });
  }, 80);

  // Period tab handlers
  document.querySelectorAll('#statsPeriodTabs .stats-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const p = tab.dataset.period;
      localStorage.setItem(`ll_stats_period_${_user}`, p);
      renderStats(p);
    });
  });
}

/* ═══════════════════════════════════════════════════
   WISHLIST
═══════════════════════════════════════════════════ */
export async function renderWishlist() {
  const items    = await DB.getWishlist(_user);
  const settings = await DB.getAllSettings(_user);
  const savedSort = localStorage.getItem(`gt_wish_sort_${_user}`) || 'priority';

  function sortItems(arr, by) {
    return [...arr].sort((a,b) => {
      if (by === 'priority') return (a.priority||2)-(b.priority||2) || a.title.localeCompare(b.title);
      if (by === 'title')    return a.title.localeCompare(b.title);
      if (by === 'price')    return parseFloat(a.price_current)||999 - (parseFloat(b.price_current)||999);
      if (by === 'sale')     return (b.on_sale?1:0)-(a.on_sale?1:0);
      return 0;
    });
  }
  const sorted = sortItems(items, savedSort);

  main().innerHTML = `
    <div class="page-header">
      <h1>Wishlist</h1>
      <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
        <select class="input" id="wishSortSelect" style="max-width:140px">
          <option value="priority"${savedSort==='priority'?' selected':''}>By Priority</option>
          <option value="title"${savedSort==='title'?' selected':''}>A–Z</option>
          <option value="price"${savedSort==='price'?' selected':''}>By Price</option>
          <option value="sale"${savedSort==='sale'?' selected':''}>On Sale First</option>
        </select>
        <button class="btn-outline" id="refreshPricesBtn">↻ Prices</button>
        <button class="btn-primary" id="openWishModal">+ Add</button>
      </div>
    </div>

    <!-- Add modal -->
    <div class="modal-overlay" id="wishModal">
      <div class="modal modal-lg">
        <div class="modal-head"><h3>Add to Wishlist</h3><button class="modal-close" id="closeWishModal">×</button></div>
        <div class="autocomplete-wrap mb-md">
          <input type="text" id="wishSearch" class="input" placeholder="Search game database…" autocomplete="off">
          <div class="autocomplete-dropdown" id="wishAcDrop"></div>
        </div>
        <p class="search-status" id="wishStatus"></p>
        <form id="wishForm">
          <div class="two-col mb-md">
            <div class="form-group"><label>Title *</label><input type="text" name="title" class="input" required placeholder="Game title…"></div>
            <div class="form-group"><label>Platform</label><input type="text" name="platform" class="input" placeholder="PC, PS5…"></div>
          </div>
          <input type="hidden" name="cover_url" id="wishCoverUrl">
          <input type="hidden" name="steam_appid" id="wishAppId">
          <div class="two-col mb-md">
            <div class="form-group">
              <label>Priority</label>
              <select name="priority" class="input">
                <option value="1">🔥 High</option>
                <option value="2" selected>Normal</option>
                <option value="3">Low</option>
              </select>
            </div>
            <div class="form-group"><label>Notes</label><input type="text" name="notes" class="input" placeholder="Optional…"></div>
          </div>
          <div class="settings-section-title">Price Tracking</div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Current Price</label><input type="text" name="price_current" class="input" placeholder="£24.99"></div>
            <div class="form-group"><label>Historical Low</label><input type="text" name="price_low" class="input" placeholder="£9.99"></div>
          </div>
          <div class="form-group mb-md">
            <label class="checkbox-row"><input type="checkbox" name="on_sale"> <span>Currently on sale</span></label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-outline" id="cancelWish">Cancel</button>
            <button type="submit" class="btn-primary">Add to Wishlist</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit price modal -->
    <div class="modal-overlay" id="priceModal">
      <div class="modal modal-sm">
        <div class="modal-head"><h3>Update Price</h3><button class="modal-close" id="closePriceModal">×</button></div>
        <form id="priceForm">
          <input type="hidden" name="item_id">
          <div class="form-group mb-md"><label>Current Price</label><input type="text" name="price_current" class="input" placeholder="£24.99"></div>
          <div class="form-group mb-md"><label>Historical Low</label><input type="text" name="price_low" class="input" placeholder="£9.99"></div>
          <div class="form-group mb-md"><label class="checkbox-row"><input type="checkbox" name="on_sale"> <span>Currently on sale</span></label></div>
          <div class="modal-actions">
            <button type="button" class="btn-outline" id="cancelPrice">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>

    ${!sorted.length ? '<div class="empty-state"><div class="empty-icon">🎯</div><h3>Wishlist is empty</h3><p>Add games you want to play, or browse trending games.</p><button class="btn-outline mt-md" data-nav="browse">Browse Trending</button></div>' : `
    <div class="wish-grid" id="wishGrid">
      ${sorted.map(item => `
        <div class="wish-card${item.on_sale?' on-sale-card':''}" data-wish-id="${item.id}">
          ${item.cover_url
            ? `<img src="${h(item.cover_url)}" class="wish-card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="wish-card-cover-ph" style="display:none">${h((item.title||'').slice(0,2).toUpperCase())}</div>`
            : `<div class="wish-card-cover-ph">${h((item.title||'').slice(0,2).toUpperCase())}</div>`}
          ${item.on_sale?'<div class="wish-sale-badge">SALE</div>':''}
          <div class="wish-card-body">
            <div class="wish-card-title">${h(item.title)}</div>
            <div class="wish-card-meta">
              ${item.platform?`📱 ${h(item.platform)}`:''}
              ${item.priority===1?'🔥 High priority':item.priority===3?'Low priority':''}
              ${item.notes?`<br><span style="font-size:.78rem;color:var(--text3)">${h(item.notes)}</span>`:''}
            </div>
            ${(item.price_current||item.price_low) ? `
            <div class="wish-price-row">
              ${item.price_current ? `<span class="wish-price-current${item.on_sale?' on-sale':''}">${h(item.price_current)}</span>` : ''}
              ${item.on_sale ? '<span class="wish-price-auto-badge">SALE</span>' : ''}
              ${item.price_low    ? `<span class="wish-price-low">Low: ${h(item.price_low)}</span>` : ''}
              ${item.price_updated ? `<span class="wish-price-date">Updated ${fmtDate(item.price_updated)}</span>` : ''}
            </div>` : item.steam_appid ? `
            <div class="wish-price-row">
              <span class="wish-price-loading" id="wish-price-${h(item.id)}">↻ Loading price…</span>
            </div>` : ''}
            <div class="wish-actions">
              <button class="btn-xs" data-edit-price="${item.id}"
                data-price-current="${h(item.price_current||'')}"
                data-price-low="${h(item.price_low||'')}"
                data-on-sale="${item.on_sale?'1':'0'}">Edit Price</button>
              <button class="btn-xs btn-primary" data-move-to-lib="${item.id}">→ Library</button>
              <button class="btn-xs btn-xs-danger" data-delete-wish="${item.id}">×</button>
            </div>
          </div>
        </div>`).join('')}
    </div>`}`;

  document.getElementById('openWishModal').onclick  = () => openModal('wishModal');
  document.getElementById('closeWishModal').onclick = () => closeModal('wishModal');
  document.getElementById('cancelWish').onclick     = () => closeModal('wishModal');
  document.getElementById('closePriceModal').onclick = () => closeModal('priceModal');
  document.getElementById('cancelPrice').onclick    = () => closeModal('priceModal');

  // Section 3: Auto-fetch prices for items that have a steam_appid but no price yet
  const missingPriceItems = items.filter(i => i.steam_appid && !i.price_current);
  if (missingPriceItems.length) {
    (async () => {
      for (const item of missingPriceItems) {
        const el = document.getElementById(`wish-price-${item.id}`);
        try {
          const price = await fetchSteamPrice(item.steam_appid);
          if (price) {
            item.price_current = `£${price.current}`;
            item.on_sale       = price.on_sale;
            item.price_updated = todayISO();
            await DB.putWishlistItem(_user, item);
            if (el) {
              el.textContent = `£${price.current}${price.on_sale ? ' 🔥 SALE' : ''}`;
              el.className   = `wish-price-current${price.on_sale ? ' on-sale' : ''}`;
            }
          } else {
            if (el) el.textContent = '';
          }
        } catch(e) {
          if (el) el.textContent = '';
        }
      }
    })();
  }

  // Sort preference (Section 1.1)
  document.getElementById('wishSortSelect')?.addEventListener('change', e => {
    localStorage.setItem(`gt_wish_sort_${_user}`, e.target.value);
    renderWishlist();
  });

  // Refresh prices for Steam games
  document.getElementById('refreshPricesBtn').onclick = async () => {
    const steamItems = items.filter(i => i.steam_appid);
    if (!steamItems.length) { toast('No Steam games with app IDs in wishlist','info'); return; }
    toast('Fetching prices…','info');
    let updated = 0;
    for (const item of steamItems) {
      const price = await fetchSteamPrice(item.steam_appid);
      if (price) {
        item.price_current  = `£${price.current}`;
        item.price_low      = item.price_low || `£${price.original}`;
        item.on_sale        = price.on_sale;
        item.price_updated  = todayISO();
        await DB.putWishlistItem(_user, item);
        updated++;
      }
    }
    await onDataChanged();
    toast(`Updated prices for ${updated} game${updated!==1?'s':''}!`, 'success');
    renderWishlist();
  };

  // Wishlist autocomplete — Steam-first so prices work
  const wishSettings = await DB.getAllSettings(_user);
  new Autocomplete({
    input: document.getElementById('wishSearch'),
    dropdown: document.getElementById('wishAcDrop'),
    status: document.getElementById('wishStatus'),
    onSearch: q => searchGamesSteamFirst(q, wishSettings),
    onSelect: item => {
      document.querySelector('#wishForm [name="title"]').value    = item.title||'';
      document.querySelector('#wishForm [name="platform"]').value = item.platform||'';
      document.getElementById('wishCoverUrl').value = item.cover_url||'';
      // Always fill steam_appid if available — required for price tracking
      if (item.steam_appid) {
        document.getElementById('wishAppId').value = item.steam_appid;
        document.getElementById('wishStatus').textContent = `✓ ${item.title} · Steam ID: ${item.steam_appid} (prices will auto-load)`;
      } else {
        document.getElementById('wishAppId').value = '';
        document.getElementById('wishStatus').textContent = `✓ ${item.title} · No Steam ID — prices unavailable`;
      }
    }
  });

  document.getElementById('wishForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await DB.putWishlistItem(_user, {
      title:         fd.get('title').trim(),
      platform:      fd.get('platform').trim(),
      cover_url:     fd.get('cover_url')||'',
      steam_appid:   fd.get('steam_appid')||null,
      priority:      parseInt(fd.get('priority')),
      notes:         fd.get('notes').trim(),
      price_current: fd.get('price_current').trim()||null,
      price_low:     fd.get('price_low').trim()||null,
      on_sale:       fd.get('on_sale')==='on',
      price_updated: todayISO(),
    });
    await onDataChanged();
    toast('Added to wishlist!','success');
    closeAllModals();
    renderWishlist();
  });

  document.getElementById('wishGrid')?.addEventListener('click', async e => {
    const editBtn = e.target.closest('[data-edit-price]');
    const delBtn  = e.target.closest('[data-delete-wish]');
    const moveBtn = e.target.closest('[data-move-to-lib]');

    if (editBtn) {
      const pf = document.getElementById('priceForm');
      pf.querySelector('[name="item_id"]').value       = editBtn.dataset.editPrice;
      pf.querySelector('[name="price_current"]').value = editBtn.dataset.priceCurrent||'';
      pf.querySelector('[name="price_low"]').value     = editBtn.dataset.priceLow||'';
      pf.querySelector('[name="on_sale"]').checked     = editBtn.dataset.onSale==='1';
      openModal('priceModal');
    }
    if (delBtn) {
      const ok = await confirm('Remove from wishlist?');
      if (ok) { await DB.deleteWishlistItem(_user, delBtn.dataset.deleteWish); await onDataChanged(); toast('Removed','info'); renderWishlist(); }
    }
    if (moveBtn) {
      const item = items.find(i=>i.id===moveBtn.dataset.moveToLib);
      if (item) {
        await DB.putGame(_user, { title:item.title, status:'backlog', cover_url:item.cover_url||'', platform:item.platform||'', date_added:todayISO(), manual_hours:0, calculated_hours:0, total_hours:0 });
        await DB.deleteWishlistItem(_user, item.id);
        await onDataChanged();
        toast(`"${item.title}" moved to library!`,'success');
        renderWishlist();
      }
    }
  });

  document.getElementById('priceForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd   = new FormData(e.target);
    const id2  = fd.get('item_id');
    const item = items.find(i=>i.id===id2);
    if (!item) return;
    item.price_current = fd.get('price_current').trim()||null;
    item.price_low     = fd.get('price_low').trim()||null;
    item.on_sale       = fd.get('on_sale')==='on';
    item.price_updated = todayISO();
    await DB.putWishlistItem(_user, item);
    await onDataChanged();
    toast('Price updated!','success');
    closeAllModals();
    renderWishlist();
  });
}

/* ═══════════════════════════════════════════════════
   PROFILE
═══════════════════════════════════════════════════ */
export async function renderProfile() {
  const games    = await DB.getGames(_user);
  const sessions = await DB.getSessions(_user);
  const favs     = await DB.getFavorites(_user);
  const profile  = await DB.getProfile(_user);
  const lib      = games.filter(g=>g.status!=='wishlist');
  const settings = await DB.getAllSettings(_user);

  const total_hours = lib.reduce((t,g)=>t+(Number(g.total_hours)||0),0);
  const completed   = lib.filter(g=>g.status==='completed'||g.status==='100%').length;
  const ratedGames  = lib.filter(g=>g.rating);
  const avg_rating  = ratedGames.length
    ? (ratedGames.reduce((t,g)=>t+Number(g.rating),0)/ratedGames.length).toFixed(1)
    : null;

  // Section 4: rating curve data — distribution across all 0.5-step values
  const RATING_STEPS = [0.5,1,1.5,2,2.5,3,3.5,4,4.5,5];
  const ratingDist   = RATING_STEPS.map(r => ({
    r,
    count: ratedGames.filter(g => Math.abs(Number(g.rating) - r) < 0.01).length,
  }));
  const maxRatingCount = Math.max(1, ...ratingDist.map(d => d.count));

  const recentlyPlayed = lib.filter(g=>g.last_played).sort((a,b)=>b.last_played.localeCompare(a.last_played)).slice(0,4);
  const favMap = {};
  for (const f of favs) favMap[f.slot] = lib.find(g=>g.id===f.game_id)||null;

  const picHtml = profile?.pic
    ? `<img src="${h(profile.pic)}" class="profile-banner-avatar-img" alt="Profile picture">`
    : `<div class="profile-banner-avatar">${_user[0].toUpperCase()}</div>`;

  const syncEnabled = settings.sync_enabled === 'true';

  main().innerHTML = `
    <div class="profile-banner">
      <div class="profile-pic-wrap" id="profilePicWrap">
        ${picHtml}
        <button class="profile-pic-edit" title="Change photo" id="editPicBtn">📷</button>
      </div>
      <div>
        <div class="profile-banner-name">${h(_user)}</div>
        <div class="profile-stats-row">
          <span><strong>${lib.length}</strong> games</span><span class="sep">·</span>
          <span><strong>${fmtHours(total_hours)}</strong> played</span><span class="sep">·</span>
          <span><strong>${completed}</strong> completed</span>
          ${avg_rating?`<span class="sep">·</span><span>★ <strong>${avg_rating}</strong> avg</span>`:''}
        </div>
      </div>
    </div>

    <!-- Profile pic picker (hidden) -->
    <input type="file" id="picFilePicker" accept="image/*" style="display:none">

    <!-- Fav game search modal -->
    <div class="modal-overlay" id="favSearchModal">
      <div class="modal modal-lg">
        <div class="modal-head">
          <h3>Choose Favorite — Slot <span id="favSlotLabel"></span></h3>
          <button class="modal-close" id="closeFavSearch">×</button>
        </div>
        <div class="autocomplete-wrap mb-md">
          <input type="text" id="favSearch" class="input" placeholder="Search your library…" autocomplete="off">
          <div class="autocomplete-dropdown" id="favDrop"></div>
        </div>
        <p id="favSearchStatus" class="search-status"></p>
        <div class="fav-search-results" id="favResults">
          ${lib.sort((a,b)=>a.title.localeCompare(b.title)).slice(0,12).map(g=>`
            <div class="fav-result-item" data-game-id="${g.id}">
              ${g.cover_url?`<img src="${h(g.cover_url)}" class="fav-result-cover" loading="lazy">`:`<div class="fav-result-ph">${h((g.title||'').slice(0,2).toUpperCase())}</div>`}
              <span>${h(g.title)}</span>
            </div>`).join('')}
        </div>
        <div class="modal-actions" style="margin-top:1rem">
          <button class="btn-xs btn-xs-danger" id="clearFavBtn">Clear slot</button>
          <button class="btn-outline" id="cancelFavSearch">Cancel</button>
        </div>
      </div>
    </div>

    <div class="profile-section">
      <div class="section-head">
        <h2>Favorite Games</h2>
      </div>
      <div class="fav-grid">
        ${[1,2,3,4].map(slot => {
          const g = favMap[slot];
          return `<div class="fav-slot" data-slot="${slot}">
            ${g
              ? `${g.cover_url?`<img src="${h(hiResCover(g))}" class="fav-cover" loading="lazy" onerror="this.src='${h(g.cover_url)}'">`:``}
                 <div class="fav-overlay"><span class="fav-title">${h(g.title)}</span><button class="fav-edit-btn" data-slot="${slot}">✎</button></div>`
              : `<div class="fav-empty" data-slot="${slot}"><div class="fav-add-icon">+</div><div class="fav-add-label">Add Favorite</div></div>`}
          </div>`;
        }).join('')}
      </div>
    </div>

    ${recentlyPlayed.length?`
    <div class="profile-section">
      <div class="section-head"><h2>Recently Played</h2></div>
      <div class="recent-grid">
        ${recentlyPlayed.map(g=>`
          <div class="recent-card" data-nav="game/${g.id}">
            <div class="recent-poster-wrap">
              ${g.cover_url
                ? `<img src="${h(hiResCover(g))}" class="recent-cover" loading="lazy"
                        onerror="this.src='${h(g.cover_url)}'">` 
                : `<div class="recent-placeholder">${h((g.title||'').slice(0,2).toUpperCase())}</div>`}
              <div class="recent-overlay">
                <span class="recent-title">${h(g.title)}</span>
                <span class="recent-hours">${fmtHours(g.total_hours)}</span>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>`:''}

    <!-- Section 4: Rating curve visualization -->
    ${ratedGames.length ? `
    <div class="profile-section">
      <div class="section-head">
        <h2>Rating Distribution</h2>
        <span class="section-sub">${ratedGames.length} rated game${ratedGames.length!==1?'s':''} · avg ${avg_rating}★</span>
      </div>
      <div class="rating-curve">
        ${ratingDist.map(d => {
          const BAR_MAX_PX = 140; // max bar height in px — drives the container height
          const barPx = d.count > 0 ? Math.max(4, Math.round((d.count / maxRatingCount) * BAR_MAX_PX)) : 0;
          return `
          <div class="rating-curve-col">
            <span class="rating-curve-count">${d.count > 0 ? d.count : ''}</span>
            <div class="rating-curve-bar-wrap">
              <div class="rating-curve-bar" style="height:${barPx}px"></div>
            </div>
            <span class="rating-curve-label">${Number.isInteger(d.r) ? d.r : d.r}</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    <div class="form-card">
      <h3 style="font-size:.9rem;font-weight:700;margin-bottom:1rem">Data</h3>
      <div style="display:flex;gap:.75rem;flex-wrap:wrap">
        ${_viewOnly ? `<div class="view-only-banner">👁 View-only mode — no changes can be made</div>` : `
          <button class="btn-outline" id="exportBtn">Export JSON</button>
          <button class="btn-outline" id="exportViewOnlyBtn">👁 Export View-Only</button>
          <label class="btn-outline" style="cursor:pointer">Import JSON<input type="file" id="importFile" accept=".json" style="display:none"></label>
          <button class="btn-xs btn-xs-danger" id="switchProfileBtn">Switch Profile</button>
        `}
      </div>
    </div>`;

  // Section 4: Profile picture with crop modal
  document.getElementById('editPicBtn').onclick = () => document.getElementById('picFilePicker').click();
  document.getElementById('picFilePicker').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    // Section 4: open crop modal instead of direct save
    openCropModal(file, async dataUrl => {
      const ts = new Date().toISOString();
      await DB.updateProfilePic(_user, dataUrl, ts);
      await onDataChanged();
      document.getElementById('profilePicWrap').innerHTML =
        `<img src="${h(dataUrl)}" class="profile-banner-avatar-img">` +
        `<button class="profile-pic-edit" title="Change photo" id="editPicBtn">📷</button>`;
      document.getElementById('navAvatar').innerHTML = `<img src="${h(dataUrl)}" class="nav-avatar-img">`;
      document.getElementById('editPicBtn').onclick = () => document.getElementById('picFilePicker').click();
      toast('Profile picture updated!','success');
    });
    // Reset file picker so same file can be picked again
    e.target.value = '';
  };

  // Favorites — click slot to open search
  let _activeFavSlot = null;
  const openFavSearch = (slot) => {
    _activeFavSlot = slot;
    document.getElementById('favSlotLabel').textContent = slot;
    openModal('favSearchModal');
  };

  document.querySelectorAll('.fav-empty').forEach(el =>
    el.addEventListener('click', () => openFavSearch(parseInt(el.dataset.slot)))
  );
  document.querySelectorAll('.fav-edit-btn').forEach(el =>
    el.addEventListener('click', e => { e.stopPropagation(); openFavSearch(parseInt(el.dataset.slot)); })
  );
  document.getElementById('closeFavSearch').onclick  = () => closeModal('favSearchModal');
  document.getElementById('cancelFavSearch').onclick = () => closeModal('favSearchModal');

  // Fav inline search
  const favSearchSettings = await DB.getAllSettings(_user);
  new Autocomplete({
    input: document.getElementById('favSearch'),
    dropdown: document.getElementById('favDrop'),
    status: document.getElementById('favSearchStatus'),
    onSearch: async q => ({
      results: lib.filter(g => g.title.toLowerCase().includes(q.toLowerCase())).slice(0,10)
        .map(g => ({ ...g, source: 'library', slug: `local:${g.id}` }))
    }),
    onSelect: async item => {
      await DB.setFavorite(_user, _activeFavSlot, item.id);
      await onDataChanged();
      toast('Favorite saved!','success');
      closeAllModals();
      renderProfile();
    }
  });

  // Fav results list click
  document.getElementById('favResults').addEventListener('click', async e => {
    const item = e.target.closest('.fav-result-item');
    if (!item) return;
    await DB.setFavorite(_user, _activeFavSlot, item.dataset.gameId);
    await onDataChanged();
    toast('Favorite saved!','success');
    closeAllModals();
    renderProfile();
  });

  document.getElementById('clearFavBtn').onclick = async () => {
    await DB.setFavorite(_user, _activeFavSlot, null);
    await onDataChanged();
    closeAllModals();
    renderProfile();
  };

  if (_viewOnly) return; // no handlers needed for view-only

  // Export / Import
  document.getElementById('exportBtn').onclick = async () => {
    const data = await DB.exportProfile(_user);
    const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'),{href:url,download:`locallogger_${_user}_${todayISO()}.json`});
    a.click(); URL.revokeObjectURL(url);
    toast('Export downloaded!','success');
  };

  // Section 7: View-only export
  document.getElementById('exportViewOnlyBtn').onclick = async () => {
    const data = await DB.exportProfile(_user, true); // viewOnly=true
    data.viewOnly = true;
    const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'),{href:url,download:`gametracker_${_user}_viewonly_${todayISO()}.json`});
    a.click(); URL.revokeObjectURL(url);
    toast('View-only profile exported! Share this file with others.','success');
  };

  document.getElementById('importFile')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const ok   = await confirm(`Import data for "${data.username}"? Existing data will be merged.`);
      if (ok) { await DB.importProfile(data); await onDataChanged(); toast('Import complete!','success'); renderProfile(); }
    } catch(err) { toast('Import failed — invalid file','error'); }
  });

  const switchBtn = document.getElementById('switchProfileBtn');
  if (switchBtn) switchBtn.onclick = () => _nav('__profiles__');
}

/* ═══════════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════════ */
export async function renderSettings() {
  const s = await DB.getAllSettings(_user);
  const devMode = localStorage.getItem('ll_dev_mode') === '1';
  const presets = [
    ['#e8673c','Orange'],['#4a9eff','Blue'],['#9b59b6','Purple'],
    ['#4caf7d','Green'],['#e05252','Red'],['#f0b840','Yellow'],
    ['#e91e8c','Pink'],['#00bcd4','Cyan'],['#ff6b35','Ember'],
    ['#a78bfa','Lavender'],['#34d399','Mint'],['#fb923c','Peach']
  ];
  const accent  = s.accent_color||'#e8673c';
  const theme   = s.theme||'dark';
  const igdbCid = s.igdb_client_id||'';
  const igdbCs  = s.igdb_client_secret||'';
  const syncOn  = s.sync_enabled==='true';
  const ratingDisplay = s.rating_display||'stars';
  const logDefaultEnd = s.log_default_end_to_now !== 'false';
  const uiDensity    = s.ui_density    || 'balanced';
  const uiBgStyle    = s.ui_bg_style   || 'default';
  const uiAnimSpeed  = s.ui_anim_speed || 'normal';
  const uiCardStyle  = s.ui_card_style || 'glass';
  const uiPosterSize = s.ui_poster_size|| 'medium';
  const uiFont       = s.ui_font       || 'dm-sans';
  const uiShadow     = s.ui_shadow     || 'medium';
  const uiAnimsOn    = s.ui_anims      !== 'false';

  main().innerHTML = `
    <div class="page-header"><h1>Settings</h1></div>
    <div class="settings-layout">

      <!-- Appearance + UI Customization -->
      <div class="form-card">
        <div class="settings-section-title">🎨 Appearance</div>
        <div class="form-group mb-lg">
          <label>Theme</label>
          <div class="theme-toggle-group">
            <div class="theme-option${theme==='dark'?' active':''}" id="themeDark">🌙 Dark</div>
            <div class="theme-option${theme==='light'?' active':''}" id="themeLight">☀️ Light</div>
          </div>
        </div>
        <div class="form-group mb-lg">
          <label>Accent Color</label>
          <div class="accent-presets">
            ${presets.map(([c,n])=>`<button class="accent-dot${accent===c?' active':''}" style="background:${c}" title="${n}" data-color="${c}"></button>`).join('')}
          </div>
          <div class="custom-accent-row">
            <span class="label-hint">Custom:</span>
            <input type="color" id="accentPicker" value="${accent}" class="color-picker-input">
            <input type="text" id="accentHex" class="input accent-hex-input" value="${accent}" placeholder="#e8673c">
            <div class="accent-preview" id="accentPreview" style="background:${accent}"></div>
          </div>
        </div>
        <button class="btn-primary" id="saveAppearance">Save Appearance</button>
      </div>

      <!-- UI Customization — expanded panel -->
      <div class="form-card">
        <div class="settings-section-title">✨ Interface Customization</div>

        <!-- Font -->
        <div class="form-group mb-lg">
          <label>Interface Font</label>
          <div class="ui-btn-group" id="fontGroup">
            <button class="ui-btn${uiFont==='dm-sans'?' active':''}" data-font="dm-sans">DM Sans</button>
            <button class="ui-btn${uiFont==='syne'?' active':''}" data-font="syne">Syne</button>
            <button class="ui-btn${uiFont==='inter'?' active':''}" data-font="inter">Inter</button>
            <button class="ui-btn${uiFont==='manrope'?' active':''}" data-font="manrope">Manrope</button>
            <button class="ui-btn${uiFont==='geist'?' active':''}" data-font="geist">Geist</button>
          </div>
        </div>

        <!-- Card style -->
        <div class="form-group mb-lg">
          <label>Card Style</label>
          <div class="ui-btn-group" id="cardStyleGroup">
            <button class="ui-btn${uiCardStyle==='glass'?' active':''}" data-cardstyle="glass">Glass</button>
            <button class="ui-btn${uiCardStyle==='solid'?' active':''}" data-cardstyle="solid">Solid</button>
            <button class="ui-btn${uiCardStyle==='minimal'?' active':''}" data-cardstyle="minimal">Minimal</button>
            <button class="ui-btn${uiCardStyle==='neon'?' active':''}" data-cardstyle="neon">Neon</button>
          </div>
        </div>

        <!-- Background -->
        <div class="form-group mb-lg">
          <label>Background Style</label>
          <div class="bg-swatch-grid" id="bgStyleGroup">
            <div class="bg-swatch${uiBgStyle==='default'?' active':''}" data-bg="default">
              <div class="bg-swatch-preview" style="background:linear-gradient(135deg,#0a0a0d,#111116)"></div>Default
            </div>
            <div class="bg-swatch${uiBgStyle==='nebula'?' active':''}" data-bg="nebula">
              <div class="bg-swatch-preview" style="background:linear-gradient(135deg,#0d0a14,#140f20)"></div>Nebula
            </div>
            <div class="bg-swatch${uiBgStyle==='ocean'?' active':''}" data-bg="ocean">
              <div class="bg-swatch-preview" style="background:linear-gradient(135deg,#080d12,#0a1420)"></div>Ocean
            </div>
            <div class="bg-swatch${uiBgStyle==='forest'?' active':''}" data-bg="forest">
              <div class="bg-swatch-preview" style="background:linear-gradient(135deg,#080d09,#0a1410)"></div>Forest
            </div>
            <div class="bg-swatch${uiBgStyle==='pure'?' active':''}" data-bg="pure">
              <div class="bg-swatch-preview" style="background:#000000"></div>Pure Black
            </div>
            <div class="bg-swatch${uiBgStyle==='noise'?' active':''}" data-bg="noise">
              <div class="bg-swatch-preview" style="background:repeating-linear-gradient(45deg,#111 0,#111 2px,#0a0a0d 2px,#0a0a0d 8px)"></div>Noise
            </div>
          </div>
        </div>

        <!-- Density -->
        <div class="form-group mb-lg">
          <label>Spacing Density</label>
          <div class="ui-btn-group" id="densityGroup">
            <button class="ui-btn${uiDensity==='compact'?' active':''}" data-density="compact">Compact</button>
            <button class="ui-btn${uiDensity==='balanced'?' active':''}" data-density="balanced">Balanced</button>
            <button class="ui-btn${uiDensity==='spacious'?' active':''}" data-density="spacious">Spacious</button>
          </div>
        </div>

        <!-- Poster size -->
        <div class="form-group mb-lg">
          <label>Poster Size</label>
          <div class="ui-btn-group" id="posterSizeGroup">
            <button class="ui-btn${uiPosterSize==='small'?' active':''}" data-postersize="small">Small</button>
            <button class="ui-btn${uiPosterSize==='medium'?' active':''}" data-postersize="medium">Medium</button>
            <button class="ui-btn${uiPosterSize==='large'?' active':''}" data-postersize="large">Large</button>
            <button class="ui-btn${uiPosterSize==='xl'?' active':''}" data-postersize="xl">XL</button>
          </div>
        </div>

        <!-- Shadow -->
        <div class="form-group mb-lg">
          <label>Shadow Depth</label>
          <div class="ui-btn-group" id="shadowGroup">
            <button class="ui-btn${uiShadow==='none'?' active':''}" data-shadow="none">None</button>
            <button class="ui-btn${uiShadow==='soft'?' active':''}" data-shadow="soft">Soft</button>
            <button class="ui-btn${uiShadow==='medium'?' active':''}" data-shadow="medium">Medium</button>
            <button class="ui-btn${uiShadow==='deep'?' active':''}" data-shadow="deep">Deep</button>
          </div>
        </div>

        <!-- Animations -->
        <div class="form-group mb-lg">
          <label>Animations</label>
          <div class="ui-btn-group" id="animGroup">
            <button class="ui-btn${uiAnimsOn?' active':''}" data-anim="on">✨ On</button>
            <button class="ui-btn${!uiAnimsOn?' active':''}" data-anim="off">Off</button>
          </div>
          <p class="label-hint" style="margin-top:.3rem">Disable for better performance or accessibility.</p>
        </div>

        <!-- Animation speed -->
        <div class="form-group mb-lg">
          <label>Animation Speed</label>
          <div class="ui-btn-group" id="animSpeedGroup">
            <button class="ui-btn${uiAnimSpeed==='fast'?' active':''}" data-animspeed="fast">Fast</button>
            <button class="ui-btn${uiAnimSpeed==='normal'?' active':''}" data-animspeed="normal">Normal</button>
            <button class="ui-btn${uiAnimSpeed==='slow'?' active':''}" data-animspeed="slow">Slow</button>
          </div>
        </div>

        <div style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:center">
          <button class="btn-primary" id="saveUICustom">Save & Apply</button>
          <button class="btn-outline" id="resetUICustom">Reset Defaults</button>
        </div>
      </div>

      <!-- Section 10: Rating display -->
      <div class="form-card">
        <div class="settings-section-title">⭐ Ratings &amp; Reviews</div>
        <div class="form-group mb-md">
          <label>Rating display style</label>
          <div class="theme-toggle-group">
            <div class="theme-option${ratingDisplay==='stars'?' active':''}" data-rating="stars" id="ratingStars">★ Stars</div>
            <div class="theme-option${ratingDisplay==='numeric'?' active':''}" data-rating="numeric" id="ratingNumeric">4.5 / 5 Numeric</div>
          </div>
          <p class="label-hint" style="margin-top:.4rem">Stars uses Letterboxd-style display. Numeric shows the raw value.</p>
        </div>
        <button class="btn-primary" id="saveRatingDisplay">Save</button>
      </div>

      <!-- Section 10: Logging behaviour -->
      <div class="form-card">
        <div class="settings-section-title">⏱ Logging Behaviour</div>
        <div class="form-group mb-md">
          <label class="checkbox-row">
            <input type="checkbox" id="logDefaultEndNow" ${logDefaultEnd?'checked':''}>
            <span>Auto-fill end time with current time when opening log modal</span>
          </label>
          <p class="label-hint" style="margin-top:.3rem">Useful if you always log sessions immediately after finishing.</p>
        </div>
        <div class="form-group mb-md">
          <label class="checkbox-row">
            <input type="checkbox" id="autoStatusInactive" ${s.auto_status_inactive==='true'?'checked':''}>
            <span>Auto-change inactive "Playing" games to "Played"</span>
          </label>
          <p class="label-hint" style="margin-top:.3rem">If a game with status <em>Playing</em> has no session logged for 30 days, it will automatically move to <em>Played</em>. Only runs once per day when you open the dashboard. Requires at least 5 sessions and 14 days of logging history.</p>
        </div>
        <button class="btn-primary" id="saveLoggingSettings">Save</button>
      </div>

      <!-- Cloud sync -->
      <div class="form-card">
        <div class="settings-section-title">☁️ Cloud Sync</div>
        <p style="font-size:.85rem;color:var(--text2);margin-bottom:1rem;line-height:1.6">
          Sync across devices anywhere — including GitHub Pages.<br>
          Requires a free <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Worker</a>.
          See <strong>cloudflare-worker.js</strong> for 5-minute setup.
        </p>
        <div class="form-group mb-md">
          <label>Worker URL</label>
          <input type="url" id="syncWorkerUrl" class="input" placeholder="https://gametracker-sync.yourname.workers.dev"
            value="${h(s.sync_worker_url||'')}" autocomplete="off" spellcheck="false">
          <p style="font-size:.75rem;color:var(--text3);margin-top:.3rem">Leave blank to disable cloud sync. Tab sync always works without this.</p>
        </div>
        <div class="sync-toggle-row mb-md">
          <label class="toggle-label">
            <input type="checkbox" id="syncToggle" ${syncOn?'checked':''} class="toggle-input">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span id="syncToggleLabel">${syncOn?'Sync enabled':'Sync disabled'}</span>
          </label>
        </div>
        <div style="display:flex;gap:.75rem;flex-wrap:wrap">
          <button class="btn-outline" id="testWorkerBtn">Test Connection</button>
          <button class="btn-primary" id="saveSyncBtn">Save Sync Settings</button>
        </div>
        <div id="syncStatus" style="margin-top:.75rem;font-size:.82rem;color:var(--text3)">
          ${syncOn&&s.sync_worker_url?'✓ Cloud sync active':'Tab sync always on · Cloud sync off'}
        </div>
      </div>

      <!-- IGDB -->
      <div class="form-card igdb-card">
        <div class="settings-section-title">🎮 Game Database — IGDB</div>
        <div class="igdb-status-banner ${igdbCid?'igdb-connected':'igdb-disconnected'}">
          <span class="igdb-dot"></span>
          <div>
            <strong>${igdbCid?'IGDB connected':'Steam only'}</strong>
            <p>${igdbCid?'Console exclusives and all non-Steam games are searchable.':'Add IGDB credentials to search console exclusives and all games.'}</p>
          </div>
          ${igdbCid?`<button class="btn-xs" id="testIgdbBtn">Test</button>`:''}
        </div>
        ${igdbCid && !s.sync_worker_url ? `
        <div class="igdb-warning-banner">
          ⚠️ <strong>Worker URL not configured.</strong>
          IGDB search requires your Cloudflare Worker URL to work correctly —
          CORS proxies strip the authentication headers IGDB needs.
          Set your Worker URL in <strong>☁️ Cloud Sync</strong> above, then save.
        </div>` : ''}
        <div class="igdb-how-to">
          <details>
            <summary>How to get free IGDB credentials (2 min)</summary>
            <ol class="igdb-steps">
              <li>Go to <a href="https://dev.twitch.tv/console" target="_blank">dev.twitch.tv/console</a> — log in with a free Twitch account.</li>
              <li>Click <strong>Register Your Application</strong>.</li>
              <li>Name: anything. OAuth Redirect URL: <code>http://localhost</code>. Category: <strong>Application Integration</strong>.</li>
              <li>After saving → click <strong>Manage</strong> → copy the <strong>Client ID</strong>.</li>
              <li>Click <strong>New Secret</strong> → copy the <strong>Client Secret</strong>.</li>
              <li>Paste both below and save.</li>
            </ol>
          </details>
        </div>
        <div id="igdbTestResult" class="igdb-test-result" style="display:none"></div>
        <div class="form-group mb-md">
          <label>Client ID</label>
          <input type="text" id="igdbCid" class="input font-mono-input" value="${h(igdbCid)}" placeholder="xxxxxxxxxxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false">
        </div>
        <div class="form-group mb-md">
          <label>Client Secret</label>
          <div style="position:relative">
            <input type="password" id="igdbCs" class="input font-mono-input" value="${h(igdbCs)}" placeholder="••••••••••••••••••••••••" autocomplete="off">
            <button type="button" class="secret-toggle" id="toggleSecret">👁</button>
          </div>
        </div>

        <!-- Wishlist search source override -->
        <div class="form-group mb-md" style="padding-top:.75rem;border-top:1px solid var(--border)">
          <label>Wishlist search source</label>
          <div class="theme-toggle-group" style="margin-top:.4rem">
            <div class="theme-option${(s.wishlist_search_source||'steam')==='steam'?' active':''}" data-wsource="steam" id="wsourceSteam">🟦 Steam first</div>
            <div class="theme-option${s.wishlist_search_source==='igdb'?' active':''}" data-wsource="igdb" id="wsourceIGDB">🟣 IGDB first</div>
            <div class="theme-option${s.wishlist_search_source==='both'?' active':''}" data-wsource="both" id="wsourceBoth">Both</div>
          </div>
          <p class="label-hint" style="margin-top:.4rem"><strong>Steam first</strong> (default) — ensures Steam App IDs are captured so prices auto-load.<br><strong>IGDB first</strong> — for console exclusives not on Steam (no price tracking).</p>
        </div>

        <div style="display:flex;gap:.75rem;flex-wrap:wrap">
          ${igdbCid?`<button class="btn-xs btn-xs-danger" id="clearIgdb">Disconnect</button>`:''}
          <button class="btn-primary" id="saveIgdb">Save IGDB Settings</button>
        </div>
      </div>

      <!-- Section 5: Developer Options (unlocked via Easter egg) -->
      ${devMode ? `
      <div class="form-card dev-options-card">
        <div class="settings-section-title">🛠 Developer Options <span class="dev-badge">DEV</span></div>
        <p style="font-size:.8rem;color:var(--text3);margin-bottom:1rem">
          You've unlocked developer mode. These tools are safe but intended for debugging.
        </p>

        <!-- KV Request Monitor -->
        <div class="debug-tool-row">
          <div>
            <strong>☁️ KV Request Monitor</strong>
            <p class="label-hint">Live counter of Cloudflare KV reads and writes. Helps diagnose high usage. Updates every 10 seconds.</p>
          </div>
          <button class="btn-outline" id="kvMonitorToggle">Show</button>
        </div>
        <div id="kvMonitorPanel" style="display:none;margin-top:.75rem">
          <div class="kv-monitor-grid" id="kvMonitorGrid">Loading…</div>
          <div style="font-size:.75rem;color:var(--text3);margin-top:.5rem">
            Cloudflare free limits: 100,000 reads/day · 1,000 writes/day
          </div>
          <div style="display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap">
            <button class="btn-xs btn-outline" id="kvWindow10">Last 10 min</button>
            <button class="btn-xs btn-outline" id="kvWindow5">Last 5 min</button>
            <button class="btn-xs btn-outline" id="kvWindow30">Last 30 min</button>
          </div>
        </div>

        <div class="debug-tool-row" style="margin-top:1.25rem">
          <div>
            <strong>Re-import all descriptions</strong>
            <p class="label-hint">Re-fetches game descriptions from IGDB or Steam. Only overwrites description — your notes and ratings are safe.</p>
          </div>
          <button class="btn-outline" id="reimportDescBtn">Run</button>
        </div>
        <div id="reimportDescStatus" style="font-size:.8rem;color:var(--text3);margin-top:.5rem;display:none"></div>

        <div class="debug-tool-row" style="margin-top:1.25rem">
          <div>
            <strong>Force sync push</strong>
            <p class="label-hint">Manually push all current data to the cloud sync relay.</p>
          </div>
          <button class="btn-outline" id="forceSyncPushBtn">Push</button>
        </div>
        <div id="forceSyncStatus" style="font-size:.8rem;color:var(--text3);margin-top:.5rem;display:none"></div>

        <div class="debug-tool-row" style="margin-top:1.25rem">
          <div>
            <strong>Clear search cache</strong>
            <p class="label-hint">Removes all cached search and time-to-beat results. Forces fresh lookups on next search.</p>
          </div>
          <button class="btn-outline" id="clearSearchCacheBtn">Clear</button>
        </div>
        <div id="clearCacheStatus" style="font-size:.8rem;color:var(--text3);margin-top:.5rem;display:none"></div>

        <div class="debug-tool-row" style="margin-top:1.25rem">
          <div>
            <strong>Export all data</strong>
            <p class="label-hint">Download a full JSON backup of your library, sessions, wishlist, and settings.</p>
          </div>
          <button class="btn-outline" id="exportDataBtn">Export JSON</button>
        </div>

        <div class="debug-tool-row" style="margin-top:1.25rem">
          <div>
            <strong>Inspect local data</strong>
            <p class="label-hint">Show counts of all stored objects in IndexedDB.</p>
          </div>
          <button class="btn-outline" id="inspectDbBtn">Inspect</button>
        </div>
        <div id="inspectDbResult" style="font-size:.8rem;color:var(--text3);margin-top:.5rem;display:none"></div>

        <div class="debug-tool-row" style="margin-top:1.25rem">
          <div>
            <strong>Re-import IGDB Ratings</strong>
            <p class="label-hint">Fetches IGDB average ratings for all games in your library. Does not overwrite your personal ratings.</p>
          </div>
          <button class="btn-outline" id="reimportIGDBRatingsBtn">Run</button>
        </div>
        <div id="reimportIGDBRatingsStatus" style="font-size:.8rem;color:var(--text3);margin-top:.5rem;display:none"></div>
        <div id="reimportIGDBRatingsLog" style="font-size:.72rem;font-family:var(--font-mono);color:var(--text3);margin-top:.35rem;max-height:160px;overflow-y:auto;display:none"></div>

        <div class="debug-tool-row" style="margin-top:1.25rem">
          <div>
            <strong>Re-import Time to Beat</strong>
            <p class="label-hint">Fetches IGDB time-to-beat data (Rushed / Normally / Completionist) for all library games. Requires IGDB credentials. Results cached per-game.</p>
          </div>
          <button class="btn-outline" id="reimportHLTBBtn">Run</button>
        </div>
        <div id="reimportHLTBStatus" style="font-size:.8rem;color:var(--text3);margin-top:.5rem;display:none"></div>
        <div id="reimportHLTBLog" style="font-size:.72rem;font-family:var(--font-mono);color:var(--text3);margin-top:.35rem;max-height:160px;overflow-y:auto;display:none"></div>
      </div>` : ''}

      <!-- Section 6: Version number -->
      <div style="text-align:center;padding:1.5rem 0 .5rem;color:var(--text3);font-size:.75rem;font-family:var(--font-mono)">
        LocalLogger — Version 1.4
      </div>

    </div>`;

  // Theme
  function setTheme(t) {
    document.querySelectorAll('.theme-option').forEach(o=>o.classList.remove('active'));
    document.getElementById(`theme${t==='dark'?'Dark':'Light'}`).classList.add('active');
  }
  document.getElementById('themeDark').onclick  = () => setTheme('dark');
  document.getElementById('themeLight').onclick = () => setTheme('light');

  // Accent
  function updateAccent(c) {
    document.getElementById('accentHex').value = c;
    document.getElementById('accentPicker').value = c;
    document.getElementById('accentPreview').style.background = c;
    document.querySelectorAll('.accent-dot').forEach(d=>d.classList.toggle('active', d.dataset.color===c));
  }
  document.querySelectorAll('.accent-dot').forEach(d=>d.addEventListener('click',()=>updateAccent(d.dataset.color)));
  document.getElementById('accentPicker').addEventListener('input', e=>updateAccent(e.target.value));
  document.getElementById('accentHex').addEventListener('input', e=>{ if(/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) updateAccent(e.target.value); });

  document.getElementById('saveAppearance').addEventListener('click', async () => {
    const t = document.querySelector('.theme-option.active')?.id==='themeDark'?'dark':'light';
    const c = document.getElementById('accentHex').value;
    if (!/^#[0-9A-Fa-f]{6}$/.test(c)) { toast('Invalid hex color','error'); return; }
    await DB.setSetting(_user,'accent_color',c);
    await DB.setSetting(_user,'theme',t);
    document.documentElement.style.setProperty('--accent',c);
    document.documentElement.style.setProperty('--accent2',c+'cc');
    document.documentElement.setAttribute('data-theme',t);
    const metaTheme = document.getElementById('themeColorMeta');
    if (metaTheme) metaTheme.content = t === 'light' ? '#f2f1ed' : '#0e0e10';
    toast('Appearance saved!','success');
  });

  // Section 10: Rating display
  document.querySelectorAll('[data-rating]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-rating]').forEach(e=>e.classList.remove('active'));
      el.classList.add('active');
    });
  });
  document.getElementById('saveRatingDisplay').addEventListener('click', async () => {
    const val = document.querySelector('[data-rating].active')?.dataset.rating || 'stars';
    await DB.setSetting(_user, 'rating_display', val);
    toast('Rating display saved!', 'success');
  });

  // ── UI Customization handlers ──
  function uiBtnGroupHandler(groupId, attrName) {
    document.querySelectorAll(`#${groupId} .ui-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${groupId} .ui-btn`).forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }
  ['fontGroup','cardStyleGroup','densityGroup','posterSizeGroup','shadowGroup','animGroup','animSpeedGroup'].forEach(g => uiBtnGroupHandler(g, g));

  document.querySelectorAll('#bgStyleGroup .bg-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('#bgStyleGroup .bg-swatch').forEach(s=>s.classList.remove('active'));
      sw.classList.add('active');
    });
  });

  document.getElementById('saveUICustom').addEventListener('click', async () => {
    const font       = document.querySelector('#fontGroup .ui-btn.active')?.dataset.font || 'dm-sans';
    const cardStyle  = document.querySelector('#cardStyleGroup .ui-btn.active')?.dataset.cardstyle || 'glass';
    const bgStyle    = document.querySelector('#bgStyleGroup .bg-swatch.active')?.dataset.bg || 'default';
    const density    = document.querySelector('#densityGroup .ui-btn.active')?.dataset.density || 'balanced';
    const posterSize = document.querySelector('#posterSizeGroup .ui-btn.active')?.dataset.postersize || 'medium';
    const shadow     = document.querySelector('#shadowGroup .ui-btn.active')?.dataset.shadow || 'medium';
    const animOn     = document.querySelector('#animGroup .ui-btn.active')?.dataset.anim !== 'off';
    const animSpeed  = document.querySelector('#animSpeedGroup .ui-btn.active')?.dataset.animspeed || 'normal';
    await DB.setSetting(_user,'ui_font',font);
    await DB.setSetting(_user,'ui_card_style',cardStyle);
    await DB.setSetting(_user,'ui_bg_style',bgStyle);
    await DB.setSetting(_user,'ui_density',density);
    await DB.setSetting(_user,'ui_poster_size',posterSize);
    await DB.setSetting(_user,'ui_shadow',shadow);
    await DB.setSetting(_user,'ui_anims',animOn?'true':'false');
    await DB.setSetting(_user,'ui_anim_speed',animSpeed);
    applyUICustomization({ ui_font:font, ui_card_style:cardStyle, ui_bg_style:bgStyle,
      ui_density:density, ui_poster_size:posterSize, ui_shadow:shadow,
      ui_anims:animOn?'true':'false', ui_anim_speed:animSpeed });
    toast('Interface settings saved!','success');
  });

  document.getElementById('resetUICustom').addEventListener('click', async () => {
    const defaults = { ui_font:'dm-sans', ui_card_style:'glass', ui_bg_style:'default',
      ui_density:'balanced', ui_poster_size:'medium', ui_shadow:'medium',
      ui_anims:'true', ui_anim_speed:'normal' };
    for (const [k,v] of Object.entries(defaults)) await DB.setSetting(_user,k,v);
    applyUICustomization(defaults);
    toast('Reset to defaults!','info');
    renderSettings();
  });

  // Section 10: Logging settings
  document.getElementById('saveLoggingSettings').addEventListener('click', async () => {
    const checked = document.getElementById('logDefaultEndNow').checked;
    await DB.setSetting(_user, 'log_default_end_to_now', checked ? 'true' : 'false');
    const autoInactive = document.getElementById('autoStatusInactive')?.checked;
    await DB.setSetting(_user, 'auto_status_inactive', autoInactive ? 'true' : 'false');
    toast('Logging settings saved!', 'success');
  });

  // Sync toggle label
  document.getElementById('syncToggle').addEventListener('change', e => {
    document.getElementById('syncToggleLabel').textContent = e.target.checked ? 'Sync enabled' : 'Sync disabled';
  });

  // Test worker
  document.getElementById('testWorkerBtn').addEventListener('click', async () => {
    const url = document.getElementById('syncWorkerUrl').value.trim();
    const statusEl = document.getElementById('syncStatus');
    if (!url) { statusEl.textContent = '⚠ Enter a worker URL first'; statusEl.style.color = 'var(--yellow)'; return; }
    statusEl.textContent = '⏳ Testing…'; statusEl.style.color = 'var(--text3)';
    const { testWorker } = await import('./sync.js');
    const r = await testWorker(url);
    statusEl.textContent = r.ok ? `✓ Connected! Worker is online (${r.ts?.slice(0,10)})` : `✗ ${r.error}`;
    statusEl.style.color = r.ok ? 'var(--green)' : 'var(--red)';
  });

  // Save sync
  document.getElementById('saveSyncBtn').onclick = async () => {
    const enabled   = document.getElementById('syncToggle').checked;
    const workerUrl = document.getElementById('syncWorkerUrl').value.trim();
    await DB.setSetting(_user, 'sync_enabled',    enabled ? 'true' : 'false');
    await DB.setSetting(_user, 'sync_worker_url', workerUrl);
    const { startSync, stopSync } = await import('./sync.js');
    const { setIGDBWorkerUrl }    = await import('./search.js');
    setIGDBWorkerUrl(workerUrl || null);   // keep IGDB proxy in sync
    if (enabled) await startSync(_user, workerUrl || null);
    else stopSync();
    toast(enabled ? 'Sync settings saved!' : 'Sync disabled', 'success');
    renderSettings();
  };

  // IGDB + wishlist source
  document.querySelectorAll('[data-wsource]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-wsource]').forEach(e=>e.classList.remove('active'));
      el.classList.add('active');
    });
  });

  document.getElementById('saveIgdb').addEventListener('click', async () => {
    const cid    = document.getElementById('igdbCid').value.trim();
    const cs     = document.getElementById('igdbCs').value.trim();
    const wsrc   = document.querySelector('[data-wsource].active')?.dataset.wsource || 'steam';
    await DB.setSetting(_user,'igdb_client_id',cid);
    await DB.setSetting(_user,'igdb_client_secret',cs);
    await DB.setSetting(_user,'wishlist_search_source', wsrc);
    toast(cid?'IGDB settings saved!':'IGDB credentials cleared','success');
    renderSettings();
  });

  document.getElementById('clearIgdb')?.addEventListener('click', async () => {
    await DB.setSetting(_user,'igdb_client_id','');
    await DB.setSetting(_user,'igdb_client_secret','');
    toast('IGDB disconnected','info');
    renderSettings();
  });

  document.getElementById('toggleSecret')?.addEventListener('click', () => {
    const i = document.getElementById('igdbCs');
    if (i) i.type = i.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('testIgdbBtn')?.addEventListener('click', async () => {
    const el = document.getElementById('igdbTestResult');
    const workerSaved = (await DB.getAllSettings(_user)).sync_worker_url;
    el.style.display='block'; el.className='igdb-test-result'; el.textContent='Testing…';
    const cid = document.getElementById('igdbCid').value.trim();
    const cs  = document.getElementById('igdbCs').value.trim();
    const r   = await testIGDB(cid, cs);
    el.className = `igdb-test-result ${r.ok ? 'igdb-test-ok' : 'igdb-test-fail'}`;
    if (r.ok) {
      el.textContent = r.count > 0
        ? `✓ Connected — ${r.count} results for "Halo"`
        : `⚠ Auth succeeded but 0 results. Your credentials may need IGDB access enabled — see note below.`;
      if (r.count === 0) {
        el.className = 'igdb-test-result igdb-test-fail';
        el.innerHTML = `⚠ Auth succeeded but search returned 0 results.<br><br>
          <strong>Fix:</strong> Go to
          <a href="https://api.igdb.com" target="_blank" style="color:inherit;text-decoration:underline">api.igdb.com</a>
          and click <strong>Get a free key</strong> — you need to request IGDB API access separately from your Twitch app.
          Once approved (usually instant), click Test again.`;
      }
    } else {
      el.textContent = `✗ ${r.error}`;
    }
  });

  // Section 10 + Section 1: Re-import descriptions debug tool
  document.getElementById('reimportDescBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('reimportDescStatus');
    statusEl.style.display='block'; statusEl.style.color='var(--text3)';
    statusEl.textContent='⏳ Starting…';
    const settings = await DB.getAllSettings(_user);
    const games = await DB.getGames(_user);
    let updated = 0, failed = 0;
    for (const game of games) {
      try {
        statusEl.textContent = `⏳ ${updated+failed+1}/${games.length} — ${game.title}`;
        const desc = await fetchDescriptionForGame(game, settings);
        if (desc) {
          await DB.putGame(_user, { ...game, description: desc, updatedAt: new Date().toISOString() });
          updated++;
        } else { failed++; }
        await new Promise(r => setTimeout(r, 300));
      } catch { failed++; }
    }
    await onDataChanged();
    statusEl.textContent = `✓ Done — ${updated} updated, ${failed} not found or no description.`;
    statusEl.style.color = updated > 0 ? 'var(--green)' : 'var(--yellow)';
  });

  // Section 10: Force sync push
  document.getElementById('forceSyncPushBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('forceSyncStatus');
    statusEl.style.display='block'; statusEl.textContent='⏳ Pushing…'; statusEl.style.color='var(--text3)';
    try {
      await onDataChanged();
      statusEl.textContent = '✓ Push complete!'; statusEl.style.color = 'var(--green)';
    } catch(e) {
      statusEl.textContent = `✗ ${e.message}`; statusEl.style.color = 'var(--red)';
    }
  });

  // KV Monitor panel
  let _kvWindow = 10 * 60 * 1000;
  let _kvRefreshTimer = null;
  let _kvOpen = false;

  function renderKVMonitor() {
    const panel = document.getElementById('kvMonitorPanel');
    if (!panel || !_kvOpen) return;
    const grid = document.getElementById('kvMonitorGrid');
    const { reads, writes, total, windowMinutes } = getKVStats(_kvWindow);
    const readsPerHour  = Math.round(reads  / (windowMinutes / 60));
    const writesPerHour = Math.round(writes / (windowMinutes / 60));
    // Daily projection
    const projReads  = readsPerHour  * 24;
    const projWrites = writesPerHour * 24;
    const readPct    = Math.min(100, Math.round((projReads  / 100000) * 100));
    const writePct   = Math.min(100, Math.round((projWrites / 1000)   * 100));
    grid.innerHTML = `
      <div class="kv-stat-row">
        <span class="kv-stat-label">Window</span>
        <span class="kv-stat-val">Last ${windowMinutes} min</span>
      </div>
      <div class="kv-stat-row">
        <span class="kv-stat-label">📖 Reads</span>
        <span class="kv-stat-val">${reads} <span style="color:var(--text3);font-size:.8rem">(~${readsPerHour}/hr)</span></span>
      </div>
      <div class="kv-stat-row">
        <span class="kv-stat-label">✍️ Writes</span>
        <span class="kv-stat-val kv-writes-val${writePct > 80 ? ' kv-danger' : writePct > 50 ? ' kv-warn' : ''}">${writes} <span style="color:var(--text3);font-size:.8rem">(~${writesPerHour}/hr)</span></span>
      </div>
      <div class="kv-stat-row">
        <span class="kv-stat-label">Total requests</span>
        <span class="kv-stat-val">${total}</span>
      </div>
      <div style="margin-top:.75rem">
        <div class="kv-proj-label">Projected daily writes: <strong>${projWrites}</strong> / 1,000 free
          <span class="kv-proj-pct${writePct>80?' kv-danger':writePct>50?' kv-warn':''}">${writePct}%</span>
        </div>
        <div class="kv-bar-track"><div class="kv-bar-fill${writePct>80?' kv-danger':writePct>50?' kv-warn':''}" style="width:${writePct}%"></div></div>
      </div>
      <div style="margin-top:.5rem">
        <div class="kv-proj-label">Projected daily reads: <strong>${projReads}</strong> / 100,000 free
          <span class="kv-proj-pct${readPct>80?' kv-danger':readPct>50?' kv-warn':''}">${readPct}%</span>
        </div>
        <div class="kv-bar-track"><div class="kv-bar-fill${readPct>80?' kv-danger':readPct>50?' kv-warn':''}" style="width:${readPct}%"></div></div>
      </div>
      <div style="font-size:.72rem;color:var(--text3);margin-top:.6rem">
        ℹ️ Only counts requests made in this browser tab since it was opened.
        Cloudflare's dashboard shows the true total.
      </div>`;
  }

  // Section 4/5: Dev options button handlers
  document.getElementById('clearSearchCacheBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('clearCacheStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Clearing…';
    try {
      const { clearSearchCache } = await import('./db.js');
      await clearSearchCache();
      statusEl.textContent = '✓ Search and HLTB cache cleared. Next search will fetch fresh results.';
    } catch(e) { statusEl.textContent = `✗ ${e.message}`; }
  });

  document.getElementById('inspectDbBtn')?.addEventListener('click', async () => {
    const el = document.getElementById('inspectDbResult');
    el.style.display = 'block'; el.textContent = 'Inspecting…';
    try {
      const games    = await DB.getGames(_user);
      const sessions = await DB.getSessions(_user);
      const wishlist = (await DB.getWishlist(_user)).length;
      el.innerHTML = `Games: <strong>${games.length}</strong> · Sessions: <strong>${sessions.length}</strong> · Wishlist: <strong>${wishlist}</strong><br>User: <strong>${_user}</strong> · Dev mode: active`;
    } catch(e) { el.textContent = `✗ ${e.message}`; }
  });

  // Re-import IGDB Ratings
  document.getElementById('reimportIGDBRatingsBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('reimportIGDBRatingsStatus');
    const logEl    = document.getElementById('reimportIGDBRatingsLog');
    statusEl.style.display = 'block';
    logEl.style.display    = 'block';
    logEl.innerHTML        = '';
    statusEl.style.color   = 'var(--text3)';

    const addLog = (msg, isError = false) => {
      const line = document.createElement('div');
      line.style.color = isError ? 'var(--red)' : '';
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const settings = await DB.getAllSettings(_user);
    if (!settings.igdb_client_id || !settings.igdb_client_secret) {
      statusEl.textContent = '✗ IGDB credentials not configured. Go to Settings → IGDB.';
      statusEl.style.color = 'var(--red)';
      return;
    }

    const games = (await DB.getGames(_user)).filter(g => g.status !== 'wishlist');
    let updated = 0, skipped = 0, failed = 0;

    statusEl.textContent = `⏳ Processing 0 / ${games.length}…`;

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      statusEl.textContent = `⏳ ${i + 1} / ${games.length} — ${game.title}`;
      try {
        const result = await fetchIGDBRatingForGame(game, settings);
        if (result?.rating) {
          await DB.putGame(_user, { ...game, igdb_rating: result.rating, igdb_rating_count: result.count, updatedAt: new Date().toISOString() });
          addLog(`✓ ${game.title} → ${result.rating}/100 (${result.count} votes)`);
          updated++;
        } else {
          addLog(`— ${game.title}: no rating found`);
          skipped++;
        }
      } catch(e) {
        addLog(`✗ ${game.title}: ${e.message}`, true);
        failed++;
      }
      // Rate-limit: 200ms between requests to stay under IGDB 4 req/s limit
      await new Promise(r => setTimeout(r, 220));
    }

    await onDataChanged();
    const color = updated > 0 ? 'var(--green)' : failed > 0 ? 'var(--red)' : 'var(--yellow)';
    statusEl.textContent = `✓ Done — ${updated} updated, ${skipped} no data, ${failed} errors`;
    statusEl.style.color = color;
  });

  // Re-import Time to Beat Data
  document.getElementById('reimportHLTBBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('reimportHLTBStatus');
    const logEl    = document.getElementById('reimportHLTBLog');
    statusEl.style.display = 'block';
    logEl.style.display    = 'block';
    logEl.innerHTML        = '';
    statusEl.style.color   = 'var(--text3)';

    const addLog = (msg, isError = false) => {
      const line = document.createElement('div');
      line.style.color = isError ? 'var(--red)' : '';
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const settings = await DB.getAllSettings(_user);
    if (!settings.igdb_client_id || !settings.igdb_client_secret) {
      statusEl.textContent = '✗ IGDB credentials required — set them in Settings first';
      statusEl.style.color = 'var(--red)';
      return;
    }

    const games = (await DB.getGames(_user)).filter(g => g.status !== 'wishlist');
    let found = 0, notFound = 0, failed = 0;

    statusEl.textContent = `⏳ Processing 0 / ${games.length}…`;

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      statusEl.textContent = `⏳ ${i + 1} / ${games.length} — ${game.title}`;
      const devLogs = [];
      try {
        const ttb = await fetchTimeToBeat(game, settings, { forceRefresh: true, devLog: msg => devLogs.push(msg) });
        if (ttb && (ttb.hastily || ttb.normally || ttb.completely)) {
          const parts = [];
          if (ttb.hastily)    parts.push(`Rushed: ${ttb.hastily}h`);
          if (ttb.normally)   parts.push(`Normal: ${ttb.normally}h`);
          if (ttb.completely) parts.push(`100%: ${ttb.completely}h`);
          addLog(`✓ ${game.title} → ${parts.join(', ')}`);
          found++;
        } else {
          addLog(`— ${game.title}: no data`);
          if (devLogs.length) devLogs.forEach(l => addLog(`  ${l}`));
          notFound++;
        }
      } catch(e) {
        addLog(`✗ ${game.title}: ${e.message}`, true);
        failed++;
      }
      // IGDB rate limit: 4 req/s — 300ms gap is safe (two calls per game)
      await new Promise(r => setTimeout(r, 300));
    }

    const color = found > 0 ? 'var(--green)' : failed > 0 ? 'var(--red)' : 'var(--yellow)';
    statusEl.textContent = `✓ Done — ${found} found, ${notFound} no data, ${failed} errors`;
    statusEl.style.color = color;
  });

  document.getElementById('kvMonitorToggle')?.addEventListener('click', () => {
    _kvOpen = !_kvOpen;
    const panel = document.getElementById('kvMonitorPanel');
    const btn   = document.getElementById('kvMonitorToggle');
    panel.style.display = _kvOpen ? 'block' : 'none';
    btn.textContent     = _kvOpen ? 'Hide'  : 'Show';
    if (_kvOpen) {
      renderKVMonitor();
      _kvRefreshTimer = setInterval(renderKVMonitor, 10_000);
    } else {
      clearInterval(_kvRefreshTimer);
    }
  });

  ['kvWindow5','kvWindow10','kvWindow30'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      _kvWindow = id === 'kvWindow5' ? 5*60000 : id === 'kvWindow30' ? 30*60000 : 10*60000;
      renderKVMonitor();
    });
  });

  // Section 10: Export all data
  document.getElementById('exportDataBtn')?.addEventListener('click', async () => {
    const [games, sessions, wishlist, favorites, settings2, profile] = await Promise.all([
      DB.getGames(_user), DB.getSessions(_user), DB.getWishlist(_user),
      DB.getFavorites(_user), DB.getAllSettings(_user), DB.getProfile(_user),
    ]);
    const data = { version:2, exported: new Date().toISOString(), username: _user, games, sessions, wishlist, favorites, settings: settings2, profile };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `gametracker-${_user}-${todayISO()}.json`;
    a.click(); URL.revokeObjectURL(url);
    toast('Data exported!', 'success');
  });
}
