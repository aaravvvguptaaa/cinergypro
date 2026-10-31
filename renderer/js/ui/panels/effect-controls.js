// Effect Controls: parameters, keyframes (stopwatch, navigation, mini timeline), masks, transitions.
import { app } from '../../app-context.js';
import { h, icon, clamp, deepClone, uid } from '../../core/util.js';
import { findClip, allTracks } from '../../core/project.js';
import { defFor, makeMask, transitionDef, makeEffect } from '../../core/effect-defs.js';
import { evaluate, setKey, removeKey, prevKeyTime, nextKeyTime, hasKeys, resolveParams } from '../../core/keyframes.js';
import { framesToTC } from '../../core/timecode.js';
import { scrubNumber, colorInput, contextMenu, ibtn, toast, promptDialog } from '../widgets.js';
import { BUILTIN_LOOKS } from '../../engine/lut.js';
import { cleanTransitions } from '../../core/edit.js';

const INTERPS = [['linear', 'Linear'], ['bezier', 'Bezier'], ['autobezier', 'Auto Bezier'], ['hold', 'Hold'], ['easeIn', 'Ease In'], ['easeOut', 'Ease Out'], ['easeInOut', 'Ease In and Out']];

export class EffectControls {
  constructor(el) {
    this.el = el;
    this.collapsed = new Set();
    this.selectedKeys = [];
    this.selectedMask = null;
    app.panels.effectControls = this;
    this.left = h('div.ec-left');
    this.canvas = h('canvas');
    this.right = h('div.ec-right', this.canvas);
    el.appendChild(h('div.ec', this.left, this.right));
    this.left.addEventListener('scroll', () => this.drawKeys());
    app.store.on('selection', () => this.render());
    app.store.on('sequence', () => this.render());
    app.store.on('change', (e) => { if (this.editing) return; if (e && e.transient && e.scope !== 'history') return; this.render(); });
    app.player.on('playhead', () => this.refreshValues());
    this.bindCanvas();
    this.render();
  }

  get seq() { return app.store.seq; }
  target() {
    const s = this.seq; if (!s) return null;
    if (app.store.selection.transition) {
      const { trackId, id } = app.store.selection.transition;
      const t = allTracks(s).find((x) => x.id === trackId); const tr = t && t.transitions.find((x) => x.id === id);
      if (tr) return { type: 'transition', track: t, tr };
    }
    const ids = [...app.store.selection.clips];
    // prefer the video clip of a linked pair; Effect Controls shows one clip
    const found = ids.map((id) => findClip(s, id)).filter(Boolean);
    const pick = found.find((f) => f.kind === 'video') || found[0];
    if (!pick) return null;
    return { type: 'clip', ...pick, all: found };
  }

  isExpanded(fxId) { return !this.collapsed.has(fxId); }

  // ---------- editing helpers ----------
  begin() { if (!this.snap) { this.snap = JSON.stringify(this.seq.tracks); this.editing = true; } }
  commit(label) {
    const s = this.seq; if (!this.snap) return;
    const after = JSON.stringify(s.tracks);
    s.tracks = JSON.parse(this.snap);
    this.snap = null; this.editing = false;
    if (after !== JSON.stringify(s.tracks)) app.store.transact(label, () => { s.tracks = JSON.parse(after); }, [s.id], { coalesce: label });
  }
  live(clipId, fxId) { const f = findClip(this.seq, clipId); return f && f.clip.effects.find((e) => e.id === fxId); }
  local(clip) { return this.seq.playhead - clip.start; }

  setValue(clipId, fxId, name, v, final) {
    this.begin();
    const f = findClip(this.seq, clipId); const fx = f.clip.effects.find((e) => e.id === fxId);
    const lf = this.local(f.clip);
    if (hasKeys(fx, name)) setKey(fx.keyframes[name], lf, v, app.prefs.get('timeline.keyframeInterp') || 'linear');
    else fx.params[name] = v;
    if (fx.type === 'timeremap' && name === 'speed' && !f.clip.timeRemap) f.clip.speed = Math.max(0.01, Math.abs(v) / 100);
    app.player.invalidate('program');
    if (f.kind === 'audio') app.audio.updateClipEffects(f.clip);
    this.drawKeys();
    if (final) { this.commit('Change ' + (defFor(fx.type) || {}).name); this.render(); }
  }

