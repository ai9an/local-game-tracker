/* js/views.js — All page renderers */

import * as DB from './db.js';
import { searchGames, getGameDetail, testIGDB, fetchSteamPrice, fetchTrending } from './search.js';
import { h, fmtHours, fmtStars, fmtDate, fmtPrice, todayISO, parseDuration,
         toast, confirm, openModal, closeModal, closeAllModals,
         Autocomplete, attachDurationCalc, setupCoverPreview } from './ui.js';
import { onDataChanged } from './sync.js';

let _user = null;
let _nav  = null;

export function init(username, navigateFn) {
  _user = username;
  _nav  = navigateFn;
}

function main() { return document.getElementById('app'); }

/* ── Status helpers ───────────────────────────────── */
const ALL_STATUSES = ['playing','completed','100%','backlog','paused','dropped'];

function statusBadge(status) {
  const cls = status === '100%' ? 'badge-100' : `badge-${status}`;
  const lbl = status === '100%' ? '💯 100%' : status;
  return `<span class="badge ${cls}">${lbl}</span>`;
}

function completionIcon(status) {
  if (status === '100%')      return '💯';
  if (status === 'completed') return '✅';
  return '';
}

/* ═══════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════ */
export async function renderDashboard() {
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
export async function renderLibrary() {
  const games = (await DB.getGames(_user)).filter(g=>g.status!=='wishlist');

  main().innerHTML = `
    <div class="page-header">
      <h1>Library</h1>
      <button class="btn-primary" data-nav="add">+ Add Game</button>
    </div>
    <div class="filter-bar">
      ${['all',...ALL_STATUSES].map(s=>`<button class="filter-pill${s==='all'?' active':''}" data-status="${s}">${s==='all'?'All':s==='100%'?'💯 100%':s.charAt(0).toUpperCase()+s.slice(1)}</button>`).join('')}
      <input type="search" class="input filter-search" id="libSearch" placeholder="Search…">
      <select class="input" id="libSort" style="max-width:150px">
        <option value="title">A–Z</option>
        <option value="hours">Most played</option>
        <option value="recent">Recently played</option>
        <option value="rating">Rating</option>
        <option value="added">Date added</option>
      </select>
    </div>
    <div class="game-grid" id="gameGrid"></div>`;

  let filter='all', sortBy='title', query='';

  function sortGames(arr) {
    return [...arr].sort((a,b)=>{
      if (sortBy==='hours')  return (Number(b.total_hours)||0)-(Number(a.total_hours)||0);
      if (sortBy==='recent') return (b.last_played||'').localeCompare(a.last_played||'');
      if (sortBy==='rating') return (Number(b.rating)||0)-(Number(a.rating)||0);
      if (sortBy==='added')  return (b.date_added||'').localeCompare(a.date_added||'');
      return (a.title||'').localeCompare(b.title||'');
    });
  }

  function render() {
    let list = games;
    if (filter!=='all') list = list.filter(g=>g.status===filter);
    if (query) list = list.filter(g=>(g.title||'').toLowerCase().includes(query.toLowerCase()));
    list = sortGames(list);
    const grid = document.getElementById('gameGrid');
    if (!list.length) {
      grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><h3>No games found</h3><p>Try a different filter.</p></div>`;
      return;
    }
    grid.innerHTML = list.map(g => `
      <div class="game-card" data-nav="game/${g.id}">
        ${g.cover_url
          ? `<img src="${h(g.cover_url)}" class="game-card-poster" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="game-card-ph" style="display:none">${h((g.title||'').slice(0,2).toUpperCase())}</div>`
          : `<div class="game-card-ph">${h((g.title||'').slice(0,2).toUpperCase())}</div>`}
        <div class="game-card-badges">
          ${statusBadge(g.status)}
          ${g.via_subscription?'<span class="sub-badge">📦 Sub</span>':''}
        </div>
        ${g.status==='100%'?'<div class="card-100-badge">💯</div>':''}
        <div class="game-card-info">
          <div class="game-card-title">${h(g.title)}</div>
          <div class="game-card-meta">${fmtHours(g.total_hours)}${g.rating?` · ${fmtStars(g.rating)}`:''}</div>
        </div>
      </div>`).join('');
  }

  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.status;
      render();
    });
  });
  document.getElementById('libSearch').addEventListener('input', e => { query=e.target.value; render(); });
  document.getElementById('libSort').addEventListener('change', e => { sortBy=e.target.value; render(); });
  render();
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

  main().innerHTML = `
    <div class="game-hero">
      <div class="game-hero-cover-wrap">
        ${game.cover_url
          ? `<img src="${h(game.cover_url)}" class="game-hero-cover" id="heroCover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="game-hero-cover-ph" style="display:none">${h((game.title||'').slice(0,2).toUpperCase())}</div>`
          : `<div class="game-hero-cover-ph">${h((game.title||'').slice(0,2).toUpperCase())}</div>`}
        ${coverAlts.length > 1 ? `<button class="cover-change-btn" id="changeCoverBtn" title="Change poster">🖼</button>` : ''}
      </div>
      <div class="game-hero-meta">
        <h1>${h(game.title)}</h1>
        <div class="game-meta-row">
          ${statusBadge(game.status)}
          ${game.via_subscription?'<span class="sub-badge">📦 Played via Subscription</span>':''}
          ${game.platform?`<span class="game-meta-item">📱 ${h(game.platform)}</span>`:''}
          ${game.release_year?`<span class="game-meta-item">📅 ${h(game.release_year)}</span>`:''}
          ${game.developer?`<span class="game-meta-item">🛠 ${h(game.developer)}</span>`:''}
          ${game.genre?`<span class="game-meta-item">🎭 ${h(game.genre)}</span>`:''}
        </div>
        ${game.description?`<p class="game-desc">${h(game.description)}</p>`:''}
        <div class="game-meta-row" style="margin-top:.75rem">
          <span class="game-meta-item">⏱ <strong>${fmtHours(game.total_hours)}</strong> played</span>
          ${game.rating?`<span class="game-meta-item rating-display">${fmtStars(game.rating)}</span>`:''}
          ${game.date_completed?`<span class="game-meta-item">✅ Completed ${fmtDate(game.date_completed)}</span>`:''}
        </div>
        ${game.review?`<blockquote style="border-left:3px solid var(--accent);padding-left:1rem;margin-top:.75rem;color:var(--text2);font-size:.9rem;line-height:1.7">${h(game.review)}</blockquote>`:''}
        <div class="game-actions">
          <button class="btn-primary" data-nav="game/${id}/edit">Edit Game</button>
          <button class="btn-outline" id="addSessionBtn">+ Log Session</button>
          ${game.status!=='completed'&&game.status!=='100%'
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

    <!-- Log session modal -->
    <div class="modal-overlay" id="sessionModal">
      <div class="modal">
        <div class="modal-head"><h3>Log Session</h3><button class="modal-close" id="closeSessionModal">×</button></div>
        <form id="sessionForm">
          <div class="two-col mb-md">
            <div class="form-group"><label>Date</label><input type="date" name="date" class="input" value="${todayISO()}" required></div>
            <div class="form-group"><label>Duration</label></div>
          </div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Start time</label><input type="time" name="start_time" class="input" required></div>
            <div class="form-group"><label>End time</label><input type="time" name="end_time" class="input" required></div>
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
                <span>✅ Completed</span>
              </label>
              <label class="complete-type-opt">
                <input type="radio" name="completion_type" value="100%">
                <span>💯 100% Completed</span>
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

  document.getElementById('addSessionBtn').onclick = () => openModal('sessionModal');
  document.getElementById('closeSessionModal').onclick = () => closeModal('sessionModal');
  document.getElementById('cancelSession').onclick = () => closeModal('sessionModal');
  document.getElementById('markCompleteBtn')?.addEventListener('click', () => openModal('completeModal'));
  const closeCompleteEl = document.getElementById('closeCompleteModal');
  if (closeCompleteEl) closeCompleteEl.onclick = () => closeModal('completeModal');
  const cancelCompleteEl = document.getElementById('cancelComplete');
  if (cancelCompleteEl) cancelCompleteEl.onclick = () => closeModal('completeModal');

  attachDurationCalc(document.getElementById('sessionForm'));

  document.getElementById('sessionForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd  = new FormData(e.target);
    const s   = fd.get('start_time'), en = fd.get('end_time');
    const dur = parseDuration(s, en);
    await DB.putSession(_user, { game_id:id, date:fd.get('date'), start_time:s, end_time:en, duration:dur, notes:fd.get('notes')||'' });
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
═══════════════════════════════════════════════════ */
export async function renderGameForm(id) {
  const isEdit = !!id;
  const game   = isEdit ? await DB.getGame(_user, id) : null;
  const settings = await DB.getAllSettings(_user);

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
                ${ALL_STATUSES.map(s=>`<option value="${s}"${(game?.status||'backlog')===s?' selected':''}>${s==='100%'?'💯 100% Completed':s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Platform</label><input type="text" name="platform" class="input" value="${h(game?.platform||'')}" placeholder="PC, PS5, Xbox…"></div>
            <div class="form-group"><label>Genre</label><input type="text" name="genre" class="input" value="${h(game?.genre||'')}" placeholder="RPG, FPS…"></div>
          </div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Release Year</label><input type="text" name="release_year" class="input" value="${h(game?.release_year||'')}" placeholder="2024"></div>
            <div class="form-group"><label>Hours Played (manual)</label><input type="number" name="manual_hours" class="input" value="${game?.manual_hours||0}" min="0" step="0.5"></div>
          </div>
          <div class="form-group mb-md"><label>Developer</label><input type="text" name="developer" class="input" value="${h(game?.developer||'')}" placeholder="Studio name…"></div>
          <div class="form-group mb-md"><label>Publisher</label><input type="text" name="publisher" class="input" value="${h(game?.publisher||'')}" placeholder="Publisher name…"></div>
          <div class="form-group mb-md"><label>Description</label><textarea name="description" class="input" rows="3" placeholder="Brief description…">${h(game?.description||'')}</textarea></div>

          <div class="form-group mb-md">
            <label class="checkbox-row"><input type="checkbox" name="via_subscription" ${game?.via_subscription?'checked':''}> <span>Played via subscription (Game Pass, PS Plus, etc.)</span></label>
          </div>

          ${isEdit ? `
          <div class="two-col mb-md">
            <div class="form-group"><label>Rating (0.5–5)</label><input type="number" name="rating" class="input" value="${h(game?.rating||'')}" min=".5" max="5" step=".5" placeholder="4.5"></div>
            <div class="form-group"><label>Date Completed</label><input type="date" name="date_completed" class="input" value="${h(game?.date_completed||'')}"></div>
          </div>
          <div class="form-group mb-md"><label>Review / Notes</label><textarea name="review" class="input" rows="3">${h(game?.review||'')}</textarea></div>` : ''}

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
        ${game?.cover_alts?.length > 1 ? `
        <div class="cover-alts-scroll" id="coverAltsRow">
          ${game.cover_alts.map(url=>`
            <img src="${h(url)}" class="cover-alt-thumb${url===game.cover_url?' selected':''}" data-url="${h(url)}" loading="lazy" title="Select this poster">`).join('')}
        </div>` : '<div id="coverAltsRow" class="cover-alts-scroll" style="display:none"></div>'}
      </div>
    </div>`;

  // Cover preview wired to hidden input
  const coverInput = document.getElementById('coverUrlInput');
  setupCoverPreview(coverInput, document.getElementById('coverPreview'));
  if (game?.cover_url) {
    document.getElementById('coverPreview').innerHTML = `<img src="${h(game.cover_url)}" style="width:100%;height:100%;object-fit:cover">`;
  }

  // Cover alt thumbnails click
  document.getElementById('coverAltsRow')?.addEventListener('click', e => {
    const thumb = e.target.closest('.cover-alt-thumb');
    if (!thumb) return;
    const url = thumb.dataset.url;
    coverInput.value = url;
    coverInput.dispatchEvent(new Event('input'));
    document.querySelectorAll('.cover-alt-thumb').forEach(t=>t.classList.toggle('selected', t.dataset.url===url));
  });

  // Autocomplete
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

      document.querySelector('[name="title"]').value       = merged.title||'';
      document.querySelector('[name="platform"]').value    = merged.platform||'';
      document.querySelector('[name="developer"]').value   = merged.developer||'';
      document.querySelector('[name="publisher"]').value   = merged.publisher||'';
      document.querySelector('[name="description"]').value = merged.description||'';
      if (merged.release_year) document.querySelector('[name="release_year"]').value = merged.release_year;
      if (merged.genres) document.querySelector('[name="genre"]').value = merged.genres;

      // Update cover
      if (merged.cover_url) {
        coverInput.value = merged.cover_url;
        coverInput.dispatchEvent(new Event('input'));
      }

      // Show cover alts
      const alts = merged.cover_alts||[];
      const altsRow = document.getElementById('coverAltsRow');
      if (alts.length > 1) {
        altsRow.style.display = 'flex';
        altsRow.innerHTML = alts.map(url=>
          `<img src="${h(url)}" class="cover-alt-thumb${url===merged.cover_url?' selected':''}" data-url="${h(url)}" loading="lazy" title="Select poster">`
        ).join('');
        altsRow.addEventListener('click', ev => {
          const thumb = ev.target.closest('.cover-alt-thumb');
          if (!thumb) return;
          const url = thumb.dataset.url;
          coverInput.value = url;
          coverInput.dispatchEvent(new Event('input'));
          altsRow.querySelectorAll('.cover-alt-thumb').forEach(t=>t.classList.toggle('selected', t.dataset.url===url));
        });
      }

      acStat.textContent = `✓ Loaded: ${merged.title}`;
    }
  });

  // Delete button (edit mode)
  document.getElementById('deleteGameTopBtn')?.addEventListener('click', async () => {
    const ok = await confirm(`Delete "${game.title}"? This will also remove all sessions.`);
    if (ok) { await DB.deleteGame(_user, id); await onDataChanged(); toast(`"${game.title}" deleted`,'info'); _nav('library'); }
  });

  // Form submit
  document.getElementById('gameForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd  = new FormData(e.target);
    const now = todayISO();

    // Collect cover_alts from current alts row
    const altThumbs = [...document.querySelectorAll('.cover-alt-thumb')].map(t=>t.dataset.url).filter(Boolean);

    const obj = {
      title:        fd.get('title').trim(),
      status:       fd.get('status'),
      platform:     fd.get('platform').trim(),
      genre:        fd.get('genre').trim(),
      release_year: fd.get('release_year').trim(),
      cover_url:    coverInput.value.trim(),
      cover_alts:   altThumbs.length ? altThumbs : (coverInput.value ? [coverInput.value] : []),
      developer:    fd.get('developer').trim(),
      publisher:    fd.get('publisher').trim(),
      description:  fd.get('description').trim(),
      manual_hours: parseFloat(fd.get('manual_hours')||0),
      via_subscription: fd.get('via_subscription')==='on',
      rating:       fd.get('rating')||null,
      review:       fd.get('review')||'',
      date_completed: fd.get('date_completed')||null,
      date_added:   game?.date_added||now,
    };
    if (!obj.title) { toast('Title is required','error'); return; }
    if (isEdit) {
      obj.id              = id;
      obj.calculated_hours = game.calculated_hours||0;
      obj.total_hours      = obj.manual_hours + (game.calculated_hours||0);
      obj.last_played      = game.last_played||null;
    } else {
      obj.total_hours      = obj.manual_hours;
      obj.calculated_hours = 0;
    }
    await DB.putGame(_user, obj);
    await onDataChanged();
    toast(isEdit?'Game updated!':'Game added to library!','success');
    _nav(isEdit?`game/${id}`:'library');
  });
}

/* ═══════════════════════════════════════════════════
   BROWSE (Trending / Steam Featured)
═══════════════════════════════════════════════════ */
export async function renderBrowse() {
  main().innerHTML = `
    <div class="page-header">
      <h1>Browse</h1>
      <button class="btn-outline" id="refreshBrowse">↻ Refresh</button>
    </div>
    <div id="browseContent">
      <div class="browse-loading">
        <div class="spinner"></div>
        <p>Loading trending games from Steam…</p>
      </div>
    </div>`;

  document.getElementById('refreshBrowse').onclick = async () => {
    const { bustCache } = await import('./db.js');
    await bustCache('browse:trending');
    renderBrowse();
  };

  await _loadBrowse();
}

async function _loadBrowse() {
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

  const games  = await DB.getGames(_user);
  const wishlist = await DB.getWishlist(_user);

  container.innerHTML = sections.map(section => `
    <div class="browse-section">
      <div class="card-head"><h2 class="browse-section-title">${h(section.label)}</h2></div>
      <div class="browse-grid">
        ${section.games.map(g => {
          const inLib  = games.find(lg => lg.title.toLowerCase() === g.title.toLowerCase());
          const inWish = wishlist.find(w => w.title.toLowerCase() === g.title.toLowerCase());
          const disc   = g.discount > 0 ? `<div class="browse-discount">-${g.discount}%</div>` : '';
          const price  = g.price_final ? `<div class="browse-price${g.discount>0?' on-sale':''}">£${g.price_final}${g.discount>0&&g.price_orig?` <s style="opacity:.5;font-size:.75em">£${g.price_orig}</s>`:''}</div>` : '';
          return `
          <div class="browse-card">
            <div class="browse-card-img-wrap">
              <img src="${h(g.header_url||g.cover_url)}" class="browse-card-img" loading="lazy"
                onerror="this.src='${h(g.cover_url||'')}';this.onerror=null">
              ${disc}
            </div>
            <div class="browse-card-body">
              <div class="browse-card-title">${h(g.title)}</div>
              ${price}
              <div class="browse-card-actions">
                ${inLib
                  ? `<span class="btn-xs btn-xs-muted" title="Already in library">✓ In Library</span>`
                  : `<button class="btn-xs btn-primary browse-add-lib" data-slug="${h(g.slug)}" data-title="${h(g.title)}" data-cover="${h(g.cover_url)}" data-appid="${h(g.steam_appid||'')}">+ Library</button>`}
                ${inWish
                  ? `<span class="btn-xs btn-xs-muted" title="Already in wishlist">♥ Wishlisted</span>`
                  : `<button class="btn-xs browse-add-wish" data-slug="${h(g.slug)}" data-title="${h(g.title)}" data-cover="${h(g.cover_url)}" data-price="${h(g.price_final||'')}" data-discount="${g.discount}" data-appid="${h(g.steam_appid||'')}">♡ Wishlist</button>`}
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');

  container.addEventListener('click', async e => {
    const libBtn  = e.target.closest('.browse-add-lib');
    const wishBtn = e.target.closest('.browse-add-wish');

    if (libBtn) {
      const title = libBtn.dataset.title;
      const cover = libBtn.dataset.cover;
      const slug  = libBtn.dataset.slug;
      await DB.putGame(_user, {
        title, cover_url: cover, slug, status: 'backlog',
        date_added: todayISO(), manual_hours: 0, calculated_hours: 0, total_hours: 0,
      });
      await onDataChanged();
      toast(`"${title}" added to library!`,'success');
      libBtn.outerHTML = `<span class="btn-xs btn-xs-muted">✓ In Library</span>`;
    }

    if (wishBtn) {
      const title    = wishBtn.dataset.title;
      const cover    = wishBtn.dataset.cover;
      const price    = wishBtn.dataset.price;
      const discount = parseInt(wishBtn.dataset.discount)||0;
      await DB.putWishlistItem(_user, {
        title, cover_url: cover, priority: 2,
        price_current: price ? `£${price}` : null,
        on_sale: discount > 0,
        price_updated: todayISO(),
      });
      await onDataChanged();
      toast(`"${title}" added to wishlist!`,'success');
      wishBtn.outerHTML = `<span class="btn-xs btn-xs-muted">♥ Wishlisted</span>`;
    }
  });
}

/* ═══════════════════════════════════════════════════
   DAILY LOG
═══════════════════════════════════════════════════ */
export async function renderLog() {
  const games    = await DB.getGames(_user);
  const sessions = await DB.getSessions(_user);
  const libGames = games.filter(g=>g.status!=='wishlist');

  const byDate = {};
  for (const s of sessions) {
    if (!byDate[s.date]) byDate[s.date]=[];
    const gm = games.find(g=>g.id===s.game_id);
    byDate[s.date].push({ ...s, game: gm });
  }
  const sortedDays = Object.entries(byDate).sort((a,b)=>b[0].localeCompare(a[0]));

  main().innerHTML = `
    <div class="page-header">
      <h1>Play Log</h1>
      <button class="btn-primary" id="openLogModal">+ Log Session</button>
    </div>

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
            <div class="form-group"><label>Duration</label></div>
          </div>
          <div class="two-col mb-md">
            <div class="form-group"><label>Start time</label><input type="time" name="start_time" class="input" required></div>
            <div class="form-group"><label>End time</label><input type="time" name="end_time" class="input" required></div>
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

  document.getElementById('openLogModal').onclick  = () => openModal('logModal');
  document.getElementById('closeLogModal').onclick = () => closeModal('logModal');
  document.getElementById('cancelLog').onclick     = () => closeModal('logModal');
  attachDurationCalc(document.getElementById('logForm'));

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
        const savedId = await DB.putGame(_user, newGame);
        // putGame returns undefined, need to fetch it
        const allGames = await DB.getGames(_user);
        const found = allGames.find(g => g.title === title && !g.id.startsWith('local'));
        gameId = found?.id;
      }
    }

    const s   = fd.get('start_time'), en = fd.get('end_time');
    const dur = parseDuration(s, en);
    await DB.putSession(_user, {
      game_id: gameId||null, title_fallback: gameId?null:title,
      date: fd.get('date'), start_time: s, end_time: en, duration: dur,
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
   STATISTICS
═══════════════════════════════════════════════════ */
export async function renderStats() {
  const games    = await DB.getGames(_user);
  const sessions = await DB.getSessions(_user);
  const lib      = games.filter(g=>g.status!=='wishlist');

  const top_games   = [...lib].filter(g=>Number(g.total_hours)>0).sort((a,b)=>Number(b.total_hours)-Number(a.total_hours)).slice(0,10);
  const avg_rating  = lib.filter(g=>g.rating).length
    ? (lib.filter(g=>g.rating).reduce((t,g)=>t+Number(g.rating),0)/lib.filter(g=>g.rating).length).toFixed(2) : null;
  const status_counts = [...ALL_STATUSES].map(s=>({ status:s, cnt:lib.filter(g=>g.status===s).length }));

  const now = new Date(); const weekMap={};
  for (let i=11;i>=0;i--) {
    const d = new Date(now); d.setDate(d.getDate()-i*7);
    weekMap[d.toISOString().slice(0,10)] = 0;
  }
  for (const s of sessions) {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-84);
    if (new Date(s.date) < cutoff) continue;
    const nearest = Object.keys(weekMap).sort().reverse().find(k=>k<=s.date);
    if (nearest) weekMap[nearest] += Number(s.duration)||0;
  }
  const weekData = Object.entries(weekMap).sort();

  main().innerHTML = `
    <div class="page-header"><h1>Statistics</h1></div>
    <div class="stat-tiles">
      <div class="stat-tile"><div class="stat-tile-val">${lib.length}</div><div class="stat-tile-label">Games tracked</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${lib.filter(g=>g.status==='completed'||g.status==='100%').length}</div><div class="stat-tile-label">Completed</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${lib.filter(g=>g.status==='100%').length > 0 ? `<span style="color:var(--gold)">💯 ${lib.filter(g=>g.status==='100%').length}</span>` : '—'}</div><div class="stat-tile-label">100% Completed</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${fmtHours(lib.reduce((t,g)=>t+(Number(g.total_hours)||0),0))}</div><div class="stat-tile-label">Total hours</div></div>
      <div class="stat-tile"><div class="stat-tile-val">${avg_rating?`★${avg_rating}`:'—'}</div><div class="stat-tile-label">Avg rating</div></div>
    </div>

    <div class="two-col mt-lg">
      <div class="card">
        <div class="card-head"><h3>Most Played</h3></div>
        <div class="card-body">
          ${top_games.length ? `<div class="chart-bars">
            ${top_games.map(g=>{
              const max = Number(top_games[0].total_hours)||1;
              const pct = Math.round((Number(g.total_hours)/max)*100);
              return `<div class="bar-item"><span class="bar-label">${completionIcon(g.status)} ${h(g.title)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-val">${fmtHours(g.total_hours)}</span></div>`;
            }).join('')}
          </div>` : '<p style="color:var(--text3)">No hours logged yet.</p>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Library by Status</h3></div>
        <div class="card-body">
          <div class="chart-bars">
            ${status_counts.map(sc=>{
              const max = Math.max(...status_counts.map(x=>x.cnt),1);
              const pct = Math.round((sc.cnt/max)*100);
              return `<div class="bar-item"><span class="bar-label ${sc.status==='100%'?'badge badge-100':'badge badge-'+sc.status}">${sc.status==='100%'?'💯 100%':sc.status}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-val">${sc.cnt}</span></div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="card mt-lg">
      <div class="card-head"><h3>Weekly Playtime (last 12 weeks)</h3></div>
      <div class="card-body">
        ${weekData.every(([,v])=>v===0) ? '<p style="color:var(--text3)">No sessions in this period.</p>' : `
        <div class="chart-bars">
          ${weekData.map(([wk,hrs])=>{
            const max = Math.max(...weekData.map(([,v])=>v),1);
            const pct = Math.round((hrs/max)*100);
            return `<div class="bar-item"><span class="bar-label" style="min-width:90px;font-size:.72rem">${wk.slice(5)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-val">${fmtHours(hrs)}</span></div>`;
          }).join('')}
        </div>`}
      </div>
    </div>`;

  setTimeout(()=>{
    document.querySelectorAll('.bar-fill').forEach(b=>{
      const w=b.style.width; b.style.width='0'; b.style.transition='none';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{ b.style.transition='width .9s cubic-bezier(.4,0,.2,1)'; b.style.width=w; }));
    });
  }, 80);
}

/* ═══════════════════════════════════════════════════
   WISHLIST
═══════════════════════════════════════════════════ */
export async function renderWishlist() {
  const items    = await DB.getWishlist(_user);
  const settings = await DB.getAllSettings(_user);
  const sorted   = [...items].sort((a,b)=>(a.priority||2)-(b.priority||2)||a.title.localeCompare(b.title));

  main().innerHTML = `
    <div class="page-header">
      <h1>Wishlist</h1>
      <div style="display:flex;gap:.5rem">
        <button class="btn-outline" id="refreshPricesBtn">↻ Update Prices</button>
        <button class="btn-primary" id="openWishModal">+ Add to Wishlist</button>
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
              ${item.price_low    ? `<span class="wish-price-low">Low: ${h(item.price_low)}</span>` : ''}
              ${item.price_updated ? `<span class="wish-price-date">Updated ${fmtDate(item.price_updated)}</span>` : ''}
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

  // Wishlist autocomplete
  const wishSettings = await DB.getAllSettings(_user);
  new Autocomplete({
    input: document.getElementById('wishSearch'),
    dropdown: document.getElementById('wishAcDrop'),
    status: document.getElementById('wishStatus'),
    onSearch: q => searchGames(q, wishSettings),
    onSelect: item => {
      document.querySelector('#wishForm [name="title"]').value   = item.title||'';
      document.querySelector('#wishForm [name="platform"]').value = item.platform||'';
      document.getElementById('wishCoverUrl').value = item.cover_url||'';
      if (item.steam_appid) document.getElementById('wishAppId').value = item.steam_appid;
      document.getElementById('wishStatus').textContent = `✓ ${item.title}`;
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
  const avg_rating  = lib.filter(g=>g.rating).length
    ? (lib.filter(g=>g.rating).reduce((t,g)=>t+Number(g.rating),0)/lib.filter(g=>g.rating).length).toFixed(1)
    : null;

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
              ? `${g.cover_url?`<img src="${h(g.cover_url)}" class="fav-cover" loading="lazy" onerror="this.style.display='none'">`:``}
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
            ${g.cover_url?`<img src="${h(g.cover_url)}" class="recent-cover" loading="lazy">`:
              `<div class="recent-placeholder">${h((g.title||'').slice(0,2).toUpperCase())}</div>`}
            <div class="recent-info">
              <span class="recent-title">${h(g.title)}</span>
              <span class="recent-hours">${fmtHours(g.total_hours)}</span>
            </div>
          </div>`).join('')}
      </div>
    </div>`:''}

    <div class="form-card">
      <h3 style="font-size:.9rem;font-weight:700;margin-bottom:1rem">Data</h3>
      <div style="display:flex;gap:.75rem;flex-wrap:wrap">
        <button class="btn-outline" id="exportBtn">Export JSON</button>
        <label class="btn-outline" style="cursor:pointer">Import JSON<input type="file" id="importFile" accept=".json" style="display:none"></label>
        <button class="btn-xs btn-xs-danger" id="switchProfileBtn">Switch Profile</button>
      </div>
    </div>`;

  // Profile picture
  document.getElementById('editPicBtn').onclick = () => document.getElementById('picFilePicker').click();
  document.getElementById('picFilePicker').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      const dataUrl = ev.target.result;
      await DB.updateProfilePic(_user, dataUrl);
      await onDataChanged();
      // Update avatar in nav and profile page
      document.getElementById('profilePicWrap').innerHTML =
        `<img src="${h(dataUrl)}" class="profile-banner-avatar-img">` +
        `<button class="profile-pic-edit" title="Change photo" id="editPicBtn">📷</button>`;
      document.getElementById('navAvatar').innerHTML = `<img src="${h(dataUrl)}" class="nav-avatar-img">`;
      document.getElementById('editPicBtn').onclick = () => document.getElementById('picFilePicker').click();
      toast('Profile picture updated!','success');
    };
    reader.readAsDataURL(file);
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

  // Export / Import
  document.getElementById('exportBtn').onclick = async () => {
    const data = await DB.exportProfile(_user);
    const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'),{href:url,download:`gametracker_${_user}_${todayISO()}.json`});
    a.click(); URL.revokeObjectURL(url);
    toast('Export downloaded!','success');
  };

  document.getElementById('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const ok   = await confirm(`Import data for "${data.username}"? Existing data will be merged.`);
      if (ok) { await DB.importProfile(data); await onDataChanged(); toast('Import complete!','success'); renderProfile(); }
    } catch(err) { toast('Import failed — invalid file','error'); }
  });

  document.getElementById('switchProfileBtn').onclick = () => _nav('__profiles__');
}

/* ═══════════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════════ */
export async function renderSettings() {
  const s = await DB.getAllSettings(_user);
  const presets = [['#e8673c','Orange'],['#4a9eff','Blue'],['#9b59b6','Purple'],['#4caf7d','Green'],['#e05252','Red'],['#f0b840','Yellow'],['#e91e8c','Pink'],['#00bcd4','Cyan']];
  const accent  = s.accent_color||'#e8673c';
  const theme   = s.theme||'dark';
  const igdbCid = s.igdb_client_id||'';
  const igdbCs  = s.igdb_client_secret||'';
  const syncOn  = s.sync_enabled==='true';

  main().innerHTML = `
    <div class="page-header"><h1>Settings</h1></div>
    <div class="settings-layout">

      <div class="form-card">
        <div class="settings-section-title">Appearance</div>
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

      <div class="form-card">
        <div class="settings-section-title">☁️ Cloud Sync</div>
        <p style="font-size:.85rem;color:var(--text2);margin-bottom:1rem;line-height:1.6">
          Sync across devices anywhere — including GitHub Pages.<br>
          Requires a free <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Worker</a>.
          See <strong>cloudflare-worker.js</strong> in the project files for 5-minute setup instructions.
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

      <div class="form-card igdb-card">
        <div class="settings-section-title">Game Database — IGDB</div>
        <div class="igdb-status-banner ${igdbCid?'igdb-connected':'igdb-disconnected'}">
          <span class="igdb-dot"></span>
          <div>
            <strong>${igdbCid?'IGDB connected':'Steam only'}</strong>
            <p>${igdbCid?'Console exclusives and all non-Steam games are searchable.':'Add IGDB credentials to search console exclusives and all games.'}</p>
          </div>
          ${igdbCid?`<button class="btn-xs" id="testIgdbBtn">Test</button>`:''}
        </div>
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
        <div style="display:flex;gap:.75rem;flex-wrap:wrap">
          ${igdbCid?`<button class="btn-xs btn-xs-danger" id="clearIgdb">Disconnect</button>`:''}
          <button class="btn-primary" id="saveIgdb">Save IGDB Credentials</button>
        </div>
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
    toast('Appearance saved!','success');
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
    if (enabled) await startSync(_user, workerUrl || null);
    else stopSync();
    toast(enabled ? 'Sync settings saved!' : 'Sync disabled', 'success');
    renderSettings();
  };

  // IGDB
  document.getElementById('saveIgdb').addEventListener('click', async () => {
    const cid = document.getElementById('igdbCid').value.trim();
    const cs  = document.getElementById('igdbCs').value.trim();
    await DB.setSetting(_user,'igdb_client_id',cid);
    await DB.setSetting(_user,'igdb_client_secret',cs);
    toast(cid?'IGDB credentials saved!':'IGDB credentials cleared','success');
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
    el.style.display='block'; el.className='igdb-test-result'; el.textContent='Testing…';
    const cid = document.getElementById('igdbCid').value.trim();
    const cs  = document.getElementById('igdbCs').value.trim();
    const r   = await testIGDB(cid,cs);
    el.className = `igdb-test-result ${r.ok?'igdb-test-ok':'igdb-test-fail'}`;
    el.textContent = r.ok ? `✓ Connected — ${r.count} results for "Fortnite"` : `✗ ${r.error}`;
  });
}
