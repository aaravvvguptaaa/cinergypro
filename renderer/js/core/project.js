// Project data model: factories and read-only queries.
import { uid, deepClone, clamp } from './util.js';
import { makeEffect } from './effect-defs.js';
import { evaluate } from './keyframes.js';

export const PROJECT_VERSION = 3;

export function createProject(name = 'Untitled') {
  return {
    format: 'cinergypro', version: PROJECT_VERSION, id: uid('proj'), name, created: Date.now(), modified: Date.now(),
    settings: {
      useProxies: false,
      scratch: { previews: 'cache', autosave: 'default', proxies: 'cache', captured: 'project' },
      ingest: { enabled: false, mode: 'copy', dest: '', proxyHeight: 720, proxyCodec: 'h264', transcodeCodec: 'prores_422' },
      color: { workingSpace: 'rec709', autoToneMapHDR: true, autoDetectLog: true, displayManaged: true },
      defaultSequence: { width: 1920, height: 1080, fps: 24, sampleRate: 48000 },
    },
    items: {},
    libraries: { colors: ['#2f7cff', '#0b0c0f', '#e8ecf3', '#6e7685'], textStyles: [], looks: [], graphics: [], effectPresets: [], transitionPresets: [] },
    production: null,
    notes: '',
    activeSequence: null,
  };
}

export function createBin(name, parent = null) { return { id: uid('bin'), type: 'bin', name, parent, label: 'mango', created: Date.now(), open: true }; }

export function createMediaItem(path, info, parent = null) {
  return {
    id: uid('media'), type: 'media', name: info.name || path.split('/').pop(), parent, path, proxy: null, info,
    label: info.kind === 'audio' ? 'forest' : info.kind === 'image' ? 'lavender' : 'iris',
    metadata: { description: '', scene: '', shot: '', take: '', reel: '', good: false, rating: 0, logNote: '', comment: '', keywords: [], camera: info.camera || '', creator: '' },
    markers: [], interpret: { fps: null, pixelAspect: null, alpha: 'auto', fieldOrder: null, colorSpace: 'auto', audioChannels: null, remove: false },
    inPoint: null, outPoint: null, offline: false, created: Date.now(), audioType: null,
  };
}

export const SYNTH_DEFAULTS = {
  black: { name: 'Black Video' }, matte: { name: 'Color Matte', color: '#2f7cff' }, transparent: { name: 'Transparent Video' },
  bars: { name: 'Bars and Tone' }, countdown: { name: 'Universal Counting Leader' }, adjustment: { name: 'Adjustment Layer' },
};

export function createSynthItem(generator, opts = {}, parent = null) {
  return { id: uid('syn'), type: 'synthetic', generator, name: opts.name || SYNTH_DEFAULTS[generator].name, parent, label: 'lavender', width: opts.width || 1920, height: opts.height || 1080, duration: opts.duration || 5, color: opts.color || SYNTH_DEFAULTS[generator].color, created: Date.now(), markers: [], metadata: {} };
}

export function createGraphicItem(name, graphic, parent = null) {
  return { id: uid('gfx'), type: 'graphic', name, parent, label: 'rose', graphic, duration: 5, created: Date.now(), markers: [], metadata: {} };
}

export function createTrack(kind, index, opts = {}) {
  const name = opts.name || (kind === 'video' ? `V${index + 1}` : `A${index + 1}`);
  return {
    id: uid('trk'), kind, name, locked: false, hidden: false, muted: false, solo: false, target: index === 0, syncLock: true,
    srcPatch: index === 0, height: kind === 'video' ? 52 : 48, color: null, clips: [], transitions: [],
    audio: { volume: 0, pan: 0, effects: [], route: 'master', automation: 'read', keyframes: { volume: [], pan: [] }, recordArm: false, inputMonitor: false, channelType: opts.channelType || 'stereo', effectsPre: true },
    collapsed: false,
  };
}

export function createSequence(name = 'Sequence 01', settings = {}, parent = null) {
  const s = Object.assign({ width: 1920, height: 1080, fps: 24, pixelAspect: 1, fieldOrder: 'progressive', sampleRate: 48000, audioChannels: 'stereo', colorSpace: 'rec709', previewRes: 'full', startTC: 0, maxBitDepth: false, autoToneMap: true }, settings);
  return {
    id: uid('seq'), type: 'sequence', name, parent, label: 'forest', created: Date.now(), settings: s,
    tracks: { video: [0, 1, 2].map((i) => createTrack('video', i)), audio: [0, 1, 2].map((i) => createTrack('audio', i)) },
    captionTracks: [], markers: [], inPoint: null, outPoint: null, playhead: 0,
    view: { zoom: 3, scrollX: 0, scrollY: 0 },
    master: { volume: 0, effects: [], keyframes: { volume: [] }, mute: false },
    buses: [], multicam: null, metadata: {}, renderedRanges: [],
  };
}

