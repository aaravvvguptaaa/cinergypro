// Non-linear editing operations. All functions mutate the sequence in place and are
// expected to run inside store.transact().
import { uid, deepClone, clamp } from './util.js';
import {
  allTracks, sortClips, findClip, linkedClips, clipSourceTime, clipHandles, createClip, createSequence, createTrack,
  itemDuration, itemHasAudio, itemHasVideo, seqDuration, itemFps,
} from './project.js';
import { makeTransition, makeEffect } from './effect-defs.js';

// ---------- helpers ----------
function shiftKeyframes(clip, delta) {
  for (const e of clip.effects) {
    for (const k of Object.keys(e.keyframes || {})) for (const kf of e.keyframes[k]) kf.t += delta;
    for (const m of e.masks || []) for (const k of Object.keys(m.keyframes || {})) for (const kf of m.keyframes[k]) kf.t += delta;
  }
  for (const m of clip.markers || []) m.frame += delta;
  if (clip.graphic) for (const l of clip.graphic.layers) for (const k of Object.keys(l.keyframes || {})) for (const kf of l.keyframes[k]) kf.t += delta;
}

function dropKeyframesOutside(clip) {
  // keep keyframes but nothing else; keyframes outside the clip are preserved (like Premiere)
}

function cloneClip(c) {
  const n = deepClone(c);
  n.id = uid('clip');
  for (const e of n.effects) e.id = uid('fx');
  return n;
}

export function srcRate(clip, fps) { return (clip.speed || 1) / fps; } // source seconds per sequence frame

// ---------- split / clear ----------
export function splitClip(seq, track, clip, frame, opts = {}) {
  if (frame <= clip.start || frame >= clip.start + clip.dur) return null;
  const fps = seq.settings.fps;
  const L = frame - clip.start;
  const right = cloneClip(clip);
  if (clip.reverse) {
    const total = clip.dur * clip.speed / fps;
    right.srcIn = clip.srcIn;
    clip.srcIn = clip.srcIn + (clip.dur - L) * clip.speed / fps;
    right.dur = clip.dur - L;
    right.start = frame;
    clip.dur = L;
    void total;
  } else {
    right.srcIn = clip.timeRemap ? clipSourceTime(clip, frame, fps) : clip.srcIn + L * clip.speed / fps;
    right.start = frame;
    right.dur = clip.dur - L;
    clip.dur = L;
  }
  shiftKeyframes(right, -L);
  if (opts.keepLink && clip.linkId) right.linkId = opts.linkMap ? opts.linkMap(clip.linkId) : clip.linkId;
  else if (clip.linkId) right.linkId = opts.linkMap ? opts.linkMap(clip.linkId) : uid('lnk');
  track.clips.push(right);
  sortClips(track);
  // Transitions attached to the clip's tail move to the right half
  for (const tr of track.transitions) if (tr.clipA === clip.id) tr.clipA = right.id;
  return right;
}

// Split every clip crossing `frame` on the given tracks, keeping A/V links consistent.
export function razorAt(seq, frame, tracks) {
  const linkMap = new Map();
  const mapper = (old) => { if (!linkMap.has(old)) linkMap.set(old, uid('lnk')); return linkMap.get(old); };
  const made = [];
  for (const t of tracks) {
    if (t.locked) continue;
    for (const c of [...t.clips]) if (frame > c.start && frame < c.start + c.dur) { const r = splitClip(seq, t, c, frame, { linkMap: mapper }); if (r) made.push(r); }
  }
  return made;
}

export function clearRange(seq, track, a, b, exclude = null) {
  if (b <= a || track.locked) return;
  const fps = seq.settings.fps;
  for (const c of [...track.clips]) {
    if (exclude && exclude.has(c.id)) continue;
    const ce = c.start + c.dur;
    if (ce <= a || c.start >= b) continue;
    if (c.start >= a && ce <= b) { removeClipObj(track, c); continue; }
    if (c.start < a && ce > b) { splitClip(seq, track, c, b); c.dur = a - c.start; continue; }
    if (c.start < a) { c.dur = a - c.start; continue; }
    // c.start >= a && ce > b : trim head
    const d = b - c.start;
    if (c.reverse) { /* reverse: head trim doesn't move srcIn */ } else c.srcIn += c.timeRemap ? (clipSourceTime(c, b, fps) - clipSourceTime(c, c.start, fps)) : d * c.speed / fps;
    c.start = b; c.dur -= d;
    shiftKeyframes(c, -d);
  }
  cleanTransitions(track);
}

