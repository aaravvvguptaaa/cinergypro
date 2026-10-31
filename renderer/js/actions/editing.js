// Timeline editing commands (wrapping core/edit.js in undoable transactions).
import { app } from '../app-context.js';
import * as E from '../core/edit.js';
import {
  createSequence, allTracks, findClip, linkedClips, seqDuration, clipAt, editPoints, itemDuration, clipSourceTime, cloneSequence,
  createClip, seqContains, graphicDefault, itemHasAudio, itemHasVideo, createTrack,
} from '../core/project.js';
import { makeEffect, makeTransition, defFor, transitionDef, AUDIO_TRANSITIONS, TRANSITIONS } from '../core/effect-defs.js';
import { uid, deepClone, clamp, LABEL_COLORS, h } from '../core/util.js';
import { formDialog, toast, modal, promptDialog, confirmDialog } from '../ui/widgets.js';
import { framesToTC, FRAME_RATES } from '../core/timecode.js';
import { evaluate } from '../core/keyframes.js';

const st = () => app.store;
const seq = () => app.store.seq;
const tx = (label, fn, opts) => { const s = seq(); if (!s) return; return app.store.transact(label, () => fn(s), [s.id], opts); };
const selIds = () => new Set(app.store.selection.clips);
const fps = () => (seq() ? seq().settings.fps : 24);

export function selectedClips() {
  const s = seq(); if (!s) return [];
  const out = [];
  for (const t of allTracks(s)) for (const c of t.clips) if (app.store.selection.clips.has(c.id)) out.push({ clip: c, track: t });
  return out;
}

// Selection with linked partners (respecting the linked selection toggle)
export function expandLinked(ids) {
  const s = seq(); const out = new Set(ids);
  if (!app.prefs.get('timeline.linkedSelection')) return out;
  for (const id of ids) { const f = findClip(s, id); if (!f) continue; for (const c of linkedClips(s, f.clip)) out.add(c.id); for (const t of allTracks(s)) for (const c of t.clips) if (f.clip.groupId && c.groupId === f.clip.groupId) out.add(c.id); }
  return out;
}

// ---------- Sequences ----------
export const SEQUENCE_PRESETS = [
  { group: 'HD', name: 'HD 1080p 23.976', w: 1920, h: 1080, fps: 23.976 }, { group: 'HD', name: 'HD 1080p 24', w: 1920, h: 1080, fps: 24 }, { group: 'HD', name: 'HD 1080p 25', w: 1920, h: 1080, fps: 25 },
  { group: 'HD', name: 'HD 1080p 29.97', w: 1920, h: 1080, fps: 29.97 }, { group: 'HD', name: 'HD 1080p 30', w: 1920, h: 1080, fps: 30 }, { group: 'HD', name: 'HD 1080p 50', w: 1920, h: 1080, fps: 50 },
  { group: 'HD', name: 'HD 1080p 59.94', w: 1920, h: 1080, fps: 59.94 }, { group: 'HD', name: 'HD 1080p 60', w: 1920, h: 1080, fps: 60 }, { group: 'HD', name: 'HD 720p 29.97', w: 1280, h: 720, fps: 29.97 },
  { group: 'UHD', name: 'UHD 4K 23.976', w: 3840, h: 2160, fps: 23.976 }, { group: 'UHD', name: 'UHD 4K 24', w: 3840, h: 2160, fps: 24 }, { group: 'UHD', name: 'UHD 4K 25', w: 3840, h: 2160, fps: 25 },
  { group: 'UHD', name: 'UHD 4K 29.97', w: 3840, h: 2160, fps: 29.97 }, { group: 'UHD', name: 'UHD 4K 59.94', w: 3840, h: 2160, fps: 59.94 }, { group: 'Cinema', name: 'DCI 4K 24', w: 4096, h: 2160, fps: 24 },
  { group: 'Cinema', name: 'DCI 2K 24', w: 2048, h: 1080, fps: 24 }, { group: 'Cinema', name: 'Scope 2.39:1 1080', w: 1920, h: 804, fps: 24 }, { group: 'Social', name: 'Vertical 9:16 1080x1920 30', w: 1080, h: 1920, fps: 30 },
  { group: 'Social', name: 'Square 1:1 1080 30', w: 1080, h: 1080, fps: 30 }, { group: 'Social', name: 'Portrait 4:5 1080x1350 30', w: 1080, h: 1350, fps: 30 }, { group: 'Broadcast', name: 'NTSC DV 720x480 29.97', w: 720, h: 480, fps: 29.97, par: 0.9091, field: 'bff' },
  { group: 'Broadcast', name: 'PAL DV 720x576 25', w: 720, h: 576, fps: 25, par: 1.094, field: 'bff' }, { group: 'HDR', name: 'UHD 4K HDR10 (PQ) 23.976', w: 3840, h: 2160, fps: 23.976, cs: 'rec2100pq' }, { group: 'HDR', name: 'UHD 4K HLG 25', w: 3840, h: 2160, fps: 25, cs: 'rec2100hlg' },
  { group: 'VR', name: 'VR Monoscopic 3840x1920 30', w: 3840, h: 1920, fps: 30 }, { group: 'VR', name: 'VR Stereo Over/Under 3840x3840 30', w: 3840, h: 3840, fps: 30 },
];

function seqSpec(settings, includeName = true) {
  return [
    ...(includeName ? [{ key: 'name', label: 'Sequence name' }] : []),
    { key: 'preset', label: 'Preset', type: 'select', string: true, options: [['custom', 'Custom']].concat(SEQUENCE_PRESETS.map((p, i) => [String(i), `${p.group}: ${p.name}`])), onChange: (v, vals, api) => { const p = SEQUENCE_PRESETS[+v]; if (p) { Object.assign(vals, { width: p.w, height: p.h, fps: p.fps, pixelAspect: p.par || 1, fieldOrder: p.field || 'progressive', colorSpace: p.cs || 'rec709' }); api.el.querySelectorAll('input[type=number]').forEach((el, i) => { el.value = [vals.width, vals.height][i] ?? el.value; }); api.el.querySelectorAll('select').forEach((sel) => { const map = { fps: vals.fps, pixelAspect: vals.pixelAspect, fieldOrder: vals.fieldOrder, colorSpace: vals.colorSpace }; for (const k of Object.keys(map)) if (sel.__key === k) sel.value = map[k]; }); } } },
    { type: 'group', label: 'Video' },
    { key: 'width', label: 'Frame width', type: 'number', min: 16, max: 16384 },
    { key: 'height', label: 'Frame height', type: 'number', min: 16, max: 16384 },
    { key: 'fps', label: 'Timebase', type: 'select', options: FRAME_RATES.map((f) => [f, f + ' fps']) },
    { key: 'pixelAspect', label: 'Pixel aspect ratio', type: 'select', options: [[1, 'Square Pixels (1.0)'], [0.9091, 'D1/DV NTSC (0.9091)'], [1.094, 'D1/DV PAL (1.094)'], [1.3333, 'HDV (1.333)'], [2, 'Anamorphic 2:1']] },
    { key: 'fieldOrder', label: 'Fields', type: 'select', string: true, options: [['progressive', 'No Fields (Progressive Scan)'], ['tff', 'Upper Field First'], ['bff', 'Lower Field First']] },
    { key: 'colorSpace', label: 'Working color space', type: 'select', string: true, options: [['rec709', 'Rec. 709'], ['rec2100pq', 'Rec. 2100 PQ'], ['rec2100hlg', 'Rec. 2100 HLG']] },
    { key: 'startTC', label: 'Start timecode', placeholder: '00:00:00:00' },
    { type: 'group', label: 'Audio' },
    { key: 'sampleRate', label: 'Sample rate', type: 'select', options: [[44100, '44100 Hz'], [48000, '48000 Hz'], [96000, '96000 Hz']] },
    { key: 'audioChannels', label: 'Mix', type: 'select', string: true, options: [['stereo', 'Stereo'], ['mono', 'Mono'], ['5.1', '5.1']] },
    ...(includeName ? [{ type: 'group', label: 'Tracks' }, { key: 'videoTracks', label: 'Video tracks', type: 'number', min: 1, max: 99 }, { key: 'audioTracks', label: 'Audio tracks', type: 'number', min: 0, max: 99 }] : []),
  ];
}