export function intrinsicEffects(kind) {
  if (kind === 'video') return [makeEffect('motion'), makeEffect('opacity'), makeEffect('timeremap')];
  return [makeEffect('volume'), makeEffect('channel_volume'), makeEffect('panner')];
}

export function createClip(kind, src, start, dur, srcIn = 0, opts = {}) {
  return {
    id: uid('clip'), kind, src, name: opts.name || 'Clip', start, dur, srcIn, speed: 1, reverse: false, maintainPitch: true,
    frameHold: null, timeRemap: false, frameInterp: 'sampling', enabled: true, linkId: opts.linkId || null, groupId: null,
    label: opts.label || null, effects: intrinsicEffects(kind), markers: [], graphic: opts.graphic || null,
    stabilized: null, reframe: null, gain: 0, channelMap: null, audioType: null, scaleToFrame: opts.scaleToFrame || false, setToFrame: !!opts.setToFrame,
  };
}

// ---------- Queries ----------
export function allTracks(seq) { return [...seq.tracks.video, ...seq.tracks.audio]; }
export function trackById(seq, id) { return allTracks(seq).find((t) => t.id === id) || null; }
export function trackIndex(seq, track) { return seq.tracks[track.kind].indexOf(track); }

export function findClip(seq, clipId) {
  for (const kind of ['video', 'audio']) for (const track of seq.tracks[kind]) {
    const i = track.clips.findIndex((c) => c.id === clipId);
    if (i >= 0) return { clip: track.clips[i], track, index: i, kind };
  }
  return null;
}

export function clipEnd(c) { return c.start + c.dur; }

export function seqDuration(seq) {
  let end = 0;
  for (const t of allTracks(seq)) for (const c of t.clips) end = Math.max(end, c.start + c.dur);
  for (const ct of seq.captionTracks || []) for (const c of ct.captions) end = Math.max(end, c.end);
  return end;
}

export function clipsAtFrame(track, f) { return track.clips.filter((c) => f >= c.start && f < c.start + c.dur); }
export function clipAt(track, f) { for (const c of track.clips) if (f >= c.start && f < c.start + c.dur) return c; return null; }

export function sortClips(track) { track.clips.sort((a, b) => a.start - b.start); }

export function linkedClips(seq, clip) {
  if (!clip.linkId) return [clip];
  const out = [];
  for (const t of allTracks(seq)) for (const c of t.clips) if (c.linkId === clip.linkId) out.push(c);
  return out;
}

export function groupedClips(seq, clip) {
  if (!clip.groupId) return [clip];
  const out = [];
  for (const t of allTracks(seq)) for (const c of t.clips) if (c.groupId === clip.groupId) out.push(c);
  return out;
}

export function editPoints(seq, opts = {}) {
  const set = new Set([0]);
  for (const t of allTracks(seq)) {
    if (opts.targetedOnly && !t.target) continue;
    for (const c of t.clips) { set.add(c.start); set.add(c.start + c.dur); }
  }
  return [...set].sort((a, b) => a - b);
}

export function getItem(project, id) { return project.items[id] || null; }

// Media-time conversion honoring Interpret Footage frame rate.
export function itemFps(item) {
  if (!item) return 0;
  if (item.type === 'media') return (item.interpret && item.interpret.fps) || item.info.fps || 0;
  if (item.type === 'sequence') return item.settings.fps;
  return 0;
}
export function nativeFps(item) { return item && item.type === 'media' ? item.info.fps || 0 : itemFps(item); }

// Duration (interpreted seconds) of the item, or Infinity for stills/generators.
export function itemDuration(project, item) {
  if (!item) return 0;
  if (item.type === 'media') {
    if (item.info.kind === 'image' || item.info.kind === 'psd') return Infinity;
    const nf = item.info.fps, f = itemFps(item);
    return nf && f ? item.info.duration * nf / f : item.info.duration;
  }
  if (item.type === 'sequence') return seqDuration(item) / item.settings.fps;
  return Infinity;
}

export function itemHasVideo(item) {
  if (!item) return false;
  if (item.type === 'media') return !!item.info.hasVideo && !item.interpret.disableVideo;
  if (item.type === 'sequence') return item.tracks.video.some((t) => t.clips.length) || true;
  return true;
}
export function itemHasAudio(item) {
  if (!item) return false;
  if (item.type === 'media') return !!item.info.hasAudio;
  if (item.type === 'sequence') return item.tracks.audio.some((t) => t.clips.length);
  if (item.type === 'synthetic') return item.generator === 'bars' || item.generator === 'countdown';
  return false;
}

// Source seconds (interpreted) for a clip at a sequence frame.
const remapCache = new WeakMap();
export function clipSourceTime(clip, seqFrame, seqFps) {
  const localFrames = seqFrame - clip.start;
  if (clip.frameHold != null) return clip.frameHold;
  if (clip.timeRemap) {
    const tr = clip.effects.find((e) => e.type === 'timeremap');
    const keys = tr && tr.keyframes.speed;
    if (keys && keys.length) return clip.srcIn + integrateSpeed(clip, keys, localFrames, seqFps);
  }
  const local = localFrames / seqFps;
  if (clip.reverse) {
    const total = clip.dur / seqFps * clip.speed;
    return clip.srcIn + Math.max(0, total - local * clip.speed - 1 / seqFps * clip.speed);
  }
  return clip.srcIn + local * clip.speed;
}

