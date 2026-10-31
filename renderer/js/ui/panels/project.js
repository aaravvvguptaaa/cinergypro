// Project panel: bins, list / icon / freeform views, columns, search, labels, drag sources.
import { app } from '../../app-context.js';
import { h, icon, LABEL_COLORS, naturalCompare, formatBytes, fileUrl, clamp } from '../../core/util.js';
import { childrenOf, itemUsage, itemDuration, binPath } from '../../core/project.js';
import { framesToTC } from '../../core/timecode.js';
import { contextMenu, ibtn, promptDialog, toast } from '../widgets.js';
import * as M from '../../actions/media.js';
import * as A from '../../actions/editing.js';
import { GRAPHIC_TEMPLATES } from '../../engine/graphics.js';

const COLUMNS = {
  name: { label: 'Name', w: 220, get: (i) => i.name },
  label: { label: 'Label', w: 44, get: (i) => i.label || '' },
  fps: { label: 'Frame Rate', w: 80, get: (i) => (i.type === 'media' && i.info.fps ? ((i.interpret.fps || i.info.fps).toFixed(2) + ' fps') : i.type === 'sequence' ? i.settings.fps + ' fps' : '') },
  start: { label: 'Media Start', w: 100, get: (i) => (i.type === 'media' && i.info.timecode) || '' },
  duration: { label: 'Media Duration', w: 100, get: (i) => durText(i) },
  inout: { label: 'In/Out Duration', w: 100, get: (i) => (i.inPoint != null || i.outPoint != null ? framesToTC(Math.round(((i.outPoint != null ? i.outPoint : itemDuration(app.store.project, i)) - (i.inPoint || 0)) * fpsOf(i)), fpsOf(i)) : '') },
  video: { label: 'Video Info', w: 150, get: (i) => (i.type === 'media' && i.info.hasVideo ? `${i.info.width}x${i.info.height}${i.info.alpha ? ' (alpha)' : ''}${i.info.hdr ? ' HDR' : ''}` : i.type === 'sequence' ? `${i.settings.width}x${i.settings.height}` : '') },
  audio: { label: 'Audio Info', w: 130, get: (i) => (i.type === 'media' && i.info.hasAudio ? `${i.info.sampleRate} Hz, ${i.info.channels} ch` : '') },
  codec: { label: 'Codec', w: 90, get: (i) => (i.type === 'media' ? i.info.codec || '' : '') },
  usage: { label: 'Usage', w: 56, get: (i) => (i.type !== 'bin' ? String(itemUsage(app.store.project, i.id).length || '') : '') },
  status: { label: 'Status', w: 80, get: (i) => (i.offline ? 'Offline' : i.proxy ? 'Proxy' : i.playback ? 'Playback copy' : '') },
  scene: { label: 'Scene', w: 70, get: (i) => (i.metadata && i.metadata.scene) || '', edit: 'scene' },
  shot: { label: 'Shot', w: 60, get: (i) => (i.metadata && i.metadata.shot) || '', edit: 'shot' },
  take: { label: 'Take', w: 50, get: (i) => (i.metadata && i.metadata.take) || '', edit: 'take' },
  good: { label: 'Good', w: 44, get: (i) => (i.metadata && i.metadata.good ? '★' : '') },
  description: { label: 'Description', w: 160, get: (i) => (i.metadata && i.metadata.description) || '', edit: 'description' },
  logNote: { label: 'Log Note', w: 160, get: (i) => (i.metadata && i.metadata.logNote) || '', edit: 'logNote' },
  reel: { label: 'Tape Name', w: 90, get: (i) => (i.metadata && i.metadata.reel) || '', edit: 'reel' },
  created: { label: 'Date Created', w: 130, get: (i) => (i.info && i.info.created ? new Date(i.info.created).toLocaleString() : i.created ? new Date(i.created).toLocaleString() : '') },
  size: { label: 'Size', w: 80, get: (i) => (i.info && i.info.size ? formatBytes(i.info.size) : '') },
  path: { label: 'File Path', w: 260, get: (i) => i.path || '' },
};

