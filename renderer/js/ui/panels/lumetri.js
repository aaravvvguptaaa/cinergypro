// Lumetri Color panel (basic, creative, curves, wheels & match, HSL secondary, vignette) and Lumetri Scopes.
import { app } from '../../app-context.js';
import { h, icon, clamp, deepClone, uid, hexToRgb } from '../../core/util.js';
import { findClip } from '../../core/project.js';
import { makeEffect } from '../../core/effect-defs.js';
import { section, sliderRow, colorInput, ibtn, toast, contextMenu, promptDialog } from '../widgets.js';
import { BUILTIN_LOOKS, curveSampler, hueCurveSampler, generateLook, lutToCube } from '../../engine/lut.js';
import { evaluate, hasKeys, setKey } from '../../core/keyframes.js';

export class LumetriPanel {
  constructor(el) {
    this.el = el;
    this.fxId = null;
    app.panels.lumetri = this;
    this.header = h('div.toolbar');
    this.body = h('div.scroll');
    el.append(this.header, this.body);
    this.openSections = new Set(['basic']);
    app.store.on('selection', () => { this.fxId = null; this.render(); });
    app.store.on('change', (e) => { if (!this.dragging && !(e && e.transient)) this.render(); });
    app.player.on('playhead', () => { if (this.hasKeys) this.render(); });
    this.render();
  }

  get seq() { return app.store.seq; }
  target() {
    const s = this.seq; if (!s) return null;
    for (const id of app.store.selection.clips) { const f = findClip(s, id); if (f && f.kind === 'video') return f; }
    return null;
  }
  fx(f) {
    if (!f) return null;
    const list = f.clip.effects.filter((e) => e.type === 'lumetri');
    return list.find((e) => e.id === this.fxId) || list[0] || null;
  }
  edit(clipId, fxId) { this.fxId = fxId; this.render(); }

  // ensure a Lumetri effect exists, then mutate a param (live during drag, commit at end)
  set(name, value, final) {
    const s = this.seq; const f = this.target(); if (!f) return;
    let fx = this.fx(f);
    if (!this.snap) this.snap = JSON.stringify(s.tracks);
    if (!fx) { fx = makeEffect('lumetri'); f.clip.effects.push(fx); this.fxId = fx.id; }
    const lf = s.playhead - f.clip.start;
    if (hasKeys(fx, name)) setKey(fx.keyframes[name], lf, deepClone(value)); else fx.params[name] = deepClone(value);
    this.dragging = !final;
    app.player.invalidate('program');
    if (final) {
      const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(this.snap); this.snap = null;
      app.store.transact('Lumetri ' + name, () => { s.tracks = JSON.parse(after); }, [s.id], { coalesce: 'lumetri:' + name });
      this.dragging = false;
    }
  }

  val(fx, name, def) { if (!fx) return def; const lf = this.seq.playhead - this.target().clip.start; return hasKeys(fx, name) ? evaluate(fx.keyframes[name], lf, fx.params[name]) : fx.params[name]; }