  toggleAnimation(clipId, fxId, name) {
    const s = this.seq;
    app.store.transact('Toggle Animation', () => {
      const f = findClip(s, clipId); const fx = f.clip.effects.find((e) => e.id === fxId);
      const lf = this.local(f.clip);
      if (hasKeys(fx, name)) { fx.params[name] = evaluate(fx.keyframes[name], lf, fx.params[name]); fx.keyframes[name] = []; }
      else { fx.keyframes[name] = []; setKey(fx.keyframes[name], clamp(lf, 0, f.clip.dur), deepClone(fx.params[name]), app.prefs.get('timeline.keyframeInterp') || 'linear'); if (fx.type === 'timeremap') f.clip.timeRemap = true; }
    });
  }

  addRemoveKey(clipId, fxId, name) {
    const s = this.seq;
    app.store.transact('Keyframe', () => {
      const f = findClip(s, clipId); const fx = f.clip.effects.find((e) => e.id === fxId);
      const lf = this.local(f.clip);
      fx.keyframes[name] = fx.keyframes[name] || [];
      if (!removeKey(fx.keyframes[name], lf)) setKey(fx.keyframes[name], lf, deepClone(evaluate(fx.keyframes[name], lf, fx.params[name])), app.prefs.get('timeline.keyframeInterp') || 'linear');
    });
  }

  gotoKey(clip, fx, name, dir) {
    const keys = fx.keyframes[name] || []; const lf = this.local(clip);
    const t = dir < 0 ? prevKeyTime(keys, lf) : nextKeyTime(keys, lf);
    if (t != null) app.player.seek(clip.start + t);
  }

  // ---------- rendering ----------
  render() {
    const tgt = this.target();
    this.left.innerHTML = '';
    this.rows = [];
    this.tgt = tgt;
    if (!tgt) { this.left.appendChild(h('div.empty', h('div', h('b', 'No clip selected'), 'Select a clip in the timeline to adjust its effects and keyframes.'))); this.drawKeys(); return; }
    if (tgt.type === 'transition') { this.renderTransition(tgt); this.drawKeys(); return; }
    const { clip } = tgt;
    const item = app.store.project.items[clip.src.itemId];
    this.left.appendChild(h('div.ec-src', h('span', 'Source:'), h('b', clip.name), h('span', { style: { marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: '10.5px' } }, framesToTC(clip.dur, this.seq.settings.fps))));
    const sec = (title) => this.left.appendChild(h('div', { style: { padding: '6px 10px 2px', color: 'var(--dim)', fontSize: '11px' } }, title));
    const all = tgt.all || [tgt];
    for (const f of all) {
      if (all.length > 1) sec(f.kind === 'video' ? 'Video' : 'Audio');
      for (const fx of f.clip.effects) this.renderEffect(f.clip, fx, f.kind);
    }
    void item;
    requestAnimationFrame(() => this.drawKeys());
  }

  renderTransition({ track, tr }) {
    const s = this.seq; const def = transitionDef(tr.type) || { name: tr.type, params: [] };
    const wrap = h('div', { style: { padding: '10px' } });
    const commit = (label, fn) => app.store.transact(label, () => { const t = allTracks(s).find((x) => x.id === track.id); const q = t.transitions.find((x) => x.id === tr.id); fn(q, t); cleanTransitions(t); });
    wrap.append(
      h('div', { style: { color: 'var(--white)', fontWeight: 600, marginBottom: '10px' } }, def.name),
      h('div.row', h('label', 'Duration'), scrubNumber({ value: tr.dur, min: 1, max: 10000, step: 1, format: (v) => framesToTC(Math.round(v), s.settings.fps), onChange: (v, fin) => { if (fin) commit('Transition Duration', (q) => { q.dur = Math.round(v); }); } })),
      h('div.row', h('label', 'Alignment'), h('select.field', { on: { change: (e) => commit('Transition Alignment', (q) => { q.align = e.target.value; }) } }, [['center', 'Center at Cut'], ['start', 'Start at Cut'], ['end', 'End at Cut']].map(([v, l]) => h('option', { value: v, selected: tr.align === v }, l)))),
      h('div.row', h('label', 'Reverse'), h('input', { type: 'checkbox', checked: tr.reverse, on: { change: (e) => commit('Reverse', (q) => { q.reverse = e.target.checked; }) } })),
    );
    for (const p of def.params) {
      const w = this.widget(p, tr.params[p.name], (v, fin) => { if (fin) commit('Transition Settings', (q) => { q.params[p.name] = v; }); else { tr.params[p.name] = v; app.player.invalidate('program'); } }, { W: s.settings.width, H: s.settings.height });
      wrap.appendChild(h('div.row', h('label', p.label), w));
    }
    const A = tr.clipA ? track.clips.find((c) => c.id === tr.clipA) : null, B = tr.clipB ? track.clips.find((c) => c.id === tr.clipB) : null;
    wrap.appendChild(h('div', { style: { marginTop: '12px', color: 'var(--dim)', fontSize: '11px', lineHeight: 1.6 } }, `A: ${A ? A.name : 'none'}`, h('br'), `B: ${B ? B.name : 'none'}`));
    this.left.appendChild(wrap);
  }

