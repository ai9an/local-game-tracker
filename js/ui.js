/* js/ui.js — Shared UI utilities */

/* ── Escape ────────────────────────────────────────── */
export function h(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Format helpers ────────────────────────────────── */
export function fmtHours(v) {
  if (v == null || v === '') return '—';
  v = parseFloat(v);
  if (isNaN(v) || v === 0) return '0h';
  if (v < 1) return `${Math.round(v*60)}m`;
  return `${v.toFixed(1)}h`;
}
export function fmtStars(r) {
  if (r == null) return '—';
  r = parseFloat(r);
  return '★'.repeat(Math.floor(r)) + (r%1>=.5?'½':'') + '☆'.repeat(5-Math.floor(r)-(r%1>=.5?1:0));
}
export function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d.slice(0,10)+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
  catch { return d; }
}
export function fmtPrice(p) {
  if (p == null || p === '') return null;
  return typeof p === 'number' ? `£${p.toFixed(2)}` : String(p);
}
export function todayISO() { return new Date().toISOString().slice(0,10); }
export function parseDuration(start, end) {
  const [sh,sm] = start.split(':').map(Number);
  const [eh,em] = end.split(':').map(Number);
  let m = (eh*60+em)-(sh*60+sm);
  if (m <= 0) m += 1440;
  return +(m/60).toFixed(4);
}

/* ── Toast ─────────────────────────────────────────── */
export function toast(msg, type='success', ms=3500) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-in'));
  setTimeout(() => {
    el.classList.replace('toast-in','toast-out');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

/* ── Modal ─────────────────────────────────────────── */
export function openModal(id) {
  const m = document.getElementById(id);
  if (m) { m.style.display='flex'; document.body.style.overflow='hidden'; }
}
export function closeModal(id) {
  const m = document.getElementById(id);
  if (m) { m.style.display='none'; document.body.style.overflow=''; }
}
export function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display='none'; });
  document.body.style.overflow='';
}
document.addEventListener('keydown', e => { if (e.key==='Escape') closeAllModals(); });
document.addEventListener('click', e => { if (e.target.classList.contains('modal-overlay')) closeAllModals(); });