function removeClipObj(track, c) {
  const i = track.clips.indexOf(c);
  if (i >= 0) track.clips.splice(i, 1);
}

export function removeClips(seq, ids) {
  for (const t of allTracks(seq)) { t.clips = t.clips.filter((c) => !ids.has(c.id)); cleanTransitions(t); }
}

// Remove transitions whose clips vanished or no longer meet.
export function cleanTransitions(track) {
  const byId = new Map(track.clips.map((c) => [c.id, c]));
  track.transitions = track.transitions.filter((tr) => {
    const A = tr.clipA ? byId.get(tr.clipA) : null, B = tr.clipB ? byId.get(tr.clipB) : null;
    if (tr.clipA && !A) return false;
    if (tr.clipB && !B) return false;
    if (A && B && A.start + A.dur !== B.start) return false;
    if (!A && !B) return false;
    // reposition
    const edge = A ? A.start + A.dur : B.start;
    if (A && B) tr.start = tr.align === 'start' ? edge : tr.align === 'end' ? edge - tr.dur : edge - Math.floor(tr.dur / 2);
    else if (A) { tr.start = edge - tr.dur; tr.dur = Math.min(tr.dur, A.dur); }
    else { tr.start = edge; tr.dur = Math.min(tr.dur, B.dur); }
    return tr.dur > 0;
  });
}

// ---------- shifting ----------
export function shiftTracks(seq, frame, amount, tracks, opts = {}) {
  for (const t of tracks) {
    if (t.locked) continue;
    if (amount > 0 && opts.split !== false) for (const c of [...t.clips]) if (frame > c.start && frame < c.start + c.dur) splitClip(seq, t, c, frame);
    for (const c of t.clips) if (c.start >= frame) c.start += amount;
    for (const tr of t.transitions) if (tr.start >= frame) tr.start += amount;
    sortClips(t);
  }
  if (opts.markers !== false) for (const m of seq.markers) if (m.frame >= frame) m.frame += amount;
  for (const ct of seq.captionTracks || []) if (opts.captions !== false) for (const c of ct.captions) if (c.start >= frame) { c.start += amount; c.end += amount; }
}

function syncTracks(seq, base) {
  // tracks affected by a ripple: the given ones plus every sync-locked unlocked track
  const set = new Set(base);
  for (const t of allTracks(seq)) if (t.syncLock && !t.locked) set.add(t);
  return [...set];
}

// ---------- placing ----------
export function placeClips(seq, placements, mode = 'overwrite') {
  // placements: [{track, clip}] all same start/dur range
  if (!placements.length) return;
  const start = Math.min(...placements.map((p) => p.clip.start));
  const end = Math.max(...placements.map((p) => p.clip.start + p.clip.dur));
  if (mode === 'insert') {
    const tracks = syncTracks(seq, placements.map((p) => p.track));
    shiftTracks(seq, start, end - start, tracks);
  } else {
    for (const p of placements) clearRange(seq, p.track, p.clip.start, p.clip.start + p.clip.dur);
  }
  for (const p of placements) { p.track.clips.push(p.clip); sortClips(p.track); }
}

// Build clips for an item (A/V linked). Returns {video:[clip], audio:[clip]}.
export function clipsForItem(project, seq, item, start, srcIn, srcOut, opts = {}) {
  const fps = seq.settings.fps;
  const dur = Math.max(1, Math.round((srcOut - srcIn) * fps));
  const linkId = uid('lnk');
  const out = { video: [], audio: [] };
  const name = item.name;
  const srcType = item.type === 'media' ? 'media' : item.type === 'sequence' ? 'sequence' : item.type === 'graphic' ? 'graphic' : 'synthetic';
  const label = item.label;
  const useVideo = opts.video !== false && itemHasVideo(item) && !(item.type === 'media' && item.info.kind === 'audio');
  const useAudio = opts.audio !== false && itemHasAudio(item);
  if (useVideo) {
    const c = createClip('video', { type: srcType, itemId: item.id }, start, dur, srcIn, { name, label, linkId: useAudio ? linkId : null, graphic: item.type === 'graphic' ? deepClone(item.graphic) : null });
    if (opts.scaleToFrame) c.setToFrame = true;
    out.video.push(c);
  }
  if (useAudio) {
    const streams = item.type === 'media' ? Math.max(1, item.info.audioStreams || 1) : 1;
    const nStreams = opts.allAudioStreams ? streams : 1;
    for (let s = 0; s < nStreams; s++) {
      const c = createClip('audio', { type: srcType, itemId: item.id, stream: s }, start, dur, srcIn, { name, label, linkId: useVideo || nStreams > 1 ? linkId : null });
      out.audio.push(c);
    }
  }
  return out;
}

