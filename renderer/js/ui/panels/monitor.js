// Source and Program monitors: playback display, transport, overlays, direct manipulation,
// comparison view, multi-camera view and pop-out.
import { app } from '../../app-context.js';
import { h, icon, clamp, fileUrl } from '../../core/util.js';
import { seqDuration, clipAt, findClip, itemDuration, clipSourceTime } from '../../core/project.js';
import { framesToTC, parseTimeInput, formatTime } from '../../core/timecode.js';
import { ibtn, contextMenu, toast } from '../widgets.js';
import { commands } from '../../core/commands.js';
import { resolveParams, setKey, hasKeys, evaluate } from '../../core/keyframes.js';
import { maskAt, tracePath } from '../../engine/masks.js';
import { layerProps, layerBounds } from '../../engine/graphics.js';

export class Monitor {
  constructor(el, kind) {
    this.el = el; this.kind = kind;
    this.zoom = 'fit';
    this.safe = false; this.grid = false; this.transparencyGrid = false; this.compare = false; this.multicam = false; this.showCaptions = true;
    this.useVideo = true; this.useAudio = true;
    if (kind === 'program') app.program = this; else app.source = this;
    this.build();
    app.player.targets[kind] = { size: () => [this.display.width, this.display.height], draw: (c, sx, sy, w, hh) => this.drawFrame(c, sx, sy, w, hh), visible: () => this.el.offsetParent !== null && !this.multicam };
    app.player.on(kind === 'program' ? 'playhead' : 'source-time', () => this.update());
    app.player.on('state', () => this.updateButtons());
    app.store.on('change', () => { this.update(); this.layout(); });
    app.store.on('selection', () => this.drawOverlay());
    app.store.on('sequence', () => { this.layout(); this.update(); });
    app.store.on('source', () => { this.layout(); this.update(); });
    if (kind === 'program') app.player.extra.add((fin) => { if (this.multicam) this.renderMulticam(); });
  }

