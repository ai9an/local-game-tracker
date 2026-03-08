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

/* ── Section 6: Letterboxd-style star rating display ── */
export function fmtStars(r) {
  if (r == null || r === '') return '—';
  r = parseFloat(r);
  if (isNaN(r)) return '—';
  const full = Math.floor(r);
  const half = (r % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
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
export function nowTimeHHMM() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
}
export function parseDuration(start, end) {
  const [sh,sm] = start.split(':').map(Number);
  const [eh,em] = end.split(':').map(Number);
  let m = (eh*60+em)-(sh*60+sm);
  if (m <= 0) m += 1440;
  return +(m/60).toFixed(4);
}
export function parsePlaytimeInput(str) {
  /* Parses strings like "2h 30m", "2.5h", "150m", "2h", "30m" → hours as float */
  if (!str || !str.trim()) return null;
  str = str.trim().toLowerCase();
  const hm = str.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/);
  if (hm) return parseFloat(hm[1]) + (hm[2] ? parseInt(hm[2])/60 : 0);
  const mo = str.match(/^(\d+(?:\.\d+)?)\s*m$/);
  if (mo) return parseFloat(mo[1]) / 60;
  const num = parseFloat(str);
  if (!isNaN(num)) return num;
  return null;
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
        <button class="btn-danger"  id="_co">Confirm</button>
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

/* ── Section 6: Interactive star rating widget ─────── */
export function renderStarRating(containerId, initialValue, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let current = parseFloat(initialValue) || 0;
  // last full star clicked — used for half-star toggle
  let lastClicked = 0;

  function draw() {
    container.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'star-btn';
      btn.dataset.star = i;
      if (current >= i)        btn.textContent = '★';
      else if (current >= i-0.5) btn.textContent = '½';
      else                      btn.textContent = '☆';
      btn.classList.toggle('star-active', current >= i - 0.5);
      btn.addEventListener('click', () => {
        if (lastClicked === i && current === i) {
          // Same full star clicked again → toggle to half
          current = i - 0.5;
        } else if (lastClicked === i && current === i - 0.5) {
          // Half star clicked again → clear to 0
          current = 0;
          lastClicked = 0;
        } else {
          current = i;
          lastClicked = i;
        }
        draw();
        if (onChange) onChange(current);
      });
      container.appendChild(btn);
    }
    // Show numeric label
    const lbl = document.createElement('span');
    lbl.className = 'star-value-label';
    lbl.textContent = current > 0 ? `${current}★` : '';
    container.appendChild(lbl);
  }
  draw();
  return {
    getValue: () => current,
    setValue: v => { current = parseFloat(v) || 0; lastClicked = Math.floor(current); draw(); }
  };
}