/* ── Confirm dialog ────────────────────────────────── */
export function confirm(msg) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal modal-sm">
      <div class="modal-head"><h3>Confirm</h3></div>
      <p style="color:var(--text2);font-size:.9rem;line-height:1.6;margin-bottom:.5rem">${h(msg)}</p>
      <div class="modal-actions">
        <button class="btn-outline" id="_cc">Cancel</button>
        <button class="btn-danger"  id="_co">Delete</button>
      </div></div>`;
    document.body.appendChild(ov);
    ov.style.display='flex';
    ov.querySelector('#_co').onclick = () => { ov.remove(); resolve(true); };
    ov.querySelector('#_cc').onclick = () => { ov.remove(); resolve(false); };
  });
}

/* ── Cover img helper ──────────────────────────────── */
export function coverImgHtml(game, cls='') {
  const src   = game?.cover_url || '';
  const label = (game?.title||'??').slice(0,2).toUpperCase();
  if (src) return `<img src="${h(src)}" alt="${h(game.title)}" class="${cls}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling?.style&&(this.nextElementSibling.style.display='flex')"><div class="cover-placeholder" style="display:none">${label}</div>`;
  return `<div class="cover-placeholder">${label}</div>`;
}

/* ── Autocomplete widget ────────────────────────────── */
export class Autocomplete {
  constructor({ input, dropdown, status, onSearch, onSelect }) {
    this.input    = input;
    this.dropdown = dropdown;
    this.status   = status;
    this.onSearch = onSearch;   // async fn(query) → { results:[] }
    this.onSelect = onSelect;   // fn(item)
    this.items    = [];
    this.active   = -1;
    this.timer    = null;
    this._bind();
  }
  _bind() {
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      const q = this.input.value.trim();
      if (q.length < 2) { this.hide(); return; }
      if (this.status) this.status.textContent = 'Searching…';
      this.timer = setTimeout(() => this._search(q), 380);
    });
    this.input.addEventListener('keydown', e => {
      if (e.key==='ArrowDown') { e.preventDefault(); this._move(1); }
      else if (e.key==='ArrowUp') { e.preventDefault(); this._move(-1); }
      else if (e.key==='Enter' && this.active>=0) { e.preventDefault(); this._pick(this.active); }
      else if (e.key==='Escape') this.hide();
    });
    document.addEventListener('click', e => {
      if (!this.input.contains(e.target) && !this.dropdown.contains(e.target)) this.hide();
    });
  }
  async _search(q) {
    try {
      const res = await this.onSearch(q);
      this.items = res.results || [];
      this.active = -1;
      if (!this.items.length) {
        if (this.status) this.status.textContent = 'No results — try a different spelling or fill in manually';
        this.dropdown.style.display='none';
        return;
      }
      const srcs = [...new Set(this.items.map(i => i.source==='igdb'?'IGDB':'Steam'))].join(' + ');
      if (this.status) this.status.textContent = `${this.items.length} result${this.items.length!==1?'s':''} from ${srcs}`;
      this._render();
    } catch(e) {
      if (this.status) this.status.textContent = 'Search unavailable — fill in manually';
      this.dropdown.style.display='none';
    }
  }
  _render() {
    this.dropdown.innerHTML = '';
    this.items.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'autocomplete-item';
      const src   = item.source||'steam';
      const bdg   = src==='igdb' ? '<span class="source-badge source-igdb">IGDB</span>' : '<span class="source-badge source-steam">Steam</span>';
      const meta  = [item.release_year, item.genres].filter(Boolean).join(' · ');
      const img   = item.cover_url
        ? `<img src="${h(item.cover_url)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="ac-ph">${(item.title||'?').slice(0,2).toUpperCase()}</div>`;
      div.innerHTML = `<div class="ac-cover">${img}</div><div class="ac-info"><span class="ac-title">${h(item.title)}</span><span class="ac-meta">${h(meta)}</span></div>${bdg}`;
      div.addEventListener('mousedown', e => { e.preventDefault(); this._pick(i); });
      div.addEventListener('mouseover', () => this._setActive(i));
      this.dropdown.appendChild(div);
    });
    // KEY FIX: proper height + scroll
    this.dropdown.style.cssText += 'display:block;max-height:320px;overflow-y:auto;overflow-x:hidden';
    this.dropdown.scrollTop = 0;
  }
  _move(dir) {
    this.active = Math.max(-1, Math.min(this.items.length-1, this.active+dir));
    this._setActive(this.active);
  }
  _setActive(i) {
    this.active = i;
    this.dropdown.querySelectorAll('.autocomplete-item').forEach((el, idx) => {
      el.classList.toggle('selected', idx===i);
      if (idx===i) el.scrollIntoView({ block:'nearest' });
    });
  }
  _pick(i) { this.onSelect(this.items[i]); this.hide(); }
  hide()    { this.dropdown.style.display='none'; this.items=[]; this.active=-1; }
}

/* ── Duration calc ─────────────────────────────────── */
export function attachDurationCalc(form) {
  const st = form.querySelector('[name="start_time"]');
  const et = form.querySelector('[name="end_time"]');
  if (!st||!et) return;
  const hint = document.createElement('span');
  hint.className='duration-hint';
  et.insertAdjacentElement('afterend', hint);
  function calc() {
    if (!st.value||!et.value) { hint.textContent=''; return; }
    const d = parseDuration(st.value, et.value);
    const h2 = Math.floor(d), m = Math.round((d-h2)*60);
    hint.textContent = m ? `= ${h2}h ${m}m` : `= ${h2}h`;
  }
  st.addEventListener('change', calc); et.addEventListener('change', calc); st.addEventListener('input', calc); et.addEventListener('input', calc);
}

/* ── Cover preview ─────────────────────────────────── */
export function setupCoverPreview(urlInput, previewContainer) {
  function update() {
    const url = urlInput.value.trim();
    previewContainer.innerHTML = url
      ? `<img src="${h(url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='<div class=cover-preview-ph>🎮</div>'">`
      : '<div class="cover-preview-ph">🎮</div>';
  }
  urlInput.addEventListener('input', update);
  update();
}