// Ensure seq has at least n tracks of a kind
export function ensureTracks(seq, kind, n) {
  while (seq.tracks[kind].length < n) seq.tracks[kind].push(createTrack(kind, seq.tracks[kind].length, { }));
  return seq.tracks[kind];
}

export function targetTrack(seq, kind) {
  const ts = seq.tracks[kind];
  return ts.find((t) => t.srcPatch && !t.locked) || ts.find((t) => t.target && !t.locked) || ts.find((t) => !t.locked) || null;
}

// Insert/overwrite an item at a frame onto patched tracks (Source Monitor edits).
export function editItemIntoSequence(project, seq, item, srcIn, srcOut, frame, mode = 'overwrite', opts = {}) {
  const { video, audio } = clipsForItem(project, seq, item, frame, srcIn, srcOut, opts);
  const placements = [];
  if (video.length) {
    let vt = opts.videoTrack || targetTrack(seq, 'video');
    if (!vt) { ensureTracks(seq, 'video', seq.tracks.video.length + 1); vt = seq.tracks.video[seq.tracks.video.length - 1]; }
    placements.push({ track: vt, clip: video[0] });
  }
  if (audio.length) {
    let at = opts.audioTrack || targetTrack(seq, 'audio');
    let idx = at ? seq.tracks.audio.indexOf(at) : seq.tracks.audio.length;
    for (const a of audio) {
      ensureTracks(seq, 'audio', idx + 1);
      placements.push({ track: seq.tracks.audio[idx], clip: a });
      idx++;
    }
  }
  placeClips(seq, placements, mode);
  return placements.map((p) => p.clip);
}

// ---------- trimming ----------
export function trimLimits(project, seq, clip) { return clipHandles(project, clip, seq.settings.fps); }

// Trim head by delta frames (positive = shorten). Ripple shifts the clip (and later clips) left.
export function trimHead(project, seq, track, clip, delta, mode = 'normal') {
  const fps = seq.settings.fps;
  const lim = trimLimits(project, seq, clip);
  delta = clamp(delta, -lim.head, clip.dur - 1);
  if (mode === 'normal') {
    // cannot extend over previous clip
    const prev = track.clips.filter((c) => c !== clip && c.start + c.dur <= clip.start).pop();
    const minStart = prev ? prev.start + prev.dur : 0;
    delta = Math.max(delta, minStart - clip.start);
  } else if (mode === 'ripple') {
    delta = Math.max(delta, -clip.start - 1e9);
  }
  if (!delta) return 0;
  if (!clip.reverse) clip.srcIn += delta * clip.speed / fps;
  clip.dur -= delta;
  if (mode === 'ripple') {
    // clip stays at its start; everything after shifts by -delta
    shiftKeyframes(clip, -delta);
    const after = clip.start + clip.dur + delta;
    shiftAfter(seq, track, clip, after, -delta);
  } else {
    clip.start += delta;
    shiftKeyframes(clip, -delta);
  }
  cleanTransitions(track);
  return delta;
}

export function trimTail(project, seq, track, clip, delta, mode = 'normal') {
  const fps = seq.settings.fps;
  const lim = trimLimits(project, seq, clip);
  delta = clamp(delta, -(clip.dur - 1), lim.tail);
  if (mode === 'normal') {
    const next = track.clips.find((c) => c !== clip && c.start >= clip.start + clip.dur);
    if (next) delta = Math.min(delta, next.start - (clip.start + clip.dur));
  }
  if (!delta) return 0;
  const oldEnd = clip.start + clip.dur;
  if (clip.reverse) clip.srcIn = Math.max(0, clip.srcIn - delta * clip.speed / fps);
  clip.dur += delta;
  if (mode === 'ripple') shiftAfter(seq, track, clip, oldEnd, delta);
  cleanTransitions(track);
  return delta;
}

function shiftAfter(seq, track, clip, frame, amount) {
  const tracks = syncTracks(seq, [track]);
  for (const t of tracks) {
    if (t.locked) continue;
    for (const c of t.clips) if (c !== clip && c.start >= frame) c.start += amount;
    for (const tr of t.transitions) if (tr.start >= frame) tr.start += amount;
    sortClips(t);
  }
  for (const m of seq.markers) if (m.frame >= frame) m.frame += amount;
}