  renderEffect(clip, fx, kind) {
    const def = defFor(fx.type) || { name: fx.type, params: [] };
    const open = !this.collapsed.has(fx.id);
    const tog = h('div.fxtog' + (fx.enabled ? '.on' : ''), { title: 'Toggle the effect on or off' }, 'fx');
    tog.addEventListener('click', () => app.store.transact('Toggle Effect', () => { const lf = this.live(clip.id, fx.id); lf.enabled = !lf.enabled; }));
    const chev = h('span.chev', icon(open ? 'chev-down' : 'chev-right', 12));
    chev.addEventListener('click', () => { if (open) this.collapsed.add(fx.id); else this.collapsed.delete(fx.id); this.render(); app.program && app.program.drawOverlay(); });
    const head = h('div.fx-h', { draggable: !def.intrinsic, dataset: { fx: fx.id } }, chev, tog, h('span.nm', def.name));
    if (def.masks) head.append(ibtn('ellipse', 'Create ellipse mask', () => this.addMask(clip, fx, 'ellipse')), ibtn('rect', 'Create 4-point polygon mask', () => this.addMask(clip, fx, 'rect')), ibtn('bezier', 'Free draw bezier mask', () => this.addMask(clip, fx, 'path')));
    if (fx.type === 'lumetri') head.appendChild(ibtn('palette', 'Open in Lumetri Color', () => { app.panels.lumetri && app.panels.lumetri.edit(clip.id, fx.id); app.dock.openPanel('lumetri'); }));
    head.append(ibtn('reset', 'Reset parameters', () => this.resetFx(clip, fx)), ibtn('more', 'Effect menu', (e) => this.fxMenu(e, clip, fx, def)));
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); this.fxMenu(e, clip, fx, def); });
    head.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-cinergy-fxmove', fx.id); });
    head.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-cinergy-fxmove')) { e.preventDefault(); head.classList.add('dragover'); } });
    head.addEventListener('dragleave', () => head.classList.remove('dragover'));
    head.addEventListener('drop', (e) => { head.classList.remove('dragover'); const id = e.dataTransfer.getData('application/x-cinergy-fxmove'); if (id) this.reorder(clip, id, fx.id); });
    this.left.appendChild(head);
    this.rows.push({ el: head, clip, fx, header: true });
    if (!open) return;
    if (def.analysis === 'stabilize') this.left.appendChild(this.analysisRow(clip, fx, 'stabilize'));
    if (def.analysis === 'reframe') this.left.appendChild(this.analysisRow(clip, fx, 'reframe'));
    for (const m of fx.masks || []) this.renderMask(clip, fx, m);
    const seq = this.seq;
    const item = app.store.project.items[clip.src.itemId];
    const layerW = item && item.info && item.info.width ? item.info.width : seq.settings.width, layerH = item && item.info && item.info.height ? item.info.height : seq.settings.height;
    for (const p of def.params) {
      if (fx.type === 'motion' && p.name === 'scaleWidth' && fx.params.uniform) continue;
      if (['curves', 'huecurves', 'wheels', 'hslkey', 'wheel'].includes(p.type)) continue;
      if (fx.type === 'timeremap' && !clip.timeRemap && p.name === 'speed') { /* still editable as speed */ }
      const lf = this.local(clip);
      const animatable = !['select', 'bool', 'text', 'lut', 'track'].includes(p.type) || fx.type === 'timeremap';
      const keyed = hasKeys(fx, p.name);
      const val = keyed ? evaluate(fx.keyframes[p.name], lf, fx.params[p.name]) : fx.params[p.name];
      const sw = h('div.sw' + (keyed ? '.on' : ''), { title: 'Toggle animation' }, animatable ? icon('stopwatch', 13) : '');
      if (animatable) sw.addEventListener('click', () => this.toggleAnimation(clip.id, fx.id, p.name));
      const isPos = fx.type === 'motion' && p.name === 'position';
      const W = isPos || fx.type === 'transform' ? seq.settings.width : layerW, H = isPos || fx.type === 'transform' ? seq.settings.height : layerH;
      const w = this.widget(p, val, (v, fin) => this.setValue(clip.id, fx.id, p.name, v, fin), { W, H, keyed });
      const nav = h('div.kfnav' + (keyed ? '.vis' : ''),
        h('button', { title: 'Previous keyframe', on: { click: () => this.gotoKey(clip, fx, p.name, -1) } }, icon('chev-left', 11)),
        h('button', { title: 'Add/remove keyframe', on: { click: () => this.addRemoveKey(clip.id, fx.id, p.name) } }, icon((fx.keyframes[p.name] || []).some((k) => Math.abs(k.t - lf) < 0.5) ? 'diamond-fill' : 'diamond', 11)),
        h('button', { title: 'Next keyframe', on: { click: () => this.gotoKey(clip, fx, p.name, 1) } }, icon('chev-right', 11)));
      const row = h('div.prm', sw, h('span.pl', { title: p.label }, p.label), h('div.pv', w), animatable ? nav : null);
      row.addEventListener('dblclick', (e) => { if (e.target.closest('.pv')) return; this.setValue(clip.id, fx.id, p.name, deepClone(p.default), true); });
      this.left.appendChild(row);
      this.rows.push({ el: row, clip, fx, param: p.name, widget: w, def: p });
    }
    if (fx.type === 'timeremap') this.left.appendChild(h('div.prm', h('span.sw'), h('span.pl', 'Clip speed'), h('div.pv', h('span', { style: { color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: '11px' } }, clip.timeRemap ? 'Variable (keyframed)' : Math.round(clip.speed * 100) + '%'))));
  }

  analysisRow(clip, fx, kind) {
    const st = kind === 'stabilize' ? clip.stabilized : clip.reframe;
    const txt = kind === 'stabilize' ? (st && st.analyzing ? 'Analyzing in background...' : st && st.ready ? 'Stabilized' : 'Not analyzed') : (st && st.keys ? `Tracked (${st.keys.length} keys)` : 'Not analyzed');
    return h('div.prm', h('span.sw'), h('span.pl', txt), h('div.pv', h('button.btn.small', { on: { click: async () => {
      const m = await import('../../actions/analysis.js');
      if (kind === 'stabilize') m.stabilizeClip(clip.id); else m.analyzeReframe(this.seq, clip, fx.params.motion);
    } } }, 'Analyze')));
  }

  widget(p, val, onChange, ctx = {}) {
    switch (p.type) {
      case 'number': case 'angle': {
        const el = scrubNumber({ value: +val || 0, min: p.min, max: p.max, step: p.step || (p.type === 'angle' ? 0.1 : 1), decimals: p.step && p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 1, onChange });
        if (ctx.keyed) el.classList.add('keyed');
        const box = h('span', el, p.unit || p.type === 'angle' ? h('span.unit', p.type === 'angle' ? '°' : p.unit) : null);
        box.set = (v) => el.set(+v || 0);
        return box;
      }
      case 'point': {
        const W = ctx.W || 1920, H = ctx.H || 1080;
        const v = val || [0.5, 0.5];
        const x = scrubNumber({ value: v[0] * W, step: 1, decimals: 1, onChange: (nx, fin) => onChange([nx / W, cur[1]], fin) });
        const y = scrubNumber({ value: v[1] * H, step: 1, decimals: 1, onChange: (ny, fin) => onChange([cur[0], ny / H], fin) });
        let cur = [...v];
        const origOnChange = onChange;
        onChange = (nv, fin) => { cur = nv; origOnChange(nv, fin); };
        const box = h('span', { style: { display: 'flex', gap: '4px' } }, x, y);
        box.set = (nv) => { cur = [...nv]; x.set(nv[0] * W); y.set(nv[1] * H); };
        if (ctx.keyed) { x.classList.add('keyed'); y.classList.add('keyed'); }
        return box;
      }
      case 'color': { const c = colorInput(val, onChange); return c; }
      case 'bool': { const c = h('input', { type: 'checkbox', checked: !!val, on: { change: (e) => onChange(e.target.checked, true) } }); c.set = (v) => { c.checked = !!v; }; return c; }
      case 'select': { const s = h('select.field', { style: { height: '20px', maxWidth: '160px' }, on: { change: (e) => onChange(e.target.value, true) } }, p.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l))); s.set = (v) => { s.value = v; }; return s; }
      case 'text': { const t = h('input.field', { value: val || '', style: { height: '20px', width: '100%' }, on: { change: (e) => onChange(e.target.value, true), keydown: (e) => e.stopPropagation() } }); t.set = (v) => { t.value = v; }; return t; }
      case 'lut': {
        const opts = [['', 'None'], ...Object.entries(BUILTIN_LOOKS).map(([k, l]) => [k, l.name]), ...(app.store.project.libraries.looks || []).filter((l) => l.path).map((l) => [l.path, l.name])];
        if (val && !opts.some((o) => o[0] === val)) opts.push([val, val.split(/[\\/]/).pop()]);
        opts.push(['__browse', 'Browse...']);
        const s = h('select.field', { style: { height: '20px', maxWidth: '170px' } }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
        s.addEventListener('change', async () => {
          if (s.value === '__browse') { const r = await window.native.call('dialog:open', { filters: [{ name: 'LUT', extensions: ['cube', '3dl'] }] }); if (r) onChange(r[0], true); else s.value = val; }
          else onChange(s.value, true);
        });
        return s;
      }
      case 'track': {
        const s = this.seq;
        const sel = h('select.field', { style: { height: '20px' }, on: { change: (e) => onChange(+e.target.value, true) } }, [[0, 'None (track above)'], ...s.tracks.video.map((t, i) => [i + 1, `Video ${i + 1}`])].map(([v, l]) => h('option', { value: v, selected: +val === v }, l)));
        return sel;
      }
      default: return h('span', String(val));
    }
  }

  refreshValues() {
    if (!this.rows || !this.tgt || this.tgt.type !== 'clip') { this.drawKeys(); return; }
    for (const r of this.rows) {
      if (!r.param || !r.widget || !r.widget.set) continue;
      const lf = this.local(r.clip);
      const fx = this.live(r.clip.id, r.fx.id); if (!fx) continue;
      if (hasKeys(fx, r.param)) r.widget.set(evaluate(fx.keyframes[r.param], lf, fx.params[r.param]));
    }
    this.drawKeys();
  }

  // ---------- masks ----------
  addMask(clip, fx, shape) {
    const m = makeMask(shape);
    app.store.transact('Add Mask', () => { this.live(clip.id, fx.id).masks.push(m); });
    this.selectedMask = { clipId: clip.id, fxId: fx.id, maskId: m.id };
    app.program && app.program.drawOverlay();
  }

  renderMask(clip, fx, m) {
    const sel = this.selectedMask && this.selectedMask.maskId === m.id;
    const name = h('span', { style: { flex: 1, color: sel ? 'var(--amber)' : 'var(--text)', cursor: 'pointer' } }, m.name || `Mask (${m.shape})`);
    name.addEventListener('click', () => { this.selectedMask = sel ? null : { clipId: clip.id, fxId: fx.id, maskId: m.id }; this.render(); app.program && app.program.drawOverlay(); });
    const track = (dir, method) => import('../../actions/analysis.js').then((a) => a.trackMask(clip.id, fx.id, m.id, dir, method));
    const row = h('div.mask-row', icon('ellipse', 12), name,
      ibtn('track-mask-back', 'Track selected mask backward', () => track(-1, this.trackMethod || 'position')),
      ibtn('track-mask-fwd', 'Track selected mask forward', () => track(1, this.trackMethod || 'position')),
      ibtn('more', 'Mask options', (e) => contextMenu(e.clientX, e.clientY, [
        { label: 'Rename Mask', action: async () => { const n = await promptDialog('Mask name', m.name || ''); if (n != null) app.store.transact('Rename Mask', () => { this.liveMask(clip, fx, m).name = n; }); } },
        { label: 'Tracking: Position', checked: (this.trackMethod || 'position') === 'position', action: () => { this.trackMethod = 'position'; } },
        { label: 'Tracking: Position and Scale', checked: this.trackMethod === 'scale', action: () => { this.trackMethod = 'scale'; } },
        { label: 'Smooth Path', checked: m.smooth !== false, action: () => app.store.transact('Mask Smoothing', () => { const lm = this.liveMask(clip, fx, m); lm.smooth = lm.smooth === false; }) },
        { label: 'Duplicate Mask', action: () => app.store.transact('Duplicate Mask', () => { const lf = this.live(clip.id, fx.id); const c = deepClone(m); c.id = uid('mask'); lf.masks.push(c); }) },
        { label: 'Delete Mask', action: () => { app.store.transact('Delete Mask', () => { const lf = this.live(clip.id, fx.id); lf.masks = lf.masks.filter((x) => x.id !== m.id); }); this.selectedMask = null; } },
      ])));
    this.left.appendChild(row);
    const lf = this.local(clip);
    const params = [['points', 'Mask Path', 'path'], ['feather', 'Mask Feather', 'number', 0, 1000], ['opacity', 'Mask Opacity', 'number', 0, 100], ['expansion', 'Mask Expansion', 'number', -1000, 1000]];
    for (const [k, label, type, min, max] of params) {
      const keyed = m.keyframes[k] && m.keyframes[k].length;
      const sw = h('div.sw' + (keyed ? '.on' : ''), icon('stopwatch', 13));
      sw.addEventListener('click', () => app.store.transact('Mask Keyframes', () => { const lm = this.liveMask(clip, fx, m); if (keyed) { lm[k] = evaluate(lm.keyframes[k], lf, lm[k]); lm.keyframes[k] = []; } else { lm.keyframes[k] = []; setKey(lm.keyframes[k], lf, deepClone(lm[k])); } }));
      let w;
      if (type === 'path') w = h('span', { style: { color: 'var(--dim)', fontSize: '11px' } }, `${m.points.length} vertices`);
      else w = scrubNumber({ value: keyed ? evaluate(m.keyframes[k], lf, m[k]) : m[k], min, max, step: 0.5, decimals: 1, onChange: (v, fin) => {
        this.begin(); const lm = this.liveMask(clip, fx, m);
        if (lm.keyframes[k] && lm.keyframes[k].length) setKey(lm.keyframes[k], lf, v); else lm[k] = v;
        app.player.invalidate('program'); if (fin) this.commit('Mask ' + label);
      } });
      const r = h('div.prm.sub', sw, h('span.pl', label), h('div.pv', w));
      this.left.appendChild(r);
      this.rows.push({ el: r, clip, fx, mask: m, maskParam: k });
    }
    const opts = h('div.prm.sub', h('span.sw'), h('span.pl', 'Inverted'), h('div.pv',
      h('input', { type: 'checkbox', checked: m.invert, on: { change: (e) => app.store.transact('Invert Mask', () => { this.liveMask(clip, fx, m).invert = e.target.checked; }) } }),
      h('select.field', { style: { height: '20px' }, on: { change: (e) => app.store.transact('Mask Mode', () => { this.liveMask(clip, fx, m).mode = e.target.value; }) } }, [['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect'], ['difference', 'Difference']].map(([v, l]) => h('option', { value: v, selected: m.mode === v }, l)))));
    this.left.appendChild(opts);
  }
  liveMask(clip, fx, m) { return this.live(clip.id, fx.id).masks.find((x) => x.id === m.id); }

  // ---------- effect menu ----------
  resetFx(clip, fx) {
    app.store.transact('Reset Effect', () => { const lf = this.live(clip.id, fx.id); const fresh = makeEffect(fx.type); lf.params = fresh.params; lf.keyframes = {}; });
  }

  reorder(clip, movingId, beforeId) {
    app.store.transact('Reorder Effects', () => {
      const f = findClip(this.seq, clip.id); const arr = f.clip.effects;
      const i = arr.findIndex((e) => e.id === movingId); if (i < 0) return;
      const [m] = arr.splice(i, 1); const j = arr.findIndex((e) => e.id === beforeId);
      arr.splice(j < 0 ? arr.length : j, 0, m);
    });
  }

  fxMenu(e, clip, fx, def) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copy', action: () => { app.store.fxClipboard = [deepClone(fx)]; } },
      { label: 'Paste', disabled: !app.store.fxClipboard, action: () => this.pasteFx(clip) },
      { label: 'Save Preset...', action: () => this.savePreset(clip, [fx]) },
      { label: 'Reset', action: () => this.resetFx(clip, fx) },
      '-',
      { label: 'Move Up', disabled: def.intrinsic, action: () => this.move(clip, fx, -1) },
      { label: 'Move Down', disabled: def.intrinsic, action: () => this.move(clip, fx, 1) },
      { label: 'Clear', disabled: def.intrinsic, action: () => app.store.transact('Remove Effect', () => { const f = findClip(this.seq, clip.id); f.clip.effects = f.clip.effects.filter((x) => x.id !== fx.id); }) },
    ]);
  }
  move(clip, fx, d) { app.store.transact('Reorder Effects', () => { const f = findClip(this.seq, clip.id); const a = f.clip.effects; const i = a.findIndex((x) => x.id === fx.id); const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; }); }
  pasteFx(clip) {
    const list = app.store.fxClipboard; if (!list) return;
    app.store.transact('Paste Effects', () => {
      const f = findClip(this.seq, clip.id);
      for (const fx of list) {
        const c = deepClone(fx); c.id = uid('fx');
        const d = defFor(c.type);
        if (!!app.audioFxDefs[c.type] !== (f.clip.kind === 'audio')) continue;
        if (d && d.intrinsic) { const i = f.clip.effects.findIndex((x) => x.type === c.type); if (i >= 0) f.clip.effects[i] = c; } else f.clip.effects.push(c);
      }
    });
  }
  async savePreset(clip, effects) {
    const name = await promptDialog('Save Preset', (defFor(effects[0].type) || {}).name + ' Preset');
    if (!name) return;
    const anchor = await new Promise((res) => contextMenu(window.innerWidth / 2 - 100, window.innerHeight / 2 - 60, [{ label: 'Scale keyframes to clip duration', action: () => res('scale') }, { label: 'Anchor to In Point', action: () => res('in') }, { label: 'Anchor to Out Point', action: () => res('out') }]));
    const preset = { id: uid('pre'), name, effects: deepClone(effects), dur: clip.dur, anchor: anchor === 'out' ? 'out' : 'in', scale: anchor === 'scale' };
    app.store.transact('Save Preset', () => { app.store.project.libraries.effectPresets.push(preset); }, ['project']);
    const user = app.prefs.get('effects.userPresets') || []; user.push(preset); app.prefs.set('effects.userPresets', user);
    toast('Preset saved to the Effects panel');
  }

  menu() {
    const t = this.target();
    return [
      { label: 'Copy All Effects', disabled: !t || t.type !== 'clip', action: () => { app.store.fxClipboard = deepClone(t.clip.effects.filter((e) => !(defFor(e.type) || {}).intrinsic)); } },
      { label: 'Paste Effects', disabled: !t || !app.store.fxClipboard, action: () => this.pasteFx(t.clip) },
      { label: 'Save All Effects as Preset...', disabled: !t || t.type !== 'clip', action: () => this.savePreset(t.clip, t.clip.effects.filter((e) => !(defFor(e.type) || {}).intrinsic)) },
      { label: 'Remove All Effects', disabled: !t || t.type !== 'clip', action: () => import('../../actions/editing.js').then((m) => m.removeEffects()) },
    ];
  }

  // ---------- keyframe canvas ----------
  resize() { this.drawKeys(); }

  frameToX(f) { const t = this.tgt; const W = this.canvas.clientWidth || 1; return (f / Math.max(1, t.clip.dur)) * (W - 16) + 8; }
  xToFrame(x) { const t = this.tgt; const W = this.canvas.clientWidth || 1; return Math.round(clamp((x - 8) / (W - 16), 0, 1) * t.clip.dur); }

  drawKeys() {
    const r = this.right.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#121418'; ctx.fillRect(0, 0, r.width, r.height);
    const t = this.tgt;
    if (!t || t.type !== 'clip') return;
    const s = this.seq;
    const lr = this.left.getBoundingClientRect();
    // clip range bar
    ctx.fillStyle = '#1c2027'; ctx.fillRect(8, 6, r.width - 16, 14);
    ctx.fillStyle = '#8a93a2'; ctx.font = '10px PlexMono'; ctx.textBaseline = 'middle';
    ctx.fillText(framesToTC(t.clip.start, s.settings.fps), 12, 13);
    const endTxt = framesToTC(t.clip.start + t.clip.dur, s.settings.fps); ctx.textAlign = 'right'; ctx.fillText(endTxt, r.width - 12, 13); ctx.textAlign = 'left';
    this.keyHits = [];
    for (const row of this.rows || []) {
      const er = row.el.getBoundingClientRect();
      const y = er.top - lr.top + er.height / 2 + 0;
      if (y < 24 || y > r.height) continue;
      ctx.fillStyle = '#171a1f'; ctx.fillRect(0, er.bottom - lr.top - 1, r.width, 1);
      let keys = null;
      if (row.param) { const fx = this.live(row.clip.id, row.fx.id); keys = fx && fx.keyframes[row.param]; }
      else if (row.maskParam) { const m = this.liveMask(row.clip, row.fx, row.mask); keys = m && m.keyframes[row.maskParam]; }
      else if (row.header) {
        // summary keys
        const fx = this.live(row.clip.id, row.fx.id); const times = new Set();
        if (fx) for (const k of Object.values(fx.keyframes)) for (const kf of k || []) times.add(kf.t);
        ctx.fillStyle = '#5d6573';
        for (const tt of times) { const x = this.frameToX(tt); diamond(ctx, x, y, 3.5); }
        continue;
      }
      if (!keys || !keys.length) continue;
      if (keys.length > 1) { ctx.strokeStyle = '#2d3a52'; ctx.beginPath(); ctx.moveTo(this.frameToX(keys[0].t), y); ctx.lineTo(this.frameToX(keys[keys.length - 1].t), y); ctx.stroke(); }
      for (const k of keys) {
        const x = this.frameToX(k.t);
        const sel = this.selectedKeys.some((q) => q.key === k);
        ctx.fillStyle = sel ? '#5c9bff' : '#c9d0db';
        if (k.interp === 'hold') ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
        else if (k.interp && k.interp !== 'linear') { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
        else diamond(ctx, x, y, 4.5);
        this.keyHits.push({ x, y, key: k, row, keys });
      }
    }
    // playhead
    const lf = s.playhead - t.clip.start;
    if (lf >= 0 && lf <= t.clip.dur) { const x = this.frameToX(lf); ctx.fillStyle = '#5c9bff'; ctx.fillRect(Math.round(x) - 0.5, 0, 1, r.height); }
  }

  bindCanvas() {
    this.canvas.addEventListener('mousedown', (e) => {
      const t = this.tgt; if (!t || t.type !== 'clip') return;
      app.dock.focus('effectControls');
      const r = this.canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = (this.keyHits || []).find((k) => Math.abs(k.x - x) < 6 && Math.abs(k.y - y) < 7);
      if (!hit) {
        if (y < 22 || !e.shiftKey) { this.selectedKeys = []; app.player.seek(t.clip.start + this.xToFrame(x)); }
        const mv = (ev) => app.player.seek(t.clip.start + this.xToFrame(ev.clientX - r.left), { scrub: true });
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        this.drawKeys();
        return;
      }
      if (e.shiftKey) { const i = this.selectedKeys.findIndex((q) => q.key === hit.key); if (i >= 0) this.selectedKeys.splice(i, 1); else this.selectedKeys.push(hit); }
      else if (!this.selectedKeys.some((q) => q.key === hit.key)) this.selectedKeys = [hit];
      // drag selected keys in time
      this.begin();
      const x0 = e.clientX; const start = this.selectedKeys.map((q) => q.key.t);
      // re-resolve live key objects after begin() snapshot (objects are live already)
      const mv = (ev) => {
        const df = Math.round((ev.clientX - x0) / Math.max(1, (r.width - 16)) * t.clip.dur);
        this.selectedKeys.forEach((q, i) => { q.key.t = clamp(start[i] + df, 0, t.clip.dur); });
        for (const q of this.selectedKeys) q.keys.sort((a, b) => a.t - b.t);
        app.player.invalidate('program'); this.drawKeys();
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); this.commit('Move Keyframes'); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      this.drawKeys();
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.selectedKeys.length) return;
      contextMenu(e.clientX, e.clientY, [
        ...INTERPS.map(([k, l]) => ({ label: l, checked: this.selectedKeys.every((q) => (q.key.interp || 'linear') === k), action: () => this.setInterp(k) })),
        '-', { label: 'Copy', action: () => { app.store.keyClipboard = this.selectedKeys.map((q) => ({ param: q.row.param, key: deepClone(q.key) })); } },
        { label: 'Paste', disabled: !app.store.keyClipboard, action: () => this.pasteKeys() },
        { label: 'Delete', action: () => this.deleteKeys() },
      ]);
    });
  }

  setInterp(kind) { const t = this.tgt; app.store.transact('Keyframe Interpolation', () => { for (const q of this.selectedKeys) { const k = this.findLiveKey(q); if (k) { k.interp = kind; if (kind === 'bezier' || kind === 'autobezier') k.spatial = 'bezier'; } } }); void t; }
  findLiveKey(q) { const f = findClip(this.seq, q.row.clip.id); if (!f) return null; let keys; if (q.row.param) keys = f.clip.effects.find((e) => e.id === q.row.fx.id).keyframes[q.row.param]; else { const m = f.clip.effects.find((e) => e.id === q.row.fx.id).masks.find((x) => x.id === q.row.mask.id); keys = m.keyframes[q.row.maskParam]; } return keys.find((k) => k.t === q.key.t); }
  deleteKeys() {
    const sel = this.selectedKeys; if (!sel.length) return false;
    app.store.transact('Delete Keyframes', () => {
      for (const q of sel) {
        const f = findClip(this.seq, q.row.clip.id); if (!f) continue;
        const fx = f.clip.effects.find((e) => e.id === q.row.fx.id);
        const keys = q.row.param ? fx.keyframes[q.row.param] : fx.masks.find((x) => x.id === q.row.mask.id).keyframes[q.row.maskParam];
        const i = keys.findIndex((k) => k.t === q.key.t); if (i >= 0) { const [k] = keys.splice(i, 1); if (!keys.length && q.row.param) fx.params[q.row.param] = k.v; }
      }
    });
    this.selectedKeys = [];
    return true;
  }
  pasteKeys() {
    const t = this.tgt; if (!t || !app.store.keyClipboard) return;
    const base = Math.min(...app.store.keyClipboard.map((k) => k.key.t));
    app.store.transact('Paste Keyframes', () => {
      const f = findClip(this.seq, t.clip.id); const lf = this.local(f.clip);
      for (const { param, key } of app.store.keyClipboard) {
        const fx = f.clip.effects.find((e) => param in e.params); if (!fx) continue;
        fx.keyframes[param] = fx.keyframes[param] || [];
        setKey(fx.keyframes[param], lf + key.t - base, deepClone(key.v), key.interp);
      }
    });
  }
}

function diamond(ctx, x, y, r) { ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); }

export function createEffectControls(el) { return new EffectControls(el); }
export { resolveParams };