/* ── Section 4: Image cropper ─────────────────────── */
export function openCropModal(file, onCropped) {
  const reader = new FileReader();
  reader.onload = ev => {
    const src = ev.target.result;
    const ov  = document.createElement('div');
    ov.className = 'modal-overlay crop-modal-overlay';
    ov.style.display = 'flex';
    ov.innerHTML = `
      <div class="modal modal-lg crop-modal">
        <div class="modal-head">
          <h3>Crop Profile Picture</h3>
          <button class="modal-close" id="closeCropModal">×</button>
        </div>
        <div class="crop-container">
          <div class="crop-frame" id="cropFrame">
            <img id="cropImg" src="${src}" draggable="false">
            <div class="crop-circle" id="cropCircle"></div>
          </div>
          <div class="crop-controls">
            <label class="crop-label">Zoom</label>
            <input type="range" id="cropZoom" min="1" max="3" step="0.05" value="1" class="crop-slider">
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-outline" id="cancelCrop">Cancel</button>
          <button class="btn-primary" id="confirmCrop">Use Photo</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const img    = ov.querySelector('#cropImg');
    const circle = ov.querySelector('#cropCircle');
    const frame  = ov.querySelector('#cropFrame');
    const zoom   = ov.querySelector('#cropZoom');

    let scale = 1, ox = 0, oy = 0, dragging = false, startX = 0, startY = 0, imgX = 0, imgY = 0;

    function clamp() {
      const fw = frame.offsetWidth, fh = frame.offsetHeight;
      const iw = img.naturalWidth * scale, ih = img.naturalHeight * scale;
      const minX = Math.min(0, fw - iw), minY = Math.min(0, fh - ih);
      ox = Math.max(minX, Math.min(0, ox));
      oy = Math.max(minY, Math.min(0, oy));
    }
    function applyTransform() {
      img.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
      img.style.transformOrigin = '0 0';
    }

    zoom.addEventListener('input', () => {
      scale = parseFloat(zoom.value);
      clamp(); applyTransform();
    });

    frame.addEventListener('mousedown', e => { dragging=true; startX=e.clientX-ox; startY=e.clientY-oy; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!dragging) return; ox=e.clientX-startX; oy=e.clientY-startY; clamp(); applyTransform(); });
    document.addEventListener('mouseup', () => { dragging=false; });
    // Touch
    frame.addEventListener('touchstart', e => { dragging=true; startX=e.touches[0].clientX-ox; startY=e.touches[0].clientY-oy; }, {passive:true});
    frame.addEventListener('touchmove',  e => { if (!dragging) return; ox=e.touches[0].clientX-startX; oy=e.touches[0].clientY-startY; clamp(); applyTransform(); }, {passive:true});
    frame.addEventListener('touchend',   () => { dragging=false; });

    ov.querySelector('#closeCropModal').onclick = () => { ov.remove(); };
    ov.querySelector('#cancelCrop').onclick     = () => { ov.remove(); };

    ov.querySelector('#confirmCrop').onclick = () => {
      // Draw cropped circle to canvas
      const size   = 256; // output px
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx    = canvas.getContext('2d');

      // Clip to circle
      ctx.beginPath();
      ctx.arc(size/2, size/2, size/2, 0, Math.PI*2);
      ctx.clip();

      // Figure out what portion of the image is in the crop circle
      const fw = frame.offsetWidth, fh = frame.offsetHeight;
      // Circle sits centred in frame
      const cx = fw/2 - circle.offsetWidth/2 - ox;
      const cy = fh/2 - circle.offsetHeight/2 - oy;
      const cw = circle.offsetWidth  / scale;
      const ch = circle.offsetHeight / scale;
      // Source coords on natural image
      const sx = cx / scale * (img.naturalWidth  / (img.naturalWidth));
      const sy = cy / scale * (img.naturalHeight / (img.naturalHeight));

      ctx.drawImage(img, sx, sy, cw, ch, 0, 0, size, size);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      ov.remove();
      onCropped(dataUrl);
    };
  };
  reader.readAsDataURL(file);
}

/* ── Autocomplete widget ────────────────────────────── */
export class Autocomplete {
  constructor({ input, dropdown, status, onSearch, onSelect }) {
    this.input    = input;
    this.dropdown = dropdown;
    this.status   = status;
    this.onSearch = onSearch;
    this.onSelect = onSelect;
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
    this._outsideHandler = e => {
      if (this.input.contains(e.target) || this.dropdown.contains(e.target)) return;
      this.hide();
    };
    document.addEventListener('mousedown', this._outsideHandler);
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
      const src  = item.source||'steam';
      const bdg  = src==='igdb' ? '<span class="source-badge source-igdb">IGDB</span>' : '<span class="source-badge source-steam">Steam</span>';
      const meta = [item.release_year, item.genres].filter(Boolean).join(' · ');
      const img  = item.cover_url
        ? `<img src="${h(item.cover_url)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="ac-ph">${(item.title||'?').slice(0,2).toUpperCase()}</div>`;
      div.innerHTML = `<div class="ac-cover">${img}</div><div class="ac-info"><span class="ac-title">${h(item.title)}</span><span class="ac-meta">${h(meta)}</span></div>${bdg}`;
      div.addEventListener('mousedown', e => { e.preventDefault(); this._pick(i); });
      div.addEventListener('mouseover', () => this._setActive(i));
      this.dropdown.appendChild(div);
    });
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
  destroy() { if (this._outsideHandler) document.removeEventListener('mousedown', this._outsideHandler); }
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
  st.addEventListener('change', calc); et.addEventListener('change', calc);
  st.addEventListener('input', calc);  et.addEventListener('input', calc);
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

/* ── Platform checkboxes (Section 3) ────────────────── */
export const PLATFORM_OPTIONS = ['PC','PlayStation','Xbox','Switch'];

