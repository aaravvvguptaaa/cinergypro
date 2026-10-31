// Timeline panel: canvas-drawn tracks, clips, transitions, keyframes; all editing tools.
const IS_MAC_UI = (window.native && window.native.platform === 'darwin');
import { app } from '../../app-context.js';
import { h, icon, clamp, LABEL_COLORS, uid, deepClone, dbToGain, gainToDb, fileUrl } from '../../core/util.js';
import { allTracks, findClip, linkedClips, seqDuration, clipAt, clipHandles, itemDuration, clipSourceTime, createClip, seqContains } from '../../core/project.js';
import * as E from '../../core/edit.js';
import * as A from '../../actions/editing.js';
import { framesToTC, parseTimeInput, formatTime } from '../../core/timecode.js';
import { contextMenu, ibtn, toast, promptDialog } from '../widgets.js';
import { evaluate, setKey } from '../../core/keyframes.js';
import { transitionDef, AUDIO_TRANSITIONS, defFor } from '../../core/effect-defs.js';
import { commands } from '../../core/commands.js';

const RULER_H = 30;
const CAPTION_H = 26;
const DIVIDER = 6;
const EDGE = 6;
export const TOOLS = [
  ['select', 'select', 'Selection Tool', 'V'], ['trackFwd', 'track-fwd', 'Track Select Forward Tool', 'A'], ['trackBack', 'track-back', 'Track Select Backward Tool', 'Shift+A'],
  ['ripple', 'ripple', 'Ripple Edit Tool', 'B'], ['roll', 'roll', 'Rolling Edit Tool', 'N'], ['rate', 'rate', 'Rate Stretch Tool', 'R'], ['razor', 'razor', 'Razor Tool', 'C'],
  ['slip', 'slip', 'Slip Tool', 'Y'], ['slide', 'slide', 'Slide Tool', 'U'], ['pen', 'pen', 'Pen Tool', 'P'], ['hand', 'hand', 'Hand Tool', 'H'], ['zoom', 'zoom', 'Zoom Tool', 'Z'], ['type', 'type', 'Type Tool', 'T'],
];

export class TimelinePanel {
  constructor(el) {
    this.el = el;
    this.tool = 'select';
    this.thumbs = new Map();
    this.drag = null;
    this.hover = null;
    this.dirty = true;
    this.snap = true;
    this.showKeyframes = { video: false, audio: true };
    app.timeline = this;
    this.openSeqs = [];
    this.build();
    app.store.on('change', () => { this.dirty = true; this.renderHeaders(); });
    app.store.on('sequence', () => { this.dirty = true; this.renderTabs(); this.renderHeaders(); this.updateTC(); });
    app.store.on('project', () => { this.openSeqs = []; this.dirty = true; this.renderTabs(); this.renderHeaders(); });
    app.store.on('selection', () => { this.dirty = true; });
    app.player.on('playhead', () => { this.dirty = true; this.updateTC(); this.autoscroll(); });
    app.audio.on('loaded', () => { this.dirty = true; });
    app.prefs.on('change', () => { this.dirty = true; });
    requestAnimationFrame(this.loop.bind(this));
  }

  get seq() { return app.store.seq; }

