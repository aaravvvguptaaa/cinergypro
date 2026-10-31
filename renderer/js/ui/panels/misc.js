// Text (captions), Properties (graphics), Markers, History, Metadata, Media Browser, Libraries,
const IS_MAC_UI = (window.native && window.native.platform === 'darwin');
const K = (t) => (IS_MAC_UI ? t : t.replace(/Cmd\+/g, 'Ctrl+'));
// Info, Production, Tools, Export Queue, Learn and Script Console panels.
import { app } from '../../app-context.js';
import { h, icon, clamp, deepClone, uid, LABEL_COLORS, formatBytes, fileUrl, basename, dirname, extname } from '../../core/util.js';
import { findClip, seqDuration, itemDuration, clipSourceTime, allTracks } from '../../core/project.js';
import { framesToTC } from '../../core/timecode.js';
import { contextMenu, ibtn, section, sliderRow, colorInput, scrubNumber, toast, promptDialog, selectInput } from '../widgets.js';
import { GRAPHIC_TEMPLATES } from '../../engine/graphics.js';
import { commands } from '../../core/commands.js';
import { TOOLS } from './timeline.js';
import { createCaptionTrack } from '../../actions/captions.js';

// ---------------- Text panel (captions and graphics layers) ----------------
export class TextPanel {
  constructor(el) {
    this.el = el; this.tab = 'captions'; this.trackId = null;
    app.panels.text = this;
    this.tabs = h('div.tabs', { style: { margin: '6px 8px 0' } });
    this.tb = h('div.toolbar');
    this.body = h('div.scroll');
    el.append(this.tabs, this.tb, this.body);
    app.store.on('change', (e) => { if (!this.typing && !(e && e.transient)) this.render(); });
    app.store.on('sequence', () => this.render());
    app.store.on('selection', () => { if (this.tab === 'graphics') this.render(); });
    app.player.on('playhead', () => this.highlight());
    this.render();
  }
  get seq() { return app.store.seq; }
  track() { const s = this.seq; if (!s) return null; return s.captionTracks.find((t) => t.id === this.trackId) || s.captionTracks[0] || null; }

  render() {
    this.tabs.innerHTML = '';
    for (const [k, l] of [['captions', 'Captions'], ['graphics', 'Graphics']]) this.tabs.appendChild(h('button' + (this.tab === k ? '.on' : ''), { on: { click: () => { this.tab = k; this.render(); } } }, l));
    this.tb.innerHTML = ''; this.body.innerHTML = '';
    if (this.tab === 'captions') this.renderCaptions(); else this.renderGraphics();
  }

  async cap() { return import('../../actions/captions.js'); }