export async function newSequenceDialog() {
  const d = app.store.project.settings.defaultSequence;
  const r = await formDialog('New Sequence', seqSpec(), { name: nextSeqName(), preset: 'custom', width: d.width, height: d.height, fps: d.fps, pixelAspect: 1, fieldOrder: 'progressive', colorSpace: 'rec709', startTC: '00:00:00:00', sampleRate: 48000, audioChannels: 'stereo', videoTracks: 3, audioTracks: 3 }, { width: 560, ok: 'Create' });
  if (!r) return null;
  return createSequenceFrom(r);
}

function nextSeqName() { const n = Object.values(app.store.project.items).filter((i) => i.type === 'sequence').length + 1; return `Sequence ${String(n).padStart(2, '0')}`; }

export function createSequenceFrom(r) {
  const { tcToFrames } = { tcToFrames: (s, f) => { const p = String(s || '0').split(/[:;]/).map(Number); while (p.length < 4) p.unshift(0); return ((p[0] * 3600 + p[1] * 60 + p[2]) * Math.round(f)) + p[3]; } };
  const s = createSequence(r.name, { width: r.width, height: r.height, fps: r.fps, pixelAspect: r.pixelAspect, fieldOrder: r.fieldOrder, colorSpace: r.colorSpace, sampleRate: r.sampleRate, audioChannels: r.audioChannels, startTC: tcToFrames(r.startTC, r.fps) }, binForSequences());
  if (r.videoTracks) { s.tracks.video = []; for (let i = 0; i < r.videoTracks; i++) s.tracks.video.push(createTrack('video', i)); }
  if (r.audioTracks != null) { s.tracks.audio = []; for (let i = 0; i < Math.max(1, r.audioTracks); i++) s.tracks.audio.push(createTrack('audio', i)); }
  app.store.transact('New Sequence', () => { app.store.project.items[s.id] = s; app.store.project.settings.defaultSequence = { width: r.width, height: r.height, fps: r.fps, sampleRate: r.sampleRate }; }, ['project']);
  app.store.setActiveSequence(s.id);
  return s;
}

function binForSequences() { const b = Object.values(app.store.project.items).find((i) => i.type === 'bin' && /sequence/i.test(i.name)); return b ? b.id : (app.panels.project ? app.panels.project.currentBin : null); }

export async function sequenceSettingsDialog() {
  const s = seq(); if (!s) return;
  const r = await formDialog('Sequence Settings', seqSpec(s.settings, false), { ...s.settings, preset: 'custom', startTC: framesToTC(s.settings.startTC || 0, s.settings.fps) }, { width: 560 });
  if (!r) return;
  const { tcToFrames } = await import('../core/timecode.js');
  tx('Sequence Settings', (q) => { const oldFps = q.settings.fps; Object.assign(q.settings, { width: r.width, height: r.height, fps: r.fps, pixelAspect: r.pixelAspect, fieldOrder: r.fieldOrder, colorSpace: r.colorSpace, sampleRate: r.sampleRate, audioChannels: r.audioChannels, startTC: tcToFrames(r.startTC, r.fps) }); if (oldFps !== r.fps) conformFps(q, oldFps, r.fps); });
  app.player.invalidate();
}

function conformFps(q, a, b) {
  const k = b / a;
  for (const t of allTracks(q)) { for (const c of t.clips) { c.start = Math.round(c.start * k); c.dur = Math.max(1, Math.round(c.dur * k)); } for (const tr of t.transitions) { tr.start = Math.round(tr.start * k); tr.dur = Math.max(1, Math.round(tr.dur * k)); } }
  for (const m of q.markers) m.frame = Math.round(m.frame * k);
  q.playhead = Math.round(q.playhead * k);
}

export function newSequenceFromItems(items) {
  const first = items.find((i) => i.type === 'media' && i.info.hasVideo) || items[0];
  if (!first) return;
  const w = first.info ? first.info.width || 1920 : 1920, hh = first.info ? first.info.height || 1080 : 1080;
  const f = first.info && first.info.fps ? first.info.fps : 24;
  const s = createSequence(first.name, { width: w, height: hh, fps: f, colorSpace: first.info && first.info.hdr ? (first.info.colorTransfer === 'arib-std-b67' ? 'rec2100hlg' : 'rec2100pq') : 'rec709' }, first.parent);
  app.store.transact('New Sequence From Clip', () => {
    app.store.project.items[s.id] = s;
    let pos = 0;
    for (const it of items) {
      const d = itemDuration(app.store.project, it);
      const dur = isFinite(d) ? d : (app.prefs.get('timeline.stillDuration') || 5);
      const inT = it.inPoint || 0, outT = it.outPoint != null ? it.outPoint : dur;
      const placed = E.editItemIntoSequence(app.store.project, s, it, inT, outT, pos, 'overwrite', { videoTrack: s.tracks.video[0], audioTrack: s.tracks.audio[0] });
      pos += placed.length ? placed[0].dur : 0;
    }
  }, ['items']);
  app.store.setActiveSequence(s.id);
}

export function duplicateSequence(id) {
  const s = app.store.project.items[id || app.store.activeSeqId]; if (!s) return;
  const c = cloneSequence(s);
  app.store.transact('Duplicate Sequence', () => { app.store.project.items[c.id] = c; }, ['items']);
  app.store.setActiveSequence(c.id);
}

// ---------- Source monitor edits (3-point editing) ----------
export function sourceRange() {
  const it = app.player.sourceItem; if (!it) return null;
  const d = itemDuration(app.store.project, it);
  const dur = isFinite(d) ? d : (app.prefs.get('timeline.stillDuration') || 5);
  const a = it.inPoint != null ? it.inPoint : (it.outPoint != null ? 0 : 0);
  const b = it.outPoint != null ? it.outPoint + 1 / app.player.sourceFps() : dur;
  return { item: it, a, b: Math.max(a + 1 / app.player.sourceFps(), b) };
}

export function sourceEdit(mode = 'overwrite', opts = {}) {
  const s = seq(); const r = sourceRange();
  if (!s) return toast('Open a sequence first', 'warn');
  if (!r) return toast('Load a clip in the Source Monitor first', 'warn');
  if (r.item.type === 'sequence' && seqContains(app.store.project, r.item.id, s.id)) return toast('A sequence cannot be nested inside itself', 'error');
  // program in/out (3-point): if program in set, place there; if only program out set, back-time
  let at = s.inPoint != null ? s.inPoint : s.playhead;
  let srcA = r.a, srcB = r.b;
  if (s.inPoint != null && s.outPoint != null && r.item.inPoint == null) srcB = srcA + (s.outPoint - s.inPoint + 1) / s.settings.fps;
  else if (s.inPoint == null && s.outPoint != null) at = Math.max(0, s.outPoint + 1 - Math.round((srcB - srcA) * s.settings.fps));
  const video = opts.video !== undefined ? opts.video : app.panels.source ? app.panels.source.useVideo !== false : true;
  const audio = opts.audio !== undefined ? opts.audio : app.panels.source ? app.panels.source.useAudio !== false : true;
  let placed = [];
  tx(mode === 'insert' ? 'Insert' : 'Overwrite', (q) => { placed = E.editItemIntoSequence(app.store.project, q, r.item, srcA, srcB, at, mode, { video, audio }); });
  if (placed.length) {
    const end = Math.max(...placed.map((c) => c.start + c.dur));
    if (app.prefs.get('timeline.playheadSnapOnEdit') !== false) app.player.seek(end);
    s.inPoint = null; s.outPoint = null;
    app.store.selectClips(placed.map((c) => c.id));
  }
}

export function replaceEdit() {
  const s = seq(); const r = sourceRange();
  const sel = selectedClips()[0] || (s && targetClipAtPlayhead());
  if (!s || !r || !sel) return toast('Select a clip and load replacement media in the Source Monitor', 'warn');
  const clip = sel.clip || sel;
  // align source frame under the source playhead to the program playhead
  const offset = (s.playhead - clip.start) / s.settings.fps * clip.speed;
  tx('Replace Edit', (q) => { for (const c of linkedClips(q, clip)) E.replaceClipSource(app.store.project, q, c, r.item, Math.max(0, app.player.sourceTime - offset)); });
}

