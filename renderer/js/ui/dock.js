// Docking workspace: resizable splits, tab groups, drag-to-dock, maximize, floating panels.
import { h, icon, Emitter, deepClone } from '../core/util.js';
import { contextMenu } from './widgets.js';

export class Dock extends Emitter {
  constructor(root, registry) {
    super();
    this.root = root;
    this.registry = registry; // id -> {title, create()}
    this.panels = new Map();  // id -> {el, inst}
    this.layout = null;
    this.focused = null;
    this.maximized = null;
    this.limbo = h('div', { style: { display: 'none' } });
    document.body.appendChild(this.limbo);
    root.addEventListener('mousedown', (e) => {
      const p = e.target.closest('.panel');
      if (p) this.focus(p.dataset.id);
    }, true);
  }

  panel(id) {
    let p = this.panels.get(id);
    if (!p) {
      const def = this.registry[id];
      if (!def) return null;
      const el = h('div.panel', { dataset: { id } });
      p = { el, inst: null, def };
      this.panels.set(id, p);
      try { p.inst = def.create(el); } catch (e) { console.error('Panel create failed', id, e); el.appendChild(h('div.empty', 'This panel failed to load: ' + e.message)); }
    }
    return p;
  }

  setLayout(layout) {
    this.layout = deepClone(layout);
    if (!this.layout.floats) this.layout.floats = [];
    this.maximized = null;
    this.render();
  }