  renderCaptions() {
    const s = this.seq;
    if (!s) { this.body.appendChild(h('div.empty', 'Open a sequence to work with captions')); return; }
    const t = this.track();
    const pick = h('select.field', { style: { flex: 1, height: '22px' }, on: { change: (e) => { this.trackId = e.target.value; this.render(); } } }, s.captionTracks.map((c) => h('option', { value: c.id, selected: t && c.id === t.id }, c.name)));
    this.search = h('input.field', { placeholder: 'Search', style: { width: '110px' }, on: { input: () => this.render(), keydown: (e) => e.stopPropagation() } });
    this.tb.append(
      s.captionTracks.length ? pick : h('span', { style: { color: 'var(--dim)', flex: 1 } }, 'No caption tracks'),
      ibtn('plus', 'Add caption at playhead', async () => { (await this.cap()).addCaption(); }),
      ibtn('cc', 'New caption track', async () => { const n = await promptDialog('Caption track name', 'Subtitles ' + (s.captionTracks.length + 1)); if (n) { app.store.transact('New Caption Track', () => { const t = createCaptionTrack(s, n); this.trackId = t.id; }); } }),
      ibtn('import', 'Import captions', async () => (await this.cap()).importCaptions()),
      ibtn('export', 'Export captions', async () => (await this.cap()).exportCaptionsDialog()),
      ibtn('more', 'Caption options', (e) => this.capMenu(e, t)));
    if (!t) { this.body.appendChild(h('div.empty', h('div', h('b', 'Create captions'), 'Add a caption at the playhead or import an SRT or WebVTT file.'))); return; }
    // style section
    const st = t.style;
    const setStyle = (k, v) => app.store.transact('Caption Style', () => { const tt = s.captionTracks.find((x) => x.id === t.id); tt.style[k] = v; }, [s.id], { coalesce: 'capstyle:' + k });
    const style = h('div',
      h('div.row', h('label', 'Font'), selectInput([['Inter', 'Inter'], ['Plex', 'IBM Plex Sans'], ['Helvetica Neue', 'Helvetica Neue'], ['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Menlo', 'Menlo']], st.font, (v) => setStyle('font', v))),
      sliderRow('Size', st.size, 16, 120, 1, (v, f) => f && setStyle('size', v)),
      h('div.row', h('label', 'Text color'), colorInput(st.color, (v, f) => f && setStyle('color', v)), h('label', { style: { flex: '0 0 auto' } }, 'Background'), colorInput(st.bg, (v, f) => f && setStyle('bg', v))),
      sliderRow('Background opacity', st.bgOpacity, 0, 100, 1, (v, f) => f && setStyle('bgOpacity', v)),
      sliderRow('Outline', st.outline || 0, 0, 10, 0.5, (v, f) => f && setStyle('outline', v)),
      h('div.row', h('label', 'Position'), selectInput([['bottom', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']], st.position, (v) => setStyle('position', v)), selectInput([['center', 'Center'], ['left', 'Left'], ['right', 'Right']], st.align, (v) => setStyle('align', v))),
      sliderRow('Safe margin', Math.round(st.margin * 100), 0, 30, 1, (v, f) => f && setStyle('margin', v / 100)),
      h('label.check', h('input', { type: 'checkbox', checked: !!st.wordByWord, on: { change: (e) => setStyle('wordByWord', e.target.checked) } }), 'Animate one word at a time'),
    );
    this.body.appendChild(section('Caption style', style, { closed: true }));
    const q = (this.search && this.search.value || '').toLowerCase();
    const fps = s.settings.fps;
    for (const c of t.captions) {
      if (q && !c.text.toLowerCase().includes(q)) continue;
      const ta = h('textarea', { rows: Math.max(1, c.text.split('\n').length) }, c.text);
      ta.addEventListener('focus', () => { app.player.seek(c.start); app.store.selection.captions.clear(); app.store.selection.captions.add(c.id); app.timeline && (app.timeline.dirty = true); });
      ta.addEventListener('input', () => { this.typing = true; c.text = ta.value; ta.rows = Math.max(1, ta.value.split('\n').length); app.player.invalidate('program'); app.timeline && (app.timeline.dirty = true); });
      ta.addEventListener('blur', () => { if (this.typing) { this.typing = false; const v = ta.value; app.store.transact('Edit Caption', () => { const tt = s.captionTracks.find((x) => x.id === t.id); const cc = tt.captions.find((x) => x.id === c.id); if (cc) cc.text = v; }); } });
      ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
      const row = h('div.cap-row', { dataset: { cap: c.id } }, h('div.times', framesToTC(c.start, fps), h('br'), framesToTC(c.end, fps), c.speaker ? h('div', { style: { color: 'var(--blue-hi)' } }, c.speaker) : null), ta);
      row.addEventListener('contextmenu', async (e) => { e.preventDefault(); const m = await this.cap(); contextMenu(e.clientX, e.clientY, [
        { label: 'Split', action: () => m.splitCaption(t.id, c.id) }, { label: 'Merge with Next', action: () => { const i = t.captions.indexOf(c); if (t.captions[i + 1]) m.mergeCaptions(t.id, new Set([c.id, t.captions[i + 1].id])); } },
        { label: 'Set Speaker...', action: async () => { const n = await promptDialog('Speaker label', c.speaker || ''); if (n != null) m.updateCaption(t.id, c.id, { speaker: n }); } },
        { label: 'Set Start to Playhead', action: () => m.updateCaption(t.id, c.id, { start: Math.min(s.playhead, c.end - 1) }) }, { label: 'Set End to Playhead', action: () => m.updateCaption(t.id, c.id, { end: Math.max(s.playhead, c.start + 1) }) },
        { label: 'Delete', action: () => m.deleteCaptions(t.id, new Set([c.id])) }]); });
      this.body.appendChild(row);
    }
    this.highlight();
  }

  capMenu(e, t) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Find and Replace...', disabled: !t, action: async () => { const f = await promptDialog('Find text'); if (!f) return; const r = await promptDialog('Replace with', ''); if (r == null) return; const n = (await this.cap()).findReplace(t.id, f, r); toast(`Replaced in ${n} caption(s)`); } },
      { label: 'Resegment (42 characters, 2 lines)', disabled: !t, action: async () => (await this.cap()).resegment(t.id, 42, 2) },
      { label: 'Rename Track...', disabled: !t, action: async () => { const n = await promptDialog('Rename', t.name); if (n) app.store.transact('Rename', () => { t.name = n; }); } },
      { label: 'Delete Track', disabled: !t, action: () => app.store.transact('Delete Caption Track', () => { this.seq.captionTracks = this.seq.captionTracks.filter((x) => x.id !== t.id); }) },
    ]);
  }

  focusCaption(id) { this.tab = 'captions'; this.render(); const el = this.body.querySelector(`[data-cap="${id}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
  highlight() { const s = this.seq; const t = this.track(); if (!s || !t || this.tab !== 'captions') return; for (const el of this.body.querySelectorAll('.cap-row')) { const c = t.captions.find((x) => x.id === el.dataset.cap); el.classList.toggle('sel', !!c && s.playhead >= c.start && s.playhead < c.end); } }

  renderGraphics() {
    const s = this.seq;
    const f = s && [...app.store.selection.clips].map((id) => findClip(s, id)).find((x) => x && x.clip.graphic);
    this.tb.append(h('button.btn.small', { on: { click: () => import('../../actions/editing.js').then((m) => m.newGraphicAtPlayhead()) } }, icon('type', 12), 'New Graphic'));
    if (!f) { this.body.appendChild(h('div.empty', 'Select a graphic clip to see its layers')); return; }
    for (const l of f.clip.graphic.layers) {
      const sel = app.program && app.program.selectedLayer === l.id;
      const row = h('div.list-row' + (sel ? '.sel' : ''), icon(l.type === 'text' ? 'type' : 'shape', 13), h('span', { style: { flex: 1 } }, l.name || l.text || l.type), h('span', { style: { cursor: 'pointer', display: 'flex' }, on: { click: (e) => { e.stopPropagation(); app.store.transact('Layer Visibility', () => { l.visible = l.visible === false; }); } } }, icon(l.visible === false ? 'eye-off' : 'eye', 13)));
      row.addEventListener('click', () => { if (app.program) app.program.selectedLayer = l.id; app.panels.properties && app.panels.properties.selectLayer(l.id); this.render(); });
      this.body.appendChild(row);
    }
  }
  resize() {}
}

// ---------------- Properties (graphics, quick clip properties, templates) ----------------
export class PropertiesPanel {
  constructor(el) {
    this.el = el; this.layerId = null; this.tab = 'edit';
    app.panels.properties = this;
    this.tabs = h('div.tabs', { style: { margin: '6px 8px 0' } }); this.body = h('div.scroll');
    el.append(this.tabs, this.body);
    app.store.on('selection', () => this.render());
    app.store.on('change', (e) => { if (!this.busy && !(e && e.transient)) this.render(); });
    app.player.on('playhead', () => {});
    this.render();
  }
  get seq() { return app.store.seq; }
  selectLayer(id) { this.layerId = id; this.tab = 'edit'; this.render(); }
  target() { const s = this.seq; if (!s) return null; return [...app.store.selection.clips].map((id) => findClip(s, id)).filter(Boolean).sort((a, b) => (a.kind === 'video' ? -1 : 1))[0] || null; }

  render() {
    this.tabs.innerHTML = '';
    for (const [k, l] of [['edit', 'Edit'], ['browse', 'Templates']]) this.tabs.appendChild(h('button' + (this.tab === k ? '.on' : ''), { on: { click: () => { this.tab = k; this.render(); } } }, l));
    this.body.innerHTML = '';
    if (this.tab === 'browse') return this.renderTemplates();
    const f = this.target();
    if (!f) { this.body.appendChild(h('div.empty', h('div', h('b', 'Nothing selected'), 'Select a clip to edit its properties, or create a graphic with the Type tool.'))); return; }
    if (f.clip.graphic) return this.renderGraphic(f);
    this.renderClip(f);
  }

  live(f) { return findClip(this.seq, f.clip.id).clip; }
  mut(label, fn, final) {
    const s = this.seq; if (!this.snap) this.snap = JSON.stringify(s.tracks);
    this.busy = true; fn(); app.player.invalidate('program');
    if (final) { const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(this.snap); this.snap = null; app.store.transact(label, () => { s.tracks = JSON.parse(after); }); this.busy = false; }
  }

  renderClip(f) {
    const c = f.clip;
    this.body.appendChild(h('div', { style: { padding: '10px 10px 0', color: 'var(--white)', fontWeight: 600 } }, c.name));
    if (f.kind === 'video') {
      const mo = c.effects.find((e) => e.type === 'motion'), op = c.effects.find((e) => e.type === 'opacity');
      const set = (fx, k, v, fin) => this.mut('Change ' + k, () => { this.live(f).effects.find((e) => e.id === fx.id).params[k] = v; }, fin);
      this.body.appendChild(section('Transform', h('div',
        sliderRow('Scale', mo.params.scale, 0, 400, 0.1, (v, fin) => set(mo, 'scale', v, fin), { def: 100 }),
        sliderRow('Position X', +(mo.params.position[0] * this.seq.settings.width).toFixed(1), -this.seq.settings.width, this.seq.settings.width * 2, 1, (v, fin) => set(mo, 'position', [v / this.seq.settings.width, this.live(f).effects.find((e) => e.id === mo.id).params.position[1]], fin)),
        sliderRow('Position Y', +(mo.params.position[1] * this.seq.settings.height).toFixed(1), -this.seq.settings.height, this.seq.settings.height * 2, 1, (v, fin) => set(mo, 'position', [this.live(f).effects.find((e) => e.id === mo.id).params.position[0], v / this.seq.settings.height], fin)),
        sliderRow('Rotation', mo.params.rotation, -180, 180, 0.1, (v, fin) => set(mo, 'rotation', v, fin)),
        sliderRow('Opacity', op.params.opacity, 0, 100, 0.1, (v, fin) => set(op, 'opacity', v, fin), { def: 100 }),
        h('div.row', h('label', 'Blend mode'), selectInput(app.effectDefs.opacity.params[1].options, op.params.blendMode, (v) => set(op, 'blendMode', v, true))),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } }, h('button.btn.small', { on: { click: () => import('../../actions/editing.js').then((m) => m.scaleToFrame('set')) } }, 'Fit to frame'), h('button.btn.small', { on: { click: () => import('../../actions/editing.js').then((m) => m.scaleToFrame('fill')) } }, 'Fill frame')))));
      this.body.appendChild(section('Speed', h('div', h('div.row', h('label', 'Speed'), h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--blue-hi)' } }, `${Math.round(c.speed * 100)}%${c.reverse ? ' reversed' : ''}`), h('button.btn.small', { on: { click: () => commands.run('clip.speed') } }, 'Change...')))));
      this.body.appendChild(section('Color', h('div', h('button.btn.small', { on: { click: () => app.dock.openPanel('lumetri') } }, 'Open Lumetri Color'), ' ', h('button.btn.small', { on: { click: () => import('./lumetri.js').then(() => app.panels.lumetri && app.panels.lumetri.auto(f)) } }, 'Auto Color'))));
    } else {
      const vol = c.effects.find((e) => e.type === 'volume'), pn = c.effects.find((e) => e.type === 'panner');
      this.body.appendChild(section('Audio', h('div',
        sliderRow('Volume (dB)', vol.params.level, -40, 15, 0.1, (v, fin) => this.mut('Volume', () => { this.live(f).effects.find((e) => e.id === vol.id).params.level = v; }, fin)),
        sliderRow('Clip gain (dB)', c.gain || 0, -24, 24, 0.1, (v, fin) => this.mut('Gain', () => { this.live(f).gain = v; }, fin)),
        sliderRow('Pan', pn.params.balance, -100, 100, 1, (v, fin) => this.mut('Pan', () => { this.live(f).effects.find((e) => e.id === pn.id).params.balance = v; }, fin)),
        h('button.btn.small', { on: { click: () => app.dock.openPanel('essentialSound') } }, 'Essential Sound'))));
    }
  }

  renderGraphic(f) {
    const g = f.clip.graphic;
    const layers = g.layers;
    if (!layers.find((l) => l.id === this.layerId)) this.layerId = layers[0] ? layers[0].id : null;
    const l = layers.find((x) => x.id === this.layerId);
    const s = this.seq;
    const setL = (k, v, fin, label = 'Edit Graphic') => this.mut(label, () => { const lc = this.live(f); const ll = lc.graphic.layers.find((x) => x.id === this.layerId); const lf = s.playhead - lc.start; if (ll.keyframes && ll.keyframes[k] && ll.keyframes[k].length) { import('../../core/keyframes.js').then((m) => m.setKey(ll.keyframes[k], lf, v)); } else ll[k] = v; if (k === 'text') { lc.name = String(v).split('\n')[0].slice(0, 30) || 'Graphic'; } }, fin);
    // layers list
    const list = h('div');
    layers.forEach((x, i) => {
      const row = h('div.list-row' + (x.id === this.layerId ? '.sel' : ''), icon(x.type === 'text' ? 'type' : 'shape', 13), h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.name || x.text || x.type));
      row.addEventListener('click', () => { this.layerId = x.id; if (app.program) { app.program.selectedLayer = x.id; app.program.drawOverlay(); } this.render(); });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [
        { label: 'Move Up', disabled: i === 0, action: () => this.mut('Reorder Layers', () => { const a = this.live(f).graphic.layers; [a[i - 1], a[i]] = [a[i], a[i - 1]]; }, true) },
        { label: 'Move Down', disabled: i === layers.length - 1, action: () => this.mut('Reorder Layers', () => { const a = this.live(f).graphic.layers; [a[i + 1], a[i]] = [a[i], a[i + 1]]; }, true) },
        { label: 'Duplicate', action: () => this.mut('Duplicate Layer', () => { const a = this.live(f).graphic.layers; const c = deepClone(a[i]); c.id = uid('lyr'); c.y += 0.05; a.splice(i, 0, c); }, true) },
        { label: 'Delete', action: () => this.mut('Delete Layer', () => { const a = this.live(f).graphic.layers; a.splice(i, 1); }, true) }]); });
      list.appendChild(row);
    });
    const addLayer = (type) => this.mut('Add Layer', () => {
      const lc = this.live(f);
      const base = { id: uid('lyr'), x: 0.5, y: 0.5, opacity: 100, rotation: 0, scale: 100, keyframes: {}, visible: true, anim: 'none', animDur: 0.5, fill: '#ffffff', fillOn: true };
      const nl = type === 'text' ? { ...base, type: 'text', name: 'Text', text: 'New Text', font: app.prefs.get('graphics.defaultFont') || 'Inter', size: app.prefs.get('graphics.defaultSize') || 96, weight: 700, align: 'center', leading: 1.15, tracking: 0, boxWidth: 0 }
        : { ...base, type, name: type === 'ellipse' ? 'Ellipse' : type === 'line' ? 'Line' : 'Rectangle', width: 400, height: 200, fill: '#2f7cff', stroke: '#ffffff', strokeWidth: type === 'line' ? 6 : 0 };
      lc.graphic.layers.unshift(nl); this.layerId = nl.id;
    }, true);
    this.body.appendChild(section('Layers', h('div', list, h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px' } }, h('button.btn.small', { on: { click: () => addLayer('text') } }, icon('type', 12), 'Text'), h('button.btn.small', { on: { click: () => addLayer('rect') } }, icon('rect', 12), 'Rectangle'), h('button.btn.small', { on: { click: () => addLayer('ellipse') } }, icon('ellipse', 12), 'Ellipse'), h('button.btn.small', { on: { click: () => addLayer('line') } }, 'Line'), h('button.btn.small', { on: { click: () => this.addImageLayer(f) } }, icon('image', 12), 'Logo')))));
    if (!l) return;
    // align
    const align = (k) => this.mut('Align', () => { const ll = this.live(f).graphic.layers.find((x) => x.id === this.layerId); ({ l: () => { ll.x = 0.1; }, c: () => { ll.x = 0.5; }, r: () => { ll.x = 0.9; }, t: () => { ll.y = 0.1; }, m: () => { ll.y = 0.5; }, b: () => { ll.y = 0.9; } })[k](); }, true);
    const distribute = (axis) => this.mut('Distribute', () => { const a = this.live(f).graphic.layers.filter((x) => x.visible !== false); a.sort((p, q) => p[axis] - q[axis]); const lo = a[0][axis], hi = a[a.length - 1][axis]; a.forEach((x, i) => { x[axis] = lo + (hi - lo) * i / Math.max(1, a.length - 1); }); }, true);
    this.body.appendChild(section('Align and Transform', h('div',
      h('div', { style: { display: 'flex', gap: '2px', marginBottom: '6px' } }, ibtn('align-l', 'Align left (title safe)', () => align('l')), ibtn('align-c', 'Align horizontal center', () => align('c')), ibtn('align-r', 'Align right', () => align('r')), ibtn('align-t', 'Align top', () => align('t')), ibtn('align-m', 'Align vertical center', () => align('m')), ibtn('align-b', 'Align bottom', () => align('b')), ibtn('dist-h', 'Distribute horizontally', () => distribute('x')), ibtn('dist-v', 'Distribute vertically', () => distribute('y'))),
      sliderRow('Position X', Math.round(l.x * s.settings.width), 0, s.settings.width, 1, (v, fin) => setL('x', v / s.settings.width, fin)),
      sliderRow('Position Y', Math.round(l.y * s.settings.height), 0, s.settings.height, 1, (v, fin) => setL('y', v / s.settings.height, fin)),
      sliderRow('Scale', l.scale, 1, 500, 0.1, (v, fin) => setL('scale', v, fin), { def: 100 }),
      sliderRow('Rotation', l.rotation || 0, -180, 180, 0.1, (v, fin) => setL('rotation', v, fin)),
      sliderRow('Opacity', l.opacity, 0, 100, 0.1, (v, fin) => setL('opacity', v, fin), { def: 100 }),
      h('div', { style: { display: 'flex', gap: '4px', marginTop: '4px' } }, ...['x', 'y', 'scale', 'rotation', 'opacity'].map((k) => h('button.btn.small' + (l.keyframes && l.keyframes[k] && l.keyframes[k].length ? '.primary' : ''), { title: `Animate ${k}`, on: { click: () => this.toggleLayerKey(f, k) } }, icon('stopwatch', 11), k))))));
    if (l.type === 'text') {
      const ta = h('textarea.field', { rows: 3, style: { width: '100%' } }, l.text);
      ta.addEventListener('input', () => setL('text', ta.value, false));
      ta.addEventListener('change', () => setL('text', ta.value, true));
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      const fonts = ['Inter', 'Plex', 'Helvetica Neue', 'Avenir Next', 'Futura', 'Gill Sans', 'Georgia', 'Times New Roman', 'Didot', 'Baskerville', 'Menlo', 'Courier New', 'Impact', 'Arial Black', 'Optima', 'Copperplate'];
      this.body.appendChild(section('Text', h('div', ta,
        h('div.row', h('label', 'Font'), selectInput(fonts.map((x) => [x, x]), l.font, (v) => setL('font', v, true))),
        h('div.row', h('label', 'Weight'), selectInput([[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold']], l.weight, (v) => setL('weight', +v, true)), h('label.check', h('input', { type: 'checkbox', checked: l.italic, on: { change: (e) => setL('italic', e.target.checked, true) } }), 'Italic'), h('label.check', h('input', { type: 'checkbox', checked: l.caps, on: { change: (e) => setL('caps', e.target.checked, true) } }), 'All caps')),
        sliderRow('Size', l.size, 8, 400, 1, (v, fin) => setL('size', v, fin)),
        sliderRow('Tracking', l.tracking || 0, -200, 800, 1, (v, fin) => setL('tracking', v, fin)),
        sliderRow('Leading', +(l.leading || 1.2).toFixed(2), 0.6, 3, 0.01, (v, fin) => setL('leading', v, fin)),
        sliderRow('Paragraph width (0 = point text)', l.boxWidth || 0, 0, s.settings.width, 1, (v, fin) => setL('boxWidth', v, fin)),
        h('div', { style: { display: 'flex', gap: '2px' } }, ibtn('align-l', 'Left align text', () => setL('align', 'left', true)), ibtn('align-c', 'Center text', () => setL('align', 'center', true)), ibtn('align-r', 'Right align text', () => setL('align', 'right', true))))));
    } else if (l.type !== 'image') {
      this.body.appendChild(section('Shape', h('div', sliderRow('Width', l.width, 1, s.settings.width * 2, 1, (v, fin) => setL('width', v, fin)), sliderRow('Height', l.height, 1, s.settings.height * 2, 1, (v, fin) => setL('height', v, fin)), l.type === 'rect' || l.type === 'roundrect' ? sliderRow('Corner radius', l.radius || 0, 0, 500, 1, (v, fin) => setL('radius', v, fin)) : null)));
    }
    this.body.appendChild(section('Appearance', h('div',
      h('div.row', h('label.check', h('input', { type: 'checkbox', checked: l.fillOn !== false, on: { change: (e) => setL('fillOn', e.target.checked, true) } }), 'Fill'), colorInput(l.fill || '#ffffff', (v, fin) => setL('fill', v, fin)),
        h('label.check', h('input', { type: 'checkbox', checked: !!l.gradient, on: { change: (e) => setL('gradient', e.target.checked ? { type: 'linear', angle: 90, stops: [[0, l.fill || '#ffffff'], [1, '#2f7cff']] } : null, true) } }), 'Gradient')),
      l.gradient ? h('div.row', h('label', 'Gradient'), colorInput(l.gradient.stops[0][1], (v, fin) => setL('gradient', { ...l.gradient, stops: [[0, v], l.gradient.stops[1]] }, fin)), colorInput(l.gradient.stops[1][1], (v, fin) => setL('gradient', { ...l.gradient, stops: [l.gradient.stops[0], [1, v]] }, fin)), scrubNumber({ value: l.gradient.angle, step: 1, onChange: (v, fin) => setL('gradient', { ...l.gradient, angle: v }, fin) })) : null,
      h('div.row', h('label.check', h('input', { type: 'checkbox', checked: !!l.strokeOn, on: { change: (e) => setL('strokeOn', e.target.checked, true) } }), 'Stroke'), colorInput(l.stroke || '#000000', (v, fin) => setL('stroke', v, fin)), scrubNumber({ value: l.strokeWidth || 0, min: 0, max: 100, step: 0.5, onChange: (v, fin) => setL('strokeWidth', v, fin) })),
      l.type === 'text' ? h('div.row', h('label.check', h('input', { type: 'checkbox', checked: !!l.bgOn, on: { change: (e) => setL('bgOn', e.target.checked, true) } }), 'Background'), colorInput(l.bg || '#000000', (v, fin) => setL('bg', v, fin)), scrubNumber({ value: l.bgOpacity == null ? 60 : l.bgOpacity, min: 0, max: 100, step: 1, onChange: (v, fin) => setL('bgOpacity', v, fin) }), scrubNumber({ value: l.bgPad || 20, min: 0, max: 200, step: 1, onChange: (v, fin) => setL('bgPad', v, fin) })) : null,
      h('div.row', h('label.check', h('input', { type: 'checkbox', checked: !!l.shadowOn, on: { change: (e) => setL('shadowOn', e.target.checked, true) } }), 'Shadow'), colorInput(l.shadow || '#000000', (v, fin) => setL('shadow', v, fin)), scrubNumber({ value: l.shadowDist == null ? 6 : l.shadowDist, min: 0, max: 200, step: 0.5, onChange: (v, fin) => setL('shadowDist', v, fin) }), scrubNumber({ value: l.shadowBlur == null ? 8 : l.shadowBlur, min: 0, max: 200, step: 0.5, onChange: (v, fin) => setL('shadowBlur', v, fin) })),
    )));
    this.body.appendChild(section('Animation', h('div',
      h('div.row', h('label', 'In/out animation'), selectInput([['none', 'None'], ['fade', 'Fade'], ['slideUp', 'Slide Up'], ['slideDown', 'Slide Down'], ['slideLeft', 'Slide from Right'], ['slideRight', 'Slide from Left'], ['pop', 'Pop'], ['blur', 'Blur In'], ['typewriter', 'Typewriter'], ['words', 'Word by Word']], l.anim || 'none', (v) => setL('anim', v, true))),
      sliderRow('Animation duration (s)', l.animDur || 0.5, 0.05, 5, 0.05, (v, fin) => setL('animDur', v, fin)),
      h('label.check', h('input', { type: 'checkbox', checked: l.animOut !== false, on: { change: (e) => setL('animOut', e.target.checked, true) } }), 'Animate out at the end'))));
    this.body.appendChild(section('Template', h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button.btn.small', { on: { click: async () => { const n = await promptDialog('Template name', f.clip.name); if (!n) return; app.store.transact('Save Template', () => { app.store.project.libraries.graphics.push({ id: uid('tpl'), name: n, graphic: deepClone(f.clip.graphic) }); }, ['project']); const user = app.prefs.get('graphics.templates') || []; user.push({ id: uid('tpl'), name: n, graphic: deepClone(f.clip.graphic) }); app.prefs.set('graphics.templates', user); toast('Saved as template'); } } }, 'Save as Template'),
      h('button.btn.small', { on: { click: () => { app.store.transact('Save Text Style', () => { app.store.project.libraries.textStyles.push({ id: uid('sty'), name: `${l.font} ${l.size}`, style: pickStyle(l) }); }, ['project']); toast('Text style saved to Libraries'); } } }, 'Save Text Style'))));
  }

  toggleLayerKey(f, k) {
    const s = this.seq;
    app.store.transact('Layer Keyframes', () => {
      const lc = findClip(s, f.clip.id).clip; const ll = lc.graphic.layers.find((x) => x.id === this.layerId);
      ll.keyframes = ll.keyframes || {};
      const lf = s.playhead - lc.start;
      if (ll.keyframes[k] && ll.keyframes[k].length) { ll.keyframes[k] = []; }
      else { ll.keyframes[k] = [{ t: Math.max(0, lf), v: ll[k], interp: 'linear' }]; }
    });
  }

  async addImageLayer(f) {
    const r = await window.native.call('dialog:open', { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }] });
    if (!r) return;
    const img = new Image(); img.src = fileUrl(r[0]); await img.decode().catch(() => {});
    this.mut('Add Logo', () => { const lc = this.live(f); const nl = { id: uid('lyr'), type: 'image', name: basename(r[0]), image: r[0], x: 0.85, y: 0.15, width: img.naturalWidth || 300, height: img.naturalHeight || 300, scale: Math.min(100, 30000 / (img.naturalWidth || 300)), opacity: 100, rotation: 0, keyframes: {}, visible: true, anim: 'fade', animDur: 0.5 }; lc.graphic.layers.unshift(nl); this.layerId = nl.id; }, true);
  }

  renderTemplates() {
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px,1fr))', gap: '8px', padding: '10px' } });
    const all = [...Object.entries(GRAPHIC_TEMPLATES).map(([k, t]) => ({ name: t.name, make: t.make })), ...(app.prefs.get('graphics.templates') || []).map((t) => ({ name: t.name, make: () => deepClone(t.graphic), user: t })), ...(app.store.project.libraries.graphics || []).map((t) => ({ name: t.name, make: () => deepClone(t.graphic) }))];
    for (const t of all) {
      const cv = h('canvas', { width: 320, height: 180, style: { width: '100%', background: '#1a1d23', borderRadius: '4px' } });
      import('../../engine/graphics.js').then((m) => { const ctx = cv.getContext('2d'); ctx.fillStyle = '#20252d'; ctx.fillRect(0, 0, 320, 180); const c2 = document.createElement('canvas'); c2.width = 320; c2.height = 180; m.drawGraphic(c2.getContext('2d'), t.make(), 320, 180, 30, 30, 120, 320 / 1920); ctx.drawImage(c2, 0, 0); });
      const card = h('div', { style: { cursor: 'pointer' }, draggable: true }, cv, h('div', { style: { fontSize: '11px', marginTop: '4px', color: 'var(--text)' } }, t.name));
      card.addEventListener('dblclick', () => import('../../actions/editing.js').then((m) => m.newGraphicAtPlayhead(t.make())));
      card.addEventListener('click', () => import('../../actions/editing.js').then((m) => m.newGraphicAtPlayhead(t.make())));
      grid.appendChild(card);
    }
    this.body.append(h('div', { style: { padding: '10px 10px 0', color: 'var(--dim)', fontSize: '11px' } }, 'Click a template to add it at the playhead.'), grid);
  }
  resize() {}
}

function pickStyle(l) { const o = {}; for (const k of ['font', 'size', 'weight', 'italic', 'tracking', 'leading', 'fill', 'fillOn', 'stroke', 'strokeOn', 'strokeWidth', 'bg', 'bgOn', 'bgOpacity', 'shadow', 'shadowOn', 'shadowDist', 'shadowBlur', 'gradient']) o[k] = deepClone(l[k]); return o; }

// ---------------- Markers ----------------
export class MarkersPanel {
  constructor(el) {
    this.el = el; this.filter = ''; this.color = null;
    this.search = h('input.field', { placeholder: 'Search markers', on: { input: (e) => { this.filter = e.target.value.toLowerCase(); this.render(); }, keydown: (e) => e.stopPropagation() } });
    this.colors = h('div', { style: { display: 'flex', gap: '3px' } });
    this.body = h('div.scroll');
    el.append(h('div.toolbar', h('div.search', icon('search', 14), this.search), this.colors, ibtn('export', 'Export marker list (CSV)', () => this.exportCsv())), this.body);
    app.store.on('change', () => this.render()); app.store.on('sequence', () => this.render());
    app.player.on('playhead', () => this.highlight());
    this.render();
  }
  render() {
    const s = app.store.seq;
    this.body.innerHTML = '';
    this.colors.innerHTML = '';
    for (const c of ['green', 'rose', 'mango', 'cerulean', 'violet', 'yellow']) { const d = h('span.label-dot', { style: { background: LABEL_COLORS[c], cursor: 'pointer', outline: this.color === c ? '2px solid #fff' : 'none' } }); d.addEventListener('click', () => { this.color = this.color === c ? null : c; this.render(); }); this.colors.appendChild(d); }
    if (!s) return;
    const all = [...s.markers.map((m) => ({ m, where: 'Sequence', frame: m.frame })), ...allTracks(s).flatMap((t) => t.clips.flatMap((c) => (c.markers || []).map((m) => ({ m, where: c.name, frame: c.start + m.frame, clip: c }))))].sort((a, b) => a.frame - b.frame);
    const list = all.filter(({ m }) => (!this.filter || (m.name + ' ' + m.comment).toLowerCase().includes(this.filter)) && (!this.color || m.color === this.color));
    if (!list.length) { this.body.appendChild(h('div.empty', h('div', h('b', 'No markers'), 'Press M to add a marker at the playhead.'))); return; }
    for (const { m, where, frame, clip } of list) {
      const row = h('div.list-row', { dataset: { f: frame } }, h('span.label-dot', { style: { background: LABEL_COLORS[m.color] || '#3fcf7f' } }), h('span.tcs', framesToTC(frame + (s.settings.startTC || 0), s.settings.fps)), h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { color: 'var(--white)' } }, m.name || '(untitled)'), m.comment ? h('div', { style: { color: 'var(--muted)', fontSize: '11px', whiteSpace: 'pre-wrap' } }, m.comment) : null), h('span', { style: { color: 'var(--dim)', fontSize: '10.5px' } }, where));
      row.addEventListener('click', () => app.player.seek(frame));
      row.addEventListener('dblclick', () => { if (!clip) import('../../actions/editing.js').then((a) => a.editMarker(m)); });
      this.body.appendChild(row);
    }
    this.highlight();
  }
  highlight() { const s = app.store.seq; if (!s) return; for (const r of this.body.querySelectorAll('.list-row')) r.classList.toggle('sel', +r.dataset.f === s.playhead); }
  async exportCsv() {
    const s = app.store.seq; if (!s) return;
    const lines = ['Name,Timecode In,Duration,Comment,Color,Type'];
    for (const m of s.markers) lines.push([m.name, framesToTC(m.frame + (s.settings.startTC || 0), s.settings.fps), framesToTC(m.dur || 0, s.settings.fps), (m.comment || '').replace(/"/g, '""'), m.color, m.type].map((x) => `"${x}"`).join(','));
    const p = await window.native.call('dialog:save', { defaultPath: `${app.info.desktop}/${s.name} Markers.csv` });
    if (p) { await window.native.call('fs:write-text', p, lines.join('\n')); toast('Markers exported'); }
  }
  resize() {}
}

// ---------------- History ----------------
export class HistoryPanel {
  constructor(el) {
    this.el = el; this.body = h('div.scroll'); el.appendChild(this.body);
    app.store.on('history', () => this.render()); this.render();
  }
  render() {
    const st = app.store; this.body.innerHTML = '';
    const open = h('div.list-row' + (!st.undoStack.length ? '.sel' : ''), icon('folder', 13), 'Open');
    open.addEventListener('click', () => st.goToHistory(-1));
    this.body.appendChild(open);
    st.undoStack.forEach((e, i) => { const r = h('div.list-row' + (i === st.undoStack.length - 1 ? '.sel' : ''), icon('history', 13), e.label); r.addEventListener('click', () => { st.goToHistory(i); app.player.invalidate(); }); this.body.appendChild(r); });
    [...st.redoStack].reverse().forEach((e, i) => { const r = h('div.list-row.future', icon('history', 13), e.label); r.addEventListener('click', () => { st.goToHistory(st.undoStack.length + i); app.player.invalidate(); }); this.body.appendChild(r); });
    this.body.scrollTop = this.body.scrollHeight;
  }
  menu() { return [{ label: 'Clear History', action: () => app.store.clearHistory() }]; }
  resize() {}
}

// ---------------- Metadata ----------------
export class MetadataPanel {
  constructor(el) {
    this.el = el; this.body = h('div.scroll'); el.appendChild(this.body);
    app.store.on('selection', () => this.render()); app.store.on('change', (e) => { if (!this.editing && !(e && e.transient)) this.render(); });
    this.render();
  }
  target() {
    const id = [...app.store.selection.items][0];
    if (id) return app.store.project.items[id];
    const s = app.store.seq; const c = s && [...app.store.selection.clips].map((x) => findClip(s, x)).find(Boolean);
    return c ? app.store.project.items[c.clip.src.itemId] : null;
  }
  render() {
    const it = this.target(); this.body.innerHTML = '';
    if (!it) { this.body.appendChild(h('div.empty', 'Select an item to view and edit its metadata')); return; }
    it.metadata = it.metadata || {};
    const field = (label, key, type = 'text') => {
      const inp = type === 'textarea' ? h('textarea.field', { rows: 3, style: { width: '100%' } }, it.metadata[key] || '') : h('input.field', { value: it.metadata[key] || '', style: { width: '100%' } });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('focus', () => { this.editing = true; });
      inp.addEventListener('change', () => { app.store.transact('Edit Metadata', () => { it.metadata[key] = inp.value; }, [it.id]); this.editing = false; });
      return h('div.row', h('label', label), inp);
    };
    this.body.appendChild(section('Clip', h('div', h('div.row', h('label', 'Name'), h('span', { style: { color: 'var(--white)' } }, it.name)),
      field('Description', 'description', 'textarea'), field('Scene', 'scene'), field('Shot', 'shot'), field('Take', 'take'), field('Tape name / reel', 'reel'), field('Camera', 'camera'), field('Creator', 'creator'), field('Log note', 'logNote', 'textarea'), field('Comment', 'comment', 'textarea'),
      h('div.row', h('label', 'Keywords'), (() => { const inp = h('input.field', { value: (it.metadata.keywords || []).join(', '), style: { width: '100%' } }); inp.addEventListener('keydown', (e) => e.stopPropagation()); inp.addEventListener('change', () => app.store.transact('Keywords', () => { it.metadata.keywords = inp.value.split(',').map((x) => x.trim()).filter(Boolean); }, [it.id])); return inp; })()),
      h('div.row', h('label', 'Rating'), h('div', [1, 2, 3, 4, 5].map((n) => h('span', { style: { cursor: 'pointer', color: (it.metadata.rating || 0) >= n ? '#f2b33d' : 'var(--dim)', fontSize: '15px' }, on: { click: () => app.store.transact('Rating', () => { it.metadata.rating = it.metadata.rating === n ? 0 : n; }, [it.id]) } }, '★')))),
      h('div.row', h('label', 'Good'), h('input', { type: 'checkbox', checked: !!it.metadata.good, on: { change: (e) => app.store.transact('Good', () => { it.metadata.good = e.target.checked; }, [it.id]) } })))));
    if (it.type === 'media') {
      const i = it.info;
      const rows = [['File', it.path], ['Format', i.format], ['Video codec', i.codec], ['Frame size', i.width ? `${i.width}x${i.height}` : ''], ['Frame rate', i.fps ? i.fps.toFixed(3) : ''], ['Pixel format', i.pixfmt], ['Color', [i.colorPrimaries, i.colorTransfer].filter(Boolean).join(' / ')], ['Audio', i.hasAudio ? `${i.audioCodec} ${i.sampleRate} Hz ${i.channels}ch` : 'None'], ['Duration', i.duration ? i.duration.toFixed(3) + ' s' : ''], ['Size', formatBytes(i.size)], ['Timecode', i.timecode || ''], ['Created', i.creationTime || ''], ['Camera', [i.make, i.camera].filter(Boolean).join(' ')]];
      this.body.appendChild(section('File', h('div', rows.map(([k, v]) => h('div.row', h('label', k), h('span', { style: { color: 'var(--text)', userSelect: 'text', wordBreak: 'break-all' } }, String(v || '')))))));
      const tags = Object.entries(i.tags || {}).slice(0, 40);
      if (tags.length) this.body.appendChild(section('Embedded tags', h('div', tags.map(([k, v]) => h('div.row', h('label', k), h('span', { style: { color: 'var(--muted)', userSelect: 'text', wordBreak: 'break-all', fontSize: '11px' } }, String(v))))), { closed: true }));
    }
  }
  resize() {}
}

// ---------------- Media Browser ----------------
export class MediaBrowser {
  constructor(el) {
    this.el = el; this.cwd = null; this.sel = new Set(); this.filter = 'all';
    this.side = h('div', { style: { width: '150px', borderRight: '1px solid var(--line-soft)', overflow: 'auto', flex: 'none' } });
    this.path = h('div.crumbs');
    this.list = h('div.scroll');
    this.ingest = h('label.check', { style: { marginLeft: 'auto' } }, h('input', { type: 'checkbox', on: { change: (e) => app.store.transact('Ingest', () => { app.store.project.settings.ingest.enabled = e.target.checked; }, ['project']) } }), 'Ingest');
    const types = h('select.field', { style: { height: '22px' }, on: { change: (e) => { this.filter = e.target.value; this.render(); } } }, [['all', 'All supported'], ['video', 'Video'], ['audio', 'Audio'], ['image', 'Images']].map(([v, l]) => h('option', { value: v }, l)));
    el.append(h('div.toolbar', ibtn('chev-left', 'Back', () => { if (this.cwd) this.go(dirname(this.cwd)); }), types, this.ingest, h('button.btn.small', { on: { click: () => this.importSel() } }, 'Import')), h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } }, this.side, h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } }, this.path, this.list)));
    this.init();
  }
  async init() {
    const vols = await window.native.call('fs:volumes');
    const favs = app.prefs.get('media.favorites') || [];
    this.side.innerHTML = '';
    const head = (t) => this.side.appendChild(h('div', { style: { padding: '8px 10px 2px', color: 'var(--dim)', fontSize: '11px' } }, t));
    if (favs.length) { head('Favorites'); for (const f of favs) this.side.appendChild(this.sideRow(basename(f), f, 'flag')); }
    head('Locations');
    for (const v of vols) this.side.appendChild(this.sideRow(v.name, v.path, v.volume ? 'proxy' : 'folder'));
    if (!this.cwd) { const mv = vols.find((v) => v.name === 'Movies' || v.name === 'Videos'); this.go(mv ? mv.path : vols[0].path); }
  }
  sideRow(name, p, ic) { const r = h('div.list-row', { style: { borderBottom: 0, cursor: 'pointer' } }, icon(ic, 13), name); r.addEventListener('click', () => this.go(p)); return r; }
  async go(p) { this.cwd = p; this.sel.clear(); try { this.entries = await window.native.call('fs:list', p); } catch { this.entries = []; } this.render(); }
  render() {
    this.path.innerHTML = '';
    const norm = this.cwd.replace(/\\/g, '/');
    const drive = /^[A-Za-z]:/.test(norm) ? norm.slice(0, 2) : '';
    const parts = norm.slice(drive.length).split('/').filter(Boolean); let acc = drive;
    this.path.appendChild(h('span', { on: { click: () => this.go(drive ? drive + '/' : '/') } }, drive ? drive + '/' : '/'));
    for (const p of parts) { acc += '/' + p; const target = acc; this.path.append(h('span', { on: { click: () => this.go(target) } }, p), h('span', { style: { color: 'var(--dim)' } }, '/')); }
    this.list.innerHTML = '';
    const { MEDIA_EXT } = { MEDIA_EXT: new Set(['.mov', '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mxf', '.mts', '.m2ts', '.mpg', '.wav', '.mp3', '.aac', '.m4a', '.aif', '.aiff', '.flac', '.ogg', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd', '.svg', '.gif', '.webp', '.exr', '.dpx', '.cinergy', '.srt', '.vtt', '.cube', '.otio', '.edl', '.xml', '.fcpxml']) };
    const kind = (n) => { const e = extname(n); if (['.wav', '.mp3', '.aac', '.m4a', '.aif', '.aiff', '.flac', '.ogg'].includes(e)) return 'audio'; if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd', '.svg', '.gif', '.webp', '.exr', '.dpx'].includes(e)) return 'image'; return 'video'; };
    const items = (this.entries || []).filter((e) => e.dir || (MEDIA_EXT.has(extname(e.name)) && (this.filter === 'all' || kind(e.name) === this.filter))).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    for (const e of items) {
      const row = h('div.list-row', { draggable: !e.dir, style: { cursor: 'default' } }, h('span', { style: { color: e.dir ? '#f2b33d' : 'var(--muted)', display: 'flex' } }, icon(e.dir ? 'folder' : kind(e.name) === 'audio' ? 'audio' : kind(e.name) === 'image' ? 'image' : 'film', 14)), h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.name), h('span', { style: { color: 'var(--dim)', fontSize: '10.5px' } }, e.dir ? '' : formatBytes(e.size)));
      row.classList.toggle('sel', this.sel.has(e.path));
      row.addEventListener('click', (ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) { this.sel.has(e.path) ? this.sel.delete(e.path) : this.sel.add(e.path); } else { this.sel = new Set([e.path]); } this.render(); });
      row.addEventListener('dblclick', async () => { if (e.dir) this.go(e.path); else { const { importPaths } = await import('../../actions/media.js'); const c = await importPaths([e.path], { allowDuplicates: false }); const id = c[0] ? c[0].id : Object.values(app.store.project.items).find((i) => i.path === e.path)?.id; if (id) app.ui.openInSource(id); } });
      row.addEventListener('dragstart', (ev) => { const paths = this.sel.has(e.path) ? [...this.sel] : [e.path]; ev.dataTransfer.setData('application/x-cinergy-paths', JSON.stringify(paths)); });
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); contextMenu(ev.clientX, ev.clientY, [{ label: 'Import', action: () => this.importSel(e.path) }, { label: IS_MAC_UI ? 'Reveal in Finder' : 'Show in Explorer', action: () => window.native.call('shell:reveal', e.path) }, e.dir ? { label: 'Add to Favorites', action: () => { app.prefs.set('media.favorites', [...new Set([...(app.prefs.get('media.favorites') || []), e.path])]); this.init(); } } : null]); });
      this.list.appendChild(row);
    }
    if (!items.length) this.list.appendChild(h('div.empty', 'No media files in this folder'));
  }
  async importSel(one) { const paths = one ? [one] : [...this.sel]; if (!paths.length) return; const { importPaths } = await import('../../actions/media.js'); await importPaths(paths); }
  resize() {}
}

// ---------------- Libraries ----------------
export class LibrariesPanel {
  constructor(el) { this.el = el; this.body = h('div.scroll'); el.appendChild(this.body); app.store.on('change', () => this.render()); app.store.on('project', () => this.render()); this.render(); }
  render() {
    const lib = app.store.project.libraries; this.body.innerHTML = '';
    const tx = (fn) => app.store.transact('Libraries', fn, ['project']);
    // colors
    const sw = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, lib.colors.map((c, i) => { const d = h('div.swatch', { style: { background: c, width: '30px', height: '22px' }, title: c }); d.addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(c); toast('Copied ' + c); }); d.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ label: 'Remove', action: () => tx(() => lib.colors.splice(i, 1)) }]); }); return d; }), colorInput('#2f7cff', (v, fin) => { if (fin) tx(() => lib.colors.push(v)); }));
    this.body.appendChild(section('Colors', sw));
    const list = (arr, label, apply) => h('div', arr.length ? arr.map((x, i) => { const r = h('div.list-row', h('span', { style: { flex: 1 } }, x.name), h('button.btn.small', { on: { click: () => apply(x) } }, 'Apply')); r.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ label: 'Rename', action: async () => { const n = await promptDialog('Rename', x.name); if (n) tx(() => { x.name = n; }); } }, { label: 'Delete', action: () => tx(() => arr.splice(i, 1)) }]); }); return r; }) : h('div', { style: { color: 'var(--dim)', fontSize: '11px' } }, `No ${label} yet`));
    const selClips = () => { const s = app.store.seq; return s ? [...app.store.selection.clips].map((id) => findClip(s, id)).filter(Boolean) : []; };
    this.body.appendChild(section('Text styles', list(lib.textStyles, 'text styles', (st) => {
      const s = app.store.seq; app.store.transact('Apply Text Style', () => { for (const f of selClips()) if (f.clip.graphic) for (const l of f.clip.graphic.layers) if (l.type === 'text' && (!app.program || !app.program.selectedLayer || app.program.selectedLayer === l.id)) Object.assign(l, deepClone(st.style)); }, [s.id]);
    })));
    this.body.appendChild(section('Looks', list(lib.looks, 'looks', (lk) => import('../../actions/editing.js').then((m) => m.applyPreset({ id: 'look', effects: [{ id: 'l', type: 'lumetri', enabled: true, params: lk.params ? deepClone(lk.params) : { ...Object.fromEntries(app.effectDefs.lumetri.params.map((p) => [p.name, deepClone(p.default)])), look: lk.path }, keyframes: {}, masks: [] }] })))));
    this.body.appendChild(section('Graphics templates', list(lib.graphics, 'templates', (t) => import('../../actions/editing.js').then((m) => m.newGraphicAtPlayhead(deepClone(t.graphic))))));
    this.body.appendChild(section('Effect presets', list(lib.effectPresets, 'presets', (p) => import('../../actions/editing.js').then((m) => m.applyPreset(p)))));
    this.body.appendChild(h('div', { style: { display: 'flex', gap: '6px', padding: '10px' } },
      h('button.btn.small', { on: { click: async () => { const p = await window.native.call('dialog:save', { defaultPath: `${app.info.desktop}/CinergyPro Library.cplib` }); if (p) { await window.native.call('fs:write-text', p, JSON.stringify({ format: 'cinergypro-library', ...lib })); toast('Library exported'); } } } }, 'Export Library'),
      h('button.btn.small', { on: { click: async () => { const r = await window.native.call('dialog:open', { filters: [{ name: 'CinergyPro Library', extensions: ['cplib', 'json'] }] }); if (!r) return; const d = JSON.parse(await window.native.call('fs:read-text', r[0])); tx(() => { for (const k of ['colors', 'textStyles', 'looks', 'graphics', 'effectPresets']) lib[k] = [...(lib[k] || []), ...(d[k] || [])]; }); toast('Library imported'); } } }, 'Import Library')));
  }
  resize() {}
}

// ---------------- Info ----------------
export class InfoPanel {
  constructor(el) { this.el = el; this.body = h('div', { style: { padding: '10px', lineHeight: 1.7, fontSize: '11.5px' } }); el.appendChild(this.body); const r = () => this.render(); app.store.on('selection', r); app.player.on('playhead', r); app.store.on('change', r); this.render(); }
  render() {
    const s = app.store.seq; const rows = [];
    const id = [...app.store.selection.items][0]; const it = id && app.store.project.items[id];
    if (it) { rows.push(['Item', it.name], ['Type', it.type === 'media' ? it.info.kind : it.type]); if (it.type === 'media') rows.push(['Video', it.info.hasVideo ? `${it.info.width}x${it.info.height} (${(it.info.fps || 0).toFixed(2)} fps)` : '-'], ['Audio', it.info.hasAudio ? `${it.info.sampleRate} Hz` : '-'], ['Duration', it.info.duration ? framesToTC(Math.round(it.info.duration * (it.info.fps || 30)), it.info.fps || 30) : 'Still']); }
    if (s) {
      rows.push(['Sequence', s.name], ['Playhead', framesToTC(s.playhead + (s.settings.startTC || 0), s.settings.fps)], ['Duration', framesToTC(seqDuration(s), s.settings.fps)]);
      for (const t of [...s.tracks.video].reverse()) { const c = t.clips.find((x) => s.playhead >= x.start && s.playhead < x.start + x.dur); if (c) rows.push([t.name, `${c.name} @ ${framesToTC(Math.round(clipSourceTime(c, s.playhead, s.settings.fps) * s.settings.fps), s.settings.fps)}`]); }
      for (const t of s.tracks.audio) { const c = t.clips.find((x) => s.playhead >= x.start && s.playhead < x.start + x.dur); if (c) rows.push([t.name, c.name]); }
      const fid = [...app.store.selection.clips][0]; const f = fid && findClip(s, fid);
      if (f) rows.push(['Selected clip', f.clip.name], ['Start', framesToTC(f.clip.start, s.settings.fps)], ['End', framesToTC(f.clip.start + f.clip.dur, s.settings.fps)], ['Duration', framesToTC(f.clip.dur, s.settings.fps)], ['Speed', Math.round(f.clip.speed * 100) + '%']);
      rows.push(['Render time', app.player.fps().toFixed(1) + ' ms/frame']);
    }
    this.body.innerHTML = '';
    for (const [k, v] of rows) this.body.appendChild(h('div', { style: { display: 'flex', gap: '10px' } }, h('span', { style: { color: 'var(--muted)', width: '110px', flex: 'none' } }, k), h('span', { style: { color: 'var(--white)', userSelect: 'text' } }, v)));
  }
  resize() {}
}

// ---------------- Production ----------------
export class ProductionPanel {
  constructor(el) { this.el = el; this.body = h('div.scroll'); el.appendChild(this.body); app.prefs.on('change', () => this.render()); this.render(); }
  async render() {
    const dir = app.prefs.get('general.production');
    this.body.innerHTML = '';
    const io = await import('../../actions/project-io.js');
    const bar = h('div.toolbar', h('button.btn.small', { on: { click: () => io.newProduction() } }, 'New Production'), h('button.btn.small', { on: { click: () => io.openProduction() } }, 'Open Production'));
    this.body.appendChild(bar);
    if (!dir) { this.body.appendChild(h('div.empty', h('div', h('b', 'Productions'), 'A production is a folder of related projects that share media. Open or create one to manage its projects here.'))); return; }
    this.body.appendChild(h('div', { style: { padding: '8px 10px', color: 'var(--white)', fontWeight: 600 } }, basename(dir)));
    const files = (await window.native.call('fs:walk', dir, 3).catch(() => [])).filter((e) => !e.dir && e.path.endsWith('.cinergy'));
    for (const f of files) {
      const locked = await window.native.call('fs:exists', f.path + '.lock');
      const isOpen = app.store.path === f.path;
      const row = h('div.list-row' + (isOpen ? '.sel' : ''), icon('film', 13), h('span', { style: { flex: 1 } }, basename(f.path).replace(/\.cinergy$/, '')), locked && !isOpen ? h('span', { style: { color: 'var(--amber)', display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px' } }, icon('lock', 11), 'In use') : null);
      row.addEventListener('dblclick', () => io.openProject(f.path));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ label: 'Open', action: () => io.openProject(f.path) }, { label: 'Import Items into Current Project', action: () => import('../../actions/media.js').then((m) => m.importProjectItems(f.path)) }, { label: IS_MAC_UI ? 'Reveal in Finder' : 'Show in Explorer', action: () => window.native.call('shell:reveal', f.path) }]); });
      this.body.appendChild(row);
    }
    this.body.appendChild(h('div', { style: { padding: '10px', display: 'flex', gap: '6px' } },
      h('button.btn.small', { on: { click: async () => { const n = await promptDialog('New project name', 'Reel ' + (files.length + 1)); if (!n) return; const { newProjectData } = io; const p = newProjectData(n); await window.native.call('fs:write-text', `${dir}/${n}.cinergy`, JSON.stringify(p)); this.render(); } } }, 'New Project in Production'),
      h('button.btn.small', { on: { click: async () => { if (!app.store.path) return toast('Save the current project first', 'warn'); await window.native.call('fs:copy', app.store.path, `${dir}/${basename(app.store.path)}`); this.render(); } } }, 'Add Current Project')));
  }
  resize() {}
}

// ---------------- Tools ----------------
export class ToolsPanel {
  constructor(el) { this.el = el; app.panels.tools = this; this.wrap = h('div.tools-strip'); el.appendChild(this.wrap); this.update(); }
  update() {
    this.wrap.innerHTML = '';
    const cur = app.timeline ? app.timeline.tool : 'select';
    for (const [id, ic, label, key] of TOOLS) { const b = ibtn(ic, label, () => app.timeline && app.timeline.setTool(id), { on: cur === id }); b.dataset.key = key; this.wrap.appendChild(b); }
  }
  resize() {}
}

// ---------------- Export queue ----------------
export class ExportQueuePanel {
  constructor(el) {
    this.el = el; this.body = h('div.scroll');
    el.append(h('div.toolbar', h('button.btn.small.primary', { on: { click: () => import('../../actions/export.js').then((m) => m.runQueue()) } }, icon('play', 12), 'Start Queue'), h('button.btn.small', { on: { click: () => import('../../actions/export.js').then((m) => { m.queue.items = m.queue.items.filter((i) => i.status === 'queued' || i.status === 'encoding'); m.queue.emit('change'); }) } }, 'Clear Finished'), h('button.btn.small', { on: { click: () => import('../../actions/export.js').then((m) => m.exportDialog()) } }, 'Add Sequence...')), this.body);
    import('../../actions/export.js').then((m) => { this.q = m.queue; m.queue.on('change', () => this.render()); this.render(); });
  }
  render() {
    this.body.innerHTML = '';
    if (!this.q || !this.q.items.length) { this.body.appendChild(h('div.empty', h('div', h('b', 'The export queue is empty'), 'Choose Add to Queue in the Export dialog to batch several exports.'))); return; }
    for (const it of this.q.items) {
      const bar = h('div', { style: { height: '4px', background: 'var(--raised)', borderRadius: '2px', overflow: 'hidden', marginTop: '4px' } }, h('div', { style: { width: Math.round(it.progress * 100) + '%', height: '100%', background: it.status === 'error' ? 'var(--red)' : 'var(--blue)' } }));
      const row = h('div', { style: { padding: '8px 10px', borderBottom: '1px solid var(--line-soft)' } },
        h('div', { style: { display: 'flex', gap: '8px' } }, h('span', { style: { color: 'var(--white)', flex: 1 } }, it.name), h('span', { style: { color: it.status === 'error' ? 'var(--red)' : 'var(--muted)', fontSize: '11px' } }, it.status === 'encoding' ? Math.round(it.progress * 100) + '%' : it.status), it.status === 'queued' || it.status === 'encoding' ? h('button.btn.small', { on: { click: () => { if (it.status === 'queued') { this.q.items = this.q.items.filter((x) => x !== it); } else it.cancel = true; this.q.emit('change'); } } }, it.status === 'encoding' ? 'Stop' : 'Remove') : null),
        h('div', { style: { color: 'var(--dim)', fontSize: '11px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${it.settings.codec || it.settings.audioCodec} - ${it.settings.out}`), bar, it.error ? h('div', { style: { color: 'var(--red)', fontSize: '11px' } }, it.error) : null);
      this.body.appendChild(row);
    }
  }
  resize() {}
}