function fpsOf(i) { return (i.type === 'media' && (i.interpret.fps || i.info.fps)) || (i.type === 'sequence' && i.settings.fps) || (app.store.seq ? app.store.seq.settings.fps : 24); }
function durText(i) {
  const d = itemDuration(app.store.project, i);
  if (!isFinite(d)) return i.type === 'media' && i.info.kind === 'image' ? 'Still' : '';
  return framesToTC(Math.round(d * fpsOf(i)), fpsOf(i));
}

function iconFor(i) {
  if (i.type === 'bin') return 'folder';
  if (i.type === 'sequence') return i.multicam ? 'multicam' : 'seq';
  if (i.type === 'graphic') return 'type';
  if (i.type === 'synthetic') return i.generator === 'adjustment' ? 'layers' : 'palette';
  if (i.info.kind === 'audio') return 'audio';
  if (i.info.kind === 'image' || i.info.kind === 'psd') return 'image';
  return 'film';
}

export class ProjectPanel {
  constructor(el) {
    this.el = el;
    this.view = 'list';
    this.currentBin = null;
    this.open = new Set();
    this.sort = { key: 'name', dir: 1 };
    this.filter = '';
    this.columns = app.prefs.get('project.columns') || ['name', 'label', 'fps', 'start', 'duration', 'video', 'audio', 'usage', 'status'];
    this.iconW = 150;
    app.panels.project = this;
    this.build();
    app.store.on('change', (e) => { if (!e || !e.transient) this.render(); });
    app.store.on('project', () => { this.currentBin = null; this.render(); });
    app.store.on('selection', () => this.updateSel());
  }