  build() {
    const el = this.el;
    this.tabs = h('div.tl-seqtabs');
    this.tc = h('input.tc', { spellcheck: false, value: '00:00:00:00' });
    this.tc.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const s = this.seq; const f = parseTimeInput(this.tc.value, s.settings.fps, s.playhead); if (f != null) app.player.seek(f - (s.settings.startTC || 0) * (/[:;]/.test(this.tc.value) ? 1 : 0)); this.tc.blur(); } if (e.key === 'Escape') this.tc.blur(); });
    this.tc.addEventListener('blur', () => this.updateTC());
    this.snapBtn = ibtn('magnet', 'Snap in Timeline', () => { app.prefs.set('timeline.snapping', !app.prefs.get('timeline.snapping')); this.updateToggles(); }, { cmd: 'timeline.snap' });
    this.linkBtn = ibtn('link', 'Linked Selection', () => { app.prefs.set('timeline.linkedSelection', !app.prefs.get('timeline.linkedSelection')); this.updateToggles(); }, { cmd: 'timeline.linkedSelection' });
    this.markerBtn = ibtn('marker', 'Add Marker', () => commands.run('marker.add'), { cmd: 'marker.add' });
    this.capBtn = ibtn('cc', 'Captions', () => import('../../actions/captions.js').then((m) => { m.addCaption(); app.dock.openPanel('text'); }));
    const wrench = ibtn('wrench', 'Timeline Display Settings', (e) => this.settingsMenu(e));
    this.zoomSlider = h('input', { type: 'range', min: 0, max: 1000, value: 500, style: { width: '110px' } });
    this.zoomSlider.addEventListener('input', () => { const s = this.seq; if (!s) return; this.setZoom(Math.pow(10, (this.zoomSlider.value / 1000) * 4.3 - 2.3), this.xOf(s.playhead)); });
    this.durLabel = h('span', { style: { color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: '11px', marginLeft: 'auto' } });
    const head = h('div.tl-head', this.tc, this.snapBtn, this.linkBtn, this.markerBtn, this.capBtn, wrench, h('div.tb-sep'), ibtn('chev-left', 'Previous Edit', () => commands.run('nav.prevEdit'), { cmd: 'nav.prevEdit' }), ibtn('chev-right', 'Next Edit', () => commands.run('nav.nextEdit'), { cmd: 'nav.nextEdit' }), this.durLabel, ibtn('minus', 'Zoom Out', () => this.zoomBy(1 / 1.5), { cmd: 'timeline.zoomOut' }), this.zoomSlider, ibtn('plus', 'Zoom In', () => this.zoomBy(1.5), { cmd: 'timeline.zoomIn' }));
    this.corner = h('div.tl-corner');
    this.headers = h('div.tl-headers');
    this.canvas = h('canvas');
    this.wrap = h('div.tl-canvas-wrap', this.canvas);
    this.body = h('div.tl-body', this.corner, this.headers, this.wrap);
    this.headers.style.gridRow = '2'; this.corner.style.gridRow = '1';
    this.hthumb = h('div.thumb');
    this.hscroll = h('div.tl-hscroll', this.hthumb);
    const root = h('div.timeline', this.tabs, head, this.body, this.hscroll);
    el.appendChild(root);
    this.ctx = this.canvas.getContext('2d');
    // a hidden or reparented canvas can lose its backing store; redraw once it comes back
    this.canvas.addEventListener('contextlost', () => { this.ctxLost = true; });
    this.canvas.addEventListener('contextrestored', () => { this.ctxLost = false; this.dirty = true; });
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bindCanvas();
    this.bindScroll();
    this.updateToggles();
    this.renderTabs();
    this.renderHeaders();
  }

  updateToggles() {
    this.snapBtn.classList.toggle('on', !!app.prefs.get('timeline.snapping'));
    this.linkBtn.classList.toggle('on', !!app.prefs.get('timeline.linkedSelection'));
  }

  setTool(t) { this.tool = t; this.canvas.style.cursor = this.toolCursor(); app.panels.tools && app.panels.tools.update(); }
  toolCursor() { return { razor: 'crosshair', hand: 'grab', zoom: 'zoom-in', type: 'text', pen: 'crosshair' }[this.tool] || 'default'; }

  // ---------- tabs ----------
  renderTabs() {
    const s = this.seq;
    if (s && !this.openSeqs.includes(s.id)) this.openSeqs.push(s.id);
    this.openSeqs = this.openSeqs.filter((id) => app.store.project.items[id]);
    this.tabs.innerHTML = '';
    for (const id of this.openSeqs) {
      const q = app.store.project.items[id];
      const t = h('div.tl-seqtab' + (id === app.store.activeSeqId ? '.active' : ''), q.multicam ? icon('multicam', 12) : icon('seq', 12), h('span', q.name), h('span', { style: { marginLeft: '4px', color: 'var(--dim)', cursor: 'pointer' }, title: 'Close sequence' }, '×'));
      t.addEventListener('click', (e) => {
        if (e.target.textContent === '×') { this.openSeqs = this.openSeqs.filter((x) => x !== id); if (id === app.store.activeSeqId) app.store.setActiveSequence(this.openSeqs[this.openSeqs.length - 1] || null); this.renderTabs(); return; }
        app.store.setActiveSequence(id);
      });
      t.addEventListener('dblclick', async () => { const n = await promptDialog('Rename Sequence', q.name); if (n) app.store.transact('Rename', () => { q.name = n; }, [q.id]); this.renderTabs(); });
      this.tabs.appendChild(t);
    }
    if (!this.openSeqs.length) this.tabs.appendChild(h('div', { style: { color: 'var(--dim)', padding: '0 12px', display: 'flex', alignItems: 'center' } }, 'No sequence open'));
  }

  // ---------- layout ----------
  rows() {
    const s = this.seq; if (!s) return [];
    const rows = [];
    let y = RULER_H - (s.view.scrollY || 0);
    for (const ct of s.captionTracks) { rows.push({ kind: 'caption', track: ct, y, h: CAPTION_H }); y += CAPTION_H; }
    for (let i = s.tracks.video.length - 1; i >= 0; i--) { const t = s.tracks.video[i]; const hh = t.collapsed ? 22 : t.height; rows.push({ kind: 'video', track: t, index: i, y, h: hh }); y += hh; }
    rows.push({ kind: 'divider', y, h: DIVIDER }); y += DIVIDER;
    for (let i = 0; i < s.tracks.audio.length; i++) { const t = s.tracks.audio[i]; const hh = t.collapsed ? 22 : t.height; rows.push({ kind: 'audio', track: t, index: i, y, h: hh }); y += hh; }
    this.contentH = y + (s.view.scrollY || 0) - RULER_H + 60;
    return rows;
  }

  xOf(f) { const s = this.seq; return (f - s.view.scrollX) * s.view.zoom; }
  fOf(x) { const s = this.seq; return x / s.view.zoom + s.view.scrollX; }

  setZoom(z, anchorX = 0) {
    const s = this.seq; if (!s) return;
    const f = this.fOf(anchorX);
    s.view.zoom = clamp(z, 0.005, 60);
    s.view.scrollX = Math.max(0, f - anchorX / s.view.zoom);
    this.zoomSlider.value = Math.round((Math.log10(s.view.zoom) + 2.3) / 4.3 * 1000);
    this.dirty = true;
  }
  zoomBy(k) { const s = this.seq; if (!s) return; this.setZoom(s.view.zoom * k, clamp(this.xOf(s.playhead), 0, this.canvas.clientWidth)); }
  zoomFit() { const s = this.seq; if (!s) return; const d = Math.max(seqDuration(s), s.settings.fps * 10); s.view.scrollX = 0; this.setZoom((this.canvas.clientWidth - 40) / d, 0); s.view.scrollX = 0; }

  autoscroll() {
    const s = this.seq; if (!s || this.drag) return;
    const w = this.canvas.clientWidth; const x = this.xOf(s.playhead);
    const mode = app.prefs.get('timeline.autoscroll') || 'page';
    if (mode === 'none') return;
    if (mode === 'smooth' && app.player.state.program.playing) { s.view.scrollX = Math.max(0, s.playhead - w / 2 / s.view.zoom); return; }
    if (x > w - 10) s.view.scrollX = s.playhead - 20 / s.view.zoom;
    else if (x < 0) s.view.scrollX = Math.max(0, s.playhead - (w * 0.1) / s.view.zoom);
  }

  updateTC() {
    const s = this.seq;
    if (document.activeElement === this.tc) return;
    this.tc.value = s ? formatTime(s.playhead, s.settings.fps, app.prefs.get('general.timeDisplay') || 'tc', s.settings.startTC || 0) : '00:00:00:00';
    if (s) this.durLabel.textContent = framesToTC(seqDuration(s), s.settings.fps);
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr); this.canvas.height = Math.max(1, r.height * dpr);
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    this.dirty = true;
    this.renderHeaders();
  }

  // ---------- headers ----------
  renderHeaders() {
    const s = this.seq;
    this.headers.innerHTML = '';
    this.corner.innerHTML = '';
    if (!s) return;
    this.corner.append(
      h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--dim)', fontSize: '10px' } }, `${s.settings.width}x${s.settings.height} ${s.settings.fps}`),
    );
    const rows = this.rows();
    for (const r of rows) {
      const top = r.y - RULER_H;
      if (r.kind === 'divider') { this.headers.appendChild(h('div.trk-divider', { style: { top: top + 'px' } })); continue; }
      if (r.kind === 'caption') {
        const ct = r.track;
        const row = h('div.trk-h', { style: { top: top + 'px', height: r.h + 'px', background: '#171c24' } },
          h('div.tbtn' + (ct.visible ? '.on' : ''), { title: 'Toggle caption visibility', on: { click: () => { app.store.transact('Caption Visibility', () => { ct.visible = !ct.visible; }); } } }, icon(ct.visible ? 'eye' : 'eye-off', 13)),
          h('div.tname', icon('cc', 12), ' ', ct.name));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ label: 'Rename', action: async () => { const n = await promptDialog('Rename Caption Track', ct.name); if (n) app.store.transact('Rename', () => { ct.name = n; }); } }, { label: 'Delete Caption Track', action: () => app.store.transact('Delete Caption Track', () => { s.captionTracks = s.captionTracks.filter((x) => x !== ct); }) }]); });
        this.headers.appendChild(row);
        continue;
      }
      const t = r.track; const isV = r.kind === 'video';
      const label = (isV ? 'V' : 'A') + (r.index + 1);
      const patch = h('div.patch' + (t.srcPatch ? '.on' : ''), { title: 'Source patching: edits from the Source Monitor go to this track' }, label);
      patch.addEventListener('click', () => { for (const x of s.tracks[r.kind]) x.srcPatch = x === t ? !t.srcPatch : false; app.store.markDirty(); this.renderHeaders(); });
      const tgt = h('div.target' + (t.target ? '.on' : ''), { title: 'Track targeting' }, label);
      tgt.addEventListener('click', (e) => { if (e.shiftKey) { const v = !t.target; for (const x of s.tracks[r.kind]) x.target = v; } else t.target = !t.target; app.store.markDirty(); this.renderHeaders(); });
      const sync = h('div.tbtn' + (t.syncLock ? '.on' : ''), { title: 'Sync lock' }, icon('sync', 12));
      sync.addEventListener('click', () => { t.syncLock = !t.syncLock; app.store.markDirty(); this.renderHeaders(); });
      const lock = h('div.tbtn.lock' + (t.locked ? '.on' : ''), { title: 'Lock track' }, icon(t.locked ? 'lock' : 'unlock', 12));
      lock.addEventListener('click', () => { app.store.transact('Lock Track', () => { t.locked = !t.locked; }); });
      const kids = [patch, lock, sync, tgt];
      if (isV) {
        const eye = h('div.tbtn' + (!t.hidden ? '.on' : ''), { title: 'Toggle track output' }, icon(t.hidden ? 'eye-off' : 'eye', 13));
        eye.addEventListener('click', () => app.store.transact('Track Output', () => { t.hidden = !t.hidden; }));
        kids.push(eye);
      } else {
        const m = h('div.tbtn.m' + (t.muted ? '.on' : ''), { title: 'Mute track' }, 'M');
        m.addEventListener('click', () => { app.store.transact('Mute', () => { t.muted = !t.muted; }); app.audio.liveUpdate(s); });
        const so = h('div.tbtn.s' + (t.solo ? '.on' : ''), { title: 'Solo track' }, 'S');
        so.addEventListener('click', (e) => { app.store.transact('Solo', () => { if (e.altKey || e.metaKey || e.ctrlKey) { const v = !t.solo; for (const x of s.tracks.audio) x.solo = false; t.solo = v; } else t.solo = !t.solo; }); app.audio.liveUpdate(s); });
        const rec = h('div.tbtn.r' + (t.audio.recordArm ? '.on' : ''), { title: 'Voice-over record arm' }, icon('mic', 12));
        rec.addEventListener('click', () => { for (const x of s.tracks.audio) x.audio.recordArm = x === t ? !t.audio.recordArm : false; app.store.markDirty(); this.renderHeaders(); });
        kids.push(m, so, rec);
      }
      kids.push(h('div.tname', { title: t.name }, t.name !== label ? t.name : ''));
      if (!isV && r.h >= 40) kids.push(h('span.vol', (t.audio.volume >= 0 ? '+' : '') + t.audio.volume.toFixed(1)));
      const row = h('div.trk-h' + (isV ? '' : '.audio') + (t.locked ? '.locked' : ''), { style: { top: top + 'px', height: r.h + 'px', borderLeft: t.color ? `3px solid ${t.color}` : null } }, ...kids);
      const rz = h('div.resize');
      rz.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const y0 = e.clientY, h0 = t.height;
        const mv = (ev) => { t.height = clamp(h0 + (ev.clientY - y0) * (isV ? 1 : 1), 24, 300); this.dirty = true; this.renderHeaders(); };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); app.store.markDirty(); };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
      row.appendChild(rz);
      row.addEventListener('dblclick', (e) => { if (e.target.closest('.tbtn, .patch, .target')) return; t.height = t.height > 60 ? (isV ? 52 : 48) : 110; this.dirty = true; this.renderHeaders(); });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.trackMenu(e, t, r); });
      this.headers.appendChild(row);
    }
  }

  trackMenu(e, t, r) {
    const s = this.seq;
    contextMenu(e.clientX, e.clientY, [
      { label: 'Rename', action: async () => { const n = await promptDialog('Rename Track', t.name); if (n) app.store.transact('Rename Track', () => { t.name = n; }); } },
      { label: 'Add Track', action: () => app.store.transact('Add Track', () => E.addTrack(s, t.kind, r.index + 1)) },
      { label: 'Add Tracks...', action: () => A.addTracksDialog() },
      { label: 'Delete Track', disabled: s.tracks[t.kind].length <= 1, action: () => app.store.transact('Delete Track', () => E.deleteTrack(s, t)) },
      { label: 'Delete Empty Tracks', action: () => A.deleteEmptyTracks() },
      '-',
      { label: 'Move Track Up', action: () => app.store.transact('Move Track', () => E.moveTrack(s, t, t.kind === 'video' ? 1 : -1)) },
      { label: 'Move Track Down', action: () => app.store.transact('Move Track', () => E.moveTrack(s, t, t.kind === 'video' ? -1 : 1)) },
      { label: t.collapsed ? 'Expand Track' : 'Minimize Track', action: () => { t.collapsed = !t.collapsed; this.dirty = true; this.renderHeaders(); } },
      { label: 'Track Color', submenu: [['None', null], ...Object.entries(LABEL_COLORS).filter(([k]) => k !== 'none').slice(0, 12)].map(([n, c]) => ({ label: n[0].toUpperCase() + n.slice(1), action: () => { t.color = c; app.store.markDirty(); this.renderHeaders(); } })) },
      ...(t.kind === 'audio' ? ['-', { label: 'Track Type', submenu: ['stereo', 'mono', '5.1'].map((k) => ({ label: k, checked: t.audio.channelType === k, action: () => app.store.transact('Track Type', () => { t.audio.channelType = k; }) })) },
        { label: 'Show Volume Keyframes', checked: this.showKeyframes.audio, action: () => { this.showKeyframes.audio = !this.showKeyframes.audio; this.dirty = true; } },
        { label: 'Track Keyframes (automation)', checked: !!this.trackKeys, action: () => { this.trackKeys = !this.trackKeys; this.dirty = true; } }] : [
        '-', { label: 'Show Opacity Keyframes', checked: this.showKeyframes.video, action: () => { this.showKeyframes.video = !this.showKeyframes.video; this.dirty = true; } }]),
    ]);
  }

  settingsMenu(e) {
    const p = (k) => app.prefs.get('timeline.' + k);
    const t = (k) => () => { app.prefs.set('timeline.' + k, !p(k)); this.dirty = true; };
    const r = e.target.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      { label: 'Show Video Thumbnails', checked: p('showThumbnails') !== 'none', action: () => { app.prefs.set('timeline.showThumbnails', p('showThumbnails') === 'none' ? 'heads' : 'none'); this.dirty = true; } },
      { label: 'Continuous Thumbnails', checked: p('showThumbnails') === 'continuous', action: () => { app.prefs.set('timeline.showThumbnails', p('showThumbnails') === 'continuous' ? 'heads' : 'continuous'); this.dirty = true; } },
      { label: 'Show Audio Waveforms', checked: p('showWaveforms'), action: t('showWaveforms') },
      { label: 'Rectified Waveforms', checked: p('rectifiedWaveforms'), action: t('rectifiedWaveforms') },
      { label: 'Show Clip Names', checked: p('showClipNames'), action: t('showClipNames') },
      { label: 'Show Through Edits', checked: p('showThroughEdits'), action: t('showThroughEdits') },
      { label: 'Show Duplicate Frame Markers', checked: p('showDuplicates'), action: t('showDuplicates') },
      { label: 'Show Video Keyframes', checked: this.showKeyframes.video, action: () => { this.showKeyframes.video = !this.showKeyframes.video; this.dirty = true; } },
      { label: 'Show Audio Keyframes', checked: this.showKeyframes.audio, action: () => { this.showKeyframes.audio = !this.showKeyframes.audio; this.dirty = true; } },
      '-',
      { label: 'Selection Follows Playhead', checked: p('selectionFollowsPlayhead'), action: t('selectionFollowsPlayhead') },
      { label: 'Snap Playhead in Timeline', checked: p('snapPlayhead'), action: t('snapPlayhead') },
      { label: 'Auto-scroll', submenu: [['page', 'Page Scroll'], ['smooth', 'Smooth Scroll'], ['none', 'No Scroll']].map(([k, l]) => ({ label: l, checked: p('autoscroll') === k, action: () => app.prefs.set('timeline.autoscroll', k) })) },
      '-',
      { label: 'Minimize All Tracks', action: () => { for (const tr of allTracks(this.seq)) tr.height = 26; this.dirty = true; this.renderHeaders(); } },
      { label: 'Expand All Tracks', action: () => { for (const tr of allTracks(this.seq)) tr.height = 80; this.dirty = true; this.renderHeaders(); } },
    ]);
  }

  // ---------- thumbnails ----------
  thumbsFor(item) {
    if (!item || item.type !== 'media' || !item.info.hasVideo) return null;
    let e = this.thumbs.get(item.id);
    if (e) return e;
    e = { img: null, count: 0, loading: true };
    this.thumbs.set(item.id, e);
    if (item.info.kind === 'image' || item.info.kind === 'psd') {
      const img = new Image(); img.onload = () => { e.img = img; e.count = 1; e.single = true; this.dirty = true; }; img.src = fileUrl(item.psdComposite || item.path);
      return e;
    }
    window.native.call('media:thumbs', item.playback || item.path, { count: 80, height: 54 }).then((r) => {
      if (!r) return;
      const img = new Image(); img.onload = () => { e.img = img; e.count = r.count; e.loading = false; this.dirty = true; }; img.src = fileUrl(r.path);
    }).catch(() => {});
    return e;
  }

  // ---------- drawing ----------
  loop() {
    requestAnimationFrame(this.loop.bind(this));
    if (!this.dirty || this.ctxLost || !this.el.isConnected || !this.el.offsetParent) return;
    this.dirty = false;
    try { this.draw(); } catch (e) { console.error('timeline draw', e); }
  }

  draw() {
    const ctx = this.ctx; const s = this.seq;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, W, H);
    if (!s) { ctx.fillStyle = '#5d6573'; ctx.font = '13px Plex'; ctx.textAlign = 'center'; ctx.fillText('Drop media here to create a sequence', W / 2, H / 2); return; }
    const rows = this.rows();
    this.headers.style.transform = '';
    const fps = s.settings.fps;
    const f0 = Math.floor(this.fOf(0)), f1 = Math.ceil(this.fOf(W));
    // In/out shading
    if (s.inPoint != null || s.outPoint != null) {
      const a = this.xOf(s.inPoint != null ? s.inPoint : 0), b = this.xOf(s.outPoint != null ? s.outPoint + 1 : seqDuration(s));
      ctx.fillStyle = 'rgba(47,124,255,0.07)'; ctx.fillRect(a, RULER_H, b - a, H);
    }
    // tracks
    for (const r of rows) {
      if (r.y > H || r.y + r.h < RULER_H) continue;
      if (r.kind === 'divider') { ctx.fillStyle = '#0a0b0e'; ctx.fillRect(0, r.y, W, r.h); continue; }
      ctx.fillStyle = r.kind === 'audio' ? '#13161b' : r.kind === 'caption' ? '#151a22' : '#15181d';
      ctx.fillRect(0, r.y, W, r.h - 1);
      ctx.fillStyle = '#1b1f26'; ctx.fillRect(0, r.y + r.h - 1, W, 1);
      if (r.track.locked) { ctx.fillStyle = 'rgba(255,255,255,0.02)'; for (let x = -r.h; x < W; x += 12) { ctx.beginPath(); ctx.moveTo(x, r.y + r.h); ctx.lineTo(x + r.h, r.y); ctx.lineTo(x + r.h + 5, r.y); ctx.lineTo(x + 5, r.y + r.h); ctx.fill(); } }
      if (r.kind === 'caption') { this.drawCaptions(ctx, r, f0, f1); continue; }
      for (const c of r.track.clips) {
        if (c.start + c.dur < f0 || c.start > f1) continue;
        this.drawClip(ctx, c, r, W);
      }
      for (const tr of r.track.transitions) {
        if (tr.start + tr.dur < f0 || tr.start > f1) continue;
        this.drawTransition(ctx, tr, r);
      }
      if (this.trackKeys && r.kind === 'audio') this.drawTrackAutomation(ctx, r, W);
    }
    // drop / drag ghosts
    if (this.ghost) for (const g of this.ghost) {
      ctx.strokeStyle = g.invalid ? '#f0505a' : '#e6ebf2'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(this.xOf(g.start) + 0.5, g.y + 2.5, g.dur * s.view.zoom, g.h - 5); ctx.setLineDash([]);
      if (g.insert) { ctx.fillStyle = '#f2b33d'; ctx.fillRect(this.xOf(g.start) - 1, RULER_H, 2, H); }
    }
    if (this.marquee) { const m = this.marquee; ctx.fillStyle = 'rgba(47,124,255,0.12)'; ctx.strokeStyle = '#5c9bff'; ctx.lineWidth = 1; ctx.fillRect(m.x, m.y, m.w, m.h); ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.w, m.h); }
    // ruler
    this.drawRuler(ctx, W, fps);
    // snap indicator
    if (this.snapLine != null) { ctx.fillStyle = '#f2b33d'; ctx.fillRect(Math.round(this.xOf(this.snapLine)) - 0.5, RULER_H, 1, H); }
    // razor hover line
    if (this.tool === 'razor' && this.hover && this.hover.frame != null) { ctx.fillStyle = '#e6ebf2'; const x = Math.round(this.xOf(this.hover.frame)) + 0.5; ctx.fillRect(x - 0.5, this.hover.allTracks ? RULER_H : this.hover.row ? this.hover.row.y : RULER_H, 1, this.hover.allTracks ? H : (this.hover.row ? this.hover.row.h : H)); }
    // playhead
    const px = Math.round(this.xOf(s.playhead)) + 0.5;
    if (px >= -10 && px <= W + 10) {
      ctx.fillStyle = '#5c9bff'; ctx.fillRect(px - 0.5, RULER_H, 1, H);
      ctx.beginPath(); ctx.moveTo(px - 6, RULER_H - 12); ctx.lineTo(px + 6, RULER_H - 12); ctx.lineTo(px + 6, RULER_H - 6); ctx.lineTo(px, RULER_H); ctx.lineTo(px - 6, RULER_H - 6); ctx.closePath(); ctx.fill();
    }
    // scrollbar
    const total = Math.max(seqDuration(s) + fps * 30, this.fOf(W));
    const vis = W / s.view.zoom;
    this.hthumb.style.left = (s.view.scrollX / total * 100) + '%';
    this.hthumb.style.width = Math.max(2, vis / total * 100) + '%';
    // sync header scroll
    this.headers.scrollTop = 0;
  }

  drawRuler(ctx, W, fps) {
    const s = this.seq;
    ctx.fillStyle = '#14171c'; ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillStyle = '#20242b'; ctx.fillRect(0, RULER_H - 1, W, 1);
    // render bar
    const rr = s.renderedRanges || [];
    const end = seqDuration(s);
    ctx.fillStyle = '#5a4a1c'; ctx.fillRect(this.xOf(0), RULER_H - 4, end * s.view.zoom, 3);
    const hash = app.exporter ? app.exporter.seqVideoHash(s) : null;
    for (const r of rr) { ctx.fillStyle = r.hash === hash ? '#2fae62' : '#7a2027'; ctx.fillRect(this.xOf(r.a), RULER_H - 4, (r.b - r.a) * s.view.zoom, 3); }
    // ticks
    const steps = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), Math.round(fps) * 2, Math.round(fps) * 5, Math.round(fps) * 10, Math.round(fps) * 30, Math.round(fps) * 60, Math.round(fps) * 300, Math.round(fps) * 600, Math.round(fps) * 1800, Math.round(fps) * 3600];
    let step = steps.find((st) => st * s.view.zoom >= 90) || steps[steps.length - 1];
    const minor = steps.find((st) => st * s.view.zoom >= 9) || step;
    const a = Math.floor(this.fOf(0) / minor) * minor, b = this.fOf(W);
    ctx.font = '10px PlexMono'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let f = Math.max(0, a); f <= b; f += minor) {
      const x = Math.round(this.xOf(f)) + 0.5;
      const major = f % step === 0;
      ctx.fillStyle = major ? '#5d6573' : '#353b45';
      ctx.fillRect(x, major ? 14 : 20, 1, major ? 12 : 6);
      if (major) { ctx.fillStyle = '#8a93a2'; ctx.fillText(framesToTC(f + (s.settings.startTC || 0), fps), x + 3, 3); }
    }
    // in/out brackets
    const io = (f, isIn) => { const x = this.xOf(isIn ? f : f + 1); ctx.fillStyle = '#5c9bff'; ctx.fillRect(x - (isIn ? 0 : 2), RULER_H - 14, 2, 14); ctx.fillRect(isIn ? x : x - 8, RULER_H - 14, 8, 2); };
    if (s.inPoint != null) io(s.inPoint, true);
    if (s.outPoint != null) io(s.outPoint, false);
    if (s.inPoint != null || s.outPoint != null) { ctx.fillStyle = 'rgba(92,155,255,0.25)'; const ax = this.xOf(s.inPoint != null ? s.inPoint : 0), bx = this.xOf(s.outPoint != null ? s.outPoint + 1 : end); ctx.fillRect(ax, RULER_H - 9, bx - ax, 5); }
    // markers
    for (const m of s.markers) {
      const x = this.xOf(m.frame);
      if (x < -20 || x > W + 20) continue;
      ctx.fillStyle = LABEL_COLORS[m.color] || '#3fcf7f';
      if (m.dur) { ctx.globalAlpha = 0.35; ctx.fillRect(x, 16, m.dur * s.view.zoom, 8); ctx.globalAlpha = 1; }
      ctx.beginPath(); ctx.moveTo(x - 5, 14); ctx.lineTo(x + 5, 14); ctx.lineTo(x + 5, 22); ctx.lineTo(x, 27); ctx.lineTo(x - 5, 22); ctx.closePath(); ctx.fill();
      if (m.type === 'chapter') { ctx.fillStyle = '#0a0b0e'; ctx.fillRect(x - 2, 17, 4, 4); }
    }
  }

  drawClip(ctx, c, r, W) {
    const s = this.seq;
    const x = this.xOf(c.start), w = Math.max(1, c.dur * s.view.zoom);
    const y = r.y + 1, hh = r.h - 3;
    const sel = app.store.selection.clips.has(c.id);
    const item = app.store.project.items[c.src.itemId];
    const offline = item && item.offline;
    const base = offline ? '#7a2027' : LABEL_COLORS[c.label || (item && item.label) || (r.kind === 'audio' ? 'forest' : 'iris')] || '#5b7cfa';
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x + 0.5, y, Math.max(1, w - 1), hh, 3); ctx.clip();
    ctx.fillStyle = shade(base, r.kind === 'audio' ? -0.45 : -0.35);
    ctx.fillRect(x, y, w, hh);
    const isV = r.kind === 'video';
    // header strip
    ctx.fillStyle = shade(base, -0.05);
    const headH = Math.min(16, hh);
    ctx.fillRect(x, y, w, headH);
    // thumbnails
    const thumbMode = app.prefs.get('timeline.showThumbnails') || 'heads';
    if (isV && hh > 26 && thumbMode !== 'none' && item && item.type === 'media') {
      const t = this.thumbsFor(item);
      if (t && t.img) {
        const th = hh - headH; const tw = th * (item.info.width || 16) / (item.info.height || 9);
        const drawAt = (dx, srcT) => {
          if (t.single) { ctx.drawImage(t.img, dx, y + headH, tw, th); return; }
          const idx = clamp(Math.floor(srcT / Math.max(0.01, item.info.duration) * t.count), 0, t.count - 1);
          const sw = t.img.width / t.count;
          ctx.drawImage(t.img, idx * sw, 0, sw, t.img.height, dx, y + headH, tw, th);
        };
        if (thumbMode === 'continuous') { for (let dx = Math.max(x, -tw); dx < Math.min(x + w, W); dx += tw) drawAt(dx, clipSourceTime(c, c.start + (dx - x) / s.view.zoom, s.settings.fps)); }
        else { drawAt(x, clipSourceTime(c, c.start, s.settings.fps)); if (w > tw * 2.5) drawAt(x + w - tw, clipSourceTime(c, c.start + c.dur - 1, s.settings.fps)); }
      }
    }
    if (!isV && hh > 18 && app.prefs.get('timeline.showWaveforms') !== false && item) this.drawWave(ctx, c, item, x, y + headH * 0.6, w, hh - headH * 0.6, base, W);
    // name & badges
    if (app.prefs.get('timeline.showClipNames') !== false && w > 24) {
      ctx.fillStyle = sel ? '#ffffff' : '#0b0d12'; ctx.font = '500 10.5px Plex'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      let label = c.name;
      if (c.speed !== 1 || c.reverse) label += ` [${c.reverse ? '-' : ''}${Math.round(c.speed * 100)}%]`;
      if (c.frameHold != null) label += ' [Hold]';
      if (c.src.type === 'sequence' && item && item.multicam) label = `[MC${(c.angle || 0) + 1}] ` + label;
      let tx = Math.max(x + 4, 4);
      const fx = c.effects.filter((e) => !defFor(e.type) || !defFor(e.type).intrinsic).length;
      if (fx) { ctx.fillStyle = sel ? '#fff' : '#1a1405'; ctx.font = 'italic 700 9px Plex'; ctx.fillText('fx', tx, y + headH / 2 + 0.5); tx += 13; ctx.font = '500 10.5px Plex'; ctx.fillStyle = sel ? '#ffffff' : '#0b0d12'; }
      ctx.fillText(label, tx, y + headH / 2 + 0.5, Math.max(0, x + w - tx - 4));
    }
    if (c.stabilized && c.stabilized.analyzing) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y + headH, w, hh - headH); ctx.fillStyle = '#e6ebf2'; ctx.font = '10px Plex'; ctx.fillText('Analyzing...', x + 6, y + headH + 10); }
    if (!c.enabled) { ctx.fillStyle = 'rgba(10,11,14,0.6)'; ctx.fillRect(x, y, w, hh); }
    // keyframes rubber band
    if ((isV && this.showKeyframes.video) || (!isV && this.showKeyframes.audio && hh >= 30)) this.drawRubber(ctx, c, isV ? 'opacity' : 'volume', isV ? 'opacity' : 'level', x, y + headH, w, hh - headH);
    // markers on clip
    for (const m of c.markers || []) { const mx = x + m.frame * s.view.zoom; ctx.fillStyle = LABEL_COLORS[m.color] || '#e8689a'; ctx.fillRect(mx - 1, y + headH, 2, hh - headH); }
    ctx.restore();
    // link/through-edit indicators
    if (app.prefs.get('timeline.showThroughEdits') !== false) {
      const prev = r.track.clips.find((p) => p.start + p.dur === c.start && p.src.itemId === c.src.itemId && Math.abs(p.srcIn + p.dur / s.settings.fps * p.speed - c.srcIn) < 0.5 / s.settings.fps && p.speed === c.speed);
      if (prev) { ctx.fillStyle = '#e6ebf2'; ctx.beginPath(); ctx.moveTo(x - 4, y + hh / 2); ctx.lineTo(x, y + hh / 2 - 4); ctx.lineTo(x + 4, y + hh / 2); ctx.lineTo(x, y + hh / 2 + 4); ctx.fill(); }
    }
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.roundRect(x + (sel ? 1 : 0.5), y + (sel ? 0.5 : 0), Math.max(1, w - (sel ? 2 : 1)), hh - (sel ? 1 : 0), 3); ctx.stroke();
    // hovered trim edge highlight
    if (this.hover && this.hover.clip === c && this.hover.edge) {
      ctx.fillStyle = this.tool === 'ripple' ? '#f2b33d' : this.tool === 'roll' ? '#f0505a' : '#5c9bff';
      const ex = this.hover.edge === 'in' ? x : x + w - 3;
      ctx.fillRect(ex, y, 3, hh);
    }
  }

  drawWave(ctx, c, item, x, y, w, hh, base, W) {
    const s = this.seq;
    let peaks = null;
    if (item.type === 'media') peaks = app.audio.peaksFor(item, c.src.stream || 0);
    if (!peaks) return;
    const vol = c.effects.find((e) => e.type === 'volume');
    const rect = app.prefs.get('timeline.rectifiedWaveforms') !== false;
    ctx.fillStyle = shade(base, 0.35);
    const a = Math.max(x, 0), b = Math.min(x + w, W);
    const mid = rect ? y + hh - 1 : y + hh / 2;
    const fps = s.settings.fps;
    const fbase = c.start;
    ctx.beginPath();
    for (let px = a; px < b; px += 1) {
      const f = fbase + (px - x) / s.view.zoom;
      const t = clipSourceTime(c, Math.floor(f), fps) + (f % 1) / fps * c.speed;
      const t2 = t + Math.max(1 / s.view.zoom, 0.1) / fps * c.speed;
      const i0 = Math.floor(t * peaks.rate), i1 = Math.max(i0 + 1, Math.floor(t2 * peaks.rate));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1 && i * 2 + 1 < peaks.data.length; i++) { if (i < 0) continue; mn = Math.min(mn, peaks.data[i * 2]); mx = Math.max(mx, peaks.data[i * 2 + 1]); }
      const g = dbToGain((vol ? evaluate((vol.keyframes.level || []), f - c.start, vol.params.level) : 0) + (c.gain || 0));
      if (rect) { const v = Math.min(1, Math.max(-mn, mx) * g); ctx.rect(px, mid - v * (hh - 2), 1, v * (hh - 2)); }
      else { ctx.rect(px, mid - Math.min(1, mx * g) * hh / 2, 1, Math.max(1, (Math.min(1, mx * g) - Math.max(-1, mn * g)) * hh / 2)); }
    }
    ctx.fill();
  }

  drawRubber(ctx, c, fxType, param, x, y, w, hh) {
    const s = this.seq;
    const fx = c.effects.find((e) => e.type === fxType); if (!fx) return;
    const keys = fx.keyframes[param] || [];
    const map = fxType === 'volume' ? (v) => { const g = dbToGain(v); return 1 - Math.min(1, Math.pow(g / 2, 0.35)); } : (v) => 1 - v / 100;
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1.2; ctx.beginPath();
    const n = Math.max(2, Math.min(400, Math.round(w / 3)));
    for (let i = 0; i <= n; i++) {
      const lf = (i / n) * c.dur;
      const v = keys.length ? evaluate(keys, lf, fx.params[param]) : fx.params[param];
      const py = y + 2 + map(v) * (hh - 4);
      const px = x + lf * s.view.zoom;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = '#ffd36b';
    for (const k of keys) { const px = x + k.t * s.view.zoom, py = y + 2 + map(k.v) * (hh - 4); ctx.beginPath(); ctx.moveTo(px, py - 4); ctx.lineTo(px + 4, py); ctx.lineTo(px, py + 4); ctx.lineTo(px - 4, py); ctx.fill(); }
  }

  drawTrackAutomation(ctx, r, W) {
    const s = this.seq; const t = r.track;
    const keys = t.audio.keyframes.volume || [];
    const map = (v) => 1 - Math.min(1, Math.pow(dbToGain(v) / 2, 0.35));
    ctx.strokeStyle = '#ff8a5c'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let px = 0; px <= W; px += 3) { const f = this.fOf(px); const v = keys.length ? evaluate(keys, f, t.audio.volume) : t.audio.volume; const py = r.y + 2 + map(v) * (r.h - 6); if (px) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.stroke();
    ctx.fillStyle = '#ff8a5c';
    for (const k of keys) { const px = this.xOf(k.t), py = r.y + 2 + map(k.v) * (r.h - 6); ctx.fillRect(px - 3, py - 3, 6, 6); }
  }

  drawTransition(ctx, tr, r) {
    const s = this.seq;
    const x = this.xOf(tr.start), w = tr.dur * s.view.zoom;
    const y = r.y + 1, hh = Math.min(r.h - 3, 22);
    const sel = app.store.selection.transition && app.store.selection.transition.id === tr.id;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, sel ? '#7aa8ff' : '#c9cfd9'); grad.addColorStop(1, sel ? '#2f7cff' : '#7d8593');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(x, y, w, hh, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + hh); ctx.lineTo(x + w, y); ctx.stroke();
    if (w > 40) { ctx.fillStyle = '#0b0d12'; ctx.font = '500 9.5px Plex'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText((transitionDef(tr.type) || {}).name || tr.type, x + w / 2, y + hh / 2, w - 6); }
  }

  drawCaptions(ctx, r, f0, f1) {
    const s = this.seq;
    for (const c of r.track.captions) {
      if (c.end < f0 || c.start > f1) continue;
      const x = this.xOf(c.start), w = (c.end - c.start) * s.view.zoom;
      const sel = app.store.selection.captions.has(c.id);
      ctx.fillStyle = sel ? '#3a6fd8' : '#2d3a52'; ctx.beginPath(); ctx.roundRect(x + 0.5, r.y + 2, Math.max(1, w - 1), r.h - 5, 3); ctx.fill();
      ctx.fillStyle = '#dfe6f1'; ctx.font = '10.5px Plex'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(c.text.replace(/\n/g, ' '), x + 5, r.y + r.h / 2, Math.max(0, w - 8));
    }
  }

  // ---------- hit testing ----------
  hit(x, y) {
    const s = this.seq; if (!s) return null;
    if (y < RULER_H) {
      for (const m of s.markers) if (Math.abs(this.xOf(m.frame) - x) < 6 && y > 12) return { area: 'marker', marker: m };
      if (s.inPoint != null && Math.abs(this.xOf(s.inPoint) - x) < 5 && y > RULER_H - 14) return { area: 'in' };
      if (s.outPoint != null && Math.abs(this.xOf(s.outPoint + 1) - x) < 5 && y > RULER_H - 14) return { area: 'out' };
      return { area: 'ruler' };
    }
    const row = this.rows().find((r) => y >= r.y && y < r.y + r.h);
    const frame = this.fOf(x);
    if (!row || row.kind === 'divider') return { area: 'empty', frame };
    if (row.kind === 'caption') {
      const c = row.track.captions.find((k) => frame >= k.start && frame < k.end);
      if (c) { const ex = this.xOf(c.start), ee = this.xOf(c.end); return { area: 'caption', row, cap: c, edge: x - ex < EDGE ? 'in' : ee - x < EDGE ? 'out' : null, frame }; }
      return { area: 'captionTrack', row, frame };
    }
    const t = row.track;
    // transitions (top portion)
    for (const tr of t.transitions) {
      const tx0 = this.xOf(tr.start), tx1 = this.xOf(tr.start + tr.dur);
      if (x >= tx0 - 3 && x <= tx1 + 3 && y < row.y + Math.min(row.h, 24)) return { area: 'transition', row, tr, edge: x - tx0 < 5 ? 'in' : tx1 - x < 5 ? 'out' : null, frame };
    }
    // clip edges near edit points
    for (const c of t.clips) {
      const cx0 = this.xOf(c.start), cx1 = this.xOf(c.start + c.dur);
      if (x >= cx0 - 1 && x <= cx1 + 1) {
        const w = cx1 - cx0;
        const e = Math.min(EDGE, w / 3);
        let edge = null;
        if (x - cx0 < e) edge = 'in'; else if (cx1 - x < e) edge = 'out';
        // rubber band
        const isV = row.kind === 'video';
        const showK = isV ? this.showKeyframes.video : this.showKeyframes.audio && row.h >= 30;
        let rubber = null;
        if (showK && !edge) {
          const fx = c.effects.find((q) => q.type === (isV ? 'opacity' : 'volume')); const param = isV ? 'opacity' : 'level';
          const keys = fx.keyframes[param] || [];
          const headH = Math.min(16, row.h - 3);
          const yTop = row.y + 1 + headH + 2, hh = row.h - 3 - headH - 4;
          const map = isV ? (v) => 1 - v / 100 : (v) => 1 - Math.min(1, Math.pow(dbToGain(v) / 2, 0.35));
          const lf = frame - c.start;
          const ky = keys.find((k) => Math.abs(this.xOf(c.start + k.t) - x) < 5 && Math.abs(yTop + map(k.v) * hh - y) < 6);
          const v = keys.length ? evaluate(keys, lf, fx.params[param]) : fx.params[param];
          const lineY = yTop + map(v) * hh;
          if (ky || Math.abs(lineY - y) < 4) rubber = { fx, param, key: ky, yTop, hh, isV };
        }
        return { area: 'clip', row, clip: c, edge, frame, rubber };
      }
    }
    if (this.trackKeys && row.kind === 'audio') return { area: 'track', row, frame, automation: true };
    return { area: 'track', row, frame };
  }

  snapTargets(exclude = new Set()) {
    const s = this.seq; const out = [s.playhead, 0];
    for (const t of allTracks(s)) for (const c of t.clips) if (!exclude.has(c.id)) out.push(c.start, c.start + c.dur);
    for (const m of s.markers) out.push(m.frame);
    if (s.inPoint != null) out.push(s.inPoint); if (s.outPoint != null) out.push(s.outPoint + 1);
    return out;
  }
  snapFrame(f, targets, shift) {
    const s = this.seq;
    if (!app.prefs.get('timeline.snapping') || shift) { this.snapLine = null; return f; }
    const th = 8 / s.view.zoom;
    let best = null, bd = th;
    for (const t of targets) { const d = Math.abs(t - f); if (d < bd) { bd = d; best = t; } }
    this.snapLine = best;
    return best != null ? best : f;
  }

  // ---------- interaction ----------
  bindScroll() {
    this.wrap.addEventListener('wheel', (e) => {
      const s = this.seq; if (!s) return;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      if (e.altKey || e.ctrlKey || e.metaKey) { this.setZoom(s.view.zoom * Math.pow(1.0018, -e.deltaY), e.clientX - r.left); return; }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { s.view.scrollX = Math.max(0, s.view.scrollX + (e.deltaX || e.deltaY) / s.view.zoom); }
      else {
        s.view.scrollY = clamp((s.view.scrollY || 0) + e.deltaY, 0, Math.max(0, this.contentH - (r.height - RULER_H)));
        this.renderHeaders();
      }
      this.dirty = true;
    }, { passive: false });
    this.hthumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const s = this.seq; const W = this.canvas.clientWidth;
      const r = this.hthumb.getBoundingClientRect();
      const edgeL = e.clientX - r.left < 7, edgeR = r.right - e.clientX < 7;
      const total = Math.max(seqDuration(s) + s.settings.fps * 30, this.fOf(W));
      const x0 = e.clientX, sx0 = s.view.scrollX, z0 = s.view.zoom;
      const mv = (ev) => {
        const dx = (ev.clientX - x0) / this.hscroll.clientWidth * total;
        if (edgeR) { const vis = W / z0 + dx; s.view.zoom = clamp(W / Math.max(10, vis), 0.005, 60); }
        else if (edgeL) { const vis = W / z0 - dx; s.view.scrollX = Math.max(0, sx0 + dx); s.view.zoom = clamp(W / Math.max(10, vis), 0.005, 60); }
        else s.view.scrollX = clamp(sx0 + dx, 0, total);
        this.dirty = true;
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  bindCanvas() {
    const c = this.canvas;
    c.addEventListener('mousemove', (e) => { if (this.drag) return; const { x, y } = this.pos(e); this.onHover(x, y, e); });
    c.addEventListener('mouseleave', () => { this.hover = null; this.dirty = true; });
    c.addEventListener('mousedown', (e) => this.onDown(e));
    c.addEventListener('dblclick', (e) => this.onDouble(e));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onContext(e); });
    // drag and drop
    this.wrap.addEventListener('dragover', (e) => this.onDragOver(e));
    this.wrap.addEventListener('dragleave', () => { this.ghost = null; this.dirty = true; });
    this.wrap.addEventListener('drop', (e) => this.onDrop(e));
  }

  onHover(x, y, e) {
    const hit = this.hit(x, y);
    this.hover = hit ? { ...hit, allTracks: e.shiftKey } : null;
    let cur = this.toolCursor();
    if (hit && hit.area === 'clip') {
      if (this.tool === 'razor') { this.hover.frame = this.snapFrame(Math.round(hit.frame), this.snapTargets(), e.altKey); cur = 'crosshair'; }
      else if (hit.rubber && (this.tool === 'select' || this.tool === 'pen')) cur = this.tool === 'pen' ? 'crosshair' : 'ns-resize';
      else if (hit.edge && ['select', 'ripple', 'roll', 'rate'].includes(this.tool)) cur = this.tool === 'rate' ? 'ew-resize' : this.tool === 'roll' ? 'col-resize' : hit.edge === 'in' ? 'w-resize' : 'e-resize';
      else if (this.tool === 'slip' || this.tool === 'slide') cur = 'ew-resize';
    } else if (hit && hit.area === 'transition' && hit.edge) cur = 'ew-resize';
    else if (hit && hit.area === 'caption' && hit.edge) cur = 'ew-resize';
    else if (hit && (hit.area === 'ruler' || hit.area === 'marker')) cur = 'pointer';
    this.canvas.style.cursor = cur;
    this.dirty = true;
  }

  onDown(e) {
    const s = this.seq; if (!s) return;
    app.dock.focus('timeline');
    const { x, y } = this.pos(e);
    const hit = this.hit(x, y);
    if (!hit) return;
    if (e.button === 1 || this.tool === 'hand' || (e.button === 0 && e.code === 'Space')) return this.dragHand(e);
    if (e.button !== 0) return;
    if (this.tool === 'zoom') { this.setZoom(s.view.zoom * (e.altKey ? 1 / 1.6 : 1.6), x); return; }
    if (hit.area === 'ruler' || hit.area === 'empty' && y < RULER_H) return this.dragPlayhead(e);
    if (hit.area === 'marker') return this.dragMarker(e, hit.marker);
    if (hit.area === 'in' || hit.area === 'out') return this.dragInOut(e, hit.area);
    if (hit.area === 'caption') return this.dragCaption(e, hit);
    if (hit.area === 'captionTrack') { app.store.selection.captions.clear(); this.dirty = true; return; }
    if (hit.area === 'transition') return this.dragTransition(e, hit);
    if (this.tool === 'type') { app.player.seek(Math.round(hit.frame)); A.newGraphicAtPlayhead(); this.setTool('select'); return; }
    if (hit.area === 'track' && hit.automation && (this.tool === 'pen' || e.metaKey || e.ctrlKey)) return this.addTrackKey(hit, y);
    if (hit.area === 'clip') {
      const clip = hit.clip;
      if (hit.row.track.locked) return;
      if (this.tool === 'razor') { A.razorAtFrame(hit.row.track, this.snapFrame(Math.round(hit.frame), this.snapTargets(), e.altKey), e.shiftKey); return; }
      if (hit.rubber && (this.tool === 'pen' || this.tool === 'select')) return this.dragRubber(e, hit);
      if (this.tool === 'trackFwd' || this.tool === 'trackBack') { A.selectForward(this.tool === 'trackFwd' ? clip.start : clip.start + clip.dur, e.shiftKey ? hit.row.track : null, this.tool === 'trackBack'); return this.startMove(e, hit); }
      if (hit.edge && (this.tool === 'select' || this.tool === 'ripple' || this.tool === 'roll' || this.tool === 'rate')) return this.dragTrim(e, hit);
      if (this.tool === 'slip') return this.dragSlip(e, hit);
      if (this.tool === 'slide') return this.dragSlide(e, hit);
      // selection
      const linked = e.altKey ? [clip.id] : [...A.expandLinked([clip.id])];
      if (e.shiftKey || e.metaKey || e.ctrlKey) app.store.selectClips(linked, app.store.selection.clips.has(clip.id) ? 'remove' : 'add');
      else if (!app.store.selection.clips.has(clip.id)) app.store.selectClips(linked);
      if (app.prefs.get('timeline.selectionFollowsPlayhead')) {}
      return this.startMove(e, hit);
    }
    // empty track area: marquee or track select tools
    if (this.tool === 'trackFwd' || this.tool === 'trackBack') { A.selectForward(Math.round(hit.frame), e.shiftKey ? hit.row && hit.row.track : null, this.tool === 'trackBack'); return; }
    return this.dragMarquee(e, x, y);
  }

  dragHand(e) {
    const s = this.seq; const x0 = e.clientX, y0 = e.clientY, sx = s.view.scrollX, sy = s.view.scrollY || 0;
    this.canvas.style.cursor = 'grabbing';
    const mv = (ev) => { s.view.scrollX = Math.max(0, sx - (ev.clientX - x0) / s.view.zoom); s.view.scrollY = Math.max(0, sy - (ev.clientY - y0)); this.dirty = true; this.renderHeaders(); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); this.canvas.style.cursor = this.toolCursor(); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragPlayhead(e) {
    const s = this.seq;
    const targets = this.snapTargets();
    const set = (ev) => {
      const { x } = this.pos(ev);
      let f = Math.max(0, Math.round(this.fOf(x)));
      if (app.prefs.get('timeline.snapPlayhead') || ev.shiftKey) f = this.snapFrame(f, targets.filter((t) => t !== s.playhead), false); else this.snapLine = null;
      app.player.pause();
      app.player.seek(f, { scrub: true });
    };
    set(e);
    this.drag = { type: 'playhead' };
    const mv = (ev) => set(ev);
    const up = () => { this.drag = null; this.snapLine = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); if (app.prefs.get('timeline.selectionFollowsPlayhead')) A.selectAtPlayhead(); this.dirty = true; };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragMarker(e, m) {
    const s = this.seq; const x0 = e.clientX, f0 = m.frame; let moved = false;
    const mv = (ev) => { const d = Math.round((ev.clientX - x0) / s.view.zoom); if (d) moved = true; m.frame = Math.max(0, f0 + d); this.dirty = true; };
    const up = () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      if (moved) { const nf = m.frame; m.frame = f0; app.store.transact('Move Marker', () => { m.frame = nf; }); } else app.player.seek(m.frame);
    };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragInOut(e, which) {
    const s = this.seq;
    const mv = (ev) => { const f = Math.max(0, Math.round(this.fOf(this.pos(ev).x))); if (which === 'in') s.inPoint = Math.min(f, s.outPoint != null ? s.outPoint : f); else s.outPoint = Math.max(f - 1, s.inPoint != null ? s.inPoint : 0); this.dirty = true; app.store.touch('inout'); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); app.store.markDirty(); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragMarquee(e, x0, y0) {
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) { app.store.selectClips([]); app.store.selection.captions.clear(); }
    const base = new Set(app.store.selection.clips);
    let moved = false;
    const mv = (ev) => {
      const { x, y } = this.pos(ev);
      if (Math.abs(x - x0) + Math.abs(y - y0) > 3) moved = true;
      this.marquee = { x: Math.min(x, x0), y: Math.min(y, y0), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      const f0 = this.fOf(this.marquee.x), f1 = this.fOf(this.marquee.x + this.marquee.w);
      const ids = new Set(base);
      for (const r of this.rows()) {
        if (!r.track || r.kind === 'caption') continue;
        if (r.y + r.h < this.marquee.y || r.y > this.marquee.y + this.marquee.h) continue;
        for (const c of r.track.clips) if (c.start < f1 && c.start + c.dur > f0) ids.add(c.id);
      }
      app.store.selectClips([...(ev.altKey ? ids : A.expandLinked([...ids]))]);
      this.dirty = true;
    };
    const up = (ev) => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      this.marquee = null; this.dirty = true;
      if (!moved) { const { x } = this.pos(ev); const hit = this.hit(x, y0); if (hit && hit.area === 'track' && hit.row) app.store.selection.track = hit.row.track.id; }
    };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  startMove(e, hit) {
    const s = this.seq;
    const x0 = e.clientX, y0 = e.clientY;
    const sel = A.selectedClips().filter((x) => !x.track.locked);
    if (!sel.length) return;
    const ids = new Set(sel.map((x) => x.clip.id));
    const targets = this.snapTargets(ids);
    const rowsAll = this.rows();
    const rowOf = (t) => rowsAll.find((r) => r.track === t);
    let moved = false, dFrames = 0, dTrack = 0, mode = 'overwrite', dup = false;
    const minStart = Math.min(...sel.map((x) => x.clip.start));
    const grabOffset = hit.frame - hit.clip.start;
    this.drag = { type: 'move' };
    const mv = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      const raw = (ev.clientX - x0) / s.view.zoom;
      // snap the grabbed clip's edges
      const gStart = hit.clip.start + raw, gEnd = gStart + hit.clip.dur;
      let snapped = this.snapFrame(gStart, targets, ev.shiftKey && false);
      let d = snapped - hit.clip.start;
      if (this.snapLine == null) { const se = this.snapFrame(gEnd, targets, false); d = se - hit.clip.dur - hit.clip.start; if (this.snapLine == null) d = raw; }
      dFrames = Math.round(Math.max(d, -minStart));
      // track change (vertical)
      const { y } = this.pos(ev);
      const r = rowsAll.find((q) => y >= q.y && y < q.y + q.h && q.track && q.kind === hit.row.kind);
      if (r && r.track !== hit.row.track) dTrack = (hit.row.kind === 'video' ? r.index - hit.row.index : r.index - hit.row.index); else if (r) dTrack = 0;
      mode = ev.metaKey || ev.ctrlKey ? 'insert' : 'overwrite';
      dup = ev.altKey;
      this.ghost = sel.map(({ clip, track }) => {
        const kindArr = s.tracks[track.kind];
        const ti = kindArr.indexOf(track) + (track.kind === hit.row.kind ? dTrack : 0);
        const tt = kindArr[clamp(ti, 0, kindArr.length - 1)];
        const rr = rowOf(tt) || rowOf(track);
        return { start: clip.start + dFrames, dur: clip.dur, y: rr.y, h: rr.h, insert: mode === 'insert' };
      });
      this.dirty = true;
      void grabOffset;
    };
    const up = () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      this.drag = null; this.ghost = null; this.snapLine = null; this.dirty = true;
      if (!moved || (!dFrames && !dTrack)) return;
      app.store.transact(dup ? 'Duplicate Clips' : 'Move Clips', () => {
        const q = this.seq;
        let list = sel.map(({ clip }) => findClip(q, clip.id)).filter(Boolean);
        if (dup) {
          const lm = new Map();
          list = list.map((f) => { const n = deepClone(f.clip); n.id = uid('clip'); if (n.linkId) { if (!lm.has(n.linkId)) lm.set(n.linkId, uid('lnk')); n.linkId = lm.get(n.linkId); } f.track.clips.push(n); return { ...f, clip: n }; });
        }
        const moves = list.map((f) => {
          const arr = q.tracks[f.kind];
          let ti = arr.indexOf(f.track) + (f.kind === hit.row.kind ? dTrack : 0);
          if (ti >= arr.length && app.prefs.get('timeline.autoCreateTracks') !== false) E.ensureTracks(q, f.kind, ti + 1);
          ti = clamp(ti, 0, arr.length - 1);
          return { clip: f.clip, fromTrack: f.track, toTrack: arr[ti].locked ? f.track : arr[ti], newStart: f.clip.start + dFrames };
        });
        E.moveClips(q, moves, mode);
      });
      this.renderHeaders();
    };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragTrim(e, hit) {
    const s = this.seq; const fps = s.settings.fps;
    const clip = hit.clip, track = hit.row.track;
    let tool = this.tool;
    if (tool === 'select' && (e.metaKey || e.ctrlKey)) tool = 'ripple';
    // find neighbor for roll
    const neighbor = hit.edge === 'in' ? track.clips.find((c) => c.start + c.dur === clip.start) : track.clips.find((c) => c.start === clip.start + clip.dur);
    if (tool === 'select' && e.altKey === false && neighbor && hit.edge && false) tool = 'roll';
    const snapshot = JSON.stringify(s.tracks);
    const targets = this.snapTargets(new Set([clip.id]));
    const x0 = e.clientX;
    const linkedTrims = app.prefs.get('timeline.linkedSelection') && !e.altKey ? linkedClips(s, clip).filter((c) => c !== clip).map((c) => ({ c, t: allTracks(s).find((t) => t.clips.includes(c)) })) : [];
    let applied = 0;
    this.drag = { type: 'trim' };
    const info = h('div', { style: { position: 'fixed', zIndex: 200, background: '#1d2129', border: '1px solid #2a2f38', borderRadius: '4px', padding: '2px 6px', fontFamily: 'var(--mono)', fontSize: '11px', color: '#e6ebf2', pointerEvents: 'none' } });
    document.body.appendChild(info);
    const mv = (ev) => {
      s.tracks = JSON.parse(snapshot);
      const f = findClip(s, clip.id); const c = f.clip, t = f.track;
      const edgeF = hit.edge === 'in' ? clip.start : clip.start + clip.dur;
      const target = this.snapFrame(edgeF + (ev.clientX - x0) / s.view.zoom, targets, false);
      let d = Math.round(target - edgeF);
      const others = linkedTrims.map(({ c: lc }) => findClip(s, lc.id)).filter(Boolean);
      if (tool === 'rate') {
        const nd = hit.edge === 'in' ? c.dur - d : c.dur + d;
        E.rateStretch(app.store.project, s, t, c, nd, hit.edge === 'in');
        for (const o of others) E.rateStretch(app.store.project, s, o.track, o.clip, nd, hit.edge === 'in');
        applied = d;
      } else if (tool === 'roll' && neighbor) {
        const nb = findClip(s, neighbor.id).clip;
        applied = hit.edge === 'in' ? E.rollEdit(app.store.project, s, t, nb, c, d) : E.rollEdit(app.store.project, s, t, c, nb, d);
      } else {
        const mode = tool === 'ripple' ? 'ripple' : 'normal';
        if (hit.edge === 'in') { applied = E.trimHead(app.store.project, s, t, c, d, mode); for (const o of others) if (o.clip.start === clip.start) E.trimHead(app.store.project, s, o.track, o.clip, applied, mode === 'ripple' ? 'normal' : mode); }
        else { applied = E.trimTail(app.store.project, s, t, c, d, mode); for (const o of others) if (o.clip.start + o.clip.dur === clip.start + clip.dur) E.trimTail(app.store.project, s, o.track, o.clip, applied, mode === 'ripple' ? 'normal' : mode); }
      }
      info.textContent = `${applied >= 0 ? '+' : '-'}${framesToTC(Math.abs(applied), fps)}  Duration ${framesToTC(c.dur, fps)}`;
      info.style.left = ev.clientX + 14 + 'px'; info.style.top = ev.clientY - 26 + 'px';
      this.dirty = true;
      // trim preview in program monitor
      app.player.dirty.program = true;
      if (app.program) app.program.trimPreview = { clip: c.id, frame: hit.edge === 'in' ? c.start : c.start + c.dur - 1 };
    };
    const up = () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      info.remove(); this.drag = null; this.snapLine = null;
      if (app.program) app.program.trimPreview = null;
      const after = JSON.stringify(s.tracks);
      s.tracks = JSON.parse(snapshot);
      if (after !== snapshot) app.store.transact(tool === 'ripple' ? 'Ripple Trim' : tool === 'roll' ? 'Roll Edit' : tool === 'rate' ? 'Rate Stretch' : 'Trim', () => { s.tracks = JSON.parse(after); });
      this.dirty = true;
    };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragSlip(e, hit) {
    const s = this.seq; const snapshot = JSON.stringify(s.tracks); const x0 = e.clientX;
    this.drag = { type: 'slip' };
    const mv = (ev) => {
      s.tracks = JSON.parse(snapshot);
      const d = -Math.round((ev.clientX - x0) / s.view.zoom);
      for (const lc of [hit.clip, ...(app.prefs.get('timeline.linkedSelection') ? linkedClips(s, hit.clip).filter((x) => x.id !== hit.clip.id) : [])]) { const f = findClip(s, lc.id); if (f) E.slipClip(app.store.project, s, f.clip, d); }
      const f = findClip(s, hit.clip.id);
      if (app.program) app.program.trimPreview = { clip: f.clip.id, frame: f.clip.start };
      app.player.dirty.program = true; this.dirty = true;
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); this.drag = null; if (app.program) app.program.trimPreview = null; const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(snapshot); if (after !== snapshot) app.store.transact('Slip', () => { s.tracks = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragSlide(e, hit) {
    const s = this.seq; const snapshot = JSON.stringify(s.tracks); const x0 = e.clientX;
    this.drag = { type: 'slide' };
    const mv = (ev) => {
      s.tracks = JSON.parse(snapshot);
      const d = Math.round((ev.clientX - x0) / s.view.zoom);
      for (const lc of [hit.clip, ...(app.prefs.get('timeline.linkedSelection') ? linkedClips(s, hit.clip).filter((x) => x.id !== hit.clip.id) : [])]) { const f = findClip(s, lc.id); if (f) E.slideClip(app.store.project, s, f.track, f.clip, d); }
      this.dirty = true; app.player.dirty.program = true;
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); this.drag = null; const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(snapshot); if (after !== snapshot) app.store.transact('Slide', () => { s.tracks = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragTransition(e, hit) {
    const s = this.seq; const tr = hit.tr; const track = hit.row.track;
    app.store.selectTransition(track.id, tr.id);
    app.dock.activate('effectControls');
    if (!hit.edge) return;
    const snapshot = JSON.stringify(s.tracks); const x0 = e.clientX;
    const mv = (ev) => {
      s.tracks = JSON.parse(snapshot);
      const t = s.tracks[track.kind].find((x) => x.id === track.id); const q = t.transitions.find((x) => x.id === tr.id);
      const d = Math.round((ev.clientX - x0) / s.view.zoom);
      const nd = Math.max(1, q.dur + (hit.edge === 'out' ? d : -d) * (q.align === 'center' ? 2 : 1));
      q.dur = nd; E.cleanTransitions(t);
      this.dirty = true;
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(snapshot); if (after !== snapshot) app.store.transact('Transition Duration', () => { s.tracks = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  dragRubber(e, hit) {
    const s = this.seq; const clip = hit.clip; const rb = hit.rubber;
    const snap = JSON.stringify(s.tracks);
    const unmap = rb.isV ? (u) => clamp((1 - u) * 100, 0, 100) : (u) => { const g = Math.pow(clamp(1 - u, 0, 1), 1 / 0.35) * 2; return clamp(gainToDb(g), -96, 15); };
    const f = findClip(s, clip.id);
    const fx = f.clip.effects.find((x) => x.id === rb.fx.id);
    const keys = fx.keyframes[rb.param] = fx.keyframes[rb.param] || [];
    let key = rb.key ? keys.find((k) => k.t === rb.key.t) : null;
    const local = Math.round(hit.frame - clip.start);
    if (!key && (this.tool === 'pen' || e.metaKey || e.ctrlKey)) { key = setKey(keys, local, evaluate(keys, local, fx.params[rb.param]), 'linear'); }
    const y0 = e.clientY, x0 = e.clientX;
    const startVals = keys.map((k) => k.v); const base = fx.params[rb.param];
    const mv = (ev) => {
      const { y } = this.pos(ev);
      const v = unmap((y - rb.yTop) / rb.hh);
      if (key) { key.v = +v.toFixed(2); if (Math.abs(ev.clientX - x0) > 3 && !ev.shiftKey) key.t = clamp(Math.round(local + (ev.clientX - x0) / s.view.zoom), 0, f.clip.dur); keys.sort((a, b) => a.t - b.t); }
      else if (!keys.length) fx.params[rb.param] = +v.toFixed(2);
      else { const dv = v - unmap((y0 - this.canvas.getBoundingClientRect().top - rb.yTop) / rb.hh); keys.forEach((k, i) => { k.v = +(startVals[i] + dv).toFixed(2); }); }
      this.dirty = true; app.player.dirty.program = true;
      void base;
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(snap); if (after !== snap) app.store.transact(rb.isV ? 'Opacity Keyframe' : 'Volume Keyframe', () => { s.tracks = JSON.parse(after); }); app.audio.liveUpdate(s); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  addTrackKey(hit, y) {
    const t = hit.row.track;
    const u = (y - hit.row.y - 2) / (hit.row.h - 6);
    const g = Math.pow(clamp(1 - u, 0, 1), 1 / 0.35) * 2;
    app.store.transact('Track Keyframe', () => { setKey(t.audio.keyframes.volume, Math.round(hit.frame), +clamp(gainToDb(g), -96, 15).toFixed(1)); });
  }

  dragCaption(e, hit) {
    const s = this.seq; const cap = hit.cap; const snap = JSON.stringify(s.captionTracks); const x0 = e.clientX;
    if (!e.shiftKey) app.store.selection.captions.clear();
    app.store.selection.captions.add(cap.id);
    if (app.panels.text) { app.panels.text.trackId = hit.row.track.id; app.panels.text.focusCaption(cap.id); }
    app.player.seek(cap.start);
    const mv = (ev) => {
      s.captionTracks = JSON.parse(snap);
      const t = s.captionTracks.find((x) => x.id === hit.row.track.id); const c = t.captions.find((x) => x.id === cap.id);
      const d = Math.round((ev.clientX - x0) / s.view.zoom);
      if (hit.edge === 'in') c.start = clamp(c.start + d, 0, c.end - 1);
      else if (hit.edge === 'out') c.end = Math.max(c.start + 1, c.end + d);
      else { c.start = Math.max(0, c.start + d); c.end = c.start + (cap.end - cap.start); }
      this.dirty = true;
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); const after = JSON.stringify(s.captionTracks); s.captionTracks = JSON.parse(snap); if (after !== snap) app.store.transact('Caption Timing', () => { s.captionTracks = JSON.parse(after); }); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  onDouble(e) {
    const { x, y } = this.pos(e);
    const hit = this.hit(x, y);
    if (!hit) return;
    if (hit.area === 'marker') return A.editMarker(hit.marker);
    if (hit.area === 'transition') { app.store.selectTransition(hit.row.track.id, hit.tr.id); app.dock.openPanel('effectControls'); return; }
    if (hit.area === 'clip') {
      const c = hit.clip;
      if (c.src.type === 'sequence') { app.store.selectClips([c.id]); A.openNested(); return; }
      if (c.src.type === 'graphic') { app.store.selectClips([c.id]); app.dock.openPanel('properties'); return; }
      const item = app.store.project.items[c.src.itemId];
      if (item) { item.inPoint = c.srcIn; item.outPoint = c.srcIn + c.dur / this.seq.settings.fps * c.speed; app.ui.openInSource(item.id, clipSourceTime(c, Math.round(hit.frame), this.seq.settings.fps)); }
    }
  }

  onContext(e) {
    const { x, y } = this.pos(e);
    const hit = this.hit(x, y);
    const s = this.seq; if (!s || !hit) return;
    if (hit.area === 'ruler' || hit.area === 'marker' || hit.area === 'in' || hit.area === 'out') {
      return contextMenu(e.clientX, e.clientY, [
        { label: 'Add Marker', cmd: 'marker.add' }, hit.marker ? { label: 'Edit Marker...', action: () => A.editMarker(hit.marker) } : null,
        hit.marker ? { label: 'Delete Marker', action: () => app.store.transact('Delete Marker', () => { s.markers = s.markers.filter((m) => m !== hit.marker); }) } : null,
        { label: 'Go to Next Marker', cmd: 'marker.next' }, { label: 'Go to Previous Marker', cmd: 'marker.prev' }, { label: 'Clear All Markers', action: () => A.clearMarkers(true) }, '-',
        { label: 'Mark In', cmd: 'mark.in' }, { label: 'Mark Out', cmd: 'mark.out' }, { label: 'Clear In and Out', cmd: 'mark.clear' }, '-',
        { label: 'Render In to Out', cmd: 'sequence.renderInOut' }, { label: 'Delete Render Files', cmd: 'sequence.deletePreviews' },
      ]);
    }
    if (hit.area === 'transition') {
      app.store.selectTransition(hit.row.track.id, hit.tr.id);
      return contextMenu(e.clientX, e.clientY, [
        { label: 'Set Transition Duration...', action: async () => { const v = await promptDialog('Transition Duration (frames)', String(hit.tr.dur)); const n = parseInt(v, 10); if (n > 0) app.store.transact('Transition Duration', () => { hit.tr.dur = n; E.cleanTransitions(hit.row.track); }); } },
        { label: 'Alignment', submenu: [['center', 'Center at Cut'], ['start', 'Start at Cut'], ['end', 'End at Cut']].map(([k, l]) => ({ label: l, checked: hit.tr.align === k, action: () => app.store.transact('Transition Alignment', () => { hit.tr.align = k; E.cleanTransitions(hit.row.track); }) })) },
        { label: 'Reverse', checked: hit.tr.reverse, action: () => app.store.transact('Reverse Transition', () => { hit.tr.reverse = !hit.tr.reverse; }) },
        { label: 'Set as Default Transition', action: () => app.prefs.set(hit.row.kind === 'video' ? 'timeline.defaultVideoTransition' : 'timeline.defaultAudioTransition', hit.tr.type) },
        '-', { label: 'Clear', action: () => app.store.transact('Delete Transition', () => { hit.row.track.transitions = hit.row.track.transitions.filter((t) => t !== hit.tr); }) },
      ]);
    }
    if (hit.area === 'caption') {
      return contextMenu(e.clientX, e.clientY, [
        { label: 'Split Caption', action: () => import('../../actions/captions.js').then((m) => m.splitCaption(hit.row.track.id, hit.cap.id)) },
        { label: 'Merge Selected Captions', action: () => import('../../actions/captions.js').then((m) => m.mergeCaptions(hit.row.track.id, app.store.selection.captions)) },
        { label: 'Delete Caption', action: () => import('../../actions/captions.js').then((m) => m.deleteCaptions(hit.row.track.id, new Set([hit.cap.id]))) },
      ]);
    }
    if (hit.area === 'clip') {
      const c = hit.clip;
      if (!app.store.selection.clips.has(c.id)) app.store.selectClips([...A.expandLinked([c.id])]);
      const item = app.store.project.items[c.src.itemId];
      const isMc = c.src.type === 'sequence' && item && item.multicam;
      return contextMenu(e.clientX, e.clientY, [
        { label: 'Cut', cmd: 'edit.cut' }, { label: 'Copy', cmd: 'edit.copy' }, { label: 'Paste Attributes...', cmd: 'edit.pasteAttributes' }, { label: 'Remove Attributes', action: () => A.removeEffects() }, '-',
        { label: 'Clear', cmd: 'edit.clear' }, { label: 'Ripple Delete', cmd: 'edit.rippleDelete' }, '-',
        { label: 'Edit Original', disabled: !item || item.type !== 'media', action: () => window.native.call('shell:open', item.path) },
        { label: 'Replace With Clip', submenu: [{ label: 'From Source Monitor', action: () => A.replaceEdit() }, { label: 'From Bin', action: () => { const it = [...app.store.selection.items].map((id) => app.store.project.items[id]).find((i) => i && i.type !== 'bin'); if (!it) return toast('Select a replacement in the Project panel', 'warn'); app.store.transact('Replace With Clip', () => { for (const lc of linkedClips(s, c)) E.replaceClipSource(app.store.project, s, lc, it); }); } }] },
        { label: 'Enable', checked: c.enabled, cmd: 'clip.enable' },
        { label: c.linkId && linkedClips(s, c).length > 1 ? 'Unlink' : 'Link', cmd: 'clip.link' },
        { label: 'Group', cmd: 'clip.group' }, { label: 'Ungroup', cmd: 'clip.ungroup' },
        { label: 'Synchronize...', action: () => A.syncSelectedClips() },
        { label: 'Merge Clips', action: () => A.mergeClipsDialog([...new Set(A.selectedClips().map((x) => app.store.project.items[x.clip.src.itemId]).filter(Boolean))]) },
        { label: 'Nest...', cmd: 'clip.nest' }, { label: 'Make Subsequence', action: () => A.makeSubsequence() },
        isMc ? { label: 'Multi-Camera', submenu: [{ label: 'Flatten', action: () => A.flattenMulticam() }, ...item.multicam.angles.map((a, i) => ({ label: `${i + 1}: ${a.name}`, checked: (c.angle || 0) === i, action: () => app.store.transact('Switch Camera', () => { for (const x of A.selectedClips()) if (x.clip.src.type === 'sequence') x.clip.angle = i; }) }))] } : null,
        '-',
        { label: 'Label', submenu: Object.entries(LABEL_COLORS).map(([k]) => ({ label: k[0].toUpperCase() + k.slice(1), action: () => app.store.transact('Label', () => { for (const x of A.selectedClips()) x.clip.label = k === 'none' ? null : k; }) })) },
        { label: 'Speed/Duration...', cmd: 'clip.speed' }, { label: 'Time Remapping', checked: c.timeRemap, action: () => A.toggleTimeRemap() }, { label: 'Reverse', checked: c.reverse, action: () => A.reverseClips() },
        { label: 'Time Interpolation', submenu: [['sampling', 'Frame Sampling'], ['blend', 'Frame Blending'], ['optical', 'Optical Flow']].map(([k, l]) => ({ label: l, checked: (c.frameInterp || 'sampling') === k, action: () => { app.store.transact('Time Interpolation', () => { for (const x of A.selectedClips()) x.clip.frameInterp = k; }); for (const x of A.selectedClips()) A.prepareRetime(x.clip.id); } })) },
        { label: 'Frame Hold Options...', submenu: [{ label: 'Add Frame Hold', cmd: 'clip.frameHold' }, { label: 'Insert Frame Hold Segment', cmd: 'clip.frameHoldSegment' }, { label: 'Hold Entire Clip on Current Frame', action: () => A.addFrameHold('whole') }, { label: 'Remove Frame Hold', action: () => app.store.transact('Remove Frame Hold', () => { for (const x of A.selectedClips()) x.clip.frameHold = null; }) }] },
        '-',
        c.kind === 'video' ? { label: 'Scale to Frame Size', checked: c.setToFrame, action: () => A.scaleToFrame('set') } : null,
        c.kind === 'video' ? { label: 'Fill Frame', action: () => A.scaleToFrame('fill') } : null,
        c.kind === 'video' ? { label: 'Scene Edit Detection...', action: () => import('../../actions/analysis.js').then((m) => m.sceneEditDetection(c.id)) } : null,
        c.kind === 'audio' ? { label: 'Audio Gain...', cmd: 'audio.gain' } : null, c.kind === 'audio' ? { label: 'Audio Channels...', action: () => A.audioChannelsDialog() } : null,
        '-',
        { label: 'Reveal in Project', cmd: 'clip.reveal' }, { label: IS_MAC_UI ? 'Reveal in Finder' : 'Show in Explorer', disabled: !item || item.type !== 'media', action: () => window.native.call('shell:reveal', item.path) },
        { label: 'Rename...', action: async () => { const n = await promptDialog('Rename Clip', c.name); if (n) app.store.transact('Rename Clip', () => { c.name = n; }); } },
        { label: 'Properties', disabled: !item || item.type !== 'media', action: () => import('../../actions/media.js').then((m) => m.mediaProperties(item)) },
        { label: 'Show Clip Keyframes', checked: c.kind === 'video' ? this.showKeyframes.video : this.showKeyframes.audio, action: () => { this.showKeyframes[c.kind] = !this.showKeyframes[c.kind]; this.dirty = true; } },
      ]);
    }
    // empty track
    const gap = hit.row && hit.row.track && hit.row.track.clips ? E.gapAt(hit.row.track, Math.round(hit.frame)) : null;
    contextMenu(e.clientX, e.clientY, [
      gap ? { label: 'Ripple Delete', action: () => app.store.transact('Ripple Delete Gap', () => E.closeGap(s, hit.row.track, gap)) } : null,
      { label: 'Paste', cmd: 'edit.paste' }, { label: 'Paste Insert', cmd: 'edit.pasteInsert' }, '-',
      { label: 'Add Tracks...', action: () => A.addTracksDialog() }, { label: 'New Graphic Here', action: () => { app.player.seek(Math.round(hit.frame)); A.newGraphicAtPlayhead(); } },
      { label: 'Close All Gaps on Targeted Tracks', action: () => A.closeAllGaps() },
    ]);
  }

  // ---------- drag & drop ----------
  dropTarget(e) {
    const { x, y } = this.pos(e);
    const s = this.seq;
    const rows = this.rows();
    let row = rows.find((r) => y >= r.y && y < r.y + r.h && r.track && r.kind !== 'caption');
    const frame = Math.max(0, Math.round(this.fOf(x)));
    return { row, frame, x, y, above: y < (rows.find((r) => r.kind === 'video') || { y: 0 }).y };
  }

  onDragOver(e) {
    const types = e.dataTransfer.types;
    const s = this.seq;
    if (types.includes('application/x-cinergy-items') || types.includes('Files') || types.includes('application/x-cinergy-paths')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!s) return;
      const t = this.dropTarget(e);
      const len = this.dragLen || Math.round(s.settings.fps * 5);
      const f = this.snapFrame(t.frame, this.snapTargets(), e.shiftKey);
      const row = t.row || this.rows().find((r) => r.kind === 'video');
      this.ghost = row ? [{ start: f, dur: len, y: row.y, h: row.h, insert: e.metaKey || e.ctrlKey }] : null;
      this.dirty = true;
      return;
    }
    if (types.includes('application/x-cinergy-effect') || types.includes('application/x-cinergy-transition') || types.includes('application/x-cinergy-preset')) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      const t = this.dropTarget(e);
      const hit = t.row ? this.hit(t.x, t.y) : null;
      this.ghost = null;
      if (hit && hit.clip) { app.store.selectClips([hit.clip.id]); }
      this.dirty = true;
    }
  }

  async onDrop(e) {
    e.preventDefault();
    this.ghost = null; this.snapLine = null; this.dirty = true;
    const dt = e.dataTransfer;
    const insert = e.metaKey || e.ctrlKey;
    const t = this.dropTarget(e);
    const fx = dt.getData('application/x-cinergy-effect');
    if (fx) { const hit = this.hit(t.x, t.y); if (hit && hit.clip) A.applyEffect(fx, [...(e.altKey ? [hit.clip.id] : [hit.clip.id])]); return; }
    const preset = dt.getData('application/x-cinergy-preset');
    if (preset) { const hit = this.hit(t.x, t.y); if (hit && hit.clip) A.applyPreset(JSON.parse(preset), [hit.clip.id]); return; }
    const trn = dt.getData('application/x-cinergy-transition');
    if (trn) {
      const hit = this.hit(t.x, t.y); if (!hit || !hit.row || !hit.row.track) return;
      const tr = hit.row.track;
      let best = null, bd = Infinity;
      for (const c of tr.clips) for (const ed of [c.start, c.start + c.dur]) { const d = Math.abs(ed - hit.frame); if (d < bd) { bd = d; best = ed; } }
      if (best == null) return;
      const A2 = tr.clips.find((c) => c.start + c.dur === best), B = tr.clips.find((c) => c.start === best);
      const align = A2 && B ? (Math.abs(hit.frame - best) * this.seq.view.zoom < 8 ? 'center' : hit.frame < best ? 'end' : 'start') : undefined;
      A.addTransitionAt(tr, best, trn, null, align);
      return;
    }
    let ids = [];
    const raw = dt.getData('application/x-cinergy-items');
    if (raw) ids = JSON.parse(raw);
    else if (dt.getData('application/x-cinergy-paths') || (dt.files && dt.files.length)) {
      const paths = dt.getData('application/x-cinergy-paths') ? JSON.parse(dt.getData('application/x-cinergy-paths')) : [...dt.files].map((f) => window.native.pathForFile(f)).filter(Boolean);
      const { importPaths } = await import('../../actions/media.js');
      const created = await importPaths(paths);
      ids = created.map((c) => c.id);
    }
    if (!ids.length) return;
    let s = this.seq;
    const items = ids.map((id) => app.store.project.items[id]).filter((i) => i && i.type !== 'bin');
    if (!s) { A.newSequenceFromItems(items); return; }
    let frame = this.snapFrame(t.frame, this.snapTargets(), e.shiftKey); this.snapLine = null;
    let placedAll = [];
    app.store.transact(insert ? 'Insert' : 'Overwrite', () => {
      for (const it of items) {
        if (it.type === 'sequence' && seqContains(app.store.project, it.id, s.id)) { toast('A sequence cannot contain itself', 'error'); continue; }
        const d = itemDuration(app.store.project, it);
        const dur = isFinite(d) ? d : (it.duration || app.prefs.get('timeline.stillDuration') || 5);
        const a = it.inPoint || 0, b = it.outPoint != null ? it.outPoint + 1 / (app.player.sourceFps() || 30) : dur;
        let vt = null, at = null;
        if (t.row) { if (t.row.kind === 'video') { vt = t.row.track; at = s.tracks.audio[Math.min(t.row.index, s.tracks.audio.length - 1)]; } else { at = t.row.track; vt = s.tracks.video[Math.min(t.row.index, s.tracks.video.length - 1)]; } }
        else if (t.above) { vt = E.addTrack(s, 'video'); }
        if (vt && vt.locked) vt = E.targetTrack(s, 'video');
        if (at && at.locked) at = E.targetTrack(s, 'audio');
        const placed = E.editItemIntoSequence(app.store.project, s, it, a, b, frame, insert ? 'insert' : 'overwrite', { videoTrack: vt, audioTrack: at, scaleToFrame: app.prefs.get('timeline.defaultScaleToFrame') === 'set' });
        placedAll.push(...placed);
        if (placed.length) frame = Math.max(...placed.map((c) => c.start + c.dur));
      }
    });
    // offer to match sequence settings to the first clip if sequence is empty
    if (placedAll.length) app.store.selectClips(placedAll.map((c) => c.id));
    this.renderHeaders();
  }
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (k < 0) { r *= 1 + k; g *= 1 + k; b *= 1 + k; } else { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export function createTimeline(el) { return new TimelinePanel(el); }