// ---------------- Learn ----------------
export class LearnPanel {
  constructor(el) {
    const steps = [
      ['Import', K('Drag files or folders into the Project panel, or press Cmd+I. Folders become bins.')],
      ['Mark a range', 'Double-click a clip to open it in the Source Monitor. Press I and O to set In and Out points.'],
      ['Edit into the timeline', 'Press comma to insert or period to overwrite at the playhead on the patched tracks. You can also drag clips into the timeline; hold Cmd to insert.'],
      ['Trim', 'Drag clip edges with the Selection tool. Hold Cmd for a ripple trim, use B for the Ripple tool, N for Rolling, Y for Slip and U for Slide.'],
      ['Cut', K('Press Cmd+K to add an edit at the playhead on targeted tracks, or C for the Razor tool. Shift+Delete performs a ripple delete.')],
      ['Transitions and effects', K('Cmd+D applies the default video transition. Drag effects from the Effects panel onto clips and adjust them in Effect Controls.')],
      ['Color', 'Switch to the Color workspace. Use Basic Correction, Curves, Color Wheels and HSL Secondary in the Lumetri Color panel and watch the scopes.'],
      ['Audio', 'Use the Audio Track Mixer for levels and track effects. Tag clips in Essential Sound to match loudness and duck music under dialogue.'],
      ['Titles and captions', 'Press T for the Type tool and click the timeline. Add captions in the Text panel or import an SRT file.'],
      ['Export', K('Press Cmd+M to open Export. Choose a preset, adjust settings and export now or add to the queue.')],
    ];
    el.appendChild(h('div.scroll', h('div', { style: { padding: '14px 16px', maxWidth: '640px' } }, h('div', { style: { color: 'var(--white)', fontSize: '15px', fontWeight: 600, marginBottom: '12px' } }, 'Editing in CinergyPro'), steps.map(([t, d], i) => h('div', { style: { display: 'grid', gridTemplateColumns: '26px 1fr', gap: '8px', marginBottom: '12px' } }, h('span', { style: { color: 'var(--blue-hi)', fontFamily: 'var(--mono)' } }, String(i + 1)), h('div', h('div', { style: { color: 'var(--white)', fontWeight: 500 } }, t), h('div', { style: { color: 'var(--muted)', lineHeight: 1.55 } }, d)))))));
  }
  resize() {}
}