  build() {
    this.search = h('input.field', { placeholder: 'Search project', on: { input: (e) => { this.filter = e.target.value.toLowerCase(); this.render(); } } });
    this.viewBtns = {
      list: ibtn('list', 'List View', () => this.setView('list')),
      icon: ibtn('grid', 'Icon View', () => this.setView('icon')),
      free: ibtn('free', 'Freeform View', () => this.setView('free')),
    };
    this.zoom = h('input', { type: 'range', min: 90, max: 320, value: 150, style: { width: '70px' }, on: { input: (e) => { this.iconW = +e.target.value; this.body.style.setProperty('--icon-w', this.iconW + 'px'); } } });
    const top = h('div.toolbar', h('div.search', icon('search', 14), this.search), ibtn('import', 'Import Media', () => M.importDialog(), { cmd: 'file.import' }));
    this.crumbs = h('div.crumbs');
    this.body = h('div.scroll', { tabindex: 0 });
    this.status = h('span', { style: { color: 'var(--dim)', fontSize: '11px', marginRight: 'auto' } });
    const bottom = h('div.toolbar.bottom', this.viewBtns.list, this.viewBtns.icon, this.viewBtns.free, this.zoom, this.status,
      ibtn('plus', 'New Item', (e) => this.newMenu(e)), ibtn('folder', 'New Bin', () => M.newBin()), ibtn('search', 'Find', () => this.search.focus()), ibtn('trash', 'Clear', () => this.deleteSelected()));
    this.el.append(top, this.crumbs, this.body, bottom);
    this.body.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-cinergy-items') || e.dataTransfer.types.includes('application/x-cinergy-paths')) { e.preventDefault(); } });
    this.body.addEventListener('drop', async (e) => {
      e.preventDefault();
      const target = e.target.closest('[data-bin]');
      const bin = target ? target.dataset.bin || null : this.currentBin;
      const raw = e.dataTransfer.getData('application/x-cinergy-items');
      if (raw) { const ids = JSON.parse(raw); this.moveTo(ids, bin); return; }
      const mp = e.dataTransfer.getData('application/x-cinergy-paths'); if (mp) { await M.importPaths(JSON.parse(mp), { bin }); return; }
      if (e.dataTransfer.files.length) await M.importPaths([...e.dataTransfer.files].map((f) => window.native.pathForFile(f)), { bin });
    });
    this.body.addEventListener('mousedown', (e) => { if (e.target === this.body || e.target.classList.contains('proj-icons') || e.target.classList.contains('proj-free')) app.store.selectItems([]); });
    this.body.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-id]')) return; e.preventDefault(); this.emptyMenu(e); });
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-id]')) M.importDialog(); });
    this.setView('list');
  }

  setView(v) { this.view = v; for (const [k, b] of Object.entries(this.viewBtns)) b.classList.toggle('on', k === v); this.render(); }

  items(parent) {
    let list = childrenOf(app.store.project, parent);
    const key = this.sort.key, dir = this.sort.dir;
    list.sort((a, b) => {
      if ((a.type === 'bin') !== (b.type === 'bin') && key === 'name') return a.type === 'bin' ? -1 : 1;
      const col = COLUMNS[key]; const va = col ? col.get(a) : '', vb = col ? col.get(b) : '';
      return naturalCompare(va, vb) * dir;
    });
    return list;
  }

  matches(i) {
    if (!this.filter) return true;
    const f = this.filter;
    return [i.name, i.path, i.metadata && Object.values(i.metadata).join(' '), (i.info && i.info.codec)].join(' ').toLowerCase().includes(f);
  }

  render() {
    const p = app.store.project;
    this.body.innerHTML = '';
    this.body.style.setProperty('--icon-w', this.iconW + 'px');
    const count = Object.values(p.items).filter((i) => i.type !== 'bin').length;
    this.status.textContent = `${count} item${count === 1 ? '' : 's'}`;
    this.renderCrumbs();
    if (!count && !Object.values(p.items).some((i) => i.type === 'bin')) {
      this.body.appendChild(h('div.empty', h('div', h('b', 'Import media to start'), 'Drop files or folders here, or double-click to browse.')));
      return;
    }
    if (this.view === 'list') this.renderList(); else if (this.view === 'icon') this.renderIcons(false); else this.renderIcons(true);
    this.updateSel();
  }

  renderCrumbs() {
    this.crumbs.innerHTML = '';
    const p = app.store.project;
    const path = []; let b = this.currentBin;
    while (b && p.items[b]) { path.unshift(p.items[b]); b = p.items[b].parent; }
    const root = h('span', { dataset: { bin: '' } }, p.name || 'Project');
    root.addEventListener('click', () => { this.currentBin = null; this.render(); });
    this.crumbs.appendChild(root);
    for (const bin of path) { this.crumbs.append(h('span', { style: { color: 'var(--dim)' } }, '/')); const s = h('span', { dataset: { bin: bin.id } }, bin.name); s.addEventListener('click', () => { this.currentBin = bin.id; this.render(); }); this.crumbs.appendChild(s); }
    this.crumbs.style.display = this.view === 'list' && !this.currentBin ? 'none' : '';
  }

  renderList() {
    const table = h('table.proj-list');
    const cols = this.columns;
    const colgroup = h('colgroup', cols.map((c) => h('col', { style: { width: (COLUMNS[c] ? COLUMNS[c].w : 100) + 'px' } })));
    const head = h('tr', cols.map((c) => {
      const th = h('th', (COLUMNS[c] || { label: c }).label + (this.sort.key === c ? (this.sort.dir > 0 ? ' ▴' : ' ▾') : ''));
      th.addEventListener('click', () => { this.sort = { key: c, dir: this.sort.key === c ? -this.sort.dir : 1 }; this.render(); });
      th.addEventListener('contextmenu', (e) => { e.preventDefault(); this.columnMenu(e); });
      return th;
    }));
    table.append(colgroup, h('thead', head));
    const tbody = h('tbody');
    const add = (parent, depth) => {
      for (const i of this.items(parent)) {
        const isBin = i.type === 'bin';
        const kidsMatch = isBin && this.filter && Object.values(app.store.project.items).some((x) => this.isDescendant(x, i.id) && this.matches(x));
        if (!this.matches(i) && !kidsMatch) continue;
        const tr = h('tr' + (i.offline ? '.offline' : ''), { dataset: { id: i.id, ...(isBin ? { bin: i.id } : {}) }, draggable: true });
        cols.forEach((c) => {
          let td;
          if (c === 'name') {
            const tw = h('span.tw', isBin ? (this.open.has(i.id) || this.filter ? '▾' : '▸') : '');
            tw.addEventListener('mousedown', (e) => { e.stopPropagation(); if (this.open.has(i.id)) this.open.delete(i.id); else this.open.add(i.id); this.render(); });
            td = h('td', h('div.namecell', { style: { paddingLeft: depth * 16 + 'px' } }, tw, h('span', { style: { color: isBin ? '#f2b33d' : 'var(--muted)', display: 'flex' } }, icon(iconFor(i), 14)), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, i.name)));
          } else if (c === 'label') td = h('td', h('span.label-dot', { style: { background: LABEL_COLORS[i.label] || LABEL_COLORS.none } }));
          else {
            const col = COLUMNS[c]; td = h('td', col ? col.get(i) : '');
            if (col && col.edit) td.addEventListener('dblclick', (e) => { e.stopPropagation(); this.inlineEdit(td, i, col.edit); });
            if (c === 'good') td.addEventListener('click', () => app.store.transact('Good', () => { i.metadata.good = !i.metadata.good; }, [i.id]));
          }
          tr.appendChild(td);
        });
        this.bindItem(tr, i);
        tbody.appendChild(tr);
        if (isBin && (this.open.has(i.id) || this.filter)) add(i.id, depth + 1);
      }
    };
    add(this.currentBin, 0);
    table.appendChild(tbody);
    this.body.appendChild(table);
  }

  isDescendant(x, binId) { let p = x.parent; while (p) { if (p === binId) return true; p = app.store.project.items[p] && app.store.project.items[p].parent; } return false; }

  renderIcons(free) {
    const wrap = h(free ? 'div.proj-free' : 'div.proj-icons');
    const list = this.filter ? Object.values(app.store.project.items).filter((i) => i.type !== 'bin' && this.matches(i)) : this.items(this.currentBin);
    let idx = 0;
    for (const i of list) {
      const thumb = h('div.thumb');
      if (i.type === 'bin') thumb.appendChild(h('span', { style: { color: '#f2b33d' } }, icon('folder', 40)));
      else this.fillThumb(thumb, i);
      const card = h('div.proj-icon', { dataset: { id: i.id, ...(i.type === 'bin' ? { bin: i.id } : {}) }, draggable: true }, thumb, h('div.nm', h('span.label-dot', { style: { background: LABEL_COLORS[i.label] || LABEL_COLORS.none } }), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, i.name)));
      if (free) {
        i.freeform = i.freeform || { x: 12 + (idx % 6) * (this.iconW + 16), y: 12 + Math.floor(idx / 6) * (this.iconW * 0.75 + 30) };
        card.style.left = i.freeform.x + 'px'; card.style.top = i.freeform.y + 'px';
        card.draggable = false;
        card.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          const x0 = e.clientX, y0 = e.clientY, fx = i.freeform.x, fy = i.freeform.y; let moved = false;
          const mv = (ev) => { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) moved = true; i.freeform.x = Math.max(0, fx + ev.clientX - x0); i.freeform.y = Math.max(0, fy + ev.clientY - y0); card.style.left = i.freeform.x + 'px'; card.style.top = i.freeform.y + 'px'; };
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); if (moved) app.store.markDirty(); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
      }
      if (i.type !== 'bin' && i.type === 'media' && i.info.kind === 'video') this.hoverScrub(thumb, i);
      this.bindItem(card, i);
      wrap.appendChild(card);
      idx++;
    }
    if (free) wrap.style.height = Math.max(400, ...list.map((i) => (i.freeform ? i.freeform.y + 200 : 0))) + 'px';
    this.body.appendChild(wrap);
  }

  fillThumb(thumb, i) {
    const d = itemDuration(app.store.project, i);
    if (isFinite(d) && d > 0) thumb.appendChild(h('span.badge', framesToTC(Math.round(d * fpsOf(i)), fpsOf(i))));
    if (i.type === 'media' && i.info.hasVideo) {
      const img = h('img', { draggable: false });
      if (i.info.kind === 'image') img.src = fileUrl(i.psdComposite || i.path);
      else window.native.call('media:poster', i.playback || i.path, Math.min(1, (i.info.duration || 0) / 3), 320).then((p) => { img.src = fileUrl(p); }).catch(() => {});
      thumb.prepend(img);
    } else if (i.type === 'media' && i.info.kind === 'audio') {
      const cv = h('canvas', { width: 300, height: 120 }); thumb.prepend(cv);
      const draw = () => { const pk = app.audio.peaksFor(i); if (!pk) return false; const ctx = cv.getContext('2d'); ctx.fillStyle = '#0c1a12'; ctx.fillRect(0, 0, 300, 120); ctx.fillStyle = '#3fcf7f'; const n = pk.data.length / 2; for (let x = 0; x < 300; x++) { const k = Math.floor(x / 300 * n); const v = Math.max(-pk.data[k * 2], pk.data[k * 2 + 1]); ctx.fillRect(x, 60 - v * 55, 1, Math.max(1, v * 110)); } return true; };
      if (!draw()) { const off = app.audio.on('loaded', () => { if (draw()) off(); }); }
    } else thumb.appendChild(icon(iconFor(i), 32));
  }

  hoverScrub(thumb, i) {
    let v = null, line = null;
    thumb.addEventListener('mouseenter', () => {
      v = h('video', { muted: true, preload: 'auto', src: fileUrl(i.playback || i.proxy || i.path), style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } });
      line = h('div.scrubline'); thumb.append(v, line);
    });
    thumb.addEventListener('mousemove', (e) => { if (!v) return; const r = thumb.getBoundingClientRect(); const u = clamp((e.clientX - r.left) / r.width, 0, 1); line.style.left = u * 100 + '%'; if (v.readyState >= 1) v.currentTime = u * (v.duration || 0); });
    thumb.addEventListener('mouseleave', () => { if (v) { v.removeAttribute('src'); v.load(); v.remove(); line.remove(); v = null; } });
  }

  bindItem(el, i) {
    el.addEventListener('mousedown', (e) => {
      if (e.button === 2 && app.store.selection.items.has(i.id)) return;
      app.dock.focus('project');
      if (e.shiftKey && this.lastClicked) {
        const ids = [...this.body.querySelectorAll('[data-id]')].map((x) => x.dataset.id);
        const a = ids.indexOf(this.lastClicked), b = ids.indexOf(i.id);
        app.store.selectItems(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
      } else if (e.metaKey || e.ctrlKey) app.store.selectItems([i.id], 'toggle');
      else if (!app.store.selection.items.has(i.id)) app.store.selectItems([i.id]);
      this.lastClicked = i.id;
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (i.type === 'bin') { if (this.view === 'list') { this.open.has(i.id) ? this.open.delete(i.id) : this.open.add(i.id); this.render(); } else { this.currentBin = i.id; this.render(); } return; }
      if (i.type === 'sequence') { app.store.setActiveSequence(i.id); return; }
      app.ui.openInSource(i.id);
    });
    el.addEventListener('dragstart', (e) => {
      const ids = app.store.selection.items.has(i.id) ? [...app.store.selection.items] : [i.id];
      e.dataTransfer.setData('application/x-cinergy-items', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'copyMove';
      const d = itemDuration(app.store.project, i); const s = app.store.seq;
      if (app.timeline && s) app.timeline.dragLen = Math.round((isFinite(d) ? d : (app.prefs.get('timeline.stillDuration') || 5)) * s.settings.fps);
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.itemMenu(e, i); });
  }

  updateSel() {
    for (const el of this.body.querySelectorAll('[data-id]')) el.classList.toggle('sel', app.store.selection.items.has(el.dataset.id));
  }

  selected() { return [...app.store.selection.items].map((id) => app.store.project.items[id]).filter(Boolean); }

  inlineEdit(td, i, field) {
    const inp = h('input.field', { value: i.metadata[field] || '', style: { width: '100%', height: '20px' } });
    td.innerHTML = ''; td.appendChild(inp); inp.focus(); inp.select();
    const done = (commit) => { if (commit && inp.value !== (i.metadata[field] || '')) app.store.transact('Edit Metadata', () => { i.metadata[field] = inp.value; }, [i.id]); else this.render(); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }

  async rename(i) { const n = await promptDialog('Rename', i.name); if (n) app.store.transact('Rename', () => { i.name = n; }, [i.id]); }

  moveTo(ids, bin) {
    const p = app.store.project;
    app.store.transact('Move to Bin', () => { for (const id of ids) { const it = p.items[id]; if (!it || id === bin || (bin && this.isDescendant(p.items[bin], id))) continue; it.parent = bin || null; } }, ['items']);
  }

  deleteSelected() { const ids = [...app.store.selection.items]; if (ids.length) M.deleteItems(ids); }

  reveal(id) {
    const it = app.store.project.items[id]; if (!it) return;
    let p = it.parent; while (p) { this.open.add(p); p = app.store.project.items[p] && app.store.project.items[p].parent; }
    if (this.view !== 'list') this.currentBin = it.parent;
    this.render();
    const el = this.body.querySelector(`[data-id="${id}"]`); if (el) el.scrollIntoView({ block: 'center' });
  }

  onKey(e) {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { const s = this.selected()[0]; if (s) { e.preventDefault(); e.stopPropagation(); this.rename(s); } }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const ids = [...this.body.querySelectorAll('[data-id]')].map((x) => x.dataset.id);
      const cur = ids.indexOf([...app.store.selection.items].pop());
      const n = clamp(cur + (e.key === 'ArrowDown' ? 1 : -1), 0, ids.length - 1);
      if (ids[n]) { app.store.selectItems([ids[n]]); e.preventDefault(); e.stopPropagation(); }
    }
  }

  newMenu(e) {
    const r = e.target.closest('button').getBoundingClientRect();
    contextMenu(r.left, r.top - 260, this.newItems());
  }

  newItems() {
    return [
      { label: 'Sequence...', action: () => A.newSequenceDialog() },
      { label: 'Bin', action: () => M.newBin() },
      { label: 'Search Bin from current search', disabled: !this.filter, action: () => this.searchBin() },
      '-',
      { label: 'Adjustment Layer', action: () => M.newSynthetic('adjustment') },
      { label: 'Color Matte...', action: () => M.newSynthetic('matte') },
      { label: 'Black Video', action: () => M.newSynthetic('black') },
      { label: 'Transparent Video', action: () => M.newSynthetic('transparent') },
      { label: 'Bars and Tone', action: () => M.newSynthetic('bars') },
      { label: 'Universal Counting Leader', action: () => M.newSynthetic('countdown') },
      { label: 'Graphic from Template', submenu: Object.entries(GRAPHIC_TEMPLATES).map(([k, t]) => ({ label: t.name, action: () => M.newGraphicItem(t.name, t.make()) })) },
    ];
  }

  async searchBin() {
    const name = await promptDialog('Search Bin name', 'Search: ' + this.filter);
    if (!name) return;
    const ids = Object.values(app.store.project.items).filter((i) => i.type !== 'bin' && this.matches(i)).map((i) => i.id);
    const b = M.newBin(name);
    toast(`${ids.length} matching item(s) are listed under the search term; drag them into "${b.name}" to collect them`);
  }

  emptyMenu(e) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Import...', cmd: 'file.import' }, { label: 'Import Folder...', action: () => M.importDialog({ folder: true }) }, '-',
      { label: 'New Bin', action: () => M.newBin() }, { label: 'New Item', submenu: () => this.newItems() }, '-',
      { label: 'Remove Unused', action: () => M.removeUnused() }, { label: 'Columns...', action: () => this.columnMenu(e) },
      { label: 'Find...', action: () => this.search.focus() },
    ]);
  }

  columnMenu(e) {
    contextMenu(e.clientX, e.clientY, Object.entries(COLUMNS).filter(([k]) => k !== 'name').map(([k, c]) => ({ label: c.label, checked: this.columns.includes(k), action: () => { this.columns = this.columns.includes(k) ? this.columns.filter((x) => x !== k) : [...this.columns, k]; app.prefs.set('project.columns', this.columns); this.render(); } })));
  }

  itemMenu(e, i) {
    const sel = this.selected();
    const media = sel.filter((x) => x.type === 'media');
    const video = media.filter((x) => x.info.kind === 'video');
    contextMenu(e.clientX, e.clientY, [
      { label: 'Cut', cmd: 'edit.cut' }, { label: 'Copy', cmd: 'edit.copy' }, { label: 'Paste', cmd: 'edit.paste' }, { label: 'Clear', action: () => this.deleteSelected() }, '-',
      { label: 'Rename', action: () => this.rename(i) }, { label: 'Duplicate', action: () => M.duplicateItems(sel.map((x) => x.id)) },
      { label: 'New Bin from Selection', action: () => { const b = M.newBin('New Bin', i.parent); this.moveTo(sel.map((x) => x.id), b.id); } },
      { label: 'Label', submenu: Object.keys(LABEL_COLORS).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), action: () => app.store.transact('Label', () => { for (const x of sel) x.label = k; }, ['items']) })) },
      '-',
      { label: 'New Sequence From Clip', disabled: !sel.length || sel.some((x) => x.type === 'bin'), action: () => A.newSequenceFromItems(sel) },
      { label: 'Open in Source Monitor', disabled: i.type === 'bin', action: () => app.ui.openInSource(i.id) },
      { label: 'Open in Timeline', disabled: i.type !== 'sequence', action: () => app.store.setActiveSequence(i.id) },
      { label: 'Create Multi-Camera Source Sequence...', disabled: media.length < 2, action: () => A.createMulticamDialog(media) },
      { label: 'Merge Clips...', disabled: media.length < 2, action: () => A.mergeClipsDialog(media) },
      i.type === 'media' && i.info.kind === 'psd' ? { label: 'Import Layers as Sequence', action: () => M.psdAsSequence(i) } : null,
      '-',
      { label: 'Proxy', disabled: !video.length, submenu: [{ label: 'Create Proxies...', action: () => M.createProxies(video, { ask: true }) }, { label: 'Attach Proxy...', action: () => M.attachProxy(video[0]) }, { label: 'Detach Proxies', action: () => M.detachProxy(video) }] },
      { label: 'Modify', disabled: !media.length, submenu: [{ label: 'Interpret Footage...', action: () => M.interpretFootage(media) }, { label: 'Audio Channels...', action: () => toast('Set channel mapping on clips in the timeline: right-click a clip, then Audio Channels') }, { label: 'Timecode...', action: async () => { const v = await promptDialog('Media start timecode', i.info.timecode || '00:00:00:00'); if (v) app.store.transact('Timecode', () => { i.info.timecode = v; }, [i.id]); } }] },
      { label: 'Make Offline', disabled: !media.length, action: () => M.makeOffline(media) },
      { label: 'Link Media...', disabled: !media.length, action: () => M.relinkDialog(media) },
      { label: 'Replace Footage...', disabled: i.type !== 'media', action: () => M.replaceFootage(i) },
      { label: 'Edit Original', disabled: i.type !== 'media', action: () => window.native.call('shell:open', i.path) },
      { label: 'Reveal in Finder', disabled: i.type !== 'media', action: () => window.native.call('shell:reveal', i.path) },
      '-',
      { label: 'Export Media...', disabled: i.type !== 'sequence', action: () => import('../../actions/export.js').then((m) => m.exportDialog({ seqIds: sel.filter((x) => x.type === 'sequence').map((x) => x.id) })) },
      { label: 'Duplicate Sequence', disabled: i.type !== 'sequence', action: () => A.duplicateSequence(i.id) },
      { label: 'Properties', disabled: i.type !== 'media', action: () => M.mediaProperties(i) },
      { label: 'Metadata', action: () => { app.dock.openPanel('metadata'); } },
    ]);
  }

  menu() { return [{ label: 'List View', action: () => this.setView('list') }, { label: 'Icon View', action: () => this.setView('icon') }, { label: 'Freeform View', action: () => this.setView('free') }, '-', { label: 'Remove Unused', action: () => M.removeUnused() }, { label: 'Metadata Display...', action: () => this.columnMenu({ clientX: 300, clientY: 200 }) }]; }

  resize() {}
}

export function createProjectPanel(el) { return new ProjectPanel(el); }
export { binPath };