export function renderPlatformCheckboxes(containerId, currentValue) {
  const el = document.getElementById(containerId);
  if (!el) return;
  // currentValue can be a comma-separated string or array
  const selected = new Set(
    Array.isArray(currentValue)
      ? currentValue
      : (currentValue||'').split(',').map(s=>s.trim()).filter(Boolean)
  );
  el.innerHTML = PLATFORM_OPTIONS.map(p => `
    <label class="platform-checkbox-label">
      <input type="checkbox" name="platform_cb" value="${p}" ${selected.has(p)?'checked':''}>
      <span class="platform-pill">${p}</span>
    </label>`).join('');
}

export function getSelectedPlatforms(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return '';
  return [...el.querySelectorAll('input[name="platform_cb"]:checked')]
    .map(cb => cb.value).join(', ');
}

/* ── Section 2: Poster crop modal (2:3 aspect ratio) ── */
/**
 * Opens a crop modal tailored for game posters (2:3 ratio).
 * @param {string} src  — data URL or object URL of the image
 * @param {function} onCropped — called with a base64 data URL of the cropped poster
 */
export function openPosterCropModal(src, onCropped) {
  const ov = document.createElement('div');
  ov.className  = 'modal-overlay crop-modal-overlay';
  ov.style.display = 'flex';
  ov.innerHTML = `
    <div class="modal modal-lg crop-modal">
      <div class="modal-head">
        <h3>Crop Poster <span style="font-size:.75rem;color:var(--text3);font-weight:400">(drag to reposition)</span></h3>
        <button class="modal-close" id="closePosterCrop">×</button>
      </div>
      <div class="crop-container poster-crop-container">
        <div class="crop-frame poster-crop-frame" id="posterCropFrame">
          <img id="posterCropImg" src="${src}" draggable="false">
          <div class="poster-crop-guide"></div>
        </div>
        <div class="crop-controls">
          <label class="crop-label">Zoom</label>
          <input type="range" id="posterCropZoom" min="1" max="4" step="0.05" value="1" class="crop-slider">
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-outline" id="cancelPosterCrop">Cancel</button>
        <button class="btn-primary" id="confirmPosterCrop">Use Poster</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const img   = ov.querySelector('#posterCropImg');
  const frame = ov.querySelector('#posterCropFrame');
  const zoom  = ov.querySelector('#posterCropZoom');
  const guide = ov.querySelector('.poster-crop-guide');

  let scale = 1, ox = 0, oy = 0, dragging = false, startX = 0, startY = 0;

  function clamp() {
    const fw = frame.offsetWidth, fh = frame.offsetHeight;
    const iw = img.naturalWidth  * scale;
    const ih = img.naturalHeight * scale;
    ox = Math.max(Math.min(0, fw - iw), Math.min(0, ox));
    oy = Math.max(Math.min(0, fh - ih), Math.min(0, oy));
  }
  function apply() {
    img.style.transform       = `translate(${ox}px,${oy}px) scale(${scale})`;
    img.style.transformOrigin = '0 0';
  }

  zoom.addEventListener('input', () => { scale = parseFloat(zoom.value); clamp(); apply(); });
  frame.addEventListener('mousedown',  e => { dragging=true; startX=e.clientX-ox; startY=e.clientY-oy; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!dragging) return; ox=e.clientX-startX; oy=e.clientY-startY; clamp(); apply(); });
  document.addEventListener('mouseup',   () => dragging=false);
  frame.addEventListener('touchstart', e => { dragging=true; startX=e.touches[0].clientX-ox; startY=e.touches[0].clientY-oy; }, {passive:true});
  frame.addEventListener('touchmove',  e => { if (!dragging) return; ox=e.touches[0].clientX-startX; oy=e.touches[0].clientY-startY; clamp(); apply(); }, {passive:true});
  frame.addEventListener('touchend',   () => dragging=false);

  ov.querySelector('#closePosterCrop').onclick  = () => ov.remove();
  ov.querySelector('#cancelPosterCrop').onclick = () => ov.remove();

  ov.querySelector('#confirmPosterCrop').onclick = () => {
    // Crop to the guide rect (2:3 ratio centred in frame)
    const gRect = guide.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();
    // Position of guide relative to image origin
    const gx = (gRect.left - fRect.left - ox) / scale;
    const gy = (gRect.top  - fRect.top  - oy) / scale;
    const gw = gRect.width  / scale;
    const gh = gRect.height / scale;

    const OUT_W = 400, OUT_H = 600; // 2:3 output
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W; canvas.height = OUT_H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, gx, gy, gw, gh, 0, 0, OUT_W, OUT_H);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    ov.remove();
    onCropped(dataUrl);
  };
}