export function fitToFill() {
  const s = seq(); const r = sourceRange();
  if (!s || !r || s.inPoint == null || s.outPoint == null) return toast('Set In and Out points in both monitors', 'warn');
  let placed = [];
  tx('Fit to Fill', (q) => {
    placed = E.editItemIntoSequence(app.store.project, q, r.item, r.a, r.b, q.inPoint, 'overwrite');
    const target = q.outPoint + 1 - q.inPoint;
    for (const c of placed) { const tr = allTracks(q).find((t) => t.clips.includes(c)); E.rateStretch(app.store.project, q, tr, c, target); }
  });
}

function targetClipAtPlayhead() {
  const s = seq();
  for (const t of [...s.tracks.video].reverse()) { if (!t.target) continue; const c = clipAt(t, s.playhead); if (c) return { clip: c, track: t }; }
  for (const t of [...s.tracks.video].reverse()) { const c = clipAt(t, s.playhead); if (c) return { clip: c, track: t }; }
  for (const t of s.tracks.audio) { const c = clipAt(t, s.playhead); if (c) return { clip: c, track: t }; }
  return null;
}

// ---------- Delete / lift / extract ----------
export function deleteSelection(ripple = false) {
  const s = seq(); if (!s) return;
  if (app.store.selection.transition) {
    const { trackId, id } = app.store.selection.transition;
    tx('Delete Transition', (q) => { const t = allTracks(q).find((x) => x.id === trackId); if (t) t.transitions = t.transitions.filter((x) => x.id !== id); });
    app.store.selectTransition(null, null);
    return;
  }
  const ids = selIds();
  if (!ids.size) {
    // delete gap at playhead on a targeted track
    if (ripple) return removeGapAtPlayhead();
    return;
  }
  tx(ripple ? 'Ripple Delete' : 'Clear', (q) => { if (ripple) E.rippleDelete(q, ids); else E.removeClips(q, ids); });
  app.store.selectClips([]);
}

export function removeGapAtPlayhead() {
  const s = seq();
  const t = allTracks(s).find((x) => x.target && E.gapAt(x, s.playhead)) || allTracks(s).find((x) => E.gapAt(x, s.playhead));
  if (!t) return;
  tx('Ripple Delete Gap', (q) => { const tr = allTracks(q).find((x) => x.id === t.id); E.closeGap(q, tr, E.gapAt(tr, q.playhead)); });
}

export function closeAllGaps() {
  tx('Close Gaps', (q) => {
    const tracks = allTracks(q).filter((t) => t.target);
    E.closeAllGaps(q, tracks.length ? tracks : allTracks(q));
  });
}
export function fillGaps() { tx('Fill Gaps', (q) => E.fillGaps(app.store.project, q, allTracks(q).filter((t) => t.target))); }

export function liftExtract(extract) {
  const s = seq(); if (!s) return;
  if (s.inPoint == null || s.outPoint == null) return toast('Set sequence In and Out points first', 'warn');
  const tracks = allTracks(s).filter((t) => t.target && !t.locked);
  tx(extract ? 'Extract' : 'Lift', (q) => { const ts = allTracks(q).filter((t) => t.target && !t.locked); if (extract) E.extractRange(q, q.inPoint, q.outPoint + 1, ts); else E.liftRange(q, q.inPoint, q.outPoint + 1, ts); });
  void tracks;
  if (extract) { s.outPoint = null; }
  app.player.seek(s.inPoint);
}

// ---------- Razor / edits ----------
export function addEdit(allTracksToo = false) {
  const s = seq(); if (!s) return;
  const sel = selectedClips();
  tx('Add Edit', (q) => {
    let tracks;
    if (sel.length && !allTracksToo) tracks = allTracks(q).filter((t) => t.clips.some((c) => app.store.selection.clips.has(c.id) && q.playhead > c.start && q.playhead < c.start + c.dur));
    else tracks = allTracksToo ? allTracks(q) : allTracks(q).filter((t) => t.target);
    E.razorAt(q, q.playhead, tracks);
  });
}

export function razorAtFrame(track, frame, all = false) {
  tx('Razor', (q) => {
    const t = allTracks(q).find((x) => x.id === track.id);
    const c = t && clipAt(t, frame);
    const tracks = all ? allTracks(q) : [t, ...(c ? linkedClips(q, c).map((lc) => allTracks(q).find((x) => x.clips.includes(lc))) : [])].filter(Boolean);
    E.razorAt(q, frame, [...new Set(tracks)]);
  });
}

// Q / W ripple trim previous/next edit to playhead; alt = non-ripple
export function trimToPlayhead(side, ripple = true) {
  const s = seq(); if (!s) return;
  const f = s.playhead;
  const tracks = allTracks(s).filter((t) => t.target && !t.locked);
  const hits = tracks.map((t) => clipAt(t, f)).filter(Boolean);
  if (!hits.length) return;
  const a = side === 'start' ? Math.max(...hits.map((c) => c.start)) : f;
  const b = side === 'start' ? f : Math.min(...hits.map((c) => c.start + c.dur));
  if (b <= a) return;
  tx(ripple ? 'Ripple Trim' : 'Trim', (q) => {
    const ts = allTracks(q).filter((t) => t.target && !t.locked);
    if (ripple) E.extractRange(q, a, b, ts); else E.liftRange(q, a, b, ts);
  });
  if (side === 'start' && ripple) app.player.seek(a);
}

export function extendToPlayhead() {
  const s = seq(); if (!s) return;
  const pts = app.store.selection.editPoints;
  const sel = selectedClips();
  tx('Extend Edit', (q) => {
    for (const { clip, track } of sel) {
      const c = findClip(q, clip.id); if (!c) continue;
      const mid = c.clip.start + c.clip.dur / 2;
      if (q.playhead >= mid) E.trimTail(app.store.project, q, c.track, c.clip, q.playhead - (c.clip.start + c.clip.dur), 'normal');
      else E.trimHead(app.store.project, q, c.track, c.clip, q.playhead - c.clip.start, 'normal');
    }
    void pts;
  });
}

export function nudgeSelection(frames) {
  const sel = selectedClips(); if (!sel.length) return;
  tx('Nudge', (q) => {
    const moves = sel.map(({ clip, track }) => { const f = findClip(q, clip.id); return { clip: f.clip, fromTrack: f.track, toTrack: f.track, newStart: Math.max(0, f.clip.start + frames) }; });
    E.moveClips(q, moves, 'overwrite');
  }, { coalesce: 'nudge' });
}

export function nudgeTrack(dir) {
  const sel = selectedClips(); if (!sel.length) return;
  tx('Move to Track', (q) => {
    const moves = [];
    for (const { clip } of sel) {
      const f = findClip(q, clip.id); const arr = q.tracks[f.kind]; const i = arr.indexOf(f.track) + (f.kind === 'video' ? dir : -dir);
      if (i < 0) continue; E.ensureTracks(q, f.kind, i + 1);
      moves.push({ clip: f.clip, fromTrack: f.track, toTrack: arr[i], newStart: f.clip.start });
    }
    E.moveClips(q, moves, 'overwrite');
  });
}

// ---------- Selection ----------
export function selectAtPlayhead() {
  const s = seq(); if (!s) return;
  const ids = [];
  for (const t of allTracks(s)) { if (!t.target) continue; const c = clipAt(t, s.playhead); if (c) ids.push(c.id); }
  app.store.selectClips([...expandLinked(ids)]);
}
export function selectAll() { const s = seq(); if (!s) return; app.store.selectClips(allTracks(s).flatMap((t) => t.clips.map((c) => c.id))); }
export function deselectAll() { app.store.selectClips([]); app.store.selectItems([]); }
export function selectForward(fromFrame, trackOnly = null, backward = false) {
  const s = seq(); if (!s) return;
  const ids = [];
  for (const t of trackOnly ? [trackOnly] : allTracks(s)) for (const c of t.clips) if (backward ? c.start < fromFrame : c.start + c.dur > fromFrame) ids.push(c.id);
  app.store.selectClips(ids);
}

