// Reusable interface widgets: menus, dialogs, forms, toasts, tooltips, scrubbable numbers.
import { h, icon, clamp, escapeHtml } from '../core/util.js';
import { displayCombo, commands } from '../core/commands.js';

// ---------- Context menu ----------
let openMenus = [];
export function closeMenus() { for (const m of openMenus) m.remove(); openMenus = []; }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.ctx-menu')) closeMenus(); }, true);
window.addEventListener('blur', closeMenus);

/** items: [{label, action, shortcut, cmd, checked, disabled, submenu:[...]}, '-'] */
export function contextMenu(x, y, items, level = 0) {
  if (level === 0) closeMenus();
  const menu = h('div.ctx-menu');
  for (const it of items) {
    if (!it) continue;
    if (it === '-' || it.sep) { menu.appendChild(h('div.ctx-sep')); continue; }
    const key = it.shortcut || (it.cmd ? (commands.keysFor(it.cmd)[0] || '') : '');
    const row = h('div.ctx-item' + (it.disabled ? '.disabled' : '') + (it.submenu ? '.sub' : ''),
      h('span.chk', it.checked ? '✓' : ''), h('span', it.label), !it.submenu && key ? h('span.k', displayCombo(key)) : null);
    if (it.submenu) {
      row.addEventListener('mouseenter', () => {
        openMenus.filter((m) => +m.dataset.level > level).forEach((m) => m.remove());
        openMenus = openMenus.filter((m) => +m.dataset.level <= level);
        const r = row.getBoundingClientRect();
        contextMenu(r.right - 2, r.top - 4, typeof it.submenu === 'function' ? it.submenu() : it.submenu, level + 1);
      });
    } else {
      row.addEventListener('mouseenter', () => { openMenus.filter((m) => +m.dataset.level > level).forEach((m) => m.remove()); openMenus = openMenus.filter((m) => +m.dataset.level <= level); });
      row.addEventListener('click', () => { closeMenus(); if (it.action) it.action(); else if (it.cmd) commands.run(it.cmd); });
    }
    menu.appendChild(row);
  }
  menu.dataset.level = level;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
  openMenus.push(menu);
  return menu;
}

// ---------- Toasts ----------
export function toast(msg, kind = 'info', ms = 3200) {
  const t = h('div.toast.' + kind, msg);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// ---------- Tooltips ----------
let tipEl = null, tipTimer = null;
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  clearTimeout(tipTimer);
  if (tipEl) { tipEl.remove(); tipEl = null; }
  if (!el || window.__noTips) return;
  tipTimer = setTimeout(() => {
    const cmd = el.dataset.cmd;
    const key = cmd ? commands.keysFor(cmd)[0] : el.dataset.key;
    tipEl = h('div.tooltip', el.dataset.tip, key ? h('span.kbd', displayCombo(key)) : null);
    document.body.appendChild(tipEl);
    const r = el.getBoundingClientRect(), tr = tipEl.getBoundingClientRect();
    tipEl.style.left = clamp(r.left + r.width / 2 - tr.width / 2, 4, window.innerWidth - tr.width - 4) + 'px';
    tipEl.style.top = (r.bottom + 6 + tr.height > window.innerHeight ? r.top - tr.height - 6 : r.bottom + 6) + 'px';
  }, 550);
});
document.addEventListener('mousedown', () => { clearTimeout(tipTimer); if (tipEl) { tipEl.remove(); tipEl = null; } }, true);

export function ibtn(name, tip, onClick, opts = {}) {
  const b = h('button.ibtn' + (opts.on ? '.on' : ''), { 'data-tip': tip, ...(opts.cmd ? { 'data-cmd': opts.cmd } : {}), type: 'button' }, icon(name, opts.size || 16));
  b.addEventListener('click', (e) => { e.stopPropagation(); if (onClick) onClick(e, b); else if (opts.cmd) commands.run(opts.cmd); });
  return b;
}