// Roll edit: move the edit point between A (left) and B (right) by delta.
export function rollEdit(project, seq, track, A, B, delta) {
  const fps = seq.settings.fps;
  const la = trimLimits(project, seq, A), lb = trimLimits(project, seq, B);
  delta = clamp(delta, -(A.dur - 1), B.dur - 1);
  delta = clamp(delta, -lb.head, la.tail);
  if (!delta) return 0;
  A.dur += delta;
  if (!B.reverse) B.srcIn += delta * B.speed / fps;
  B.start += delta; B.dur -= delta;
  shiftKeyframes(B, -delta);
  cleanTransitions(track);
  return delta;
}

export function slipClip(project, seq, clip, delta) {
  const fps = seq.settings.fps;
  const lim = trimLimits(project, seq, clip);
  // positive delta = show later source (Premiere: drag right shows earlier). We use source offset frames.
  delta = clamp(delta, -lim.head, lim.tail);
  if (!delta) return 0;
  clip.srcIn += delta * clip.speed / fps;
  return delta;
}

export function slideClip(project, seq, track, clip, delta) {
  const idx = track.clips.indexOf(clip);
  const prev = track.clips[idx - 1], next = track.clips[idx + 1];
  const fps = seq.settings.fps;
  if (prev && prev.start + prev.dur === clip.start) {
    const lp = trimLimits(project, seq, prev);
    delta = clamp(delta, -(prev.dur - 1), lp.tail);
  } else if (delta < 0) delta = Math.max(delta, -(clip.start - (prev ? prev.start + prev.dur : 0)));
  if (next && clip.start + clip.dur === next.start) {
    const ln = trimLimits(project, seq, next);
    delta = clamp(delta, -ln.head, next.dur - 1);
  } else if (delta > 0 && next) delta = Math.min(delta, next.start - (clip.start + clip.dur));
  if (!delta) return 0;
  if (prev && prev.start + prev.dur === clip.start) prev.dur += delta;
  if (next && clip.start + clip.dur === next.start) { if (!next.reverse) next.srcIn += delta * next.speed / fps; next.start += delta; next.dur -= delta; shiftKeyframes(next, -delta); }
  clip.start += delta;
  cleanTransitions(track);
  return delta;
}

// Rate stretch: change duration by changing speed.
export function rateStretch(project, seq, track, clip, newDur, fromHead = false) {
  newDur = Math.max(1, Math.round(newDur));
  const ratio = clip.dur / newDur;
  const oldEnd = clip.start + clip.dur;
  clip.speed = clip.speed * ratio;
  if (fromHead) clip.start = oldEnd - newDur;
  clip.dur = newDur;
  cleanTransitions(track);
}

// ---------- moving ----------
// moves: [{clip, fromTrack, toTrack, newStart}]
export function moveClips(seq, moves, mode = 'overwrite') {
  const ids = new Set(moves.map((m) => m.clip.id));
  for (const m of moves) { removeClipObj(m.fromTrack, m.clip); }
  for (const t of allTracks(seq)) cleanTransitions(t);
  if (mode === 'insert') {
    const byTrack = new Map();
    for (const m of moves) { const arr = byTrack.get(m.toTrack) || []; arr.push(m); byTrack.set(m.toTrack, arr); }
    const start = Math.min(...moves.map((m) => m.newStart));
    const end = Math.max(...moves.map((m) => m.newStart + m.clip.dur));
    shiftTracks(seq, start, end - start, syncTracks(seq, [...byTrack.keys()]));
  } else {
    for (const m of moves) clearRange(seq, m.toTrack, m.newStart, m.newStart + m.clip.dur, ids);
  }
  for (const m of moves) { m.clip.start = Math.max(0, m.newStart); m.toTrack.clips.push(m.clip); sortClips(m.toTrack); }
  for (const t of allTracks(seq)) cleanTransitions(t);
}

// ---------- deleting ----------
export function rippleDelete(seq, ids) {
  // Collect ranges per track; close gaps track by track.
  const ranges = [];
  for (const t of allTracks(seq)) for (const c of t.clips) if (ids.has(c.id)) ranges.push({ track: t, a: c.start, b: c.start + c.dur });
  removeClips(seq, ids);
  // Merge ranges (union across all tracks) and shift everything after each by its length,
  // but only where the gap is empty across sync-locked tracks.
  const union = mergeRanges(ranges.map((r) => [r.a, r.b]));
  for (let i = union.length - 1; i >= 0; i--) {
    const [a, b] = union[i];
    const tracks = syncTracks(seq, ranges.map((r) => r.track));
    const blocked = tracks.some((t) => !t.locked && t.clips.some((c) => c.start < b && c.start + c.dur > a));
    const len = blocked ? gapLengthEmpty(tracks, a, b) : b - a;
    if (len > 0) shiftTracks(seq, a + (b - a - len) + len, -len, tracks.filter((t) => !t.locked), { split: false });
  }
  for (const t of allTracks(seq)) cleanTransitions(t);
}