  build() {
    const k = this.kind;
    this.display = h('canvas.display');
    this.dctx = this.display.getContext('2d', { alpha: false, desynchronized: true });
    this.overlay = h('canvas.overlay');
    this.octx = this.overlay.getContext('2d');
    this.handles = h('div.handles');
    this.info = h('div.mon-info');
    this.view = h('div.mon-view', this.display, this.overlay, this.handles, this.info);
    this.tc = h('input.tc', { spellcheck: false });
    this.tc.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.jumpTo(this.tc.value); this.tc.blur(); } if (e.key === 'Escape') this.tc.blur(); });
    this.tc.addEventListener('blur', () => this.update());
    this.zoomSel = h('select.field', { style: { width: '74px', height: '22px', fontSize: '11px' } }, ['fit', 10, 25, 50, 75, 100, 150, 200, 400].map((z) => h('option', { value: z }, z === 'fit' ? 'Fit' : z + '%')));
    this.zoomSel.addEventListener('change', () => { this.zoom = this.zoomSel.value === 'fit' ? 'fit' : +this.zoomSel.value; this.pan = [0, 0]; this.layout(); });
    this.resSel = h('select.field', { style: { width: '62px', height: '22px', fontSize: '11px' }, title: 'Playback resolution' }, ['full', '1/2', '1/4', '1/8'].map((r) => h('option', { value: r }, r === 'full' ? 'Full' : r)));
    this.resSel.value = app.prefs.get('playback.resolution') || 'full';
    this.resSel.addEventListener('change', () => { app.prefs.set('playback.resolution', this.resSel.value); app.player.invalidate(); });
    this.dur = h('input.tc.dur', { readOnly: true, tabindex: -1 });
    this.name = h('span', { style: { color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'center', fontSize: '11px' } });
    const settings = ibtn('settings', 'Monitor settings', (e) => this.settingsMenu(e));
    const bar = h('div.mon-bar', this.tc, this.zoomSel, this.name, this.resSel, settings, this.dur);
    this.mini = h('div.mon-mini', h('div.track'), this.miniRange = h('div.range'), this.miniHead = h('div.head'));
    this.bindMini();
    const P = k === 'program';
    const run = (cmd) => () => commands.run(cmd);
    this.playBtn = ibtn('play', 'Play / Stop', () => (P ? app.player.toggle() : app.player.toggleSource()), { cmd: 'play.toggle' });
    this.playBtn.classList.add('play');
    const t = h('div.transport',
      ibtn('marker', 'Add Marker', () => { app.dock.focus(k); commands.run('marker.add'); }, { cmd: 'marker.add' }),
      ibtn('mark-in', 'Mark In', () => { app.dock.focus(k); commands.run('mark.in'); }, { cmd: 'mark.in' }),
      ibtn('mark-out', 'Mark Out', () => { app.dock.focus(k); commands.run('mark.out'); }, { cmd: 'mark.out' }),
      ibtn('to-in', 'Go to In', () => { app.dock.focus(k); commands.run('mark.gotoIn'); }, { cmd: 'mark.gotoIn' }),
      ibtn('step-back', 'Step Back 1 Frame', () => this.step(-1), { cmd: 'nav.stepBack' }),
      this.playBtn,
      ibtn('step-fwd', 'Step Forward 1 Frame', () => this.step(1), { cmd: 'nav.stepFwd' }),
      ibtn('to-out', 'Go to Out', () => { app.dock.focus(k); commands.run('mark.gotoOut'); }, { cmd: 'mark.gotoOut' }),
      this.loopBtn = ibtn('loop', 'Loop Playback', () => { const st = app.player.state[k]; st.loop = !st.loop; this.updateButtons(); }),
      h('div.tb-sep'),
      ...(P ? [
        ibtn('lift', 'Lift', run('edit.lift'), { cmd: 'edit.lift' }), ibtn('extract', 'Extract', run('edit.extract'), { cmd: 'edit.extract' }),
        ibtn('camera', 'Export Frame', run('file.exportFrame'), { cmd: 'file.exportFrame' }),
        this.cmpBtn = ibtn('compare', 'Comparison View', () => this.toggleCompare()),
        this.mcBtn = ibtn('multicam', 'Multi-Camera View', () => this.toggleMulticam(), { cmd: 'view.multicam' }),
        this.proxyBtn = ibtn('proxy', 'Toggle Proxies', () => import('../../actions/media.js').then((m) => { m.toggleProxies(); this.updateButtons(); })),
        ibtn('fullscreen', 'Full Screen Playback', () => this.fullscreen()),
      ] : [
        ibtn('insert', 'Insert', run('edit.insert'), { cmd: 'edit.insert' }), ibtn('overwrite', 'Overwrite', run('edit.overwrite'), { cmd: 'edit.overwrite' }),
        this.dragV = h('div.ibtn', { draggable: true, 'data-tip': 'Drag video only' }, icon('film', 16)), this.dragA = h('div.ibtn', { draggable: true, 'data-tip': 'Drag audio only' }, icon('audio', 16)),
        ibtn('camera', 'Export Frame', () => this.exportSourceFrame()),
      ]),
    );
    if (!P) {
      for (const [btn, opt] of [[this.dragV, { video: true, audio: false }], [this.dragA, { video: false, audio: true }]]) {
        btn.addEventListener('dragstart', (e) => { const it = app.player.sourceItem; if (!it) return e.preventDefault(); this.useVideo = opt.video; this.useAudio = opt.audio; e.dataTransfer.setData('application/x-cinergy-items', JSON.stringify([it.id])); e.dataTransfer.setData('application/x-cinergy-avonly', JSON.stringify(opt)); });
        btn.addEventListener('dragend', () => { this.useVideo = true; this.useAudio = true; });
      }
      this.view.draggable = true;
      this.view.addEventListener('dragstart', (e) => { const it = app.player.sourceItem; if (!it || e.target !== this.view && e.target !== this.handles) return; e.dataTransfer.setData('application/x-cinergy-items', JSON.stringify([it.id])); });
      this.view.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-cinergy-items') || e.dataTransfer.types.includes('Files')) e.preventDefault(); });
      this.view.addEventListener('drop', async (e) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData('application/x-cinergy-items');
        if (raw) { const id = JSON.parse(raw)[0]; app.ui.openInSource(id); return; }
        if (e.dataTransfer.files.length) { const { importPaths } = await import('../../actions/media.js'); const c = await importPaths([...e.dataTransfer.files].map((f) => window.native.pathForFile(f))); if (c[0]) app.ui.openInSource(c[0].id); }
      });
    }
    const root = h('div.monitor', this.view, bar, this.mini, t);
    this.el.appendChild(root);
    this.bindView();
    new ResizeObserver(() => this.layout()).observe(this.view);
    this.updateButtons();
  }

  get item() { return this.kind === 'source' ? app.player.sourceItem : null; }
  get seq() { return app.store.seq; }

  dims() {
    if (this.kind === 'program') { const s = this.seq; return s ? [s.settings.width * (s.settings.pixelAspect || 1), s.settings.height] : [1920, 1080]; }
    const it = this.item; if (!it) return [1920, 1080];
    if (it.type === 'sequence') return [it.settings.width, it.settings.height];
    if (it.info && it.info.width) return [it.info.width * (it.interpret && it.interpret.pixelAspect || it.info.pixelAspect || 1), it.info.height];
    return [it.width || 1920, it.height || 1080];
  }

  layout() {
    const r = this.view.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    const [w, hh] = this.dims();
    let dw, dh;
    if (this.zoom === 'fit') { const k = Math.min((r.width - 8) / w, (r.height - 8) / hh); dw = w * k; dh = hh * k; }
    else { dw = w * this.zoom / 100 / dpr; dh = hh * this.zoom / 100 / dpr; }
    this.pan = this.pan || [0, 0];
    const dx = (r.width - dw) / 2 + this.pan[0], dy = (r.height - dh) / 2 + this.pan[1];
    this.rect = { x: dx, y: dy, w: dw, h: dh };
    Object.assign(this.display.style, { left: dx + 'px', top: dy + 'px', width: dw + 'px', height: dh + 'px' });
    const pw = Math.max(2, Math.round(Math.min(dw, r.width) * dpr)), ph = Math.max(2, Math.round(Math.min(dh, r.height) * dpr));
    if (this.display.width !== Math.round(dw * dpr) || this.display.height !== Math.round(dh * dpr)) { this.display.width = Math.max(2, Math.round(dw * dpr)); this.display.height = Math.max(2, Math.round(dh * dpr)); }
    void pw; void ph;
    this.overlay.width = Math.round(r.width * dpr); this.overlay.height = Math.round(r.height * dpr);
    app.player.invalidate(this.kind);
    this.drawOverlay();
  }

  drawFrame(glCanvas, sx, sy, w, hh) {
    this.dctx.drawImage(glCanvas, sx, sy, w, hh, 0, 0, this.display.width, this.display.height);
    if (this.compare && this.refImage) this.drawCompare();
    this.drawOverlay();
  }

  update() {
    const k = this.kind;
    if (k === 'program') {
      const s = this.seq;
      if (document.activeElement !== this.tc) this.tc.value = s ? formatTime(s.playhead, s.settings.fps, app.prefs.get('general.timeDisplay') || 'tc', s.settings.startTC || 0) : '';
      if (s) {
        const d = seqDuration(s);
        this.dur.value = s.inPoint != null && s.outPoint != null ? framesToTC(s.outPoint - s.inPoint + 1, s.settings.fps) : framesToTC(d, s.settings.fps);
        this.name.textContent = s.name;
        const total = Math.max(1, d);
        this.miniHead.style.left = (s.playhead / total * 100) + '%';
        const a = s.inPoint != null ? s.inPoint : 0, b = s.outPoint != null ? s.outPoint : total;
        this.miniRange.style.display = s.inPoint != null || s.outPoint != null ? '' : 'none';
        this.miniRange.style.left = (a / total * 100) + '%'; this.miniRange.style.width = ((b - a) / total * 100) + '%';
      } else { this.name.textContent = 'No sequence'; this.dur.value = ''; }
    } else {
      const it = this.item;
      const fps = app.player.sourceFps();
      const t = app.player.sourceTime;
      if (document.activeElement !== this.tc) this.tc.value = it ? framesToTC(Math.round(t * fps), fps) : '';
      if (it) {
        const d = app.player.sourceDuration();
        this.name.textContent = it.name;
        this.dur.value = it.inPoint != null || it.outPoint != null ? framesToTC(Math.round(((it.outPoint != null ? it.outPoint : d) - (it.inPoint || 0)) * fps) + 1, fps) : framesToTC(Math.round(d * fps), fps);
        this.miniHead.style.left = (t / Math.max(0.001, d) * 100) + '%';
        const a = it.inPoint != null ? it.inPoint : 0, b = it.outPoint != null ? it.outPoint : d;
        this.miniRange.style.display = it.inPoint != null || it.outPoint != null ? '' : 'none';
        this.miniRange.style.left = (a / d * 100) + '%'; this.miniRange.style.width = ((b - a) / d * 100) + '%';
      } else { this.name.textContent = 'Drop a clip here or double-click one in the Project panel'; this.dur.value = ''; }
    }
  }

  updateButtons() {
    const st = app.player.state[this.kind];
    this.playBtn.innerHTML = ''; this.playBtn.appendChild(icon(st.playing ? 'stop' : 'play', 16));
    this.loopBtn.classList.toggle('on', !!st.loop);
    if (this.cmpBtn) this.cmpBtn.classList.toggle('on', this.compare);
    if (this.mcBtn) this.mcBtn.classList.toggle('on', this.multicam);
    if (this.proxyBtn) this.proxyBtn.classList.toggle('on', !!app.store.project.settings.useProxies);
  }

  step(n) { if (this.kind === 'program') app.player.step(n); else { app.player.stopSource(); app.player.seekSource(app.player.sourceTime + n / app.player.sourceFps()); } }

  jumpTo(text) {
    if (this.kind === 'program') { const s = this.seq; if (!s) return; let f = parseTimeInput(text, s.settings.fps, s.playhead + (s.settings.startTC || 0)); if (f != null) app.player.seek(f - (/^[+-]/.test(text) ? 0 : (s.settings.startTC || 0)) - (/^[+-]/.test(text) ? (s.settings.startTC || 0) : 0)); }
    else { const fps = app.player.sourceFps(); const f = parseTimeInput(text, fps, Math.round(app.player.sourceTime * fps)); if (f != null) app.player.seekSource(f / fps); }
  }

  bindMini() {
    const set = (e) => {
      const r = this.mini.getBoundingClientRect(); const u = clamp((e.clientX - r.left) / r.width, 0, 1);
      if (this.kind === 'program') { const s = this.seq; if (s) app.player.seek(Math.round(u * seqDuration(s)), { scrub: true }); }
      else app.player.seekSource(u * app.player.sourceDuration(), { scrub: true });
    };
    this.mini.addEventListener('mousedown', (e) => {
      set(e);
      const mv = (ev) => set(ev); const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  settingsMenu(e) {
    const r = e.target.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      { label: 'Safe Margins', checked: this.safe, action: () => { this.safe = !this.safe; this.drawOverlay(); } },
      { label: 'Rule of Thirds Guides', checked: this.grid, action: () => { this.grid = !this.grid; this.drawOverlay(); } },
      { label: 'Center Guides', checked: this.center, action: () => { this.center = !this.center; this.drawOverlay(); } },
      { label: 'Transparency Grid', checked: this.transparencyGrid, action: () => { this.transparencyGrid = !this.transparencyGrid; app.player.invalidate(this.kind); } },
      { label: 'Show Captions', checked: this.showCaptions, action: () => { this.showCaptions = !this.showCaptions; app.player.invalidate(); } },
      { label: 'Clip Name Overlay', checked: this.overlays === true, action: () => { this.overlays = this.overlays !== true; this.drawOverlay(); } },
      '-',
      { label: 'Playback Resolution', submenu: ['full', '1/2', '1/4', '1/8'].map((v) => ({ label: v === 'full' ? 'Full' : v, checked: app.prefs.get('playback.resolution') === v, action: () => { app.prefs.set('playback.resolution', v); this.resSel.value = v; } })) },
      { label: 'Paused Resolution', submenu: ['full', '1/2', '1/4'].map((v) => ({ label: v === 'full' ? 'Full' : v, checked: app.prefs.get('playback.pausedResolution') === v, action: () => { app.prefs.set('playback.pausedResolution', v); app.player.invalidate(); } })) },
      { label: 'High Quality Playback', checked: !!app.prefs.get('playback.highQuality'), action: () => { app.prefs.set('playback.highQuality', !app.prefs.get('playback.highQuality')); app.player.invalidate(); } },
      { label: 'Time Display', submenu: [['tc', 'Timecode'], ['frames', 'Frames'], ['seconds', 'Seconds'], ['feet', 'Feet + Frames (16mm)']].map(([k, l]) => ({ label: l, checked: (app.prefs.get('general.timeDisplay') || 'tc') === k, action: () => { app.prefs.set('general.timeDisplay', k); this.update(); app.timeline && app.timeline.updateTC(); } })) },
      '-',
      ...(this.kind === 'program' ? [
        { label: 'Multi-Camera View', checked: this.multicam, action: () => this.toggleMulticam() },
        { label: 'Comparison View', checked: this.compare, action: () => this.toggleCompare() },
        { label: 'Comparison: Side by Side', checked: this.cmpMode === 'side', action: () => { this.cmpMode = 'side'; app.player.invalidate(); } },
        { label: 'Comparison: Split', checked: this.cmpMode !== 'side', action: () => { this.cmpMode = 'split'; app.player.invalidate(); } },
        { label: 'Set Reference Frame to Playhead', action: () => this.setReference() },
        { label: 'VR Video: Flat View', checked: !!this.vrView, action: () => { this.vrView = !this.vrView; app.player.invalidate(); } },
        { label: 'Pop Out to External Display', action: () => this.popout() },
        { label: 'Full Screen', action: () => this.fullscreen() },
      ] : [
        { label: 'Open Clip in Finder', disabled: !this.item || this.item.type !== 'media', action: () => window.native.call('shell:reveal', this.item.path) },
        { label: 'Close Clip', action: () => { app.store.sourceItemId = null; app.store.emit('source'); } },
      ]),
    ]);
  }

  // ---------- overlays & direct manipulation ----------
  toView(nx, ny) { return [this.rect.x + nx * this.rect.w, this.rect.y + ny * this.rect.h]; }
  toNorm(vx, vy) { return [(vx - this.rect.x) / this.rect.w, (vy - this.rect.y) / this.rect.h]; }

  activeClip() {
    if (this.kind !== 'program') return null;
    const s = this.seq; if (!s) return null;
    const ids = [...app.store.selection.clips];
    for (const id of ids) { const f = findClip(s, id); if (f && f.kind === 'video' && s.playhead >= f.clip.start && s.playhead < f.clip.start + f.clip.dur) return f; }
    return null;
  }

  // layer quad corners (normalized seq coords) for a clip's motion
  clipQuad(seq, clip) {
    const item = app.store.project.items[clip.src.itemId];
    const local = seq.playhead - clip.start;
    const mo = clip.effects.find((e) => e.type === 'motion');
    const m = resolveParams(mo, local);
    let sw = seq.settings.width, sh = seq.settings.height;
    if (item && item.type === 'media' && item.info.width) { sw = item.info.width * (item.interpret.pixelAspect || item.info.pixelAspect || 1); sh = item.info.height; }
    else if (item && item.type === 'sequence') { sw = item.settings.width; sh = item.settings.height; }
    const base = clip.setToFrame ? Math.min(seq.settings.width / sw, seq.settings.height / sh) : 1;
    const sx = base * m.scale / 100 * (m.uniform ? 1 : m.scaleWidth / Math.max(0.0001, m.scale)), sy = base * m.scale / 100;
    const rot = m.rotation * Math.PI / 180;
    const corner = (u, v) => {
      const px = (u - m.anchor[0]) * sw * sx, py = (v - m.anchor[1]) * sh * sy;
      const rx = px * Math.cos(rot) - py * Math.sin(rot), ry = px * Math.sin(rot) + py * Math.cos(rot);
      return [m.position[0] + rx / seq.settings.width, m.position[1] + ry / seq.settings.height];
    };
    return { pts: [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)], m, sw, sh, sx, sy, mo, local };
  }

  drawOverlay() {
    const ctx = this.octx; if (!ctx || !this.rect) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const R = this.rect;
    if (this.safe) {
      ctx.strokeStyle = 'rgba(230,235,242,0.55)'; ctx.lineWidth = 1;
      ctx.strokeRect(R.x + R.w * 0.05 + 0.5, R.y + R.h * 0.05 + 0.5, R.w * 0.9, R.h * 0.9);
      ctx.strokeRect(R.x + R.w * 0.1 + 0.5, R.y + R.h * 0.1 + 0.5, R.w * 0.8, R.h * 0.8);
      ctx.beginPath(); ctx.moveTo(R.x + R.w / 2 - 10, R.y + R.h / 2); ctx.lineTo(R.x + R.w / 2 + 10, R.y + R.h / 2); ctx.moveTo(R.x + R.w / 2, R.y + R.h / 2 - 10); ctx.lineTo(R.x + R.w / 2, R.y + R.h / 2 + 10); ctx.stroke();
    }
    if (this.grid) { ctx.strokeStyle = 'rgba(230,235,242,0.3)'; ctx.beginPath(); for (const k of [1 / 3, 2 / 3]) { ctx.moveTo(R.x + R.w * k, R.y); ctx.lineTo(R.x + R.w * k, R.y + R.h); ctx.moveTo(R.x, R.y + R.h * k); ctx.lineTo(R.x + R.w, R.y + R.h * k); } ctx.stroke(); }
    if (this.center) { ctx.strokeStyle = 'rgba(92,155,255,0.6)'; ctx.beginPath(); ctx.moveTo(R.x + R.w / 2, R.y); ctx.lineTo(R.x + R.w / 2, R.y + R.h); ctx.moveTo(R.x, R.y + R.h / 2); ctx.lineTo(R.x + R.w, R.y + R.h / 2); ctx.stroke(); }
    this.handles.innerHTML = '';
    // info text
    if (this.kind === 'program' && this.overlays === true) {
      const s = this.seq;
      const c = s && [...s.tracks.video].reverse().map((t) => clipAt(t, s.playhead)).find(Boolean);
      this.info.textContent = c ? c.name : '';
    } else this.info.textContent = '';
    if (this.kind !== 'program' || app.player.state.program.playing) return;
    const f = this.activeClip();
    if (!f) return;
    const s = this.seq;
    // mask editing
    const ec = app.panels.effectControls;
    const selMask = ec && ec.selectedMask;
    if (selMask && selMask.clipId === f.clip.id) {
      const fx = f.clip.effects.find((e) => e.id === selMask.fxId); const mask = fx && fx.masks.find((m) => m.id === selMask.maskId);
      if (mask) return this.drawMaskEditor(f, fx, mask);
    }
    if (f.clip.src.type === 'graphic' && f.clip.graphic) return this.drawGraphicEditor(f);
    const q = this.clipQuad(s, f.clip);
    const vpts = q.pts.map(([x, y]) => this.toView(x, y));
    ctx.strokeStyle = '#5c9bff'; ctx.lineWidth = 1;
    ctx.beginPath(); vpts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
    const anchorV = this.toView(q.m.position[0], q.m.position[1]);
    ctx.beginPath(); ctx.arc(anchorV[0], anchorV[1], 5, 0, Math.PI * 2); ctx.moveTo(anchorV[0] - 8, anchorV[1]); ctx.lineTo(anchorV[0] + 8, anchorV[1]); ctx.moveTo(anchorV[0], anchorV[1] - 8); ctx.lineTo(anchorV[0], anchorV[1] + 8); ctx.stroke();
    const mids = [0, 1, 2, 3].map((i) => [(vpts[i][0] + vpts[(i + 1) % 4][0]) / 2, (vpts[i][1] + vpts[(i + 1) % 4][1]) / 2]);
    [...vpts, ...mids].forEach((p, i) => { const hd = h('div.handle', { style: { left: p[0] + 'px', top: p[1] + 'px', cursor: i < 4 ? 'nwse-resize' : 'ew-resize' } }); hd.addEventListener('mousedown', (e) => this.dragScale(e, f, q, i)); this.handles.appendChild(hd); });
    // effect point params (e.g. centers) for expanded effects
    for (const fx of f.clip.effects) {
      if (!ec || !ec.isExpanded(fx.id)) continue;
      const def = (app.effectDefs[fx.type] || {}).params || [];
      for (const p of def) if (p.type === 'point' && fx.type !== 'motion' && fx.type !== 'transform') {
        const v = resolveParams(fx, q.local)[p.name];
        // effect points live in layer space; map through the clip quad (bilinear)
        const lp = this.layerToSeq(q, v);
        const vp = this.toView(lp[0], lp[1]);
        const hd = h('div.handle.pt', { style: { left: vp[0] + 'px', top: vp[1] + 'px' }, title: p.label });
        hd.addEventListener('mousedown', (e) => this.dragEffectPoint(e, f, fx, p.name, q));
        this.handles.appendChild(hd);
      }
    }
  }

  layerToSeq(q, uv) {
    const [a, b, c, d] = q.pts;
    const [u, v] = uv;
    const top = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], bot = [d[0] + (c[0] - d[0]) * u, d[1] + (c[1] - d[1]) * u];
    return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
  }
  seqToLayer(q, p) {
    // inverse via affine approximation (quad is a parallelogram for affine motion)
    const [a, b, , d] = q.pts;
    const ex = [b[0] - a[0], b[1] - a[1]], ey = [d[0] - a[0], d[1] - a[1]];
    const det = ex[0] * ey[1] - ex[1] * ey[0] || 1e-9;
    const rx = p[0] - a[0], ry = p[1] - a[1];
    return [(rx * ey[1] - ry * ey[0]) / det, (ex[0] * ry - ex[1] * rx) / det];
  }

  bindView() {
    this.view.addEventListener('mousedown', (e) => {
      if (e.target.closest('.handle')) return;
      app.dock.focus(this.kind);
      if (this.kind !== 'program' || e.button !== 0) return;
      if (this.compare && this.cmpMode !== 'side') { this.dragSplit(e); return; }
      const s = this.seq; if (!s) return;
      const [nx, ny] = this.toNorm(e.offsetX + (e.target === this.view ? 0 : 0), e.offsetY);
      const r = this.view.getBoundingClientRect();
      const n = this.toNorm(e.clientX - r.left, e.clientY - r.top);
      void nx; void ny;
      // pick topmost clip under cursor
      let picked = null;
      for (const t of [...s.tracks.video].reverse()) {
        if (t.hidden) continue;
        const c = clipAt(t, s.playhead); if (!c || !c.enabled) continue;
        if (c.src.type === 'graphic') { picked = { clip: c, track: t }; break; }
        const q = this.clipQuad(s, c);
        if (pointInQuad(n, q.pts)) { picked = { clip: c, track: t }; break; }
      }
      if (!picked) { if (!e.shiftKey) app.store.selectClips([]); return; }
      if (!app.store.selection.clips.has(picked.clip.id)) app.store.selectClips([picked.clip.id]);
      if (picked.clip.src.type === 'graphic') { const g = this.pickGraphicLayer(picked, n); if (g) { this.selectedLayer = g.id; app.panels.properties && app.panels.properties.selectLayer(g.id); return this.dragGraphicLayer(e, findClip(s, picked.clip.id), g); } return; }
      this.dragPosition(e, findClip(s, picked.clip.id));
    });
    this.view.addEventListener('dblclick', (e) => {
      if (this.kind !== 'program') return;
      const f = this.activeClip();
      if (f && f.clip.src.type === 'graphic') { const r = this.view.getBoundingClientRect(); const n = this.toNorm(e.clientX - r.left, e.clientY - r.top); const l = this.pickGraphicLayer(f, n); if (l && l.type === 'text') this.editText(f, l); }
    });
    this.view.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) { // scrub with wheel
        e.preventDefault();
        if (this.kind === 'program') app.player.step(e.deltaY > 0 ? 1 : -1); else this.step(e.deltaY > 0 ? 1 : -1);
        return;
      }
      e.preventDefault();
      const cur = this.zoom === 'fit' ? Math.round(this.rect.w * (window.devicePixelRatio || 1) / this.dims()[0] * 100) : this.zoom;
      this.zoom = clamp(Math.round(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15)), 5, 800); this.layout();
    }, { passive: false });
    this.view.addEventListener('contextmenu', (e) => { e.preventDefault(); this.settingsMenu({ target: { getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY }) } }); });
  }

  motionTx(f, label, mutate) {
    const s = this.seq;
    const snap = JSON.stringify(f.clip.effects);
    return {
      move: () => { mutate(); app.player.invalidate('program'); this.drawOverlay(); },
      end: () => { const after = JSON.stringify(f.clip.effects); f.clip.effects = JSON.parse(snap); if (after !== snap) app.store.transact(label, () => { const g = findClip(s, f.clip.id); g.clip.effects = JSON.parse(after); }); },
    };
  }

  setParam(fx, name, value, local) {
    if (hasKeys(fx, name)) setKey(fx.keyframes[name], local, value, app.prefs.get('timeline.keyframeInterp') || 'linear');
    else fx.params[name] = value;
  }

  dragPosition(e, f) {
    const s = this.seq; const x0 = e.clientX, y0 = e.clientY;
    const mo = f.clip.effects.find((x) => x.type === 'motion');
    const local = s.playhead - f.clip.start;
    const p0 = resolveParams(mo, local).position;
    const snap = JSON.stringify(f.clip.effects);
    let moved = false;
    const mv = (ev) => {
      const dx = (ev.clientX - x0) / this.rect.w, dy = (ev.clientY - y0) / this.rect.h;
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 2) moved = true;
      let nx = p0[0] + dx, ny = p0[1] + dy;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) ny = p0[1]; else nx = p0[0]; }
      if (Math.abs(nx - 0.5) < 0.008) nx = 0.5; if (Math.abs(ny - 0.5) < 0.008) ny = 0.5;
      this.setParam(mo, 'position', [+nx.toFixed(5), +ny.toFixed(5)], local);
      app.player.invalidate('program'); this.drawOverlay();
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); const after = JSON.stringify(f.clip.effects); f.clip.effects = JSON.parse(snap); if (moved && after !== snap) app.store.transact('Position', () => { findClip(s, f.clip.id).clip.effects = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragScale(e, f, q, idx) {
    e.stopPropagation(); e.preventDefault();
    const s = this.seq; const mo = f.clip.effects.find((x) => x.type === 'motion');
    const local = q.local;
    const center = this.toView(q.m.position[0], q.m.position[1]);
    const d0 = Math.hypot(e.clientX - this.view.getBoundingClientRect().left - center[0], e.clientY - this.view.getBoundingClientRect().top - center[1]);
    const a0 = Math.atan2(e.clientY - this.view.getBoundingClientRect().top - center[1], e.clientX - this.view.getBoundingClientRect().left - center[0]);
    const s0 = q.m.scale, r0 = q.m.rotation, sw0 = q.m.scaleWidth;
    const snap = JSON.stringify(f.clip.effects);
    const rotate = e.altKey;
    const mv = (ev) => {
      const r = this.view.getBoundingClientRect();
      const x = ev.clientX - r.left - center[0], y = ev.clientY - r.top - center[1];
      if (rotate) { let ang = r0 + (Math.atan2(y, x) - a0) * 180 / Math.PI; if (ev.shiftKey) ang = Math.round(ang / 15) * 15; this.setParam(mo, 'rotation', +ang.toFixed(2), local); }
      else {
        const k = Math.hypot(x, y) / Math.max(1, d0);
        if (idx >= 4 && !mo.params.uniform) { if (idx % 2 === 1) this.setParam(mo, 'scaleWidth', +(sw0 * k).toFixed(2), local); else this.setParam(mo, 'scale', +(s0 * k).toFixed(2), local); }
        else this.setParam(mo, 'scale', +(s0 * k).toFixed(2), local);
      }
      app.player.invalidate('program'); this.drawOverlay();
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); const after = JSON.stringify(f.clip.effects); f.clip.effects = JSON.parse(snap); if (after !== snap) app.store.transact(rotate ? 'Rotation' : 'Scale', () => { findClip(s, f.clip.id).clip.effects = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragEffectPoint(e, f, fx, name, q) {
    e.stopPropagation(); e.preventDefault();
    const s = this.seq; const snap = JSON.stringify(f.clip.effects);
    const mv = (ev) => {
      const r = this.view.getBoundingClientRect();
      const n = this.toNorm(ev.clientX - r.left, ev.clientY - r.top);
      const lp = this.seqToLayer(q, n);
      const live = f.clip.effects.find((x) => x.id === fx.id);
      this.setParam(live, name, [+lp[0].toFixed(4), +lp[1].toFixed(4)], q.local);
      app.player.invalidate('program'); this.drawOverlay();
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); const after = JSON.stringify(f.clip.effects); f.clip.effects = JSON.parse(snap); if (after !== snap) app.store.transact('Effect Point', () => { findClip(s, f.clip.id).clip.effects = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  // masks
  drawMaskEditor(f, fx, mask) {
    const s = this.seq; const q = this.clipQuad(s, f.clip);
    const local = q.local;
    const m = maskAt(mask, local);
    const ctx = this.octx;
    const vp = m.points.map((p) => this.toView(...this.layerToSeq(q, p)));
    ctx.strokeStyle = '#f2b33d'; ctx.lineWidth = 1.5;
    // trace path in view space
    const viewMask = { ...m, points: vp.map(([x, y]) => [x, y]) };
    ctx.beginPath(); tracePath(ctx, viewMask, 1, 1); ctx.stroke();
    if (m.feather > 0) { ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(242,179,61,0.6)'; ctx.save(); const cx = vp.reduce((a, p) => a + p[0], 0) / vp.length, cy = vp.reduce((a, p) => a + p[1], 0) / vp.length; const k = 1 + m.feather / 300; ctx.beginPath(); tracePath(ctx, { ...viewMask, points: vp.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]) }, 1, 1); ctx.stroke(); ctx.restore(); ctx.setLineDash([]); }
    vp.forEach((p, i) => {
      const hd = h('div.handle', { style: { left: p[0] + 'px', top: p[1] + 'px', borderColor: '#f2b33d' } });
      hd.addEventListener('mousedown', (e) => this.dragMaskPoint(e, f, fx, mask, q, i));
      this.handles.appendChild(hd);
    });
    // drag whole mask by clicking inside
    const area = h('div', { style: { position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: 'move' } });
    area.addEventListener('mousedown', (e) => { const r = this.view.getBoundingClientRect(); const n = this.seqToLayer(q, this.toNorm(e.clientX - r.left, e.clientY - r.top)); if (mask.shape === 'path' && e.altKey) this.addMaskPoint(f, fx, mask, n, local); else this.dragMaskPoint(e, f, fx, mask, q, -1); });
    this.handles.prepend(area);
  }

  dragMaskPoint(e, f, fx, mask, q, idx) {
    e.stopPropagation(); e.preventDefault();
    const s = this.seq; const snap = JSON.stringify(f.clip.effects);
    const r0 = this.view.getBoundingClientRect();
    const start = this.seqToLayer(q, this.toNorm(e.clientX - r0.left, e.clientY - r0.top));
    const pts0 = maskAt(mask, q.local).points.map((p) => [...p]);
    const mv = (ev) => {
      const r = this.view.getBoundingClientRect();
      const n = this.seqToLayer(q, this.toNorm(ev.clientX - r.left, ev.clientY - r.top));
      const live = f.clip.effects.find((x) => x.id === fx.id).masks.find((x) => x.id === mask.id);
      let pts;
      if (idx < 0) pts = pts0.map(([x, y]) => [x + n[0] - start[0], y + n[1] - start[1]]);
      else if (live.shape === 'ellipse' || live.shape === 'rect') {
        // keep the box: move dragged corner, adjust neighbours
        pts = pts0.map((p) => [...p]); const opp = (idx + 2) % 4;
        pts[idx] = n;
        const a = pts0[opp];
        if (idx === 0 || idx === 2) { pts[1] = [n[0] === a[0] ? a[0] : (idx === 0 ? a[0] : n[0]), idx === 0 ? n[1] : a[1]]; pts[3] = [idx === 0 ? n[0] : a[0], idx === 0 ? a[1] : n[1]]; }
        else { pts[0] = [idx === 1 ? a[0] : n[0], idx === 1 ? n[1] : a[1]]; pts[2] = [idx === 1 ? n[0] : a[0], idx === 1 ? a[1] : n[1]]; }
      } else { pts = pts0.map((p) => [...p]); pts[idx] = n; }
      pts = pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
      if (live.keyframes.points && live.keyframes.points.length) setKey(live.keyframes.points, q.local, pts); else live.points = pts;
      app.player.invalidate('program'); this.drawOverlay();
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); const after = JSON.stringify(f.clip.effects); f.clip.effects = JSON.parse(snap); if (after !== snap) app.store.transact('Edit Mask', () => { findClip(s, f.clip.id).clip.effects = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  addMaskPoint(f, fx, mask, n, local) {
    app.store.transact('Add Mask Vertex', () => {
      const g = findClip(this.seq, f.clip.id); const m = g.clip.effects.find((x) => x.id === fx.id).masks.find((x) => x.id === mask.id);
      const pts = maskAt(m, local).points;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const d = Math.hypot((a[0] + b[0]) / 2 - n[0], (a[1] + b[1]) / 2 - n[1]); if (d < bd) { bd = d; bi = i; } }
      pts.splice(bi + 1, 0, n);
      if (m.keyframes.points && m.keyframes.points.length) setKey(m.keyframes.points, local, pts); else m.points = pts;
    });
  }

  // graphics
  pickGraphicLayer(f, n) {
    const s = this.seq; const g = f.clip.graphic; if (!g) return null;
    const c = document.createElement('canvas').getContext('2d');
    const local = s.playhead - f.clip.start;
    for (const l of g.layers) {
      if (l.visible === false) continue;
      const lp = layerProps(l, local);
      const b = layerBounds(c, lp, s.settings.width, s.settings.height, 1);
      if (Math.abs(n[0] - b.x) <= b.w / 2 + 0.01 && Math.abs(n[1] - b.y) <= b.h / 2 + 0.01) return l;
    }
    return null;
  }

  drawGraphicEditor(f) {
    const s = this.seq; const g = f.clip.graphic;
    const c = document.createElement('canvas').getContext('2d');
    const local = s.playhead - f.clip.start;
    const ctx = this.octx;
    for (const l of g.layers) {
      if (l.visible === false) continue;
      const lp = layerProps(l, local);
      const b = layerBounds(c, lp, s.settings.width, s.settings.height, 1);
      const [x, y] = this.toView(b.x - b.w / 2, b.y - b.h / 2);
      const w = b.w * this.rect.w, hh = b.h * this.rect.h;
      ctx.save(); ctx.translate(x + w / 2, y + hh / 2); ctx.rotate(b.rotation * Math.PI / 180);
      ctx.strokeStyle = l.id === this.selectedLayer ? '#5c9bff' : 'rgba(92,155,255,0.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(-w / 2, -hh / 2, w, hh);
      ctx.restore();
      if (l.id === this.selectedLayer) {
        for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + hh], [x, y + hh]]) {
          const hd = h('div.handle', { style: { left: cx + 'px', top: cy + 'px', cursor: 'nwse-resize' } });
          hd.addEventListener('mousedown', (e) => this.dragGraphicScale(e, f, l, [x + w / 2, y + hh / 2]));
          this.handles.appendChild(hd);
        }
      }
    }
  }

  graphicTx(f, label, fn) {
    const s = this.seq; const snap = JSON.stringify(f.clip.graphic);
    return { move: fn, end: () => { const after = JSON.stringify(f.clip.graphic); f.clip.graphic = JSON.parse(snap); if (after !== snap) app.store.transact(label, () => { findClip(s, f.clip.id).clip.graphic = JSON.parse(after); }); } };
  }

  setLayerProp(l, k, v, local) { if (l.keyframes && l.keyframes[k] && l.keyframes[k].length) setKey(l.keyframes[k], local, v); else l[k] = v; }

  dragGraphicLayer(e, f, layer) {
    const s = this.seq; const local = s.playhead - f.clip.start;
    const l = f.clip.graphic.layers.find((x) => x.id === layer.id);
    const p0 = layerProps(l, local); const x0 = e.clientX, y0 = e.clientY;
    const t = this.graphicTx(f, 'Move Layer', (ev) => {
      let nx = p0.x + (ev.clientX - x0) / this.rect.w, ny = p0.y + (ev.clientY - y0) / this.rect.h;
      if (Math.abs(nx - 0.5) < 0.006) nx = 0.5; if (Math.abs(ny - 0.5) < 0.006) ny = 0.5;
      this.setLayerProp(l, 'x', +nx.toFixed(4), local); this.setLayerProp(l, 'y', +ny.toFixed(4), local);
      app.player.invalidate('program'); this.drawOverlay();
    });
    const up = () => { document.removeEventListener('mousemove', t.move); document.removeEventListener('mouseup', up); t.end(); };
    document.addEventListener('mousemove', t.move); document.addEventListener('mouseup', up);
  }

  dragGraphicScale(e, f, layer, center) {
    e.stopPropagation(); e.preventDefault();
    const s = this.seq; const local = s.playhead - f.clip.start;
    const l = f.clip.graphic.layers.find((x) => x.id === layer.id);
    const r = this.view.getBoundingClientRect();
    const d0 = Math.hypot(e.clientX - r.left - center[0], e.clientY - r.top - center[1]);
    const s0 = layerProps(l, local).scale;
    const t = this.graphicTx(f, 'Scale Layer', (ev) => { const d = Math.hypot(ev.clientX - r.left - center[0], ev.clientY - r.top - center[1]); this.setLayerProp(l, 'scale', +(s0 * d / Math.max(1, d0)).toFixed(2), local); app.player.invalidate('program'); this.drawOverlay(); });
    const up = () => { document.removeEventListener('mousemove', t.move); document.removeEventListener('mouseup', up); t.end(); };
    document.addEventListener('mousemove', t.move); document.addEventListener('mouseup', up);
  }

  editText(f, layer) {
    const s = this.seq;
    const c = document.createElement('canvas').getContext('2d');
    const b = layerBounds(c, layer, s.settings.width, s.settings.height, 1);
    const [x, y] = this.toView(b.x - b.w / 2, b.y - b.h / 2);
    const ta = h('textarea', { style: { position: 'absolute', left: x + 'px', top: y + 'px', width: Math.max(160, b.w * this.rect.w) + 'px', height: Math.max(40, b.h * this.rect.h) + 'px', zIndex: 5, background: 'rgba(10,11,14,0.75)', color: '#fff', border: '1px solid #5c9bff', font: `${layer.weight} ${Math.max(12, layer.size * this.rect.h / s.settings.height)}px Inter`, textAlign: layer.align, resize: 'none', outline: 'none' } }, layer.text);
    this.view.appendChild(ta);
    ta.focus(); ta.select();
    const done = () => { const v = ta.value; ta.remove(); if (v !== layer.text) app.store.transact('Edit Text', () => { const g = findClip(s, f.clip.id); const l = g.clip.graphic.layers.find((x) => x.id === layer.id); l.text = v; if (l.name === layer.text || !l.name) l.name = v.slice(0, 30); }); };
    ta.addEventListener('blur', done);
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) ta.blur(); });
  }

  // ---------- comparison ----------
  async setReference(frame) {
    const s = this.seq; if (!s) return;
    const f = frame != null ? frame : s.playhead;
    const w = 960; const r = await app.player.renderExact(s, f, { scale: w / s.settings.width });
    const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(r.w, r.h);
    for (let y = 0; y < r.h; y++) img.data.set(r.bytes.subarray((r.h - 1 - y) * r.w * 4, (r.h - y) * r.w * 4), y * r.w * 4);
    ctx.putImageData(img, 0, 0);
    this.refImage = c; this.refFrame = f;
    app.player.invalidate('program');
  }
  toggleCompare() {
    this.compare = !this.compare;
    if (this.compare && !this.refImage) { const s = this.seq; const pts = s ? [...new Set(s.tracks.video.flatMap((t) => t.clips.map((c) => c.start)))].filter((x) => x < s.playhead).sort((a, b) => b - a) : []; this.setReference(pts[0] != null ? pts[0] + 1 : 0); }
    this.split = this.split || 0.5;
    this.updateButtons(); app.player.invalidate('program');
  }
  drawCompare() {
    const W = this.display.width, H = this.display.height;
    if (this.cmpMode === 'side') {
      const cur = document.createElement('canvas'); cur.width = W; cur.height = H; cur.getContext('2d').drawImage(this.display, 0, 0);
      this.dctx.fillStyle = '#000'; this.dctx.fillRect(0, 0, W, H);
      this.dctx.drawImage(this.refImage, 0, H / 4, W / 2, H / 2); this.dctx.drawImage(cur, W / 2, H / 4, W / 2, H / 2);
      this.dctx.fillStyle = '#e6ebf2'; this.dctx.font = `${Math.round(H / 30)}px Plex`; this.dctx.fillText('Reference', 10, H / 4 - 8); this.dctx.fillText('Current', W / 2 + 10, H / 4 - 8);
    } else {
      const sx = Math.round(W * this.split);
      this.dctx.drawImage(this.refImage, 0, 0, this.refImage.width * this.split, this.refImage.height, 0, 0, sx, H);
      this.dctx.fillStyle = '#5c9bff'; this.dctx.fillRect(sx - 1, 0, 2, H);
    }
  }
  dragSplit(e) {
    const mv = (ev) => { const r = this.display.getBoundingClientRect(); this.split = clamp((ev.clientX - r.left) / r.width, 0, 1); app.player.invalidate('program'); };
    mv(e);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  // ---------- multicam ----------
  multicamClip() {
    const s = this.seq; if (!s) return null;
    for (const t of [...s.tracks.video].reverse()) { const c = clipAt(t, s.playhead); if (c && c.src.type === 'sequence') { const n = app.store.project.items[c.src.itemId]; if (n && n.multicam) return { clip: c, track: t, nested: n }; } }
    return null;
  }
  toggleMulticam() {
    this.multicam = !this.multicam;
    if (this.mcGrid) { this.mcGrid.remove(); this.mcGrid = null; }
    if (this.multicam) {
      const mc = this.multicamClip();
      if (!mc) { toast('Place the playhead over a multicam clip to use the multi-camera view', 'warn'); this.multicam = false; this.updateButtons(); return; }
      const n = mc.nested.tracks.video.length;
      const cols = Math.ceil(Math.sqrt(n));
      this.mcGrid = h('div.mc-grid', { style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } });
      this.mcCells = mc.nested.tracks.video.map((t, i) => {
        const cv = h('canvas', { width: 320, height: 180 });
        const cell = h('div.mc-cell', cv, h('span.n', `${i + 1}  ${mc.nested.multicam.angles[i] ? mc.nested.multicam.angles[i].name : t.name}`));
        cell.addEventListener('click', () => { import('../../actions/editing.js').then((m) => m.multicamSwitch(i, app.player.state.program.playing)); });
        this.mcGrid.appendChild(cell);
        return { cv, cell };
      });
      this.view.appendChild(this.mcGrid);
    }
    this.updateButtons(); app.player.invalidate('program');
  }
  renderMulticam() {
    const mc = this.multicamClip(); if (!mc || !this.mcCells) return;
    const s = this.seq; const gl = app.gl;
    const nf = Math.round(clipSourceTime(mc.clip, s.playhead, s.settings.fps) * mc.nested.settings.fps);
    const scale = 320 / mc.nested.settings.width;
    this.mcCells.forEach((cell, i) => {
      const fbo = app.compositor.renderSequence(mc.nested, nf, { scale, playing: app.player.state.program.playing, rate: 1, angleOnly: i, ownerSuffix: ':mc' + i });
      const fin = app.compositor.finalize(fbo);
      app.player.ensureCanvas(fin.w, fin.h);
      app.compositor.present(fin, [0, 0, fin.w, fin.h]);
      const ctx = cell.cv.getContext('2d'); cell.cv.width = fin.w; cell.cv.height = fin.h;
      ctx.drawImage(app.gl.canvas, 0, app.gl.canvas.height - fin.h, fin.w, fin.h, 0, 0, fin.w, fin.h);
      gl.release(fbo); gl.release(fin);
      cell.cell.classList.toggle(app.player.state.program.playing ? 'live' : 'active', (mc.clip.angle || 0) === i);
      cell.cell.classList.toggle(app.player.state.program.playing ? 'active' : 'live', false);
    });
  }

  // ---------- full screen & pop-out ----------
  fullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    this.view.requestFullscreen().then(() => setTimeout(() => this.layout(), 100)).catch(() => {});
    const onChange = () => { this.layout(); if (!document.fullscreenElement) document.removeEventListener('fullscreenchange', onChange); };
    document.addEventListener('fullscreenchange', onChange);
  }
  async popout() {
    const displays = await window.native.call('app:displays');
    const ext = displays.find((d) => !d.primary) || displays[0];
    await window.native.call('window:popout', { kind: 'program', displayId: ext.id, fullscreen: !!displays.find((d) => !d.primary), title: 'CinergyPro Program' });
    if (!this.popFn) {
      let last = 0;
      this.popFn = (fin) => {
        const now = performance.now(); if (now - last < 30) return; last = now;
        const w = Math.min(fin.w, 1280), hh = Math.round(w * fin.h / fin.w);
        app.player.ensureCanvas(w, hh);
        app.compositor.present(fin, [0, 0, w, hh]);
        const c = document.createElement('canvas'); c.width = w; c.height = hh;
        c.getContext('2d').drawImage(app.gl.canvas, 0, app.gl.canvas.height - hh, w, hh, 0, 0, w, hh);
        c.toBlob((b) => { if (b) b.arrayBuffer().then((buf) => window.native.post({ type: 'frame', w, h: hh, data: buf })); }, 'image/jpeg', 0.85);
      };
      app.player.extra.add(this.popFn);
      window.native.on('window:popout-closed', () => { app.player.extra.delete(this.popFn); this.popFn = null; });
    }
  }

  async exportSourceFrame() {
    const it = this.item; if (!it) return;
    const fps = app.player.sourceFps();
    const path = await window.native.call('dialog:save', { title: 'Export Frame', defaultPath: `${app.info.desktop}/${it.name}_${Math.round(app.player.sourceTime * fps)}.png`, filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg'] }] });
    if (!path) return;
    const gl = app.gl;
    app.pool.beginFrame();
    let fbo = app.compositor.renderSource(it, app.player.sourceTime, { scale: 1 });
    await app.pool.waitAll(); gl.release(fbo); app.pool.beginFrame();
    fbo = app.compositor.renderSource(it, app.player.sourceTime, { scale: 1 });
    const fin = app.compositor.finalize(fbo);
    const bytes = app.compositor.toBytes(fin);
    await window.native.call('export:still', path, bytes.buffer, fin.w, fin.h, path.endsWith('jpg') ? 'jpg' : 'png');
    gl.release(fbo); gl.release(fin); gl.releaseAll();
    toast('Frame exported');
  }

  resize() { this.layout(); }
}

function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function createSourceMonitor(el) { return new Monitor(el, 'source'); }
export function createProgramMonitor(el) { return new Monitor(el, 'program'); }