  render() {
    const f = this.target();
    const fx = this.fx(f);
    this.hasKeys = fx && Object.values(fx.keyframes).some((k) => k && k.length);
    this.header.innerHTML = '';
    this.body.innerHTML = '';
    if (!f) { this.body.appendChild(h('div.empty', h('div', h('b', 'Select a video clip'), 'Color adjustments apply to the selected clip. Use an adjustment layer to grade several clips at once.'))); return; }
    const all = f.clip.effects.filter((e) => e.type === 'lumetri');
    const pick = h('select.field', { style: { flex: 1, height: '22px' }, on: { change: (e) => { if (e.target.value === '__new') { app.store.transact('Add Lumetri', () => { const c = findClip(this.seq, f.clip.id); const n = makeEffect('lumetri'); c.clip.effects.push(n); this.fxId = n.id; }); } else { this.fxId = e.target.value; this.render(); } } } },
      ...all.map((e, i) => h('option', { value: e.id, selected: fx && e.id === fx.id }, `${f.clip.name} : Lumetri Color ${all.length > 1 ? i + 1 : ''}`)), h('option', { value: '__new' }, 'Add Lumetri Color effect'), !all.length ? h('option', { value: '', selected: true }, f.clip.name + ' (no Lumetri yet)') : null);
    this.header.append(pick, ibtn('reset', 'Reset all', () => { if (!fx) return; app.store.transact('Reset Lumetri', () => { const c = findClip(this.seq, f.clip.id); const e = c.clip.effects.find((x) => x.id === fx.id); e.params = makeEffect('lumetri').params; e.keyframes = {}; }); }), ibtn('more', 'Lumetri menu', (e) => this.menu(e, f, fx)));
    const v = (n, d) => this.val(fx, n, d);
    const sec = (key, title, body) => section(title, body, { closed: !this.openSections.has(key), onToggle: (o) => (o ? this.openSections.add(key) : this.openSections.delete(key)) });
    const S = (label, name, min, max, step, def, scale = 1) => sliderRow(label, +(v(name, def) / scale).toFixed(3), min, max, step, (x, fin) => this.set(name, x * scale, fin), { def });

    // Basic correction
    const basic = h('div',
      h('div.row', h('label', 'Input LUT'), h('select.field', { style: { flex: 1 }, on: { change: (e) => this.set('inputLut', e.target.value, true) } }, makeEffect('lumetri').params && app.effectDefs.lumetri.params[0].options.map(([k, l]) => h('option', { value: k, selected: v('inputLut', 'none') === k }, l)))),
      h('div', { style: { display: 'flex', gap: '6px', margin: '6px 0' } }, h('button.btn.small', { on: { click: () => this.auto(f) } }, 'Auto'), h('button.btn.small', { on: { click: () => this.whiteBalancePick(f) } }, icon('dropper', 12), 'WB Selector')),
      h('div', { style: { color: 'var(--dim)', fontSize: '11px', margin: '6px 0 2px' } }, 'White balance'),
      S('Temperature', 'temperature', -100, 100, 0.1, 0), S('Tint', 'tint', -100, 100, 0.1, 0),
      h('div', { style: { color: 'var(--dim)', fontSize: '11px', margin: '8px 0 2px' } }, 'Tone'),
      S('Exposure', 'exposure', -5, 5, 0.01, 0), S('Contrast', 'contrast', -100, 100, 0.1, 0), S('Highlights', 'highlights', -100, 100, 0.1, 0), S('Shadows', 'shadows', -100, 100, 0.1, 0),
      S('Whites', 'whites', -100, 100, 0.1, 0), S('Blacks', 'blacks', -100, 100, 0.1, 0), S('Saturation', 'saturation', 0, 200, 0.1, 100), S('Vibrance', 'vibrance', -100, 100, 0.1, 0));
    this.body.appendChild(sec('basic', 'Basic Correction', basic));

    // Creative
    const looks = [['', 'None'], ...Object.entries(BUILTIN_LOOKS).map(([k, l]) => [k, l.name]), ...(app.store.project.libraries.looks || []).filter((l) => l.path).map((l) => [l.path, l.name])];
    const cur = v('look', '');
    if (cur && !looks.some((l) => l[0] === cur)) looks.push([cur, cur.split(/[\\/]/).pop()]);
    const lookSel = h('select.field', { style: { flex: 1 } }, looks.map(([k, l]) => h('option', { value: k, selected: k === cur }, l)), h('option', { value: '__browse' }, 'Browse...'));
    lookSel.addEventListener('change', async () => { if (lookSel.value === '__browse') { const r = await window.native.call('dialog:open', { filters: [{ name: 'LUT', extensions: ['cube', '3dl'] }] }); if (r) { app.store.transact('Add Look', () => { app.store.project.libraries.looks.push({ id: uid('look'), name: r[0].split(/[\\/]/).pop(), path: r[0] }); }, ['project']); this.set('look', r[0], true); } else lookSel.value = cur; } else this.set('look', lookSel.value, true); });
    const creative = h('div',
      h('div.row', h('label', 'Look'), lookSel), S('Intensity', 'lookIntensity', 0, 200, 0.1, 100),
      h('div', { style: { color: 'var(--dim)', fontSize: '11px', margin: '8px 0 2px' } }, 'Adjustments'),
      S('Faded Film', 'faded', 0, 100, 0.1, 0), S('Sharpen', 'sharpen', -100, 100, 0.1, 0), S('Vibrance', 'vibrance', -100, 100, 0.1, 0), S('Saturation', 'saturation', 0, 200, 0.1, 100),
      h('div.row', h('label', 'Shadow Tint'), colorInput(v('shadowTint', '#808080'), (c, fin) => this.set('shadowTint', c, fin)), h('label', { style: { flex: '0 0 auto' } }, 'Highlight Tint'), colorInput(v('highlightTint', '#808080'), (c, fin) => this.set('highlightTint', c, fin))),
      S('Tint Balance', 'tintBalance', -100, 100, 0.1, 0));
    this.body.appendChild(sec('creative', 'Creative', creative));

    // Curves
    this.body.appendChild(sec('curves', 'Curves', this.curvesUI(v('curves', makeEffect('lumetri').params.curves), v('hueCurves', makeEffect('lumetri').params.hueCurves))));

    // Wheels & match
    const wheels = v('wheels', { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] });
    const wbox = h('div.wheels', ['shadows', 'midtones', 'highlights'].map((k) => this.wheel(k[0].toUpperCase() + k.slice(1), wheels[k] || [0, 0, 0], (nv, fin) => { const w = deepClone(this.val(this.fx(this.target()), 'wheels', wheels)); w[k] = nv; this.set('wheels', w, fin); })));
    const match = h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
      h('button.btn.small', { on: { click: () => { app.program && (app.program.compare || app.program.toggleCompare()); toast('Set the reference frame in the Program Monitor comparison view, then press Apply Match'); } } }, 'Comparison View'),
      h('button.btn.small.primary', { on: { click: () => this.applyMatch(f) } }, 'Apply Match'));
    this.body.appendChild(sec('wheels', 'Color Wheels & Match', h('div', match, wbox)));

    // HSL secondary
    const key = v('hslKey', makeEffect('lumetri').params.hslKey);
    const setKey2 = (patch, fin) => { const k = { ...deepClone(this.val(this.fx(this.target()), 'hslKey', key)), ...patch }; this.set('hslKey', k, fin); };
    const rangeRow = (label, arr, idx, min, max) => sliderRow(label, +arr[idx].toFixed(3), min, max, 0.005, (x, fin) => { const a = [...arr]; a[idx] = x; setKey2({ [label[0].toLowerCase() === 'h' ? 'h' : label.startsWith('Sat') ? 's' : 'l']: a }, fin); });
    const hsl = h('div',
      h('label.check', h('input', { type: 'checkbox', checked: !!v('hslEnabled', 0), on: { change: (e) => this.set('hslEnabled', e.target.checked ? 1 : 0, true) } }), 'Enable HSL secondary'),
      h('div', { style: { display: 'flex', gap: '6px', margin: '6px 0' } }, h('button.btn.small', { on: { click: () => this.keyPick(f, setKey2) } }, icon('dropper', 12), 'Set color'), h('label.check', h('input', { type: 'checkbox', checked: key.showMask, on: { change: (e) => setKey2({ showMask: e.target.checked }, true) } }), 'Show mask'), h('label.check', h('input', { type: 'checkbox', checked: key.invert, on: { change: (e) => setKey2({ invert: e.target.checked }, true) } }), 'Invert')),
      rangeRow('Hue center', key.h, 0, 0, 1), rangeRow('Hue width', key.h, 1, 0, 0.5), rangeRow('Hue soft', key.h, 2, 0, 0.3),
      rangeRow('Sat min', key.s, 0, 0, 1), rangeRow('Sat max', key.s, 1, 0, 1), rangeRow('Luma min', key.l, 0, 0, 1), rangeRow('Luma max', key.l, 1, 0, 1),
      h('div', { style: { color: 'var(--dim)', fontSize: '11px', margin: '8px 0 2px' } }, 'Correction'),
      this.wheel('Secondary', v('hslWheel', [0, 0, 0]), (nv, fin) => this.set('hslWheel', nv, fin), 90),
      S('Temperature', 'hslTemp', -100, 100, 0.1, 0), S('Tint', 'hslTint', -100, 100, 0.1, 0), S('Contrast', 'hslContrast', -100, 100, 0.1, 0), S('Saturation', 'hslSaturation', 0, 200, 0.1, 100));
    this.body.appendChild(sec('hsl', 'HSL Secondary', hsl));

    // Vignette
    this.body.appendChild(sec('vignette', 'Vignette', h('div', S('Amount', 'vignetteAmount', -5, 5, 0.01, 0), S('Midpoint', 'vignetteMidpoint', 0, 100, 0.1, 50), S('Roundness', 'vignetteRoundness', -100, 100, 0.1, 0), S('Feather', 'vignetteFeather', 0, 100, 0.1, 50))));
  }

  menu(e, f, fx) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Save Look to Libraries', disabled: !fx, action: async () => { const n = await promptDialog('Look name', 'My Look'); if (!n) return; app.store.transact('Save Look', () => { app.store.project.libraries.looks.push({ id: uid('look'), name: n, params: deepClone(fx.params) }); }, ['project']); toast('Look saved to Libraries'); } },
      { label: 'Export Look as .cube...', disabled: !fx, action: () => this.exportCube(fx) },
      { label: 'Copy Grade', disabled: !fx, action: () => { app.store.gradeClipboard = deepClone(fx); toast('Grade copied'); } },
      { label: 'Paste Grade to Selected Clips', disabled: !app.store.gradeClipboard, action: () => import('../../actions/editing.js').then((m) => m.applyPreset({ id: 'grade', effects: [app.store.gradeClipboard] })) },
    ]);
  }

  async exportCube(fx) {
    // Bake the global (non-spatial) part of the grade into a 33^3 cube by sampling a synthetic image through the pipeline
    const path = await window.native.call('dialog:save', { defaultPath: `${app.info.desktop}/Look.cube`, filters: [{ name: 'Cube LUT', extensions: ['cube'] }] });
    if (!path) return;
    const N = 33; const gl = app.gl;
    const data = new Uint8Array(N * N * N * 4);
    let k = 0; for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) { data[k++] = Math.round(r / (N - 1) * 255); data[k++] = Math.round(g / (N - 1) * 255); data[k++] = Math.round(b / (N - 1) * 255); data[k++] = 255; }
    const src = gl.uploadData(null, N * N, N, data, { nearest: true });
    const inFbo = gl.acquire(N * N, N, { bytes: true });
    gl.pass('copy', 'uniform sampler2D uTex; void main(){ fragColor = texture(uTex, vUv); }', inFbo, { uTex: src });
    const { EFFECT_IMPL } = await import('../../engine/shaders.js');
    const p = { ...fx.params, sharpen: 0, vignetteAmount: 0, hslEnabled: 0 };
    const info = { scale: 1, lumetriTextures: (q) => app.compositor.lumetriTextures(q), dummyLut: () => app.compositor.dummyLut(), loadLut: (q) => app.compositor.loadLut(q) };
    const out = EFFECT_IMPL.lumetri(app.compositor.ctx, inFbo, p, info);
    const bytes = app.compositor.toBytes(out);
    gl.release(out); gl.release(inFbo); gl.deleteTexture(src);
    const lut = { size: N, data: new Float32Array(N * N * N * 3) };
    for (let i = 0; i < N * N * N; i++) { lut.data[i * 3] = bytes[i * 4] / 255; lut.data[i * 3 + 1] = bytes[i * 4 + 1] / 255; lut.data[i * 3 + 2] = bytes[i * 4 + 2] / 255; }
    await window.native.call('fs:write-text', path, lutToCube(lut, 'CinergyPro Look'));
    toast('Look exported');
  }

  async auto(f) {
    const { autoTone } = await import('../../actions/analysis.js');
    const r = await autoTone(f.clip.id); if (!r) return;
    const s = this.seq;
    app.store.transact('Auto Color', () => {
      const c = findClip(s, f.clip.id); let fx = c.clip.effects.find((e) => e.id === this.fxId) || c.clip.effects.find((e) => e.type === 'lumetri');
      if (!fx) { fx = makeEffect('lumetri'); c.clip.effects.push(fx); }
      Object.assign(fx.params, r);
    });
  }

  async applyMatch(f) {
    const prog = app.program; if (!prog || prog.refFrame == null) return toast('Turn on Comparison View and choose a reference frame first', 'warn');
    const s = this.seq;
    let refClip = null;
    for (const t of [...s.tracks.video].reverse()) { const c = t.clips.find((x) => prog.refFrame >= x.start && prog.refFrame < x.start + x.dur); if (c) { refClip = c; break; } }
    if (!refClip) return toast('No clip at the reference frame', 'warn');
    const { colorMatch } = await import('../../actions/analysis.js');
    const r = await colorMatch(refClip.id, prog.refFrame, f.clip.id); if (!r) return;
    app.store.transact('Color Match', () => { const c = findClip(s, f.clip.id); let fx = c.clip.effects.find((e) => e.type === 'lumetri'); if (!fx) { fx = makeEffect('lumetri'); c.clip.effects.push(fx); } Object.assign(fx.params, r); });
    toast('Match applied');
  }

  // pick a pixel from the program monitor
  pickPixel() {
    return new Promise((resolve) => {
      const prog = app.program; if (!prog) return resolve(null);
      toast('Click a pixel in the Program Monitor');
      const handler = (e) => {
        e.stopPropagation(); e.preventDefault();
        const r = prog.display.getBoundingClientRect();
        const x = Math.floor((e.clientX - r.left) / r.width * prog.display.width), y = Math.floor((e.clientY - r.top) / r.height * prog.display.height);
        const d = prog.dctx.getImageData(clamp(x - 2, 0, prog.display.width - 5), clamp(y - 2, 0, prog.display.height - 5), 5, 5).data;
        let R = 0, G = 0, B = 0; for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
        prog.view.removeEventListener('mousedown', handler, true); prog.view.style.cursor = '';
        resolve([R / 25 / 255, G / 25 / 255, B / 25 / 255]);
      };
      prog.view.style.cursor = 'crosshair';
      prog.view.addEventListener('mousedown', handler, true);
    });
  }

  async whiteBalancePick(f) {
    const c = await this.pickPixel(); if (!c) return;
    const fx = this.fx(f);
    const t0 = fx ? fx.params.temperature : 0, ti0 = fx ? fx.params.tint : 0;
    const temp = clamp(t0 + ((c[2] - c[0]) / Math.max(0.05, (c[0] + c[2]) / 2)) * 45, -100, 100);
    const tint = clamp(ti0 + (((c[0] + c[2]) / 2 - c[1]) / Math.max(0.05, c[1])) * 45, -100, 100);
    this.set('temperature', +temp.toFixed(1), false); this.set('tint', +tint.toFixed(1), true);
  }

  async keyPick(f, setKey2) {
    const c = await this.pickPixel(); if (!c) return;
    const mx = Math.max(...c), mn = Math.min(...c), l = (mx + mn) / 2, d = mx - mn;
    let hue = 0; if (d) { if (mx === c[0]) hue = ((c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0)) / 6; else if (mx === c[1]) hue = ((c[2] - c[0]) / d + 2) / 6; else hue = ((c[0] - c[1]) / d + 4) / 6; }
    const sat = d ? (l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)) : 0;
    setKey2({ h: [hue, 0.06, 0.04], s: [Math.max(0, sat - 0.25), Math.min(1, sat + 0.25), 0.1], l: [Math.max(0, l - 0.3), Math.min(1, l + 0.3), 0.1] }, true);
    this.set('hslEnabled', 1, true);
  }

  // ---------- color wheel ----------
  wheel(label, value, onChange, size = 120) {
    const cv = h('canvas', { width: size * 2, height: size * 2 });
    const ctx = cv.getContext('2d');
    let v = [...value];
    const draw = () => {
      const R = size, c = size;
      ctx.clearRect(0, 0, size * 2, size * 2);
      const img = ctx.createImageData(size * 2, size * 2);
      for (let y = 0; y < size * 2; y++) for (let x = 0; x < size * 2; x++) {
        const dx = (x - c) / R, dy = (y - c) / R; const r = Math.hypot(dx, dy); if (r > 0.96) continue;
        const ang = Math.atan2(-dy, dx); const hue = (ang / (2 * Math.PI) + 1) % 1;
        const rgb = hsv(hue, r * 0.6, 0.55 + 0.2 * (1 - r));
        const i = (y * size * 2 + x) * 4; img.data[i] = rgb[0] * 255; img.data[i + 1] = rgb[1] * 255; img.data[i + 2] = rgb[2] * 255; img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.moveTo(c - 10, c); ctx.lineTo(c + 10, c); ctx.moveTo(c, c - 10); ctx.lineTo(c, c + 10); ctx.stroke();
      const px = c + v[0] * R * 0.92, py = c - v[1] * R * 0.92;
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.stroke();
    };
    draw();
    cv.addEventListener('mousedown', (e) => {
      const set = (ev, fin) => {
        const r = cv.getBoundingClientRect();
        let x = ((ev.clientX - r.left) / r.width * 2 - 1) / 0.92, y = -((ev.clientY - r.top) / r.height * 2 - 1) / 0.92;
        const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
        if (ev.shiftKey) { x *= 0.25; y *= 0.25; }
        v = [+x.toFixed(4), +y.toFixed(4), v[2] || 0]; draw(); onChange(v, fin);
      };
      set(e, false);
      const mv = (ev) => set(ev, false);
      const up = (ev) => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); onChange(v, true); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    cv.addEventListener('dblclick', () => { v = [0, 0, v[2] || 0]; draw(); onChange(v, true); });
    const lum = h('input', { type: 'range', min: -1, max: 1, step: 0.01, value: v[2] || 0, style: { width: '90%' } });
    lum.addEventListener('input', () => { v = [v[0], v[1], +lum.value]; onChange(v, false); });
    lum.addEventListener('change', () => onChange(v, true));
    lum.addEventListener('dblclick', () => { lum.value = 0; v = [v[0], v[1], 0]; onChange(v, true); });
    return h('div.wheel', cv, lum, h('span.lbl', label));
  }

  // ---------- curves ----------
  curvesUI(curves, hue) {
    const tabs = ['master', 'r', 'g', 'b'];
    const colors = { master: '#e6ebf2', r: '#ff5a5f', g: '#3fcf7f', b: '#5c9bff' };
    this.curveCh = this.curveCh || 'master';
    const box = h('div');
    const seg = h('div.seg', { style: { marginBottom: '6px' } }, tabs.map((t) => h('button' + (t === this.curveCh ? '.on' : ''), { on: { click: () => { this.curveCh = t; this.render(); } } }, t === 'master' ? 'Luma' : t.toUpperCase())));
    const cv = h('canvas.curve-ed', { width: 520, height: 520 });
    const ctx = cv.getContext('2d');
    let pts = deepClone(curves[this.curveCh] || [[0, 0], [1, 1]]);
    const draw = () => {
      const W = 520;
      ctx.fillStyle = '#0a0c0f'; ctx.fillRect(0, 0, W, W);
      ctx.strokeStyle = '#1f242c'; ctx.lineWidth = 1; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(i * W / 4, 0); ctx.lineTo(i * W / 4, W); ctx.moveTo(0, i * W / 4); ctx.lineTo(W, i * W / 4); ctx.stroke(); }
      ctx.strokeStyle = '#2a2f38'; ctx.beginPath(); ctx.moveTo(0, W); ctx.lineTo(W, 0); ctx.stroke();
      for (const t of tabs) { if (t === this.curveCh) continue; const p = curves[t]; if (!p || (p.length === 2 && p[0][1] === 0 && p[1][1] === 1)) continue; const s2 = curveSampler(p); ctx.strokeStyle = colors[t] + '55'; ctx.beginPath(); for (let x = 0; x <= W; x += 4) { const y = W - s2(x / W) * W; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
      const s = curveSampler(pts);
      ctx.strokeStyle = colors[this.curveCh]; ctx.lineWidth = 2.5; ctx.beginPath();
      for (let x = 0; x <= W; x += 2) { const y = W - clamp(s(x / W), 0, 1) * W; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      ctx.fillStyle = colors[this.curveCh];
      for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x * W, W - y * W, 7, 0, Math.PI * 2); ctx.fill(); }
    };
    draw();
    const commit = (fin) => { const all = deepClone(this.val(this.fx(this.target()), 'curves', curves)); all[this.curveCh] = pts; this.set('curves', all, fin); };
    cv.addEventListener('mousedown', (e) => {
      const r = cv.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = 1 - (e.clientY - r.top) / r.height;
      let idx = pts.findIndex(([x, y]) => Math.hypot(x - nx, y - ny) < 0.04);
      if (idx < 0) { pts.push([nx, ny]); pts.sort((a, b) => a[0] - b[0]); idx = pts.findIndex((p) => p[0] === nx); }
      if (e.button === 2 || e.altKey) { if (idx > 0 && idx < pts.length - 1) pts.splice(idx, 1); draw(); commit(true); return; }
      const mv = (ev) => {
        const x = clamp((ev.clientX - r.left) / r.width, 0, 1), y = clamp(1 - (ev.clientY - r.top) / r.height, 0, 1);
        const lo = idx > 0 ? pts[idx - 1][0] + 0.01 : 0, hi = idx < pts.length - 1 ? pts[idx + 1][0] - 0.01 : 1;
        pts[idx] = [idx === 0 ? Math.min(x, hi) : idx === pts.length - 1 ? Math.max(x, lo) : clamp(x, lo, hi), y];
        draw(); commit(false);
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); commit(true); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('dblclick', () => { pts = [[0, 0], [1, 1]]; draw(); commit(true); });
    box.append(h('div', { style: { color: 'var(--dim)', fontSize: '11px', marginBottom: '4px' } }, 'RGB Curves: click to add points, Option-click to remove, double-click to reset'), seg, cv);
    // Hue curves
    const hTabs = [['hueSat', 'Hue vs Sat'], ['hueHue', 'Hue vs Hue'], ['hueLuma', 'Hue vs Luma'], ['lumaSat', 'Luma vs Sat'], ['satSat', 'Sat vs Sat']];
    this.hueCh = this.hueCh || 'hueSat';
    const hseg = h('div.seg', { style: { margin: '12px 0 6px', flexWrap: 'wrap' } }, hTabs.map(([k, l]) => h('button' + (k === this.hueCh ? '.on' : ''), { on: { click: () => { this.hueCh = k; this.render(); } } }, l)));
    const hc = h('canvas.curve-ed', { width: 520, height: 260, style: { aspectRatio: '2' } });
    const hctx = hc.getContext('2d');
    let hp = deepClone((hue && hue[this.hueCh]) || []);
    const periodic = this.hueCh.startsWith('hue');
    const hdraw = () => {
      const W = 520, H = 260;
      for (let x = 0; x < W; x++) { const t = x / W; hctx.fillStyle = periodic ? `hsl(${t * 360},70%,${30}%)` : `rgb(${t * 60 + 10},${t * 60 + 10},${t * 60 + 14})`; hctx.fillRect(x, 0, 1, H); }
      hctx.strokeStyle = 'rgba(255,255,255,0.25)'; hctx.beginPath(); hctx.moveTo(0, H / 2); hctx.lineTo(W, H / 2); hctx.stroke();
      const s = periodic ? hueCurveSampler(hp) : (hp.length ? curveSampler(hp) : () => 0.5);
      hctx.strokeStyle = '#fff'; hctx.lineWidth = 2; hctx.beginPath();
      for (let x = 0; x <= W; x += 2) { const y = H - clamp(s(x / W), 0, 1) * H; x ? hctx.lineTo(x, y) : hctx.moveTo(x, y); }
      hctx.stroke();
      hctx.fillStyle = '#fff'; for (const [x, y] of hp) { hctx.beginPath(); hctx.arc(x * W, H - y * H, 6, 0, Math.PI * 2); hctx.fill(); }
    };
    hdraw();
    const hcommit = (fin) => { const all = deepClone(this.val(this.fx(this.target()), 'hueCurves', hue)); all[this.hueCh] = hp; this.set('hueCurves', all, fin); };
    hc.addEventListener('mousedown', (e) => {
      const r = hc.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = 1 - (e.clientY - r.top) / r.height;
      let idx = hp.findIndex(([x, y]) => Math.abs(x - nx) < 0.02 && Math.abs(y - ny) < 0.06);
      if (e.altKey && idx >= 0) { hp.splice(idx, 1); hdraw(); hcommit(true); return; }
      if (idx < 0) {
        // first click places a point on the neutral line; plus two neighbours to keep the change local
        if (!hp.length) hp.push([clamp(nx - 0.08, 0, 1), 0.5], [clamp(nx + 0.08, 0, 1), 0.5]);
        hp.push([nx, 0.5]); hp.sort((a, b) => a[0] - b[0]); idx = hp.findIndex((p) => p[0] === nx);
      }
      const mv = (ev) => { hp[idx] = [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp(1 - (ev.clientY - r.top) / r.height, 0, 1)]; hdraw(); hcommit(false); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); hp.sort((a, b) => a[0] - b[0]); hcommit(true); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    hc.addEventListener('dblclick', () => { hp = []; hdraw(); hcommit(true); });
    box.append(hseg, hc);
    return box;
  }

  resize() {}
}

function hsv(h, s, v) { const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s); return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; }

// ---------------- Scopes ----------------
export class ScopesPanel {
  constructor(el) {
    this.el = el;
    this.mode = 'waveform';
    this.wfMode = 'luma';
    this.brightness = 1;
    this.canvas = h('canvas');
    const seg = h('div.seg', ['waveform', 'parade', 'vectorscope', 'histogram', 'all'].map((m) => h('button' + (m === this.mode ? '.on' : ''), { dataset: { m }, on: { click: () => { this.mode = m; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m)); } } }, m[0].toUpperCase() + m.slice(1))));
    const wf = h('select.field', { style: { height: '22px' }, on: { change: (e) => { this.wfMode = e.target.value; } } }, [['luma', 'Luma'], ['rgb', 'RGB'], ['ycbcr', 'YC']].map(([v, l]) => h('option', { value: v }, l)));
    const br = h('input', { type: 'range', min: 0.3, max: 4, step: 0.1, value: 1, style: { width: '80px' }, on: { input: (e) => { this.brightness = +e.target.value; } } });
    this.readout = h('span', { style: { marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: '10.5px', color: 'var(--muted)' } });
    el.append(h('div.toolbar', seg, wf, h('span', { style: { color: 'var(--dim)', fontSize: '11px' } }, 'Brightness'), br, this.readout), h('div.scopes', this.canvas));
    this.consumer = (data, w, hh) => { if (this.el.offsetParent) this.draw(data, w, hh); };
    app.player.scopeConsumers.add(this.consumer);
    app.player.invalidate('program');
  }
  resize() { app.player.invalidate('program'); }

  draw(px, w, hh) {
    const c = this.canvas; const r = c.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#07080a'; ctx.fillRect(0, 0, r.width, r.height);
    // pixel rows come bottom-up from readPixels
    const modes = this.mode === 'all' ? ['waveform', 'vectorscope', 'parade', 'histogram'] : [this.mode];
    const cols = modes.length > 1 ? 2 : 1, rows = modes.length > 1 ? 2 : 1;
    const cw = r.width / cols, ch = r.height / rows;
    modes.forEach((m, i) => { const x = (i % cols) * cw, y = Math.floor(i / cols) * ch; ctx.save(); ctx.translate(x, y); this['draw_' + m](ctx, px, w, hh, cw, ch); ctx.restore(); });
    // readout: min/max luma
    let mn = 1, mx = 0, clipped = 0;
    for (let i = 0; i < px.length; i += 16) { const l = (px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722) / 255; mn = Math.min(mn, l); mx = Math.max(mx, l); if (px[i] > 253 || px[i + 1] > 253 || px[i + 2] > 253) clipped++; }
    this.readout.textContent = `min ${(mn * 100).toFixed(0)} IRE  max ${(mx * 100).toFixed(0)} IRE${clipped ? '  clipping' : ''}`;
  }

  grid(ctx, W, H, pad) {
    ctx.strokeStyle = '#1e2229'; ctx.fillStyle = '#4b5260'; ctx.font = '9px PlexMono'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) { const y = pad + (H - pad * 2) * (1 - i / 10); ctx.beginPath(); ctx.moveTo(28, y + 0.5); ctx.lineTo(W - 4, y + 0.5); ctx.stroke(); if (i % 2 === 0) ctx.fillText(String(i * 10), 4, y + 3); }
  }

  plotWave(ctx, px, w, hh, x0, W, H, chan, color) {
    const pad = 10; const plotH = H - pad * 2;
    const acc = new Float32Array(Math.ceil(W) * 256);
    for (let y = 0; y < hh; y += 1) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v;
      if (chan === 'l') v = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722; else v = px[i + chan];
      const cx = Math.floor(x / w * (W - 1)); acc[cx * 256 + Math.round(v)]++;
    }
    const img = ctx.createImageData(Math.ceil(W), Math.ceil(plotH));
    const norm = this.brightness * 2.2 / (hh / 60);
    const [cr, cg, cb] = color;
    for (let cx = 0; cx < Math.ceil(W); cx++) for (let v = 0; v < 256; v++) {
      const n = acc[cx * 256 + v]; if (!n) continue;
      const yy = Math.floor((1 - v / 255) * (plotH - 1)); const i = (yy * Math.ceil(W) + cx) * 4;
      const a = Math.min(1, n * norm * 0.25);
      img.data[i] = Math.min(255, img.data[i] + cr * a); img.data[i + 1] = Math.min(255, img.data[i + 1] + cg * a); img.data[i + 2] = Math.min(255, img.data[i + 2] + cb * a); img.data[i + 3] = 255;
    }
    const tmp = document.createElement('canvas'); tmp.width = img.width; tmp.height = img.height; tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(tmp, x0, pad); ctx.globalCompositeOperation = 'source-over';
  }

  draw_waveform(ctx, px, w, hh, W, H) {
    this.grid(ctx, W, H, 10);
    const x0 = 30, PW = W - 36;
    if (this.wfMode === 'rgb') { this.plotWave(ctx, px, w, hh, x0, PW, H, 0, [255, 70, 70]); this.plotWave(ctx, px, w, hh, x0, PW, H, 1, [70, 255, 110]); this.plotWave(ctx, px, w, hh, x0, PW, H, 2, [80, 140, 255]); }
    else this.plotWave(ctx, px, w, hh, x0, PW, H, 'l', [150, 255, 170]);
  }
  draw_parade(ctx, px, w, hh, W, H) {
    this.grid(ctx, W, H, 10);
    const x0 = 30, PW = (W - 40) / 3;
    this.plotWave(ctx, px, w, hh, x0, PW - 4, H, 0, [255, 70, 70]);
    this.plotWave(ctx, px, w, hh, x0 + PW, PW - 4, H, 1, [70, 255, 110]);
    this.plotWave(ctx, px, w, hh, x0 + PW * 2, PW - 4, H, 2, [80, 140, 255]);
  }
  draw_vectorscope(ctx, px, w, hh, W, H) {
    const R = Math.min(W, H) / 2 - 12, cx = W / 2, cy = H / 2;
    ctx.strokeStyle = '#1e2229'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // skin tone line (~123 degrees)
    ctx.strokeStyle = '#6b5a3c'; ctx.beginPath(); ctx.moveTo(cx, cy); const sa = -123 * Math.PI / 180; ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R); ctx.stroke();
    const targets = { R: [1, 0, 0], Mg: [1, 0, 1], B: [0, 0, 1], Cy: [0, 1, 1], G: [0, 1, 0], Yl: [1, 1, 0] };
    ctx.fillStyle = '#4b5260'; ctx.font = '9px PlexMono';
    for (const [n, [r, g, b]] of Object.entries(targets)) { const u = (-0.1146 * r - 0.3854 * g + 0.5 * b) * 0.75, v = (0.5 * r - 0.4542 * g - 0.0458 * b) * 0.75; const x = cx + u * 2 * R, y = cy - v * 2 * R; ctx.strokeStyle = '#3a404b'; ctx.strokeRect(x - 5, y - 5, 10, 10); ctx.fillText(n, x + 7, y + 3); }
    const img = ctx.getImageData(0, 0, Math.ceil(W * (window.devicePixelRatio || 1)), Math.ceil(H * (window.devicePixelRatio || 1)));
    void img;
    ctx.fillStyle = `rgba(150,255,170,${Math.min(0.5, 0.06 * this.brightness)})`;
    for (let i = 0; i < px.length; i += 8) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const u = -0.1146 * r - 0.3854 * g + 0.5 * b, v = 0.5 * r - 0.4542 * g - 0.0458 * b;
      ctx.fillRect(cx + u * 2 * R * 0.75 / 0.75, cy - v * 2 * R * 0.75 / 0.75, 1.2, 1.2);
    }
  }
  draw_histogram(ctx, px, w, hh, W, H) {
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < px.length; i += 4) { bins[0][px[i]]++; bins[1][px[i + 1]]++; bins[2][px[i + 2]]++; bins[3][Math.round(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722)]++; }
    const max = Math.max(...bins.slice(0, 3).map((b) => Math.max(...b.slice(2, 254)))) || 1;
    const colors = ['rgba(255,70,70,0.5)', 'rgba(70,255,110,0.5)', 'rgba(80,140,255,0.5)'];
    ctx.globalCompositeOperation = 'lighter';
    bins.slice(0, 3).forEach((b, k) => { ctx.fillStyle = colors[k]; ctx.beginPath(); ctx.moveTo(8, H - 8); for (let i = 0; i < 256; i++) ctx.lineTo(8 + i / 255 * (W - 16), H - 8 - Math.min(1, b[i] / max) * (H - 20)); ctx.lineTo(W - 8, H - 8); ctx.fill(); });
    ctx.globalCompositeOperation = 'source-over';
  }
}

export function createLumetri(el) { return new LumetriPanel(el); }
export function createScopes(el) { return new ScopesPanel(el); }
export { hexToRgb };