// ---------------- Script console ----------------
export class ScriptConsole {
  constructor(el) {
    this.el = el;
    this.out = h('div.scroll', { style: { fontFamily: 'var(--mono)', fontSize: '11px', padding: '8px', whiteSpace: 'pre-wrap', userSelect: 'text' } });
    this.inp = h('textarea.field', { rows: 4, placeholder: K('JavaScript with the cinergy API. Cmd+Enter to run. Example: cinergy.sequence().clips().length'), style: { fontFamily: 'var(--mono)', fontSize: '11.5px', margin: '6px', width: 'calc(100% - 12px)' } });
    this.inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.run(); } });
    el.append(h('div.toolbar', h('button.btn.small.primary', { on: { click: () => this.run() } }, 'Run'), h('button.btn.small', { on: { click: () => this.loadScript() } }, 'Run Script File...'), h('button.btn.small', { on: { click: () => { this.out.innerHTML = ''; } } }, 'Clear')), this.out, this.inp);
  }
  log(...a) { this.out.appendChild(h('div', a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '))); this.out.scrollTop = this.out.scrollHeight; }
  async run(code) {
    code = code || this.inp.value;
    const { scriptingAPI } = await import('../../actions/scripting.js');
    try { const r = await scriptingAPI.run(code, (...a) => this.log(...a)); if (r !== undefined) this.log('=> ' + (typeof r === 'object' ? JSON.stringify(r) : String(r))); }
    catch (e) { this.log('Error: ' + e.message); }
  }
  async loadScript() { const r = await window.native.call('dialog:open', { filters: [{ name: 'JavaScript', extensions: ['js'] }] }); if (r) this.run(await window.native.call('fs:read-text', r[0])); }
  resize() {}
}

export const createText = (el) => new TextPanel(el);
export const createProperties = (el) => new PropertiesPanel(el);
export const createMarkers = (el) => new MarkersPanel(el);
export const createHistory = (el) => new HistoryPanel(el);
export const createMetadata = (el) => new MetadataPanel(el);
export const createMediaBrowser = (el) => new MediaBrowser(el);
export const createLibraries = (el) => new LibrariesPanel(el);
export const createInfo = (el) => new InfoPanel(el);
export const createProduction = (el) => new ProductionPanel(el);
export const createTools = (el) => new ToolsPanel(el);
export const createExportQueue = (el) => new ExportQueuePanel(el);
export const createLearn = (el) => new LearnPanel(el);
export const createScriptConsole = (el) => new ScriptConsole(el);
