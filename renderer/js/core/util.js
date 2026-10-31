// Small shared helpers.
let _uid = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${(++_uid).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const deepClone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const raf = () => new Promise((r) => requestAnimationFrame(r));
export const dbToGain = (db) => (db <= -96 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0.0000159 ? -96 : 20 * Math.log10(g));
export const basename = (p) => (p || '').split(/[\\/]/).pop();
export const dirname = (p) => { const d = (p || '').split(/[\\/]/).slice(0, -1).join('/') || '/'; return /^[A-Za-z]:$/.test(d) ? d + '/' : d; };
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };
export const stem = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };
export const joinPath = (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/');

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function throttle(fn, ms) {
  let last = 0, t; return (...a) => {
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...a); } else { clearTimeout(t); t = setTimeout(() => { last = performance.now(); fn(...a); }, ms - (now - last)); }
  };
}

export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { const s = this._h.get(ev); if (s) s.delete(fn); }
  emit(ev, ...a) { const s = this._h.get(ev); if (s) for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error('handler error', ev, e); } } }
}

export function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// Tiny DOM builder: h('div.cls#id', {attrs, on:{click}}, ...children)
export function h(tag, props, ...kids) {
  let [name, ...rest] = tag.split(/(?=[.#])/);
  const e = document.createElement(name || 'div');
  for (const r of rest) { if (r[0] === '.') e.classList.add(r.slice(1)); else if (r[0] === '#') e.id = r.slice(1); }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'class') e.className += ' ' + v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k in e && k !== 'list' && k !== 'form' && typeof v !== 'string') e[k] = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  appendKids(e, kids);
  return e;
}
function appendKids(e, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) appendKids(e, k);
    else e.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('class', 'ico');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.appendChild(u);
  return s;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex || '');
  if (!m) return [1, 1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, m[4] ? parseInt(m[4], 16) / 255 : 1];
}
export function rgbToHex(r, g, b) {
  const c = (v) => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

export function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text]));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function naturalCompare(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }); }

export const LABEL_COLORS = {
  violet: '#8f6cf2', iris: '#5b7cfa', caribbean: '#21b5a6', lavender: '#c39af5', cerulean: '#2f9bea', forest: '#4f9b4a',
  rose: '#e8689a', mango: '#f0a23c', purple: '#a24ad8', blue: '#3f6ae8', teal: '#2aa6a6', magenta: '#d64fc3', tan: '#c8a77a',
  green: '#5fc25a', brown: '#9a6b44', yellow: '#e8d14a', none: '#5a6070',
};

export function frameKey(seqId, frame) { return seqId + ':' + frame; }

export function fileUrl(p) { return window.native ? window.native.mediaUrl(p) : 'file://' + p; }