// ---------- Link / group / enable / nest ----------
export function toggleLink() {
  const sel = selectedClips(); if (!sel.length) return;
  const ids = selIds();
  const linked = sel.some(({ clip }) => clip.linkId && sel.filter((x) => x.clip.linkId === clip.linkId).length > 1);
  tx(linked ? 'Unlink' : 'Link', (q) => (linked ? E.unlinkClips(q, ids) : E.linkClips(q, ids)));
}
export function toggleGroup(ungroup) { const ids = selIds(); if (!ids.size) return; tx(ungroup ? 'Ungroup' : 'Group', (q) => (ungroup ? E.ungroupClips(q, ids) : E.groupClips(q, ids))); }
export function toggleEnable() { const ids = selIds(); if (!ids.size) return; tx('Enable', (q) => E.setEnabled(q, ids)); }
export async function nest() {
  const ids = selIds(); if (!ids.size) return;
  const name = await promptDialog('Nested Sequence Name', 'Nested Sequence ' + (Object.values(app.store.project.items).filter((i) => i.type === 'sequence').length));
  if (!name) return;
  let res;
  app.store.transact('Nest', () => { res = E.nestClips(app.store.project, seq(), ids, name); }, ['items']);
  if (res) app.store.selectClips(res.clips.map((c) => c.id));
}
export function makeSubsequence() {
  const s = seq(); if (!s) return;
  const a = s.inPoint != null ? s.inPoint : 0, b = s.outPoint != null ? s.outPoint + 1 : seqDuration(s);
  const sub = cloneSequence(s, s.name + ' Sub');
  for (const t of allTracks(sub)) {
    E.clearRange(sub, t, 0, a); E.clearRange(sub, t, b, 1e12);
    for (const c of t.clips) c.start -= a; for (const tr of t.transitions) tr.start -= a;
  }
  sub.markers = sub.markers.filter((m) => m.frame >= a && m.frame < b).map((m) => ({ ...m, frame: m.frame - a }));
  sub.inPoint = sub.outPoint = null; sub.playhead = 0;
  app.store.transact('Make Subsequence', () => { app.store.project.items[sub.id] = sub; }, ['items']);
  toast('Subsequence created in the Project panel');
}

// ---------- Speed ----------
export async function speedDialog() {
  const sel = selectedClips(); if (!sel.length) return toast('Select clips first', 'warn');
  const c = sel[0].clip;
  const r = await formDialog('Clip Speed / Duration', [
    { key: 'speed', label: 'Speed', type: 'number', min: 1, max: 100000, step: 0.1, note: 'Percent of normal speed' },
    { key: 'duration', label: 'Duration', note: 'Timecode; leave unchanged to keep the speed value' },
    { key: 'reverse', label: '', type: 'check', text: 'Reverse speed' },
    { key: 'pitch', label: '', type: 'check', text: 'Maintain audio pitch' },
    { key: 'ripple', label: '', type: 'check', text: 'Ripple edit, shifting trailing clips' },
    { key: 'interp', label: 'Time interpolation', type: 'select', string: true, options: [['sampling', 'Frame Sampling'], ['blend', 'Frame Blending'], ['optical', 'Optical Flow']] },
  ], { speed: +(c.speed * 100).toFixed(2), duration: framesToTC(c.dur, fps(), { dropFrame: false }), reverse: c.reverse, pitch: c.maintainPitch, ripple: false, interp: c.frameInterp || 'sampling' });
  if (!r) return;
  const { tcToFrames } = await import('../core/timecode.js');
  const durF = tcToFrames(r.duration, fps());
  tx('Speed/Duration', (q) => {
    for (const { clip } of sel) {
      const f = findClip(q, clip.id); if (!f) continue;
      let speed = r.speed / 100;
      if (durF && durF !== c.dur && Math.abs(r.speed / 100 - c.speed) < 1e-6) speed = f.clip.speed * f.clip.dur / durF;
      E.setSpeed(app.store.project, q, f.track, f.clip, { speed, reverse: r.reverse, maintainPitch: r.pitch, ripple: r.ripple, frameInterp: r.interp });
    }
  });
  if (r.interp === 'optical' || r.interp === 'blend') for (const { clip } of sel) prepareRetime(clip.id);
}

export async function prepareRetime(clipId) {
  const s = seq(); const f = findClip(s, clipId); if (!f) return;
  const c = f.clip; const item = app.store.project.items[c.src.itemId];
  if (!item || item.type !== 'media' || c.speed >= 1 || c.kind !== 'video') { if (c.retimed) { c.retimed = null; app.player.invalidate(); } return; }
  const { jobs } = await import('./jobs.js');
  jobs.run(`Optical flow: ${c.name}`, async (j) => {
    const path = await window.native.call('media:retime', item.path, { speed: c.speed, method: c.frameInterp === 'blend' ? 'blend' : 'optical', fps: item.info.fps, jobId: j.id });
    const g = findClip(app.store.seq, clipId); if (!g) return;
    g.clip.retimed = { path, ready: true, speed: c.speed, srcScale: 1 / c.speed };
    app.store.markDirty(); app.player.invalidate();
  }, 'retime').catch((e) => toast('Optical flow failed: ' + e.message, 'error'));
}

export function addFrameHold(mode) {
  const s = seq(); const sel = selectedClips();
  const target = sel.find((x) => s.playhead >= x.clip.start && s.playhead < x.clip.start + x.clip.dur && x.clip.kind === 'video') || (targetClipAtPlayhead());
  if (!target) return toast('Place the playhead over a video clip', 'warn');
  tx(mode === 'insert' ? 'Insert Frame Hold Segment' : 'Add Frame Hold', (q) => {
    const f = findClip(q, target.clip.id);
    if (mode === 'insert') E.insertFreezeFrame(app.store.project, q, f.track, f.clip, q.playhead, Math.round(2 * q.settings.fps));
    else E.addFrameHold(q, f.track, f.clip, q.playhead, mode === 'whole' ? 'whole' : 'segment');
  });
}

export function reverseClips() { const sel = selectedClips(); if (!sel.length) return; tx('Reverse', (q) => { for (const { clip } of sel) { const f = findClip(q, clip.id); f.clip.reverse = !f.clip.reverse; } }); }
export function toggleTimeRemap() {
  const sel = selectedClips(); if (!sel.length) return;
  tx('Time Remapping', (q) => {
    for (const { clip } of sel) {
      const f = findClip(q, clip.id); const c = f.clip;
      c.timeRemap = !c.timeRemap;
      const tr = c.effects.find((e) => e.type === 'timeremap');
      if (c.timeRemap && tr && !(tr.keyframes.speed || []).length) tr.keyframes.speed = [{ t: 0, v: c.speed * 100, interp: 'linear' }, { t: c.dur, v: c.speed * 100, interp: 'linear' }];
    }
  });
}

// ---------- Scale ----------
export function scaleToFrame(mode = 'set') {
  const sel = selectedClips().filter((x) => x.clip.kind === 'video'); if (!sel.length) return;
  tx(mode === 'set' ? 'Set to Frame Size' : 'Scale to Frame Size', (q) => {
    for (const { clip } of sel) {
      const f = findClip(q, clip.id);
      if (mode === 'fill') { const item = app.store.project.items[f.clip.src.itemId]; const w = item && item.info ? item.info.width : q.settings.width, hh = item && item.info ? item.info.height : q.settings.height; f.clip.setToFrame = false; const mo = f.clip.effects.find((e) => e.type === 'motion'); mo.params.scale = Math.max(q.settings.width / w, q.settings.height / hh) * 100; }
      else { f.clip.setToFrame = !f.clip.setToFrame; }
    }
  });
}