function gapLengthEmpty(tracks, a, b) {
  // largest shift that keeps every track free of overlaps
  let len = b - a;
  for (const t of tracks) for (const c of t.clips) if (c.start < b && c.start + c.dur > a) len = Math.min(len, Math.max(0, b - (c.start + c.dur)));
  return len;
}

function mergeRanges(rs) {
  rs.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of rs) { const l = out[out.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else out.push([...r]); }
  return out;
}

export function liftRange(seq, a, b, tracks) { for (const t of tracks) clearRange(seq, t, a, b); }
export function extractRange(seq, a, b, tracks) {
  for (const t of tracks) clearRange(seq, t, a, b);
  shiftTracks(seq, b, -(b - a), syncTracks(seq, tracks).filter((t) => !t.locked), { split: false });
  for (const m of [...seq.markers]) if (m.frame >= a && m.frame < b) seq.markers.splice(seq.markers.indexOf(m), 1);
}

// Gaps
export function gapAt(track, frame) {
  let prevEnd = 0;
  for (const c of track.clips) {
    if (frame < c.start && frame >= prevEnd) return { a: prevEnd, b: c.start };
    prevEnd = Math.max(prevEnd, c.start + c.dur);
  }
  return null;
}
export function closeGap(seq, track, gap) {
  const len = gap.b - gap.a;
  const tracks = syncTracks(seq, [track]);
  const ok = tracks.every((t) => t.locked || !t.clips.some((c) => c.start < gap.b && c.start + c.dur > gap.a));
  shiftTracks(seq, gap.b, -len, ok ? tracks.filter((t) => !t.locked) : [track], { split: false });
}
export function closeAllGaps(seq, tracks) {
  for (const t of tracks) {
    let pos = 0;
    for (const c of t.clips) { if (c.start > pos) { const d = c.start - pos; for (const tr of t.transitions) if (tr.start >= c.start) tr.start -= d; c.start = pos; } pos = c.start + c.dur; }
    cleanTransitions(t);
  }
}
// Fill gaps by extending the previous clip's tail into the gap (where handles allow).
export function fillGaps(project, seq, tracks) {
  for (const t of tracks) {
    for (let i = 0; i < t.clips.length - 1; i++) {
      const a = t.clips[i], b = t.clips[i + 1];
      const gap = b.start - (a.start + a.dur);
      if (gap > 0) trimTail(project, seq, t, a, gap, 'normal');
    }
  }
}

// ---------- speed ----------
export function setSpeed(project, seq, track, clip, opts) {
  const { speed, reverse, maintainPitch, ripple, keepDuration, frameInterp } = opts;
  const oldDur = clip.dur;
  if (speed != null && speed > 0) {
    const newDur = keepDuration ? clip.dur : Math.max(1, Math.round(clip.dur * clip.speed / speed));
    clip.speed = speed;
    if (!keepDuration) {
      if (ripple) { const d = newDur - oldDur; clip.dur = newDur; shiftAfter(seq, track, clip, clip.start + oldDur, d); }
      else {
        const next = track.clips.find((c) => c !== clip && c.start >= clip.start + oldDur);
        clip.dur = next ? Math.min(newDur, next.start - clip.start) : newDur;
      }
    }
  }
  if (reverse != null) clip.reverse = reverse;
  if (maintainPitch != null) clip.maintainPitch = maintainPitch;
  if (frameInterp) clip.frameInterp = frameInterp;
  cleanTransitions(track);
}

export function addFrameHold(seq, track, clip, frame, mode = 'segment') {
  const fps = seq.settings.fps;
  const t = clipSourceTime(clip, frame, fps);
  if (mode === 'whole') { clip.frameHold = t; return clip; }
  const right = splitClip(seq, track, clip, frame);
  if (!right) { clip.frameHold = t; return clip; }
  right.frameHold = t;
  return right;
}

export function insertFreezeFrame(project, seq, track, clip, frame, durFrames) {
  const fps = seq.settings.fps;
  const t = clipSourceTime(clip, frame, fps);
  const right = splitClip(seq, track, clip, frame);
  const hold = cloneClip(clip);
  hold.start = frame; hold.dur = durFrames; hold.frameHold = t; hold.linkId = null;
  shiftTracks(seq, frame, durFrames, syncTracks(seq, [track]), { split: false });
  if (right) right.start = frame + durFrames;
  track.clips.push(hold); sortClips(track);
  return hold;
}