// ---------- Modal dialogs ----------
export function modal({ title, body, buttons = [{ label: 'OK', primary: true, value: true }], width, left = [], onOpen, closeOnBack = true }) {
  return new Promise((resolve) => {
    const back = h('div.modal-back');
    const box = h('div.modal', { style: width ? { width: width + 'px' } : null });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const footer = h('div.modal-f', h('div.left', left.map((b) => h('button.btn', { on: { click: () => b.action(close) } }, b.label))),
      buttons.map((b) => h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), { on: { click: async () => { if (b.validate && !(await b.validate())) return; close(typeof b.value === 'function' ? b.value() : b.value); } } }, b.label)));
    box.append(h('div.modal-h', title), h('div.modal-b', body), footer);
    back.appendChild(box);
    if (closeOnBack) back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && !(e.target.tagName === 'TEXTAREA')) {
        const prim = buttons.find((b) => b.primary); if (prim) { e.preventDefault(); e.stopPropagation(); footer.querySelector('.btn.primary').click(); }
      }
      e.stopPropagation();
    };
    document.addEventListener('keydown', key, true);
    document.body.appendChild(back);
    const first = box.querySelector('input, select, textarea');
    if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
    if (onOpen) onOpen(box, close);
  });
}

export async function confirmDialog(message, detail = '', okLabel = 'OK', danger = false) {
  return !!(await modal({ title: message, body: detail ? h('div', { style: { color: 'var(--muted)', maxWidth: '440px', lineHeight: '1.5' } }, detail) : h('div'), buttons: [{ label: 'Cancel', value: false }, { label: okLabel, primary: !danger, danger, value: true }] }));
}

export async function promptDialog(title, value = '', label = '') {
  const inp = h('input.field', { value, style: { width: '100%' } });
  const r = await modal({ title, body: h('div', label ? h('div', { style: { color: 'var(--muted)', marginBottom: '6px' } }, label) : null, inp), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => inp.value }] });
  return r;
}

/**
 * Form builder. spec: [{key,label,type:'text'|'number'|'select'|'check'|'color'|'textarea'|'file'|'folder'|'group'|'note'|'range', options, min,max,step, note, show:(vals)=>bool}]
 */
export function form(spec, values) {
  const vals = { ...values };
  const root = h('div');
  const rows = [];
  const render = () => {
    for (const r of rows) r.el.style.display = !r.s.show || r.s.show(vals) ? '' : 'none';
  };
  for (const s of spec) {
    if (s.type === 'group') { const el = h('div.form-group', s.label); root.appendChild(el); rows.push({ s, el }); continue; }
    if (s.type === 'note') { const el = h('div', { style: { color: 'var(--dim)', fontSize: '11px', margin: '4px 0 8px', lineHeight: '1.5' } }, s.label); root.appendChild(el); rows.push({ s, el }); continue; }
    let input;
    const set = (v) => { vals[s.key] = v; render(); if (s.onChange) s.onChange(v, vals, api); };
    switch (s.type) {
      case 'select':
        input = h('select.field', { on: { change: (e) => set(isNaN(e.target.value) || s.string ? e.target.value : Number(e.target.value)) } },
          (typeof s.options === 'function' ? s.options(vals) : s.options).map(([v, l]) => h('option', { value: v, selected: String(vals[s.key]) === String(v) }, l)));
        break;
      case 'check': input = h('label.check', h('input', { type: 'checkbox', checked: !!vals[s.key], on: { change: (e) => set(e.target.checked) } }), s.text || ''); break;
      case 'number': input = h('input.field', { type: 'number', value: vals[s.key], min: s.min, max: s.max, step: s.step || 'any', style: { width: '120px' }, on: { input: (e) => set(parseFloat(e.target.value)) } }); break;
      case 'range': {
        const out = h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--blue-hi)', width: '46px', textAlign: 'right' } }, String(vals[s.key]));
        input = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('input', { type: 'range', min: s.min, max: s.max, step: s.step || 1, value: vals[s.key], style: { flex: 1 }, on: { input: (e) => { out.textContent = e.target.value; set(parseFloat(e.target.value)); } } }), out);
        break;
      }
      case 'color': input = h('div.swatch', { style: { background: vals[s.key] } }, h('input', { type: 'color', value: vals[s.key], on: { input: (e) => { e.target.parentNode.style.background = e.target.value; set(e.target.value); } } })); break;
      case 'textarea': input = h('textarea.field', { rows: s.rows || 4, on: { input: (e) => set(e.target.value) } }, vals[s.key] || ''); break;
      case 'file': case 'folder': case 'savefile': {
        const inp = h('input.field', { value: vals[s.key] || '', style: { flex: 1 }, on: { input: (e) => set(e.target.value) } });
        const btn = h('button.btn.small', { on: { click: async () => {
          let p = null;
          if (s.type === 'savefile') p = await window.native.call('dialog:save', { defaultPath: inp.value, filters: s.filters });
          else { const r = await window.native.call('dialog:open', { directory: s.type === 'folder', filters: s.filters, defaultPath: inp.value || undefined }); p = r && r[0]; }
          if (p) { inp.value = p; set(p); }
        } } }, 'Browse...');
        input = h('div', { style: { display: 'flex', gap: '6px' } }, inp, btn);
        break;
      }
      default: input = h('input.field', { value: vals[s.key] == null ? '' : vals[s.key], placeholder: s.placeholder || '', on: { input: (e) => set(e.target.value) } });
    }
    const el = h('div.form-row', h('label', s.label || ''), input, s.note ? h('div.note', s.note) : null);
    root.appendChild(el); rows.push({ s, el });
  }
  render();
  const api = { el: root, values: vals, refresh: render };
  return api;
}