// ---------- Markers & In/Out ----------
export function addMarker(opts = {}) {
  const s = seq();
  const sel = selectedClips();
  const frame = s ? s.playhead : 0;
  if (app.store.focusPanel === 'source' && app.player.sourceItem) {
    const it = app.player.sourceItem;
    app.store.transact('Add Marker', () => { it.markers = it.markers || []; it.markers.push({ id: uid('mk'), frame: Math.round(app.player.sourceTime * app.player.sourceFps()), dur: 0, name: '', comment: '', color: 'green', type: 'comment' }); }, ['items']);
    return;
  }
  if (!s) return;
  if (sel.length === 1 && opts.clip && frame >= sel[0].clip.start && frame < sel[0].clip.start + sel[0].clip.dur) {
    tx('Add Clip Marker', (q) => { const f = findClip(q, sel[0].clip.id); f.clip.markers.push({ id: uid('mk'), frame: frame - f.clip.start, dur: 0, name: '', comment: '', color: 'rose', type: 'comment' }); });
    return;
  }
  const existing = s.markers.find((m) => m.frame === frame);
  if (existing) { if (opts.edit !== false) editMarker(existing); return; }
  tx('Add Marker', (q) => { q.markers.push({ id: uid('mk'), frame, dur: 0, name: opts.name || '', comment: opts.comment || '', color: opts.color || 'green', type: opts.type || 'comment' }); q.markers.sort((a, b) => a.frame - b.frame); });
}

export async function editMarker(m) {
  const s = seq(); if (!s) return;
  const r = await formDialog('Marker', [
    { key: 'name', label: 'Name' },
    { key: 'dur', label: 'Duration (frames)', type: 'number', min: 0 },
    { key: 'comment', label: 'Comments', type: 'textarea', rows: 4 },
    { key: 'color', label: 'Color', type: 'select', string: true, options: Object.keys(LABEL_COLORS).filter((k) => k !== 'none').map((k) => [k, k[0].toUpperCase() + k.slice(1)]) },
    { key: 'type', label: 'Type', type: 'select', string: true, options: [['comment', 'Comment Marker'], ['chapter', 'Chapter Marker'], ['segmentation', 'Segmentation Marker'], ['web', 'Web Link']] },
    { key: 'url', label: 'URL', show: (v) => v.type === 'web' },
  ], { ...m }, { left: [{ label: 'Delete', action: (close) => { tx('Delete Marker', (q) => { q.markers = q.markers.filter((x) => x.id !== m.id); }); close(null); } }] });
  if (!r) return;
  tx('Edit Marker', (q) => { const x = q.markers.find((y) => y.id === m.id); if (x) Object.assign(x, r); });
}

export function gotoMarker(dir) {
  const s = seq(); if (!s) return;
  const list = s.markers.map((m) => m.frame).sort((a, b) => a - b);
  const f = dir > 0 ? list.find((x) => x > s.playhead) : [...list].reverse().find((x) => x < s.playhead);
  if (f != null) app.player.seek(f);
}
export function clearMarkers(all) { const s = seq(); if (!s) return; tx('Clear Markers', (q) => { q.markers = all ? [] : q.markers.filter((m) => m.frame !== q.playhead); }); }

function monitorTarget() { return app.store.focusPanel === 'source' ? 'source' : 'program'; }

export function markIn() {
  if (monitorTarget() === 'source') { const it = app.player.sourceItem; if (!it) return; app.store.transact('Mark In', () => { it.inPoint = app.player.sourceTime; if (it.outPoint != null && it.outPoint < it.inPoint) it.outPoint = null; }, [it.id]); return; }
  const s = seq(); if (!s) return; s.inPoint = s.playhead; if (s.outPoint != null && s.outPoint < s.inPoint) s.outPoint = null; app.store.markDirty(); app.store.touch('inout');
}
export function markOut() {
  if (monitorTarget() === 'source') { const it = app.player.sourceItem; if (!it) return; app.store.transact('Mark Out', () => { it.outPoint = app.player.sourceTime; if (it.inPoint != null && it.inPoint > it.outPoint) it.inPoint = null; }, [it.id]); return; }
  const s = seq(); if (!s) return; s.outPoint = s.playhead; if (s.inPoint != null && s.inPoint > s.outPoint) s.inPoint = null; app.store.markDirty(); app.store.touch('inout');
}
export function clearInOut(which = 'both') {
  if (monitorTarget() === 'source') { const it = app.player.sourceItem; if (!it) return; app.store.transact('Clear In/Out', () => { if (which !== 'out') it.inPoint = null; if (which !== 'in') it.outPoint = null; }, [it.id]); return; }
  const s = seq(); if (!s) return; if (which !== 'out') s.inPoint = null; if (which !== 'in') s.outPoint = null; app.store.markDirty(); app.store.touch('inout');
}
export function markClip() {
  const s = seq(); if (!s) return;
  const sel = selectedClips();
  let a, b;
  if (sel.length) { a = Math.min(...sel.map((x) => x.clip.start)); b = Math.max(...sel.map((x) => x.clip.start + x.clip.dur)) - 1; }
  else { const c = targetClipAtPlayhead(); if (!c) return; a = c.clip.start; b = c.clip.start + c.clip.dur - 1; }
  s.inPoint = a; s.outPoint = b; app.store.touch('inout');
}
export function gotoInOut(which) {
  if (monitorTarget() === 'source') { const it = app.player.sourceItem; if (!it) return; const t = which === 'in' ? it.inPoint : it.outPoint; if (t != null) app.player.seekSource(t); return; }
  const s = seq(); if (!s) return; const f = which === 'in' ? s.inPoint : s.outPoint; if (f != null) app.player.seek(f);
}

export function gotoEdit(dir) {
  const s = seq(); if (!s) return;
  const pts = editPoints(s, { targetedOnly: allTracks(s).some((t) => t.target) });
  const f = dir > 0 ? pts.find((x) => x > s.playhead) : [...pts].reverse().find((x) => x < s.playhead);
  if (f != null) app.player.seek(f);
  if (app.prefs.get('timeline.selectionFollowsPlayhead')) selectAtPlayhead();
}

// ---------- Transitions ----------
export function applyDefaultTransition(kind = 'both') {
  const s = seq(); if (!s) return;
  const vType = app.prefs.get('timeline.defaultVideoTransition') || 'cross_dissolve';
  const aType = app.prefs.get('timeline.defaultAudioTransition') || 'constant_power';
  const vDur = app.prefs.get('timeline.videoTransitionDur') || Math.round(s.settings.fps);
  const aDur = app.prefs.get('timeline.audioTransitionDur') || Math.round(s.settings.fps / 2);
  const sel = selectedClips();
  tx('Apply Transition', (q) => {
    const edges = [];
    if (sel.length) {
      // apply at both ends of each selected clip
      for (const { clip, track } of sel) { const t = allTracks(q).find((x) => x.id === track.id); edges.push([t, clip.start], [t, clip.start + clip.dur]); }
    } else {
      // nearest edit point to the playhead on targeted tracks
      for (const t of allTracks(q)) {
        if (!t.target || t.locked) continue;
        let best = null, bd = Infinity;
        for (const c of t.clips) for (const e of [c.start, c.start + c.dur]) { const d = Math.abs(e - q.playhead); if (d < bd) { bd = d; best = e; } }
        if (best != null) edges.push([t, best]);
      }
    }
    for (const [t, edge] of edges) {
      if (t.kind === 'video' && kind === 'audio') continue;
      if (t.kind === 'audio' && kind === 'video') continue;
      E.addTransition(app.store.project, q, t, edge, t.kind === 'video' ? vType : aType, t.kind === 'video' ? vDur : aDur);
    }
  });
}

export function addTransitionAt(track, edge, type, dur, align) {
  tx('Add Transition', (q) => { const t = allTracks(q).find((x) => x.id === track.id); const kindOk = t.kind === 'audio' ? !!AUDIO_TRANSITIONS[type] : !AUDIO_TRANSITIONS[type]; if (!kindOk) return; E.addTransition(app.store.project, q, t, edge, type, dur || (t.kind === 'video' ? app.prefs.get('timeline.videoTransitionDur') : app.prefs.get('timeline.audioTransitionDur')) || 24, { align }); });
}