// ---------- link / group / enable ----------
export function linkClips(seq, ids) { const l = uid('lnk'); for (const t of allTracks(seq)) for (const c of t.clips) if (ids.has(c.id)) c.linkId = l; }
export function unlinkClips(seq, ids) { for (const t of allTracks(seq)) for (const c of t.clips) if (ids.has(c.id)) c.linkId = null; }
export function groupClips(seq, ids) { const g = uid('grp'); for (const t of allTracks(seq)) for (const c of t.clips) if (ids.has(c.id)) c.groupId = g; }
export function ungroupClips(seq, ids) { for (const t of allTracks(seq)) for (const c of t.clips) if (ids.has(c.id)) c.groupId = null; }
export function setEnabled(seq, ids, v) { for (const t of allTracks(seq)) for (const c of t.clips) if (ids.has(c.id)) c.enabled = v === undefined ? !c.enabled : v; }

// ---------- nesting ----------
export function nestClips(project, seq, ids, name) {
  const sel = [];
  for (const k of ['video', 'audio']) seq.tracks[k].forEach((t, ti) => t.clips.forEach((c) => { if (ids.has(c.id)) sel.push({ c, t, ti, k }); }));
  if (!sel.length) return null;
  const start = Math.min(...sel.map((s) => s.c.start));
  const end = Math.max(...sel.map((s) => s.c.start + s.c.dur));
  const minV = Math.min(...sel.filter((s) => s.k === 'video').map((s) => s.ti).concat([999]));
  const minA = Math.min(...sel.filter((s) => s.k === 'audio').map((s) => s.ti).concat([999]));
  const nested = createSequence(name || 'Nested Sequence', deepClone(seq.settings), seq.parent);
  nested.tracks.video = []; nested.tracks.audio = [];
  for (const k of ['video', 'audio']) {
    const maxT = Math.max(-1, ...sel.filter((s) => s.k === k).map((s) => s.ti));
    const base = k === 'video' ? minV : minA;
    for (let i = base === 999 ? 0 : base; i <= maxT; i++) nested.tracks[k].push(createTrack(k, nested.tracks[k].length));
    if (!nested.tracks[k].length) nested.tracks[k].push(createTrack(k, 0));
  }
  for (const s of sel) {
    const base = s.k === 'video' ? minV : minA;
    const c = deepClone(s.c); c.start -= start;
    nested.tracks[s.k][s.ti - base].clips.push(c);
  }
  // transitions entirely inside move along
  for (const k of ['video', 'audio']) seq.tracks[k].forEach((t, ti) => {
    for (const tr of t.transitions) if ((tr.clipA && ids.has(tr.clipA) || !tr.clipA) && (tr.clipB && ids.has(tr.clipB) || !tr.clipB)) {
      const base = k === 'video' ? minV : minA; const nt = nested.tracks[k][ti - base];
      if (nt) nt.transitions.push({ ...deepClone(tr), start: tr.start - start });
    }
  });
  for (const t of allTracks(nested)) sortClips(t);
  project.items[nested.id] = nested;
  removeClips(seq, ids);
  const hasV = sel.some((s) => s.k === 'video'), hasA = sel.some((s) => s.k === 'audio');
  const linkId = hasV && hasA ? uid('lnk') : null;
  const out = [];
  if (hasV) {
    const c = createClip('video', { type: 'sequence', itemId: nested.id }, start, end - start, 0, { name: nested.name, label: 'forest', linkId });
    seq.tracks.video[minV].clips.push(c); sortClips(seq.tracks.video[minV]); out.push(c);
  }
  if (hasA) {
    const c = createClip('audio', { type: 'sequence', itemId: nested.id }, start, end - start, 0, { name: nested.name, label: 'forest', linkId });
    seq.tracks.audio[minA].clips.push(c); sortClips(seq.tracks.audio[minA]); out.push(c);
  }
  return { nested, clips: out };
}

// ---------- replace ----------
export function replaceClipSource(project, seq, clip, item, srcIn = null) {
  clip.src = { ...clip.src, type: item.type === 'media' ? 'media' : item.type === 'sequence' ? 'sequence' : item.type === 'graphic' ? 'graphic' : 'synthetic', itemId: item.id };
  clip.name = item.name;
  if (srcIn != null) clip.srcIn = srcIn;
  const dur = itemDuration(project, item);
  if (isFinite(dur)) {
    const span = clip.dur * clip.speed / seq.settings.fps;
    if (clip.srcIn + span > dur) clip.srcIn = Math.max(0, dur - span);
  }
}