function integrateSpeed(clip, keys, localFrames, fps) {
  let cache = remapCache.get(clip);
  const sig = JSON.stringify(keys) + '|' + clip.dur + '|' + fps;
  if (!cache || cache.sig !== sig) {
    const table = new Float64Array(clip.dur + 2);
    let acc = 0;
    for (let f = 0; f <= clip.dur + 1; f++) {
      table[f] = acc;
      const sp = evaluate(keys, f + 0.5, 100) / 100;
      acc += sp / fps;
    }
    cache = { sig, table };
    remapCache.set(clip, cache);
  }
  const f = clamp(localFrames, 0, clip.dur + 1);
  const i = Math.floor(f), fr = f - i;
  const a = cache.table[i] || 0, b = cache.table[Math.min(i + 1, cache.table.length - 1)] || a;
  return a + (b - a) * fr;
}

// Source seconds consumed by a clip (for handle/trim limits).
export function clipSourceSpan(clip, seqFps) {
  if (clip.frameHold != null) return 0;
  if (clip.timeRemap) return clipSourceTime(clip, clip.start + clip.dur, seqFps) - clip.srcIn;
  return clip.dur / seqFps * clip.speed;
}

// Available handles in frames before/after the clip (Infinity for stills).
export function clipHandles(project, clip, seqFps) {
  const item = clip.src.type === 'media' || clip.src.type === 'sequence' ? project.items[clip.src.itemId] : null;
  if (!item) return { head: Infinity, tail: Infinity };
  const dur = itemDuration(project, item);
  if (!isFinite(dur)) return { head: Infinity, tail: Infinity };
  const sp = Math.abs(clip.speed) || 1;
  const head = Math.floor(clip.srcIn * seqFps / sp);
  const tail = Math.floor((dur - clip.srcIn - clipSourceSpan(clip, seqFps)) * seqFps / sp);
  return { head: Math.max(0, head), tail: Math.max(0, tail) };
}

export function itemUsage(project, itemId) {
  const uses = [];
  for (const it of Object.values(project.items)) {
    if (it.type !== 'sequence') continue;
    for (const t of allTracks(it)) for (const c of t.clips) if (c.src.itemId === itemId) uses.push({ seq: it, clip: c, track: t });
  }
  return uses;
}

export function childrenOf(project, parentId) { return Object.values(project.items).filter((i) => (i.parent || null) === (parentId || null)); }

export function binPath(project, item) {
  const parts = []; let p = item.parent;
  while (p && project.items[p]) { parts.unshift(project.items[p].name); p = project.items[p].parent; }
  return parts.join(' / ');
}

export function cloneSequence(seq, name) {
  const copy = deepClone(seq);
  copy.id = uid('seq'); copy.name = name || seq.name + ' Copy';
  const linkMap = new Map();
  for (const t of allTracks(copy)) {
    t.id = uid('trk');
    const idMap = new Map();
    for (const c of t.clips) { const old = c.id; c.id = uid('clip'); idMap.set(old, c.id); if (c.linkId) { if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk')); c.linkId = linkMap.get(c.linkId); } }
    for (const tr of t.transitions) { tr.id = uid('tr'); tr.clipA = idMap.get(tr.clipA) || null; tr.clipB = idMap.get(tr.clipB) || null; }
  }
  return copy;
}

// Does sequence `seqId` (transitively) contain sequence `targetId`? Prevent recursive nesting.
export function seqContains(project, seqId, targetId, seen = new Set()) {
  if (seqId === targetId) return true;
  if (seen.has(seqId)) return false;
  seen.add(seqId);
  const s = project.items[seqId];
  if (!s || s.type !== 'sequence') return false;
  for (const t of allTracks(s)) for (const c of t.clips) if (c.src.type === 'sequence' && seqContains(project, c.src.itemId, targetId, seen)) return true;
  return false;
}

export function graphicDefault(seq, text = 'Title') {
  return {
    layers: [{
      id: uid('lyr'), type: 'text', name: text, text, x: 0.5, y: 0.5, font: 'Inter', size: 96, weight: 700, italic: false, tracking: 0, leading: 1.15,
      align: 'center', fill: '#ffffff', fillOn: true, stroke: '#000000', strokeWidth: 0, strokeOn: false, bg: '#000000', bgOn: false, bgOpacity: 60, bgPad: 20,
      shadow: '#000000', shadowOn: false, shadowOpacity: 60, shadowDist: 6, shadowAngle: 135, shadowBlur: 8, opacity: 100, rotation: 0, scale: 100,
      boxWidth: 0, gradient: null, mask: false, anim: 'none', animDur: 0.5, visible: true, keyframes: {},
    }],
    responsive: { pinTo: null, timeIn: 0, timeOut: 0 },
  };
}