// ---------- Effects ----------
export function applyEffect(type, clipIds, opts = {}) {
  const s = seq(); if (!s) return;
  const ids = clipIds || [...selIds()];
  if (!ids.length) return toast('Select clips to apply the effect to', 'warn');
  const isAudio = !!(defFor(type) && ['Intrinsic'].indexOf(defFor(type).category) < 0 && (window.__audioFx || {})[type]);
  tx('Apply ' + (defFor(type) ? defFor(type).name : type), (q) => {
    for (const id of ids) {
      const f = findClip(q, id); if (!f) continue;
      const audioFx = !!(app.audioFxDefs[type]);
      if (audioFx !== (f.clip.kind === 'audio')) continue;
      const fx = makeEffect(type, opts.params || {});
      if (opts.preset) { Object.assign(fx.params, deepClone(opts.preset.params)); fx.keyframes = deepClone(opts.preset.keyframes || {}); }
      // insert before intrinsics so effects render first (order of non-intrinsic list matters only)
      f.clip.effects.push(fx);
    }
  });
  void isAudio;
}

export function applyEffectToTrack(trackId, type) {
  tx('Apply Track Effect', (q) => { const t = allTracks(q).find((x) => x.id === trackId); if (t) t.audio.effects.push(makeEffect(type)); });
}

export function applyPreset(preset, clipIds) {
  const ids = clipIds || [...selIds()];
  tx('Apply Preset', (q) => {
    for (const id of ids) {
      const f = findClip(q, id); if (!f) continue;
      for (const e of preset.effects) {
        if (!!app.audioFxDefs[e.type] !== (f.clip.kind === 'audio')) continue;
        const copy = deepClone(e); copy.id = uid('fx');
        if (preset.anchor === 'out') for (const k of Object.keys(copy.keyframes || {})) for (const kf of copy.keyframes[k]) kf.t = f.clip.dur - (preset.dur || 0) + kf.t;
        if (preset.scale && preset.dur) for (const k of Object.keys(copy.keyframes || {})) for (const kf of copy.keyframes[k]) kf.t = kf.t * f.clip.dur / preset.dur;
        const intrinsicIdx = f.clip.effects.findIndex((x) => x.type === copy.type && defFor(copy.type) && defFor(copy.type).intrinsic);
        if (intrinsicIdx >= 0) f.clip.effects[intrinsicIdx] = copy; else f.clip.effects.push(copy);
      }
    }
  });
}

export function removeEffects(clipIds) {
  const ids = clipIds || [...selIds()];
  tx('Remove Effects', (q) => { for (const id of ids) { const f = findClip(q, id); if (!f) continue; const fresh = createClip(f.clip.kind, f.clip.src, 0, 1, 0).effects; f.clip.effects = fresh; } });
}

// ---------- Clipboard ----------
export function copy(cut = false) {
  const s = seq();
  if (app.store.focusPanel === 'project') { app.store.clipboard = { kind: 'items', ids: [...app.store.selection.items] }; return; }
  if (!s) return;
  const ids = selIds(); if (!ids.size) return;
  app.store.clipboard = E.copyClips(s, ids);
  if (cut) tx('Cut', (q) => E.removeClips(q, ids));
}
export function paste(mode = 'overwrite') {
  const cb = app.store.clipboard; const s = seq();
  if (!cb) return;
  if (cb.kind === 'items') { import('./media.js').then((m) => m.duplicateItems(cb.ids)); return; }
  if (!s) return;
  let placed = [];
  tx(mode === 'insert' ? 'Paste Insert' : 'Paste', (q) => { placed = E.pasteClips(q, cb, q.playhead, mode); });
  if (placed.length) { app.store.selectClips(placed.map((c) => c.id)); app.player.seek(Math.max(...placed.map((c) => c.start + c.dur))); }
}
export async function pasteAttributes() {
  const cb = app.store.clipboard; if (!cb || cb.kind !== 'clips') return toast('Copy a clip first', 'warn');
  const src = cb.items[0].c;
  const vsrc = cb.items.find((i) => i.k === 'video'), asrc = cb.items.find((i) => i.k === 'audio');
  const r = await formDialog('Paste Attributes', [
    { type: 'group', label: 'Video attributes' }, { key: 'motion', label: '', type: 'check', text: 'Motion' }, { key: 'opacity', label: '', type: 'check', text: 'Opacity' }, { key: 'timeremap', label: '', type: 'check', text: 'Time Remapping' }, { key: 'effects', label: '', type: 'check', text: 'Effects' },
    { type: 'group', label: 'Audio attributes' }, { key: 'volume', label: '', type: 'check', text: 'Volume' }, { key: 'channel_volume', label: '', type: 'check', text: 'Channel Volume' }, { key: 'panner', label: '', type: 'check', text: 'Panner' },
    { type: 'group', label: 'Options' }, { key: 'scaleKeyframes', label: '', type: 'check', text: 'Scale attribute times' }, { key: 'speed', label: '', type: 'check', text: 'Speed' },
  ], { motion: true, opacity: true, timeremap: false, effects: true, volume: true, channel_volume: true, panner: true, scaleKeyframes: true, speed: false });
  if (!r) return;
  tx('Paste Attributes', (q) => {
    for (const { clip } of selectedClips()) {
      const f = findClip(q, clip.id); if (!f) continue;
      const source = f.clip.kind === 'video' ? (vsrc || {}).c : (asrc || {}).c;
      if (source) E.pasteAttributes(source, f.clip, r);
    }
  });
  void src;
}
export function duplicateInPlace() { copy(); const cb = app.store.clipboard; if (!cb) return; const s = seq(); const end = Math.max(...selectedClips().map((x) => x.clip.start + x.clip.dur)); const save = s.playhead; s.playhead = end; paste('overwrite'); s.playhead = save; }

// ---------- Match frame / reveal ----------
export function matchFrame() {
  const s = seq(); if (!s) return;
  const t = selectedClips()[0] || targetClipAtPlayhead();
  if (!t) return;
  const item = app.store.project.items[t.clip.src.itemId]; if (!item) return;
  const tt = clipSourceTime(t.clip, s.playhead, s.settings.fps);
  app.ui.openInSource(item.id, tt);
  if (item.type === 'media') { item.inPoint = t.clip.srcIn; item.outPoint = t.clip.srcIn + t.clip.dur / s.settings.fps * t.clip.speed; }
}
export function reverseMatchFrame() {
  const s = seq(); const it = app.player.sourceItem; if (!s || !it) return;
  const t = app.player.sourceTime;
  for (const tr of allTracks(s)) for (const c of tr.clips) if (c.src.itemId === it.id) { const a = c.srcIn, b = a + c.dur / s.settings.fps * c.speed; if (t >= a && t < b) { app.player.seek(c.start + Math.round((t - a) / c.speed * s.settings.fps)); return; } }
  toast('That source frame is not in the active sequence');
}
export function revealInProject() {
  const t = selectedClips()[0]; if (!t) return;
  app.store.selectItems([t.clip.src.itemId]);
  app.dock.openPanel('project');
  app.panels.project && app.panels.project.reveal(t.clip.src.itemId);
}
export function openNested() {
  const t = selectedClips()[0]; if (!t || t.clip.src.type !== 'sequence') return;
  const s = seq();
  const nested = app.store.project.items[t.clip.src.itemId];
  nested.playhead = Math.round(clipSourceTime(t.clip, s.playhead, s.settings.fps) * nested.settings.fps);
  app.store.setActiveSequence(nested.id);
}