// ---------- transitions ----------
export function addTransition(project, seq, track, edgeFrame, type, durFrames, opts = {}) {
  const A = track.clips.find((c) => c.start + c.dur === edgeFrame) || null;
  const B = track.clips.find((c) => c.start === edgeFrame) || null;
  if (!A && !B) return null;
  // remove existing transition at the edge
  track.transitions = track.transitions.filter((tr) => !((tr.clipA && A && tr.clipA === A.id) || (tr.clipB && B && tr.clipB === B.id && (!tr.clipA || (A && tr.clipA === A.id)))));
  let align = opts.align || (A && B ? 'center' : A ? 'end' : 'start');
  let dur = durFrames;
  if (A && B) {
    const la = clipHandles(project, A, seq.settings.fps), lb = clipHandles(project, B, seq.settings.fps);
    if (align === 'center') { const half = Math.min(Math.floor(dur / 2), la.tail, lb.head, A.dur, B.dur); dur = Math.max(1, half * 2 || Math.min(dur, A.dur, B.dur)); if (!half) align = la.tail < lb.head ? 'start' : 'end'; }
    if (align === 'start') dur = Math.min(dur, B.dur, la.tail === Infinity ? dur : Math.max(1, la.tail));
    if (align === 'end') dur = Math.min(dur, A.dur, lb.head === Infinity ? dur : Math.max(1, lb.head));
  } else dur = Math.min(dur, (A || B).dur);
  const tr = makeTransition(type, dur, { clipA: A ? A.id : null, clipB: B ? B.id : null, align, start: 0, ...opts.extra });
  track.transitions.push(tr);
  cleanTransitions(track);
  return tr;
}

export function transitionAt(track, frame) {
  return track.transitions.find((tr) => frame >= tr.start && frame < tr.start + tr.dur) || null;
}

// ---------- tracks ----------
export function addTrack(seq, kind, index = null, opts = {}) {
  const t = createTrack(kind, seq.tracks[kind].length, opts);
  t.target = false; t.srcPatch = false;
  if (index == null || index >= seq.tracks[kind].length) seq.tracks[kind].push(t); else seq.tracks[kind].splice(index, 0, t);
  renumberTracks(seq);
  return t;
}
export function deleteTrack(seq, track) {
  const arr = seq.tracks[track.kind];
  if (arr.length <= 1) return false;
  arr.splice(arr.indexOf(track), 1);
  renumberTracks(seq);
  return true;
}
export function moveTrack(seq, track, dir) {
  const arr = seq.tracks[track.kind]; const i = arr.indexOf(track); const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renumberTracks(seq);
}
export function renumberTracks(seq) {
  for (const k of ['video', 'audio']) seq.tracks[k].forEach((t, i) => { if (/^[VA]\d+$/.test(t.name)) t.name = (k === 'video' ? 'V' : 'A') + (i + 1); });
}
export function deleteEmptyTracks(seq) {
  for (const k of ['video', 'audio']) { seq.tracks[k] = seq.tracks[k].filter((t, i) => t.clips.length || i === 0); }
  renumberTracks(seq);
}

// ---------- clipboard ----------
export function copyClips(seq, ids) {
  const sel = [];
  for (const k of ['video', 'audio']) seq.tracks[k].forEach((t, ti) => t.clips.forEach((c) => { if (ids.has(c.id)) sel.push({ k, ti, c: deepClone(c) }); }));
  if (!sel.length) return null;
  const start = Math.min(...sel.map((s) => s.c.start));
  const minV = Math.min(...sel.filter((s) => s.k === 'video').map((s) => s.ti).concat([999]));
  const minA = Math.min(...sel.filter((s) => s.k === 'audio').map((s) => s.ti).concat([999]));
  return { kind: 'clips', items: sel.map((s) => ({ ...s, ti: s.ti - (s.k === 'video' ? minV : minA), c: { ...s.c, start: s.c.start - start } })) };
}