  render() {
    for (const p of this.panels.values()) this.limbo.appendChild(p.el);
    this.root.innerHTML = '';
    this.root.classList.toggle('maximized', !!this.maximized);
    this.root.appendChild(this.renderNode(this.layout.root, []));
    for (let i = 0; i < this.layout.floats.length; i++) {
      const f = this.layout.floats[i];
      const wrap = h('div.float-panel', { style: { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' } });
      wrap.appendChild(this.renderGroup(f.group, ['float', i]));
      this.makeFloatMovable(wrap, f);
      this.root.appendChild(wrap);
    }
    this.notifyResize();
    this.emit('layout');
  }

  renderNode(node, path) {
    if (node.type === 'group') return this.renderGroup(node, path);
    const el = h('div.dock-split.' + (node.dir === 'col' ? 'dk-col' : 'dk-row'));
    if (!node.sizes || node.sizes.length !== node.children.length) node.sizes = node.children.map(() => 1);
    node.children.forEach((child, i) => {
      if (i > 0) el.appendChild(this.splitter(node, i, el));
      const wrap = h('div.dock-node', { style: { flex: `${node.sizes[i]} 1 0` } });
      wrap.appendChild(this.renderNode(child, [...path, i]));
      el.appendChild(wrap);
    });
    return el;
  }

  splitter(node, i, container) {
    const s = h('div.splitter');
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      s.classList.add('dragging');
      const wraps = [...container.children].filter((c) => c.classList.contains('dock-node'));
      const a = wraps[i - 1], b = wraps[i];
      const horiz = node.dir !== 'col';
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const total = horiz ? ra.width + rb.width : ra.height + rb.height;
      const sum = node.sizes[i - 1] + node.sizes[i];
      const start = horiz ? e.clientX : e.clientY;
      const startA = horiz ? ra.width : ra.height;
      const move = (ev) => {
        const d = (horiz ? ev.clientX : ev.clientY) - start;
        const na = Math.max(60, Math.min(total - 60, startA + d));
        node.sizes[i - 1] = sum * na / total; node.sizes[i] = sum - node.sizes[i - 1];
        a.style.flex = `${node.sizes[i - 1]} 1 0`; b.style.flex = `${node.sizes[i]} 1 0`;
        this.notifyResize();
      };
      const up = () => { s.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); this.emit('changed'); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    return s;
  }

  renderGroup(group, path) {
    const g = h('div.dock-group');
    if (this.maximized === group) g.classList.add('max');
    const tabs = h('div.dock-tabs');
    const body = h('div.dock-body');
    if (!group.panels.includes(group.active)) group.active = group.panels[0];
    for (const id of group.panels) {
      const p = this.panel(id);
      if (!p) continue;
      const tab = h('div.dock-tab' + (id === group.active ? '.active' : ''), h('span', p.def.title), h('span.x', { title: 'Close panel' }, icon('close', 10)));
      tab.addEventListener('mousedown', (e) => {
        if (e.target.closest('.x')) return;
        if (e.button !== 0) return;
        this.startTabDrag(e, group, id, () => { group.active = id; this.render(); this.focus(id); });
      });
      tab.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); this.closePanel(id); });
      tab.addEventListener('dblclick', () => this.toggleMaximize(group));
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); this.panelMenu(e.clientX, e.clientY, group, id); });
      tabs.appendChild(tab);
      p.el.classList.toggle('active', id === group.active);
      body.appendChild(p.el);
    }
    const mb = h('div.menu-btn', { title: 'Panel menu' }, icon('menu', 14));
    mb.addEventListener('click', (e) => { const r = mb.getBoundingClientRect(); this.panelMenu(r.left, r.bottom, group, group.active); e.stopPropagation(); });
    tabs.appendChild(mb);
    g.append(tabs, body);
    g.__group = group;
    if (group.panels.includes(this.focused)) g.classList.add('focused');
    return g;
  }

  panelMenu(x, y, group, id) {
    const p = this.panel(id);
    const extra = p && p.inst && p.inst.menu ? p.inst.menu() : [];
    contextMenu(x, y, [
      ...extra, extra.length ? '-' : null,
      { label: this.maximized === group ? 'Restore Frame Size' : 'Maximize Frame', shortcut: '`', action: () => this.toggleMaximize(group) },
      { label: 'Undock Panel', action: () => this.floatPanel(id) },
      { label: 'Close Panel', action: () => this.closePanel(id) },
      { label: 'Close Other Panels in Group', action: () => { for (const o of [...group.panels]) if (o !== id) this.closePanel(o, false); this.render(); } },
    ]);
  }

  startTabDrag(e, group, id, onClick) {
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, indicator = null, target = null;
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      dragging = true;
      if (!indicator) { indicator = h('div.dock-drop'); document.body.appendChild(indicator); }
      target = this.dropTarget(ev.clientX, ev.clientY);
      if (!target) { indicator.style.display = 'none'; return; }
      indicator.style.display = 'block';
      const r = target.rect; let x = r.left, y = r.top, w = r.width, hh = r.height;
      if (target.zone === 'left') w /= 2; else if (target.zone === 'right') { x += w / 2; w /= 2; } else if (target.zone === 'top') hh /= 2; else if (target.zone === 'bottom') { y += hh / 2; hh /= 2; }
      Object.assign(indicator.style, { position: 'fixed', left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' });
    };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      if (indicator) indicator.remove();
      if (!dragging) { onClick(); return; }
      if (target) this.movePanel(id, group, target.group, target.zone);
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }

  dropTarget(x, y) {
    const groups = [...this.root.querySelectorAll('.dock-group')];
    for (const g of groups) {
      const r = g.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
      let zone = 'center';
      const m = 0.25;
      if (y - r.top < 30) zone = 'center';
      else if (fx < m) zone = 'left'; else if (fx > 1 - m) zone = 'right'; else if (fy < m) zone = 'top'; else if (fy > 1 - m) zone = 'bottom';
      return { group: g.__group, zone, rect: r };
    }
    return null;
  }

  // ----- tree manipulation -----
  findParent(node, target, parent = null, index = -1) {
    if (node === target) return { parent, index };
    if (node.type === 'split') for (let i = 0; i < node.children.length; i++) { const r = this.findParent(node.children[i], target, node, i); if (r) return r; }
    return null;
  }

  removeFromGroup(group, id) {
    group.panels = group.panels.filter((p) => p !== id);
    if (group.active === id) group.active = group.panels[0];
    if (!group.panels.length) {
      const fi = this.layout.floats.findIndex((f) => f.group === group);
      if (fi >= 0) { this.layout.floats.splice(fi, 1); return; }
      const r = this.findParent(this.layout.root, group);
      if (r && r.parent) { r.parent.children.splice(r.index, 1); r.parent.sizes.splice(r.index, 1); this.collapse(this.layout.root); }
    }
  }

  collapse(node, parent = null, idx = -1) {
    if (node.type !== 'split') return;
    for (let i = node.children.length - 1; i >= 0; i--) this.collapse(node.children[i], node, i);
    if (node.children.length === 1 && parent) { parent.children[idx] = node.children[0]; }
    else if (node.children.length === 1 && !parent) { this.layout.root = node.children[0]; }
    // flatten same-direction splits
    if (parent && node.children.length > 1 && node.dir === parent.dir && parent.children[idx] === node) {
      const total = parent.sizes[idx]; const s = node.sizes.reduce((a, b) => a + b, 0);
      parent.children.splice(idx, 1, ...node.children);
      parent.sizes.splice(idx, 1, ...node.sizes.map((x) => x / s * total));
    }
  }

  movePanel(id, fromGroup, toGroup, zone) {
    if (fromGroup === toGroup && (zone === 'center' || fromGroup.panels.length === 1)) return;
    this.removeFromGroup(fromGroup, id);
    if (zone === 'center') { toGroup.panels.push(id); toGroup.active = id; }
    else {
      const newGroup = { type: 'group', panels: [id], active: id };
      const r = this.findParent(this.layout.root, toGroup);
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
      const before = zone === 'left' || zone === 'top';
      const fl = this.layout.floats.find((f) => f.group === toGroup);
      if (fl) { fl.group = { type: 'split', dir, children: before ? [newGroup, toGroup] : [toGroup, newGroup], sizes: [1, 1] }; }
      else if (!r || !r.parent) this.layout.root = { type: 'split', dir, children: before ? [newGroup, toGroup] : [toGroup, newGroup], sizes: [1, 1] };
      else if (r.parent.dir === dir) { r.parent.children.splice(before ? r.index : r.index + 1, 0, newGroup); const s = r.parent.sizes[r.index] / 2; r.parent.sizes[r.index] = s; r.parent.sizes.splice(before ? r.index : r.index + 1, 0, s); }
      else r.parent.children[r.index] = { type: 'split', dir, children: before ? [newGroup, toGroup] : [toGroup, newGroup], sizes: [1, 1] };
    }
    this.render();
    this.focus(id);
    this.emit('changed');
  }

  allGroups(node = this.layout.root, out = []) {
    if (node.type === 'group') out.push(node); else for (const c of node.children) this.allGroups(c, out);
    if (node === this.layout.root) for (const f of this.layout.floats) this.allGroups(f.group, out);
    return out;
  }

  groupOf(id) { return this.allGroups().find((g) => g.panels.includes(id)) || null; }

  isOpen(id) { return !!this.groupOf(id); }

  openPanel(id, opts = {}) {
    let g = this.groupOf(id);
    if (!g) {
      if (opts.float) { this.panel(id); this.layout.floats.push({ group: { type: 'group', panels: [id], active: id }, x: 160, y: 90, w: opts.w || 520, h: opts.h || 420 }); this.render(); this.focus(id); return; }
      const near = opts.near ? this.groupOf(opts.near) : null;
      g = near || this.allGroups().sort((a, b) => b.panels.length - a.panels.length)[0];
      g.panels.push(id);
    }
    g.active = id;
    this.render();
    this.focus(id);
    this.emit('changed');
  }

  closePanel(id, rerender = true) {
    const g = this.groupOf(id);
    if (!g) return;
    if (this.allGroups().length === 1 && g.panels.length === 1) return;
    this.removeFromGroup(g, id);
    if (rerender) this.render();
    this.emit('changed');
  }

  floatPanel(id) {
    const g = this.groupOf(id);
    if (g) this.removeFromGroup(g, id);
    this.layout.floats.push({ group: { type: 'group', panels: [id], active: id }, x: 200, y: 120, w: 520, h: 400 });
    this.render();
  }

  makeFloatMovable(wrap, f) {
    const tabs = wrap.querySelector('.dock-tabs');
    tabs.addEventListener('mousedown', (e) => {
      if (e.target.closest('.dock-tab') || e.target.closest('.menu-btn')) return;
      const sx = e.clientX - f.x, sy = e.clientY - f.y;
      const move = (ev) => { f.x = ev.clientX - sx; f.y = ev.clientY - sy; wrap.style.left = f.x + 'px'; wrap.style.top = f.y + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    const grip = h('div', { style: { position: 'absolute', right: 0, bottom: 0, width: '14px', height: '14px', cursor: 'nwse-resize' } });
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, w0 = f.w, h0 = f.h;
      const move = (ev) => { f.w = Math.max(240, w0 + ev.clientX - sx); f.h = Math.max(160, h0 + ev.clientY - sy); wrap.style.width = f.w + 'px'; wrap.style.height = f.h + 'px'; this.notifyResize(); };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    wrap.appendChild(grip);
  }

  toggleMaximize(group) {
    if (!group) { const g = this.groupOf(this.focused); group = g; }
    if (!group) return;
    this.maximized = this.maximized === group ? null : group;
    this.render();
  }

  focus(id) {
    if (!id || this.focused === id) { this.highlight(); return; }
    this.focused = id;
    this.highlight();
    this.emit('focus', id);
  }
  highlight() {
    for (const g of this.root.querySelectorAll('.dock-group')) g.classList.toggle('focused', !!(g.__group && g.__group.panels.includes(this.focused) && g.__group.active === this.focused));
  }

  activate(id) { const g = this.groupOf(id); if (g && g.active !== id) { g.active = id; this.render(); } }

  notifyResize() {
    cancelAnimationFrame(this._rz);
    this._rz = requestAnimationFrame(() => { for (const p of this.panels.values()) if (p.inst && p.inst.resize && p.el.isConnected) try { p.inst.resize(); } catch (e) { console.error(e); } });
  }

  serialize() { return deepClone(this.layout); }
}

// ---------- Built-in workspace layouts ----------
const G = (panels, active) => ({ type: 'group', panels, active: active || panels[0] });
const S = (dir, children, sizes) => ({ type: 'split', dir, children, sizes });

export const WORKSPACES = {
  Assembly: { root: S('col', [S('row', [G(['project', 'mediaBrowser', 'libraries']), G(['source']), G(['program'])], [1.3, 1, 1]), S('row', [G(['tools']), G(['timeline'])], [0.03, 1])], [1.25, 1]) },
  Editing: { root: S('col', [S('row', [G(['source', 'effectControls', 'audioClipMixer', 'metadata']), G(['program'])], [1, 1]), S('row', [G(['project', 'mediaBrowser', 'libraries', 'info', 'effects', 'markers', 'history']), G(['tools']), G(['timeline']), G(['meters'])], [0.42, 0.028, 1.5, 0.05])], [1.15, 1]) },
  Color: { root: S('row', [S('col', [S('row', [G(['scopes', 'source']), G(['program'])], [1, 1.3]), S('row', [G(['project', 'effectControls']), G(['timeline'])], [0.5, 1.5])], [1.2, 1]), G(['lumetri'])], [1, 0.3]) },
  Effects: { root: S('row', [S('col', [S('row', [G(['effectControls', 'source']), G(['program'])], [1, 1.2]), S('row', [G(['project', 'history']), G(['tools']), G(['timeline'])], [0.45, 0.028, 1.5])], [1.15, 1]), G(['effects', 'properties'])], [1, 0.26]) },
  Audio: { root: S('row', [S('col', [S('row', [G(['audioTrackMixer', 'audioClipMixer', 'source']), G(['program'])], [1.2, 1]), S('row', [G(['project', 'effects', 'markers']), G(['timeline']), G(['meters'])], [0.4, 1.5, 0.06])], [1.1, 1]), G(['essentialSound', 'effectControls'])], [1, 0.26]) },
  Captions: { root: S('row', [G(['text', 'project']), S('col', [G(['program']), G(['timeline'])], [1.2, 1]), G(['properties', 'effectControls'])], [0.3, 1, 0.26]) },
  Graphics: { root: S('row', [S('col', [S('row', [G(['effectControls', 'project']), G(['program'])], [0.8, 1.3]), S('row', [G(['tools']), G(['timeline'])], [0.028, 1])], [1.2, 1]), G(['properties', 'libraries', 'text'])], [1, 0.27]) },
  Review: { root: S('col', [S('row', [G(['program']), G(['markers', 'history'])], [2, 0.6]), G(['timeline'])], [1.6, 1]) },
  Learning: { root: S('col', [S('row', [G(['learn', 'project']), G(['program'])], [1, 1.4]), G(['timeline'])], [1.2, 1]) },
};