// ---------- Tracks ----------
export async function addTracksDialog() {
  const r = await formDialog('Add Tracks', [
    { key: 'v', label: 'Add video tracks', type: 'number', min: 0, max: 99 }, { key: 'vPos', label: 'Placement', type: 'select', string: true, options: [['after', 'After last track'], ['before', 'Before first track']] },
    { key: 'a', label: 'Add audio tracks', type: 'number', min: 0, max: 99 }, { key: 'aType', label: 'Track type', type: 'select', string: true, options: [['stereo', 'Stereo'], ['mono', 'Mono'], ['5.1', '5.1']] },
    { key: 'b', label: 'Add audio submix tracks', type: 'number', min: 0, max: 16 },
  ], { v: 1, vPos: 'after', a: 1, aType: 'stereo', b: 0 });
  if (!r) return;
  tx('Add Tracks', (q) => {
    for (let i = 0; i < r.v; i++) E.addTrack(q, 'video', r.vPos === 'before' ? 0 : null);
    for (let i = 0; i < r.a; i++) E.addTrack(q, 'audio', null, { channelType: r.aType });
    for (let i = 0; i < r.b; i++) q.buses.push({ id: uid('bus'), name: `Submix ${q.buses.length + 1}`, volume: 0, pan: 0, effects: [], mute: false });
  });
}
export function deleteEmptyTracks() { tx('Delete Empty Tracks', (q) => E.deleteEmptyTracks(q)); }

// ---------- Audio ----------
export async function audioGainDialog() {
  const sel = selectedClips().filter((x) => x.clip.kind === 'audio');
  if (!sel.length) return toast('Select audio clips', 'warn');
  const r = await formDialog('Audio Gain', [
    { key: 'mode', label: '', type: 'select', string: true, options: [['set', 'Set Gain to'], ['adjust', 'Adjust Gain by'], ['peak', 'Normalize Max Peak to'], ['all', 'Normalize All Peaks to'], ['lufs', 'Normalize Loudness to (LUFS)']] },
    { key: 'value', label: 'dB', type: 'number', step: 0.1 },
  ], { mode: 'peak', value: -3 });
  if (!r) return;
  if (r.mode === 'set' || r.mode === 'adjust') { tx('Audio Gain', (q) => { for (const { clip } of sel) { const f = findClip(q, clip.id); f.clip.gain = r.mode === 'set' ? r.value : (f.clip.gain || 0) + r.value; } }); return; }
  await normalizeClips(sel.map((x) => x.clip.id), r.mode, r.value);
}

export async function normalizeClips(ids, mode, target) {
  const s = seq();
  const { AudioEngine } = await import('../engine/audio-engine.js');
  const results = new Map();
  let maxPeak = -96;
  for (const id of ids) {
    const f = findClip(s, id); if (!f) continue;
    const item = app.store.project.items[f.clip.src.itemId];
    if (!item || item.type !== 'media') continue;
    const buf = await app.audio.ensure(item, f.clip.src.stream || 0);
    if (!buf) continue;
    const a = Math.floor(f.clip.srcIn * buf.sampleRate), b = Math.min(buf.length, Math.ceil((f.clip.srcIn + f.clip.dur / s.settings.fps * f.clip.speed) * buf.sampleRate));
    const sub = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: Math.max(1, b - a), sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) sub.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
    const m = AudioEngine.measure(sub);
    results.set(id, m); maxPeak = Math.max(maxPeak, m.peak);
  }
  tx('Normalize', (q) => {
    for (const [id, m] of results) {
      const f = findClip(q, id);
      if (mode === 'peak') f.clip.gain = target - maxPeak;
      else if (mode === 'all') f.clip.gain = target - m.peak;
      else if (mode === 'lufs') f.clip.gain = Math.min(target - m.integrated, -0.5 - m.peak);
    }
  });
  return results;
}

export async function audioChannelsDialog() {
  const sel = selectedClips().filter((x) => x.clip.kind === 'audio'); if (!sel.length) return;
  const r = await formDialog('Modify Audio Channels', [
    { key: 'map', label: 'Channel mapping', type: 'select', string: true, options: [['stereo', 'Stereo (as recorded)'], ['leftBoth', 'Left channel to both'], ['rightBoth', 'Right channel to both'], ['swap', 'Swap left and right'], ['mono', 'Mono sum']] },
  ], { map: 'stereo' });
  if (!r) return;
  tx('Audio Channels', (q) => {
    for (const { clip } of sel) {
      const f = findClip(q, clip.id);
      f.clip.effects = f.clip.effects.filter((e) => e.type !== 'channel_tools');
      const mode = { stereo: 'none', leftBoth: 'fillRight', rightBoth: 'fillLeft', swap: 'swap', mono: 'mono' }[r.map];
      if (mode !== 'none') f.clip.effects.push(makeEffect('channel_tools', { mode }));
    }
  });
}

// ---------- Multicam ----------
export async function createMulticamDialog(items) {
  items = items.filter((i) => i.type === 'media' && (i.info.hasVideo || i.info.hasAudio));
  if (items.length < 2) return toast('Select two or more clips in the Project panel', 'warn');
  const r = await formDialog('Create Multi-Camera Source Sequence', [
    { key: 'name', label: 'Name' },
    { key: 'sync', label: 'Synchronize using', type: 'select', string: true, options: [['audio', 'Audio'], ['timecode', 'Timecode'], ['in', 'In Points'], ['out', 'Out Points'], ['marker', 'Clip Marker'], ['none', 'Start of clips']] },
  ], { name: items[0].name + ' Multicam', sync: 'audio' }, { ok: 'Create' });
  if (!r) return;
  const { computeOffsets } = await import('./analysis.js');
  const offsets = await computeOffsets(items, r.sync);
  const s = app.store.seq;
  const v = items.find((i) => i.info.hasVideo) || items[0];
  const settings = { width: v.info.width || 1920, height: v.info.height || 1080, fps: v.info.fps || (s ? s.settings.fps : 24) };
  const mc = E.createMulticamSequence(app.store.project, items, offsets, r.name, settings, items[0].parent);
  app.store.transact('Create Multicam', () => { app.store.project.items[mc.id] = mc; }, ['items']);
  app.store.selectItems([mc.id]);
  toast('Multicam source sequence created. Edit it into a sequence and turn on the multi-camera view.');
}

export async function mergeClipsDialog(items) {
  const v = items.find((i) => i.type === 'media' && i.info.hasVideo);
  const a = items.filter((i) => i !== v && i.type === 'media' && i.info.hasAudio);
  if (!v || !a.length) return toast('Select one video clip and at least one audio clip', 'warn');
  const r = await formDialog('Merge Clips', [{ key: 'sync', label: 'Synchronize using', type: 'select', string: true, options: [['audio', 'Audio'], ['timecode', 'Timecode'], ['in', 'In Point'], ['none', 'Start']] }, { key: 'removeCam', label: '', type: 'check', text: 'Remove audio from camera clip' }], { sync: 'audio', removeCam: true }, { ok: 'Merge' });
  if (!r) return;
  const { computeOffsets } = await import('./analysis.js');
  const offs = await computeOffsets([v, ...a], r.sync);
  const fpsv = v.info.fps || 24;
  const merged = createSequence(v.name + ' Merged', { width: v.info.width, height: v.info.height, fps: fpsv }, v.parent);
  merged.tracks.audio = [];
  const base = Math.min(...offs);
  const dur = Math.round(v.info.duration * fpsv);
  merged.tracks.video[0].clips.push(createClip('video', { type: 'media', itemId: v.id }, Math.round((offs[0] - base) * fpsv), dur, 0, { name: v.name }));
  if (!r.removeCam && v.info.hasAudio) { const t = createTrack('audio', 0, { name: 'Camera' }); t.clips.push(createClip('audio', { type: 'media', itemId: v.id, stream: 0 }, Math.round((offs[0] - base) * fpsv), dur, 0, { name: v.name })); merged.tracks.audio.push(t); }
  a.forEach((it, i) => { const t = createTrack('audio', merged.tracks.audio.length, { name: it.name.slice(0, 20) }); t.clips.push(createClip('audio', { type: 'media', itemId: it.id, stream: 0 }, Math.round((offs[i + 1] - base) * fpsv), Math.round(it.info.duration * fpsv), 0, { name: it.name })); merged.tracks.audio.push(t); });
  merged.label = 'tan';
  app.store.transact('Merge Clips', () => { app.store.project.items[merged.id] = merged; }, ['items']);
  app.store.selectItems([merged.id]);
}