export function pasteClips(seq, clip, frame, mode = 'overwrite') {
  if (!clip || clip.kind !== 'clips') return [];
  const vBase = Math.max(0, seq.tracks.video.findIndex((t) => t.target && !t.locked));
  const aBase = Math.max(0, seq.tracks.audio.findIndex((t) => t.target && !t.locked));
  const linkMap = new Map();
  const placements = [];
  for (const it of clip.items) {
    const base = it.k === 'video' ? vBase : aBase;
    ensureTracks(seq, it.k, base + it.ti + 1);
    const c = cloneClip(it.c);
    c.start = frame + it.c.start;
    if (c.linkId) { if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk')); c.linkId = linkMap.get(c.linkId); }
    placements.push({ track: seq.tracks[it.k][base + it.ti], clip: c });
  }
  if (mode === 'insert') {
    const start = frame, end = Math.max(...placements.map((p) => p.clip.start + p.clip.dur));
    shiftTracks(seq, start, end - start, syncTracks(seq, placements.map((p) => p.track)));
    for (const p of placements) { p.track.clips.push(p.clip); sortClips(p.track); }
  } else {
    for (const p of placements) { clearRange(seq, p.track, p.clip.start, p.clip.start + p.clip.dur); p.track.clips.push(p.clip); sortClips(p.track); }
  }
  return placements.map((p) => p.clip);
}

export function pasteAttributes(src, dst, opts) {
  // opts: {motion, opacity, timeremap, volume, channel_volume, panner, effects:true, speed:true, scaleKeyframes}
  const pick = (type) => src.effects.find((e) => e.type === type);
  for (const t of ['motion', 'opacity', 'timeremap', 'volume', 'channel_volume', 'panner']) {
    if (!opts[t]) continue;
    const s = pick(t); const di = dst.effects.findIndex((e) => e.type === t);
    if (s && di >= 0) { const copy = deepClone(s); copy.id = uid('fx'); dst.effects[di] = copy; }
  }
  if (opts.effects) {
    for (const e of src.effects) {
      if (['motion', 'opacity', 'timeremap', 'volume', 'channel_volume', 'panner'].includes(e.type)) continue;
      if ((dst.kind === 'video') !== (src.kind === 'video')) continue;
      const copy = deepClone(e); copy.id = uid('fx');
      if (opts.scaleKeyframes && src.dur && dst.dur) for (const k of Object.keys(copy.keyframes)) for (const kf of copy.keyframes[k]) kf.t = kf.t * dst.dur / src.dur;
      dst.effects.push(copy);
    }
  }
  if (opts.speed && src.kind === dst.kind) { dst.speed = src.speed; dst.reverse = src.reverse; }
}

// ---------- multicam ----------
export function createMulticamSequence(project, items, offsets, name, settings, parent) {
  const seq = createSequence(name, settings, parent);
  seq.tracks.video = []; seq.tracks.audio = [];
  const fps = seq.settings.fps;
  items.forEach((item, i) => {
    const vt = createTrack('video', i, { name: `Camera ${i + 1}` });
    seq.tracks.video.push(vt);
    const off = Math.round((offsets[i] || 0) * fps);
    const dur = Math.round(itemDuration(project, item) * fps);
    if (itemHasVideo(item) && item.info.kind !== 'audio') vt.clips.push(createClip('video', { type: 'media', itemId: item.id }, Math.max(0, off), dur - Math.max(0, -off), Math.max(0, -off) / fps, { name: item.name, label: item.label }));
    if (itemHasAudio(item)) {
      const at = createTrack('audio', seq.tracks.audio.length, { name: `Cam ${i + 1} Audio` });
      at.clips.push(createClip('audio', { type: 'media', itemId: item.id, stream: 0 }, Math.max(0, off), dur - Math.max(0, -off), Math.max(0, -off) / fps, { name: item.name, label: item.label }));
      if (i > 0) at.muted = true;
      seq.tracks.audio.push(at);
    }
  });
  if (!seq.tracks.audio.length) seq.tracks.audio.push(createTrack('audio', 0));
  seq.multicam = { angles: items.map((it, i) => ({ name: it.name, track: i })), audioAngle: 0, audioFollowsVideo: false };
  seq.label = 'caribbean';
  return seq;
}

// Multicam clip on a parent timeline: clip.src.type==='sequence' && nested seq.multicam; clip.angle selects track
export function switchMulticamAngle(seq, clip, angle) { clip.angle = angle; }

export function multicamCutAt(seq, track, frame, angle) {
  const c = track.clips.find((x) => frame >= x.start && frame < x.start + x.dur);
  if (!c) return null;
  if (frame === c.start) { c.angle = angle; return c; }
  const r = splitClip(seq, track, c, frame);
  if (r) r.angle = angle;
  return r;
}

export function seqEnd(seq) { return seqDuration(seq); }
export { itemFps };
