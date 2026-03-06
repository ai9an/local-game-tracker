/* js/app.js — SPA entry point */

import { openDB, getProfiles, createProfile, touchProfile, deleteProfile, getAllSettings, getProfile } from './db.js';
import * as Views from './views.js';
import { toast, confirm, h } from './ui.js';
import { initSync, startSync, stopSync, discoverRemoteProfiles } from './sync.js';

let currentUser = null;

/* ── Profile selector ─────────────────────────────── */
async function showProfileSelector() {
  const profiles = (await getProfiles()).sort((a,b) => new Date(b.lastLogin) - new Date(a.lastLogin));
  const app = document.getElementById('app');
  document.getElementById('app-nav').style.display = 'none';

  // Try to find a saved worker URL from any local profile
  let workerUrl = null;
  for (const p of profiles) {
    try {
      const s = await getAllSettings(p.username);
      if (s.sync_worker_url) { workerUrl = s.sync_worker_url; break; }
    } catch(e) {}
  }

  // Discover remote profiles in background
  let remoteUsers = [];
  if (workerUrl) {
    try { remoteUsers = await discoverRemoteProfiles(workerUrl); } catch(e) {}
  }

  // Filter remote users that aren't already local
  const localNames  = new Set(profiles.map(p => p.username.toLowerCase()));
  const remoteExtra = remoteUsers.filter(u => !localNames.has(u.toLowerCase()));

  app.innerHTML = `
    <div class="profile-screen">
      <div class="profile-screen-card">
        <div class="profile-screen-logo">🎮</div>
        <h1 class="profile-screen-title">Game Tracker</h1>
        <p class="profile-screen-sub">Your personal gaming journal</p>

        ${profiles.length ? `
        <div class="profile-list" id="profileList">
          ${profiles.map(p => {
            const picHtml = p.pic
              ? `<img src="${h(p.pic)}" class="profile-list-avatar-img">`
              : `<div class="profile-list-avatar">${p.username[0].toUpperCase()}</div>`;
            return `
            <div class="profile-list-item" data-username="${h(p.username)}">
              ${picHtml}
              <div class="profile-list-info">
                <span class="profile-list-name">${h(p.username)}</span>
                <span class="profile-list-date">Last login: ${new Date(p.lastLogin).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span>
              </div>
              <button class="btn-xs btn-xs-danger profile-del" data-username="${h(p.username)}" title="Delete profile">×</button>
            </div>`;
          }).join('')}
        </div>
        <div class="profile-divider"><span>or</span></div>` : ''}

        ${remoteExtra.length ? `
        <div style="margin-bottom:.75rem">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text3);margin-bottom:.5rem">☁️ Also on sync server</div>
          <div class="profile-list" id="remoteProfileList">
            ${remoteExtra.map(u => `
            <div class="profile-list-item profile-list-item-remote" data-username="${h(u)}">
              <div class="profile-list-avatar" style="background:var(--blue)">${u[0].toUpperCase()}</div>
              <div class="profile-list-info">
                <span class="profile-list-name">${h(u)}</span>
                <span class="profile-list-date">Tap to sync from server</span>
              </div>
            </div>`).join('')}
          </div>
        </div>
        <div class="profile-divider"><span>or</span></div>` : ''}

        <div class="form-group">
          <label>${profiles.length || remoteExtra.length ? 'Create new profile' : 'Enter your name to get started'}</label>
          <div class="profile-create-row">
            <input type="text" id="newUsername" class="input" placeholder="Your name…" maxlength="40" autocomplete="off">
            <button class="btn-primary" id="createProfileBtn">Create</button>
          </div>
          <p id="createError" style="color:var(--red);font-size:.78rem;margin-top:.3rem;display:none"></p>
        </div>

        <p class="profile-privacy-note">🔒 Data stored locally in your browser${workerUrl ? ' · ☁️ Cloud sync active' : ''}</p>
      </div>
    </div>`;

  document.getElementById('profileList')?.addEventListener('click', async e => {
    const delBtn = e.target.closest('.profile-del');
    const item   = e.target.closest('.profile-list-item');
    if (delBtn) {
      e.stopPropagation();
      const name = delBtn.dataset.username;
      const ok   = await confirm(`Delete profile "${name}"? All your data will be permanently lost.`);
      if (ok) { await deleteProfile(name); showProfileSelector(); }
      return;
    }
    if (item) loginAs(item.dataset.username);
  });

  document.getElementById('remoteProfileList')?.addEventListener('click', async e => {
    const item = e.target.closest('.profile-list-item-remote');
    if (!item) return;
    const name = item.dataset.username;
    // Create locally then login (sync will pull their data automatically)
    try { await createProfile(name); } catch(e) {}
    loginAs(name);
  });

  const input = document.getElementById('newUsername');
  const errEl = document.getElementById('createError');

  async function doCreate() {
    const name = input.value.trim();
    errEl.style.display = 'none';
    if (!name) { input.focus(); return; }
    if (name.length < 2) { errEl.textContent = 'Name must be at least 2 characters.'; errEl.style.display = 'block'; return; }
    const all = await getProfiles();
    if (all.some(p => p.username.toLowerCase() === name.toLowerCase())) {
      errEl.textContent = 'A profile with that name already exists.'; errEl.style.display = 'block'; return;
    }
    await createProfile(name);
    loginAs(name);
  }

  document.getElementById('createProfileBtn').addEventListener('click', doCreate);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });
  if (!profiles.length && !remoteExtra.length) setTimeout(() => input.focus(), 100);
}