export async function syncSelectedClips() {
  const sel = selectedClips(); if (sel.length < 2) return toast('Select two or more clips on different tracks', 'warn');
  const r = await formDialog('Synchronize', [{ key: 'by', label: 'Synchronize point', type: 'select', string: true, options: [['audio', 'Audio'], ['start', 'Clip Start'], ['end', 'Clip End'], ['timecode', 'Timecode'], ['marker', 'Clip Marker']] }], { by: 'audio' });
  if (!r) return;
  const s = seq();
  const ref = sel[0];
  if (r.by === 'audio') {
    const { audioOffsetBetween } = await import('./analysis.js');
    const refItem = app.store.project.items[ref.clip.src.itemId];
    const moves = [];
    for (const x of sel.slice(1)) {
      const it = app.store.project.items[x.clip.src.itemId];
      const off = await audioOffsetBetween(refItem, it);
      if (off == null) continue;
      // place x so that matching source times align: x.start = ref.start + (off - (x.srcIn - ref.srcIn)) in frames
      const newStart = Math.round(ref.clip.start + (off - x.clip.srcIn + ref.clip.srcIn) * s.settings.fps);
      moves.push({ id: x.clip.id, newStart });
    }
    tx('Synchronize', (q) => { E.moveClips(q, moves.map((m) => { const f = findClip(q, m.id); return { clip: f.clip, fromTrack: f.track, toTrack: f.track, newStart: m.newStart }; }), 'overwrite'); });
    return;
  }
  tx('Synchronize', (q) => {
    const moves = [];
    for (const x of sel.slice(1)) {
      const f = findClip(q, x.clip.id);
      let ns = f.clip.start;
      if (r.by === 'start') ns = ref.clip.start;
      else if (r.by === 'end') ns = ref.clip.start + ref.clip.dur - f.clip.dur;
      else if (r.by === 'marker' && ref.clip.markers[0] && f.clip.markers[0]) ns = ref.clip.start + ref.clip.markers[0].frame - f.clip.markers[0].frame;
      moves.push({ clip: f.clip, fromTrack: f.track, toTrack: f.track, newStart: Math.max(0, ns) });
    }
    E.moveClips(q, moves, 'overwrite');
  });
}

export function enableMulticam() {
  const sel = selectedClips().filter((x) => x.clip.src.type === 'sequence');
  if (!sel.length) return toast('Select a multicam clip', 'warn');
  tx('Multi-Camera', (q) => { for (const { clip } of sel) { const f = findClip(q, clip.id); const n = app.store.project.items[f.clip.src.itemId]; if (n && n.multicam) f.clip.angle = f.clip.angle == null ? 0 : f.clip.angle; } });
}

export function multicamSwitch(angle, live = false) {
  const s = seq(); if (!s) return;
  const t = s.tracks.video.find((tr) => clipAt(tr, s.playhead) && clipAt(tr, s.playhead).src.type === 'sequence' && app.store.project.items[clipAt(tr, s.playhead).src.itemId]?.multicam);
  if (!t) return;
  const c = clipAt(t, s.playhead);
  const nested = app.store.project.items[c.src.itemId];
  if (angle >= nested.tracks.video.length) return;
  tx('Switch Camera', (q) => {
    const tr = q.tracks.video.find((x) => x.id === t.id);
    if (live) E.multicamCutAt(q, tr, q.playhead, angle);
    else { const cc = clipAt(tr, q.playhead); cc.angle = angle; }
  }, { coalesce: live ? null : 'mcswitch' });
}

export function flattenMulticam() {
  const s = seq(); if (!s) return;
  const sel = selectedClips().filter((x) => x.clip.src.type === 'sequence');
  tx('Flatten Multi-Camera', (q) => {
    for (const { clip } of sel) {
      const f = findClip(q, clip.id); const c = f.clip; const n = app.store.project.items[c.src.itemId];
      if (!n || !n.multicam) continue;
      const nt = n.tracks.video[c.angle || 0]; const src = nt && nt.clips[0]; if (!src) continue;
      const offset = c.srcIn - src.start / n.settings.fps;
      c.src = { ...src.src }; c.srcIn = src.srcIn + offset; c.name = src.name; c.angle = null;
    }
  });
}

// ---------- Auto reframe sequence ----------
export async function autoReframeSequence() {
  const s = seq(); if (!s) return;
  const r = await formDialog('Auto Reframe Sequence', [
    { key: 'aspect', label: 'Target aspect ratio', type: 'select', string: true, options: [['9:16', 'Vertical 9:16'], ['1:1', 'Square 1:1'], ['4:5', 'Vertical 4:5'], ['16:9', 'Horizontal 16:9'], ['custom', 'Custom']] },
    { key: 'w', label: 'Width', type: 'number', show: (v) => v.aspect === 'custom' }, { key: 'h', label: 'Height', type: 'number', show: (v) => v.aspect === 'custom' },
    { key: 'motion', label: 'Motion tracking', type: 'select', string: true, options: [['slow', 'Slower Motion'], ['default', 'Default'], ['fast', 'Faster Motion']] },
    { key: 'nest', label: 'Clip nesting', type: 'select', string: true, options: [['none', "Don't nest clips"], ['nest', 'Nest clips']] },
  ], { aspect: '9:16', w: 1080, h: 1920, motion: 'default', nest: 'none' }, { ok: 'Create' });
  if (!r) return;
  const dims = { '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9] }[r.aspect];
  let W, H;
  if (r.aspect === 'custom') { W = r.w; H = r.h; } else { H = r.aspect === '16:9' ? s.settings.height : Math.round(s.settings.height * (dims[0] > dims[1] ? 1 : 1)); W = Math.round(H * dims[0] / dims[1] / 2) * 2; if (r.aspect !== '16:9') { H = 1920 * (s.settings.height / 1080); W = Math.round(H * dims[0] / dims[1] / 2) * 2; H = Math.round(H); } }
  const copy = cloneSequence(s, `${s.name} - Auto Reframed (${r.aspect})`);
  copy.settings.width = W; copy.settings.height = H;
  app.store.transact('Auto Reframe Sequence', () => { app.store.project.items[copy.id] = copy; }, ['items']);
  app.store.setActiveSequence(copy.id);
  const { analyzeReframe } = await import('./analysis.js');
  for (const t of copy.tracks.video) for (const c of t.clips) if (c.src.type === 'media') { c.effects.push(makeEffect('auto_reframe', { motion: r.motion })); analyzeReframe(copy, c, r.motion); }
}

// ---------- Graphics ----------
export function newGraphicAtPlayhead(template) {
  const s = seq(); if (!s) return;
  const g = template || graphicDefault(s, 'Title');
  const dur = Math.round((app.prefs.get('timeline.stillDuration') || 5) * s.settings.fps);
  let clip;
  tx('New Graphic', (q) => {
    // first empty video track above content at playhead
    let t = q.tracks.video.find((tr, i) => i > 0 && !tr.locked && !tr.clips.some((c) => c.start < q.playhead + dur && c.start + c.dur > q.playhead));
    if (!t) t = E.addTrack(q, 'video');
    clip = createClip('video', { type: 'graphic', itemId: null }, q.playhead, dur, 0, { name: 'Graphic', label: 'rose', graphic: deepClone(g) });
    clip.name = g.layers[0] ? (g.layers[0].text || g.layers[0].name || 'Graphic').slice(0, 30) : 'Graphic';
    t.clips.push(clip); t.clips.sort((a, b) => a.start - b.start);
  });
  app.store.selectClips([clip.id]);
  app.dock.openPanel('properties');
  return clip;
}

export function addAdjustmentLayer() {
  import('./media.js').then(async (m) => {
    const it = await m.newSynthetic('adjustment');
    const s = seq(); if (!s || !it) return;
    const dur = Math.round(5 * s.settings.fps);
    tx('Add Adjustment Layer', (q) => {
      let t = q.tracks.video.find((tr, i) => i > 0 && !tr.clips.some((c) => c.start < q.playhead + dur && c.start + c.dur > q.playhead));
      if (!t) t = E.addTrack(q, 'video');
      const c = createClip('video', { type: 'synthetic', itemId: it.id }, q.playhead, dur, 0, { name: it.name, label: 'lavender' });
      t.clips.push(c); t.clips.sort((a, b) => a.start - b.start);
    });
  });
}

export { targetClipAtPlayhead, TRANSITIONS };