export async function formDialog(title, spec, values, opts = {}) {
  const f = form(spec, values);
  const r = await modal({ title, body: f.el, width: opts.width || 520, buttons: [{ label: 'Cancel', value: null }, { label: opts.ok || 'OK', primary: true, value: () => f.values }], left: opts.left || [] });
  return r;
}

// ---------- Scrubbable number ----------
/**
 * Number display that drags horizontally to change; click to type.
 * opts: {value, min, max, step, decimals, unit, onChange(v, final), format}
 */
export function scrubNumber(opts) {
  let value = opts.value;
  const el = h('span.scrub', { tabindex: 0 });
  const dec = opts.decimals != null ? opts.decimals : (opts.step && opts.step < 1 ? Math.max(1, -Math.floor(Math.log10(opts.step))) : 0);
  const fmt = (v) => (opts.format ? opts.format(v) : (typeof v === 'number' ? v.toFixed(dec) : String(v)));
  const show = () => { el.textContent = fmt(value); };
  show();
  let startX = 0, startV = 0, moved = false;
  el.addEventListener('mousedown', (e) => {
    if (el.classList.contains('editing')) return;
    e.preventDefault(); e.stopPropagation();
    startX = e.clientX; startV = value; moved = false;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      if (!moved) return;
      const mult = ev.shiftKey ? 10 : ev.altKey || ev.metaKey || ev.ctrlKey ? 0.1 : 1;
      let v = startV + dx * (opts.step || 1) * mult;
      if (opts.min != null) v = Math.max(opts.min, v);
      if (opts.max != null) v = Math.min(opts.max, v);
      value = +v.toFixed(Math.max(dec, 3));
      show(); opts.onChange && opts.onChange(value, false);
    };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      if (moved) opts.onChange && opts.onChange(value, true);
      else edit();
    };
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.classList.contains('editing')) edit(); });
  function edit() {
    el.classList.add('editing'); el.contentEditable = 'true'; el.textContent = typeof value === 'number' ? String(+value.toFixed(dec + 2)) : value;
    const range = document.createRange(); range.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    const done = (commit) => {
      el.classList.remove('editing'); el.contentEditable = 'false';
      if (commit) {
        let v = opts.parse ? opts.parse(el.textContent) : parseFloat(el.textContent);
        if (opts.evalMath !== false && /^[\d.\s+\-*/()]+$/.test(el.textContent)) { try { v = Function('return (' + el.textContent + ')')(); } catch {} }
        if (Number.isFinite(v)) { if (opts.min != null) v = Math.max(opts.min, v); if (opts.max != null) v = Math.min(opts.max, v); value = v; opts.onChange && opts.onChange(value, true); }
      }
      show(); el.removeEventListener('keydown', kd); el.removeEventListener('blur', bl);
    };
    const kd = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); el.blur(); } if (e.key === 'Escape') { done(false); el.blur(); } };
    const bl = () => done(true);
    el.addEventListener('keydown', kd); el.addEventListener('blur', bl);
  }
  el.set = (v) => { value = v; show(); };
  return el;
}

export function colorInput(value, onChange) {
  const sw = h('div.swatch', { style: { background: value } });
  const inp = h('input', { type: 'color', value: value && value.length === 7 ? value : '#ffffff' });
  inp.addEventListener('input', () => { sw.style.background = inp.value; onChange(inp.value, false); });
  inp.addEventListener('change', () => onChange(inp.value, true));
  sw.appendChild(inp);
  sw.set = (v) => { sw.style.background = v; inp.value = v; };
  return sw;
}