/* ── Login ────────────────────────────────────────── */
async function loginAs(username) {
  await touchProfile(username);
  currentUser = username;

  const settings = await getAllSettings(username);

  // Apply saved theme & accent immediately
  if (settings.accent_color) {
    document.documentElement.style.setProperty('--accent',  settings.accent_color);
    document.documentElement.style.setProperty('--accent2', settings.accent_color + 'cc');
    // Also persist to localStorage for the FOUC-prevention script
    try {
      localStorage.setItem('gt_accent_' + username, settings.accent_color);
      localStorage.setItem('gt_theme_'  + username, settings.theme || 'dark');
    } catch(e) {}
  }
  if (settings.theme) {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }

  Views.init(username, navigate);

  // Start sync
  initSync(username);
  if (settings.sync_enabled === 'true') {
    await startSync(username, settings.sync_worker_url || null);
  }

  // Refresh view on sync events
  window.addEventListener('gt:synced', () => {
    const path = location.hash.slice(1) || 'dashboard';
    dispatch(path);
  });

  document.getElementById('app-nav').style.display = 'flex';
  await updateNav(username);

  const hash = location.hash.slice(1) || 'dashboard';
  dispatch(hash);
}

async function updateNav(username) {
  const profile = await getProfile(username);
  document.getElementById('navUsername').textContent = username;
  const avatarEl = document.getElementById('navAvatar');
  if (profile?.pic) {
    avatarEl.innerHTML = `<img src="${h(profile.pic)}" class="nav-avatar-img">`;
  } else {
    avatarEl.innerHTML = '';
    avatarEl.textContent = username[0].toUpperCase();
  }
}

/* ── Navigation ───────────────────────────────────── */
function setActiveNav(view) {
  document.querySelectorAll('.nav-links button, .mobile-menu button').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === view);
  });
  // Close mobile menu on navigate
  const menu = document.getElementById('mobileMenu');
  if (menu) menu.style.display = 'none';
  const btn = document.getElementById('hamburgerBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

export function navigate(path, push = true) {
  if (path === '__profiles__') { stopSync(); currentUser = null; showProfileSelector(); return; }
  const hash = '#' + path;
  if (push && location.hash !== hash) history.pushState(null, '', hash);
  dispatch(path);
}

function dispatch(path) {
  if (!currentUser) { showProfileSelector(); return; }
  const exactMap = {
    'dashboard': () => { setActiveNav('dashboard'); Views.renderDashboard(); },
    'library':   () => { setActiveNav('library');   Views.renderLibrary(); },
    'log':       () => { setActiveNav('log');        Views.renderLog(); },
    'stats':     () => { setActiveNav('stats');      Views.renderStats(); },
    'wishlist':  () => { setActiveNav('wishlist');   Views.renderWishlist(); },
    'browse':    () => { setActiveNav('browse');     Views.renderBrowse(); },
    'profile':   () => { setActiveNav('profile');    Views.renderProfile(); },
    'settings':  () => { setActiveNav('settings');   Views.renderSettings(); },
    'add':       () => { setActiveNav('library');    Views.renderGameForm(null); },
  };
  if (exactMap[path]) { exactMap[path](); return; }

  const gm = path.match(/^game\/([^/]+)$/);
  if (gm) { setActiveNav('library'); Views.renderGameDetail(gm[1]); return; }

  const em = path.match(/^game\/([^/]+)\/edit$/);
  if (em) { setActiveNav('library'); Views.renderGameForm(em[1]); return; }

  dispatch('dashboard');
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-nav]');
  if (!el) return;
  e.preventDefault();
  navigate(el.dataset.nav);
});

window.addEventListener('popstate', () => {
  const hash = location.hash.slice(1) || 'dashboard';
  if (currentUser) dispatch(hash);
});

/* ── Hamburger menu wiring ────────────────────────── */
document.addEventListener('click', e => {
  const btn = e.target.closest('#hamburgerBtn');
  if (!btn) return;
  const menu = document.getElementById('mobileMenu');
  if (!menu) return;
  const open = menu.style.display === 'flex';
  menu.style.display = open ? 'none' : 'flex';
  btn.setAttribute('aria-expanded', String(!open));
});

// Close menu on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#mobileMenu') && !e.target.closest('#hamburgerBtn')) {
    const menu = document.getElementById('mobileMenu');
    if (menu) menu.style.display = 'none';
  }
});

/* ── Boot ─────────────────────────────────────────── */
async function boot() {
  await openDB();
  const remembered = sessionStorage.getItem('gt_user');
  if (remembered) {
    const profiles = await getProfiles();
    if (profiles.find(p => p.username === remembered)) {
      await loginAs(remembered); return;
    }
  }
  showProfileSelector();
}

window.addEventListener('beforeunload', () => {
  if (currentUser) sessionStorage.setItem('gt_user', currentUser);
});

boot().catch(err => {
  console.error('Boot error:', err);
  document.getElementById('app').innerHTML =
    `<div style="text-align:center;padding:4rem;color:var(--red)">Failed to initialize: ${err.message}</div>`;
});