export function selectInput(options, value, onChange) {
  const s = h('select.field', { style: { maxWidth: '100%' }, on: { change: (e) => onChange(e.target.value) } }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  return s;
}

export function section(title, body, opts = {}) {
  const sec = h('div.section' + (opts.closed ? '.closed' : ''));
  const head = h('div.section-h', icon('chev-down', 14).cloneNode(true), h('span', title), opts.right || null);
  head.firstChild.classList.add('chev');
  head.addEventListener('click', (e) => { if (e.target.closest('button, input, select')) return; sec.classList.toggle('closed'); if (opts.onToggle) opts.onToggle(!sec.classList.contains('closed')); });
  sec.append(head, h('div.section-b', body));
  return sec;
}

export function sliderRow(label, value, min, max, step, onChange, opts = {}) {
  const num = scrubNumber({ value, min, max, step, onChange: (v, f) => { range.value = v; onChange(v, f); }, decimals: opts.decimals });
  const range = h('input', { type: 'range', min, max, step, value });
  range.addEventListener('input', () => { num.set(+range.value); onChange(+range.value, false); });
  range.addEventListener('change', () => onChange(+range.value, true));
  range.addEventListener('dblclick', () => { const d = opts.def != null ? opts.def : 0; range.value = d; num.set(d); onChange(d, true); });
  const row = h('div.row', h('label', { title: label }, label), range, num);
  row.set = (v) => { range.value = v; num.set(v); };
  return row;
}

// ---------- Command palette ----------
export function commandPalette(extraItems = []) {
  closeMenus();
  const items = commands.list().filter((c) => c.palette !== false && c.label).map((c) => ({ label: c.label, cat: c.category, key: commands.keysFor(c.id)[0], run: () => commands.run(c.id) })).concat(extraItems);
  const box = h('div.palette');
  const inp = h('input', { placeholder: 'Search commands, panels and effects' });
  const list = h('div.list');
  box.append(inp, list);
  const back = h('div', { style: { position: 'fixed', inset: 0, zIndex: 999 } });
  document.body.append(back, box);
  let sel = 0, shown = [];
  const close = () => { box.remove(); back.remove(); };
  back.addEventListener('mousedown', close);
  const render = () => {
    const q = inp.value.toLowerCase().trim();
    shown = items.filter((i) => !q || (i.label + ' ' + i.cat).toLowerCase().includes(q)).slice(0, 60);
    if (q) shown.sort((a, b) => a.label.toLowerCase().indexOf(q) - b.label.toLowerCase().indexOf(q));
    sel = clamp(sel, 0, Math.max(0, shown.length - 1));
    list.innerHTML = '';
    shown.forEach((it, i) => {
      const row = h('div.item' + (i === sel ? '.hl' : ''), h('span.cat', it.cat || ''), h('span', { style: { flex: 1 } }, it.label), it.key ? h('span.kbd', displayCombo(it.key)) : null);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); close(); it.run(); });
      list.appendChild(row);
    });
  };
  inp.addEventListener('input', () => { sel = 0; render(); });
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { sel++; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel--; render(); e.preventDefault(); }
    else if (e.key === 'Enter') { const it = shown[sel]; close(); if (it) it.run(); }
    else if (e.key === 'Escape') close();
  });
  render();
  setTimeout(() => inp.focus(), 10);
}

export function progressDialog(title) {
  const bar = h('div', { style: { height: '6px', background: 'var(--raised)', borderRadius: '3px', overflow: 'hidden', margin: '10px 0' } }, h('div', { style: { height: '100%', width: '0%', background: 'var(--blue)', transition: 'width .15s' } }));
  const label = h('div', { style: { color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: '11px' } }, 'Starting...');
  let cancelled = false; let closeFn = null;
  modal({ title, body: h('div', { style: { width: '420px' } }, bar, label), buttons: [{ label: 'Cancel', value: 'cancel' }], closeOnBack: false, onOpen: (_b, close) => { closeFn = close; } }).then((v) => { if (v === 'cancel') cancelled = true; });
  return {
    set(p, text) { bar.firstChild.style.width = Math.round(clamp(p, 0, 1) * 100) + '%'; if (text) label.textContent = text; },
    get cancelled() { return cancelled; },
    close() { if (closeFn) closeFn('done'); },
  };
}

export { escapeHtml };
