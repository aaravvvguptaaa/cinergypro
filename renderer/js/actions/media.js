// Media import, ingest, proxies, relinking, interpretation and project management.
import { app } from '../app-context.js';
import { createMediaItem, createBin, createSequence, createSynthItem, createGraphicItem, itemUsage, itemDuration } from '../core/project.js';
import { basename, dirname, extname, stem, uid, deepClone, naturalCompare } from '../core/util.js';
import { jobs } from './jobs.js';
import { toast, formDialog, confirmDialog, modal } from '../ui/widgets.js';
import { MediaPool } from '../engine/media-pool.js';
import { snapFps } from '../core/timecode.js';
import { h } from '../core/util.js';

export const MEDIA_EXT = new Set(['.mov', '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mxf', '.mts', '.m2ts', '.ts', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp', '.dv', '.r3d', '.braw', '.crm', '.mts',
  '.wav', '.mp3', '.aac', '.m4a', '.aif', '.aiff', '.flac', '.ogg', '.opus', '.wma', '.caf',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.svg', '.psd', '.exr', '.dpx', '.tga', '.heic']);
const STILL_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.exr', '.dpx', '.tga', '.bmp']);

export async function importDialog(opts = {}) {
  const r = await window.native.call('dialog:open', { title: 'Import', multi: true, directory: !!opts.folder, filters: opts.folder ? undefined : [{ name: 'Media', extensions: [...MEDIA_EXT].map((e) => e.slice(1)) }, { name: 'All Files', extensions: ['*'] }] });
  if (r) await importPaths(r, opts);
}

// Group numbered stills into image sequences: name_0001.png ...
function detectSequences(files) {
  const groups = new Map(); const singles = [];
  for (const f of files) {
    const ext = extname(f);
    const m = /^(.*?)(\d{3,})$/.exec(stem(f));
    if (STILL_EXT.has(ext) && m) { const key = dirname(f) + '/' + m[1] + '#' + ext; (groups.get(key) || groups.set(key, []).get(key)).push(f); }
    else singles.push(f);
  }
  const seqs = [];
  for (const [, arr] of groups) { if (arr.length >= 4) seqs.push(arr.sort(naturalCompare)); else singles.push(...arr); }
  return { singles, seqs };
}

export async function importPaths(paths, opts = {}) {
  const project = app.store.project;
  let parent = opts.bin !== undefined ? opts.bin : currentBin();
  const files = [];
  const binFor = new Map();
  for (const p of paths) {
    const st = await window.native.call('fs:stat', p).catch(() => null);
    if (!st) continue;
    if (st.dir) {
      const entries = await window.native.call('fs:walk', p, app.prefs.get('media.importSubfolders') ? 8 : 0);
      const createBins = app.prefs.get('media.createBinsFromFolders') !== false;
      let rootBin = parent;
      if (createBins) { const b = createBin(basename(p), parent); binFor.set(p, b); rootBin = b.id; }
      for (const e of entries) {
        if (e.dir) { if (createBins) { const pb = binFor.get(dirname(e.path)); const b = createBin(basename(e.path), pb ? pb.id : rootBin); binFor.set(e.path, b); } continue; }
        if (MEDIA_EXT.has(extname(e.path))) files.push({ path: e.path, bin: createBins ? (binFor.get(dirname(e.path)) || { id: rootBin }).id : parent });
      }
    } else if (/\.cinergy$/i.test(p)) { await importProjectItems(p); }
    else if (/\.(srt|vtt|scc)$/i.test(p)) { const { importCaptions } = await import('./captions.js'); await importCaptions(p); }
    else if (/\.(cube|3dl)$/i.test(p)) { app.store.transact('Import LUT', () => { project.libraries.looks.push({ id: uid('look'), name: stem(p), path: p }); }, ['project']); toast('LUT added to Libraries'); }
    else if (/\.(otio|edl|fcpxml|xml)$/i.test(p)) { const { importTimeline } = await import('./interchange.js'); await importTimeline(p); }
    else if (MEDIA_EXT.has(extname(p))) files.push({ path: p, bin: parent });
  }
  // Skip duplicates already in the project unless preference allows
  const existing = new Set(Object.values(project.items).filter((i) => i.type === 'media').map((i) => i.path));
  const fresh = files.filter((f) => !existing.has(f.path));
  if (fresh.length < files.length && !opts.allowDuplicates) toast(`${files.length - fresh.length} file(s) are already in the project`, 'info');
  if (!fresh.length && !binFor.size) return [];
  const { singles, seqs } = opts.noSequences ? { singles: fresh.map((f) => f.path), seqs: [] } : detectSequences(fresh.map((f) => f.path));
  const binOf = new Map(fresh.map((f) => [f.path, f.bin]));
  const created = [];
  const job = jobs.start(`Importing ${singles.length + seqs.length} item(s)`, 'import');
  let i = 0;
  for (const p of singles) {
    try {
      jobs.update(job.id, i / Math.max(1, singles.length), `Importing ${basename(p)}`);
      const info = await window.native.call('media:probe', p);
      if (info.kind === 'unknown') { toast(`${basename(p)} has no audio or video streams`, 'warn'); continue; }
      if (info.fps) info.fps = snapFps(info.fps);
      const item = createMediaItem(p, info, binOf.get(p) || parent);
      if (info.kind === 'psd') await preparePsd(item, opts);
      created.push(item);
    } catch (e) { toast(`Cannot import ${basename(p)}: ${e.message}`, 'error', 6000); }
    i++;
  }
  for (const seqFiles of seqs) {
    try {
      const fps = app.prefs.get('media.imageSequenceFps') || 24;
      jobs.update(job.id, 0.9, `Building image sequence ${basename(seqFiles[0])}`);
      const movie = await window.native.call('media:image-sequence', seqFiles, { fps, jobId: job.id });
      const info = await window.native.call('media:probe', movie);
      info.name = stem(seqFiles[0]).replace(/\d+$/, '') + `[${seqFiles.length} frames]`;
      info.fps = fps; info.imageSequence = { first: seqFiles[0], count: seqFiles.length };
      const item = createMediaItem(movie, info, binOf.get(seqFiles[0]) || parent);
      item.name = info.name; item.sourceFiles = seqFiles[0];
      created.push(item);
    } catch (e) { toast('Image sequence import failed: ' + e.message, 'error'); }
  }
  jobs.done(job.id);
  app.store.transact('Import', () => {
    for (const b of binFor.values()) project.items[b.id] = b;
    for (const it of created) project.items[it.id] = it;
  }, ['items']);
  app.store.selectItems(created.map((c) => c.id));
  // post-import processing
  for (const it of created) postImport(it);
  if (project.settings.ingest.enabled) ingest(created);
  return created;
}

async function preparePsd(item, opts) {
  const r = await window.native.call('media:psd', item.path);
  item.info.width = r.width; item.info.height = r.height;
  item.psdComposite = r.composite;
  item.psdLayers = r.layers;
}

export async function psdAsSequence(item) {
  if (!item.psdLayers || !item.psdLayers.length) return toast('This Photoshop file has no layers to import', 'warn');
  const project = app.store.project;
  const items = [];
  for (const l of item.psdLayers) {
    const info = await window.native.call('media:probe', l.path);
    const it = createMediaItem(l.path, { ...info, kind: 'image' }, item.parent);
    it.name = `${l.name} (${item.name})`;
    items.push({ it, l });
  }
  const fps = app.store.seq ? app.store.seq.settings.fps : 24;
  const seq = createSequence(stem(item.name), { width: item.info.width, height: item.info.height, fps }, item.parent);
  const { createClip, createTrack } = await import('../core/project.js');
  seq.tracks.video = items.map((x, i) => createTrack('video', i, { name: x.l.name.slice(0, 24) })).reverse().reverse();
  const dur = Math.round((app.prefs.get('timeline.stillDuration') || 5) * fps);
  items.slice().reverse().forEach((x, i) => {
    const c = createClip('video', { type: 'media', itemId: x.it.id }, 0, dur, 0, { name: x.l.name });
    const op = c.effects.find((e) => e.type === 'opacity'); op.params.opacity = Math.round(x.l.opacity * 100);
    seq.tracks.video[i].clips.push(c);
  });
  app.store.transact('Import Layers as Sequence', () => { for (const x of items) project.items[x.it.id] = x.it; project.items[seq.id] = seq; }, ['items']);
  app.store.setActiveSequence(seq.id);
}

// Check decodability, prepare waveforms
export async function postImport(item) {
  if (item.type !== 'media') return;
  if (item.info.hasAudio && app.prefs.get('media.generateWaveforms') !== false) app.audio.bufferFor(item, 0);
  if (item.info.kind === 'video') {
    const can = await MediaPool.canPlay(item.path);
    if (!can.ok) await makePlaybackProxy(item, `Preparing ${item.name} for playback`);
    else if (shouldAutoProxy(item)) createProxies([item]);
    app.timeline && app.timeline.thumbsFor(item);
  }
}

function shouldAutoProxy(item) {
  const mode = app.prefs.get('media.autoProxy');
  if (mode === 'always') return true;
  if (mode === 'large') return item.info.width > 3000;
  return false;
}

export async function makePlaybackProxy(item, label) {
  try {
    await jobs.run(label || `Transcoding ${item.name}`, async (j) => {
      const out = await window.native.call('media:proxy', item.path, { height: Math.min(1080, item.info.height || 1080), codec: 'h264', jobId: j.id });
      app.store.project.items[item.id] && (app.store.project.items[item.id].playback = out);
      app.store.markDirty();
      app.pool.dropPath(item.path);
      app.player.invalidate();
      toast(`${item.name} uses a playback copy because its codec cannot be decoded directly. Exports use the original.`, 'info', 6000);
    }, 'proxy');
  } catch (e) { if (!/Cancelled/.test(e.message)) toast('Transcode failed: ' + e.message, 'error'); }
}

// ---------- Proxies ----------
export async function createProxies(items, opts = {}) {
  const st = app.store.project.settings.ingest;
  let settings = opts.settings;
  if (!settings && opts.ask) {
    settings = await formDialog('Create Proxies', [
      { key: 'height', label: 'Frame size', type: 'select', options: [[360, '640x360'], [540, '960x540'], [720, '1280x720'], [1080, '1920x1080']] },
      { key: 'codec', label: 'Format', type: 'select', string: true, options: [['h264', 'H.264'], ['prores_proxy', 'Apple ProRes 422 Proxy'], ['prores_lt', 'Apple ProRes 422 LT'], ['dnxhr_lb', 'DNxHR LB']] },
      { key: 'dest', label: 'Destination', type: 'select', string: true, options: [['cache', 'Media cache'], ['next', 'Next to original media, in Proxies folder']] },
    ], { height: st.proxyHeight, codec: st.proxyCodec, dest: 'cache' }, { ok: 'Create' });
    if (!settings) return;
  }
  settings = settings || { height: st.proxyHeight, codec: st.proxyCodec, dest: 'cache' };
  for (const item of items.filter((i) => i.type === 'media' && i.info.kind === 'video')) {
    jobs.run(`Proxy: ${item.name}`, async (j) => {
      const dir = settings.dest === 'next' ? dirname(item.path) + '/Proxies' : undefined;
      const out = await window.native.call('media:proxy', item.path, { height: settings.height, codec: settings.codec, dir, jobId: j.id });
      const it = app.store.project.items[item.id];
      if (it) { it.proxy = out; app.store.markDirty(); app.store.emit('change', { scope: 'items' }); }
    }, 'proxy').catch((e) => { if (!/Cancelled/.test(e.message)) toast('Proxy failed: ' + e.message, 'error'); });
  }
  toast('Creating proxies in the background');
}

export async function attachProxy(item) {
  const r = await window.native.call('dialog:open', { title: 'Attach Proxy', filters: [{ name: 'Media', extensions: ['mov', 'mp4', 'mxf', 'm4v'] }] });
  if (!r) return;
  app.store.transact('Attach Proxy', () => { item.proxy = r[0]; }, ['items']);
  app.player.invalidate();
}

export function detachProxy(items) { app.store.transact('Detach Proxy', () => { for (const it of items) it.proxy = null; }, ['items']); app.player.invalidate(); }

export function toggleProxies() {
  const p = app.store.project;
  p.settings.useProxies = !p.settings.useProxies;
  app.compositor.useProxies = p.settings.useProxies;
  app.store.markDirty();
  app.player.invalidate();
  app.ui && app.ui.updateHeader();
  toast(p.settings.useProxies ? 'Playing back from proxies' : 'Playing back from full-resolution media');
}

// ---------- Ingest ----------
export async function ingest(items) {
  const st = app.store.project.settings.ingest;
  const mode = st.mode;
  for (const item of items.filter((i) => i.type === 'media')) {
    if ((mode === 'copy' || mode === 'copyProxy' || mode === 'transcode') && !st.dest) { toast('Set an ingest destination in Project Settings', 'warn'); return; }
    jobs.run(`Ingest: ${item.name}`, async (j) => {
      let path = item.path;
      if (mode === 'copy' || mode === 'copyProxy') { path = await window.native.call('fs:copy', item.path, st.dest + '/' + basename(item.path)); }
      if (mode === 'transcode' && item.info.kind === 'video') path = await window.native.call('media:transcode', item.path, { codec: st.transcodeCodec, dir: st.dest, jobId: j.id });
      const it = app.store.project.items[item.id];
      if (it && path !== it.path) { it.originalPath = it.path; it.path = path; app.store.markDirty(); }
      if ((mode === 'proxy' || mode === 'copyProxy') && item.info.kind === 'video') await createProxies([it], { settings: { height: st.proxyHeight, codec: st.proxyCodec, dest: 'cache' } });
    }, 'ingest').catch((e) => toast('Ingest failed: ' + e.message, 'error'));
  }
}

// ---------- Offline / relink ----------
export async function checkOffline() {
  const project = app.store.project;
  const missing = [];
  for (const it of Object.values(project.items)) {
    if (it.type !== 'media') continue;
    const ok = await window.native.call('fs:exists', it.path).catch(() => false);
    if (!ok !== !!it.offline) it.offline = !ok;
    if (!ok) missing.push(it);
    if (it.proxy && !(await window.native.call('fs:exists', it.proxy).catch(() => false))) it.proxy = null;
    if (it.playback && !(await window.native.call('fs:exists', it.playback).catch(() => false))) { it.playback = null; postImport(it); }
  }
  if (missing.length) {
    app.store.emit('change', { scope: 'items' });
    const auto = await autoRelink(missing);
    const still = missing.filter((m) => m.offline);
    if (still.length) {
      const go = await confirmDialog(`${still.length} media file(s) are offline`, still.slice(0, 6).map((m) => basename(m.path)).join(', ') + (still.length > 6 ? '...' : '') + '. Locate them now?', 'Locate');
      if (go) await relinkDialog(still);
    } else if (auto) toast(`Relinked ${auto} file(s) automatically`);
  }
  app.player.invalidate();
}

// Look for files with the same name next to the project and in previously relinked folders
export async function autoRelink(items, roots = []) {
  const searchRoots = [...roots];
  if (app.store.path) { searchRoots.push(dirname(app.store.path)); searchRoots.push(dirname(dirname(app.store.path))); }
  let n = 0;
  for (const it of items) {
    for (const r of [...searchRoots]) {
      const p = await window.native.call('fs:find-file', basename(it.path), [r], app.prefs.get('media.relinkSearchDepth') || 6).catch(() => null);
      if (p) {
        const info = await window.native.call('media:probe', p).catch(() => null);
        if (info && Math.abs((info.duration || 0) - (it.info.duration || 0)) < 0.5) { it.path = p; it.offline = false; n++; searchRoots.unshift(dirname(p)); break; }
      }
    }
  }
  if (n) app.store.markDirty();
  return n;
}

export async function relinkDialog(items) {
  for (const it of items) {
    const r = await window.native.call('dialog:open', { title: `Where is "${basename(it.path)}"?`, defaultPath: dirname(it.path) });
    if (!r) break;
    const p = r[0];
    const info = await window.native.call('media:probe', p).catch(() => null);
    if (!info) { toast('That file cannot be read', 'error'); continue; }
    if (Math.abs((info.duration || 0) - (it.info.duration || 0)) > 1 && !(await confirmDialog('The durations do not match', `Original: ${it.info.duration.toFixed(2)}s, selected: ${info.duration.toFixed(2)}s. Link anyway?`, 'Link'))) continue;
    app.store.transact('Link Media', () => { it.path = p; it.offline = false; it.info = { ...it.info, ...info, name: it.info.name }; }, ['items']);
    // try siblings in the same folder for the rest
    await autoRelink(items.filter((x) => x.offline), [dirname(p)]);
  }
  app.store.emit('change', { scope: 'items' });
  app.player.invalidate();
}

export function makeOffline(items) { app.store.transact('Make Offline', () => { for (const it of items) it.offline = true; }, ['items']); app.player.invalidate(); }

export async function replaceFootage(item) {
  const r = await window.native.call('dialog:open', { title: `Replace "${item.name}" with` });
  if (!r) return;
  const info = await window.native.call('media:probe', r[0]);
  app.store.transact('Replace Footage', () => { item.path = r[0]; item.info = info; item.name = info.name; item.offline = false; item.proxy = null; item.playback = null; }, ['items']);
  app.pool.dropPath(r[0]);
  postImport(item);
  app.player.invalidate();
}

// ---------- Interpret footage ----------
export async function interpretFootage(items) {
  const it = items[0];
  if (!it || it.type !== 'media') return;
  const r = await formDialog(`Interpret Footage: ${items.length > 1 ? items.length + ' items' : it.name}`, [
    { type: 'group', label: 'Frame rate' },
    { key: 'fpsMode', label: 'Frame rate', type: 'select', string: true, options: [['file', `Use frame rate from file (${(it.info.fps || 0).toFixed(3)})`], ['assume', 'Assume this frame rate']] },
    { key: 'fps', label: 'Assume', type: 'number', step: 0.001, show: (v) => v.fpsMode === 'assume' },
    { type: 'group', label: 'Pixel aspect ratio' },
    { key: 'par', label: 'Pixel aspect', type: 'select', options: [[0, `Use from file (${(it.info.pixelAspect || 1).toFixed(4)})`], [1, 'Square Pixels (1.0)'], [0.9091, 'D1/DV NTSC (0.9091)'], [1.0940, 'D1/DV PAL (1.0940)'], [1.3333, 'HDV 1080 / DVCPRO HD 720 (1.333)'], [1.5, 'DVCPRO HD 1080 (1.5)'], [2, 'Anamorphic 2:1 (2.0)'], [1.5, 'Anamorphic 1.5x'], [1.33, 'Anamorphic 1.33x']] },
    { type: 'group', label: 'Alpha channel' },
    { key: 'alpha', label: 'Alpha', type: 'select', string: true, options: [['auto', 'Use embedded alpha'], ['ignore', 'Ignore alpha channel'], ['invert', 'Invert alpha channel'], ['premultiplied', 'Treat as premultiplied']] },
    { type: 'group', label: 'Color' },
    { key: 'colorSpace', label: 'Input color space', type: 'select', string: true, options: [['auto', 'Automatic (from file)'], ['rec709', 'Rec. 709'], ['pq', 'Rec. 2100 PQ'], ['hlg', 'Rec. 2100 HLG']] },
    { key: 'fieldOrder', label: 'Field order', type: 'select', string: true, options: [['file', 'Use from file'], ['progressive', 'Progressive'], ['tff', 'Upper field first'], ['bff', 'Lower field first']] },
  ], { fpsMode: it.interpret.fps ? 'assume' : 'file', fps: it.interpret.fps || it.info.fps || 24, par: it.interpret.pixelAspect || 0, alpha: it.interpret.alpha || 'auto', colorSpace: it.interpret.colorSpace || 'auto', fieldOrder: it.interpret.fieldOrder || 'file' });
  if (!r) return;
  app.store.transact('Interpret Footage', () => {
    for (const x of items) {
      if (x.type !== 'media') continue;
      x.interpret.fps = r.fpsMode === 'assume' ? r.fps : null;
      x.interpret.pixelAspect = r.par || null;
      x.interpret.alpha = r.alpha; x.interpret.colorSpace = r.colorSpace; x.interpret.fieldOrder = r.fieldOrder === 'file' ? null : r.fieldOrder;
    }
  }, ['items']);
  app.player.invalidate();
}

// ---------- Synthetic items ----------
export async function newSynthetic(generator) {
  const seq = app.store.seq;
  const defaults = { width: seq ? seq.settings.width : 1920, height: seq ? seq.settings.height : 1080, color: '#2f7cff', name: undefined };
  let opts = defaults;
  if (generator === 'matte') {
    const r = await formDialog('New Color Matte', [{ key: 'name', label: 'Name' }, { key: 'color', label: 'Color', type: 'color' }, { key: 'width', label: 'Width', type: 'number' }, { key: 'height', label: 'Height', type: 'number' }], { ...defaults, name: 'Color Matte' });
    if (!r) return; opts = r;
  }
  const it = createSynthItem(generator, opts, currentBin());
  app.store.transact('New ' + it.name, () => { app.store.project.items[it.id] = it; }, ['items']);
  app.store.selectItems([it.id]);
  return it;
}

export function newGraphicItem(name, graphic) {
  const it = createGraphicItem(name, graphic, currentBin());
  app.store.transact('New Graphic', () => { app.store.project.items[it.id] = it; }, ['items']);
  return it;
}

export function newBin(name = 'New Bin', parent) {
  const b = createBin(name, parent === undefined ? currentBin() : parent);
  app.store.transact('New Bin', () => { app.store.project.items[b.id] = b; }, ['items']);
  app.store.selectItems([b.id]);
  return b;
}

export function currentBin() {
  const p = app.panels.project;
  return p && p.currentBin !== undefined ? p.currentBin : null;
}

// ---------- Project management ----------
export function removeUnused() {
  const project = app.store.project;
  const unused = Object.values(project.items).filter((i) => (i.type === 'media' || i.type === 'synthetic' || i.type === 'graphic') && !itemUsage(project, i.id).length);
  if (!unused.length) return toast('No unused items');
  app.store.transact('Remove Unused', () => { for (const i of unused) delete project.items[i.id]; }, ['items']);
  toast(`Removed ${unused.length} unused item(s)`);
}

export async function deleteItems(ids) {
  const project = app.store.project;
  const all = new Set(ids);
  // include children of bins
  let grew = true;
  while (grew) { grew = false; for (const it of Object.values(project.items)) if (it.parent && all.has(it.parent) && !all.has(it.id)) { all.add(it.id); grew = true; } }
  const used = [...all].filter((id) => itemUsage(project, id).length);
  if (used.length && !(await confirmDialog(`${used.length} item(s) are used in sequences`, 'Deleting them also removes their clips from every sequence.', 'Delete', true))) return;
  app.store.transact('Delete', () => {
    for (const id of all) {
      for (const u of itemUsage(project, id)) u.track.clips = u.track.clips.filter((c) => c.src.itemId !== id);
      delete project.items[id];
    }
  }, ['items']);
  if (all.has(app.store.activeSeqId)) app.store.setActiveSequence(Object.values(project.items).find((i) => i.type === 'sequence')?.id || null);
  if (all.has(app.store.sourceItemId)) { app.store.sourceItemId = null; app.store.emit('source'); }
}

export function duplicateItems(ids) {
  const project = app.store.project;
  const out = [];
  app.store.transact('Duplicate', () => {
    for (const id of ids) {
      const it = project.items[id]; if (!it || it.type === 'bin') continue;
      const c = deepClone(it); c.id = uid(it.type); c.name = it.name + ' Copy';
      project.items[c.id] = c; out.push(c);
    }
  }, ['items']);
  app.store.selectItems(out.map((o) => o.id));
}

export async function projectManager() {
  const r = await formDialog('Project Manager', [
    { type: 'note', label: 'Collect the project and the media it uses into one folder, so it can be archived or moved to another system.' },
    { key: 'mode', label: 'Resulting project', type: 'select', string: true, options: [['collect', 'Collect files and copy to new location'], ['transcode', 'Consolidate and transcode']] },
    { key: 'dest', label: 'Destination', type: 'folder' },
    { key: 'unused', label: 'Options', type: 'check', text: 'Exclude unused clips' },
    { key: 'proxies', label: '', type: 'check', text: 'Include proxies' },
    { key: 'codec', label: 'Transcode format', type: 'select', string: true, options: [['prores_422', 'Apple ProRes 422'], ['dnxhr_hq', 'DNxHR HQ'], ['h264', 'H.264']], show: (v) => v.mode === 'transcode' },
  ], { mode: 'collect', dest: '', unused: true, proxies: false, codec: 'prores_422' }, { ok: 'Collect' });
  if (!r || !r.dest) return;
  const project = JSON.parse(app.store.serialize());
  const root = `${r.dest}/${project.name || 'Project'}`;
  const media = Object.values(project.items).filter((i) => i.type === 'media');
  const keep = r.unused ? media.filter((i) => itemUsage(app.store.project, i.id).length) : media;
  if (r.unused) for (const i of media) if (!keep.includes(i)) delete project.items[i.id];
  const job = jobs.start('Collecting project files', 'collect');
  let n = 0;
  for (const it of keep) {
    jobs.update(job.id, n++ / keep.length, `Copying ${it.name}`);
    try {
      if (r.mode === 'transcode' && it.info.kind === 'video') it.path = await window.native.call('media:transcode', it.path, { codec: r.codec, dir: root + '/Media' });
      else it.path = await window.native.call('fs:copy', it.path, root + '/Media/' + basename(it.path));
      if (r.proxies && it.proxy) it.proxy = await window.native.call('fs:copy', it.proxy, root + '/Proxies/' + basename(it.proxy)); else it.proxy = null;
      it.playback = null;
    } catch (e) { toast(`Could not copy ${it.name}: ${e.message}`, 'error'); }
  }
  await window.native.call('fs:write-text', `${root}/${project.name || 'Project'}.cinergy`, JSON.stringify(project));
  jobs.done(job.id);
  toast('Project collected');
  window.native.call('shell:reveal', `${root}/${project.name || 'Project'}.cinergy`);
}

export async function importProjectItems(path) {
  const { migrate } = await import('./project-io.js');
  const other = migrate(JSON.parse(await window.native.call('fs:read-text', path)));
  const bin = createBin(stem(path));
  app.store.transact('Import Project', () => {
    app.store.project.items[bin.id] = bin;
    for (const it of Object.values(other.items)) { if (!it.parent) it.parent = bin.id; app.store.project.items[it.id] = it; }
  }, ['items']);
  toast('Imported items from ' + basename(path));
}

export async function mediaProperties(item) {
  const i = item.info || {};
  const rows = [
    ['File', item.path], ['Type', i.kind], ['Format', i.format], ['Duration', i.duration ? i.duration.toFixed(3) + ' s' : 'Still'], ['Size', i.size ? (i.size / 1048576).toFixed(1) + ' MB' : ''],
    ['Video', i.hasVideo ? `${i.width}x${i.height}, ${(i.fps || 0).toFixed(3)} fps, ${i.codec} ${i.profile || ''}` : 'None'], ['Pixel format', i.pixfmt], ['Bit depth', i.bitDepth],
    ['Color', [i.colorPrimaries, i.colorTransfer, i.colorSpace].filter(Boolean).join(' / ') || 'Unspecified'], ['HDR', i.hdr ? 'Yes' : 'No'], ['Field order', i.fieldOrder],
    ['Audio', i.hasAudio ? `${i.audioCodec}, ${i.sampleRate} Hz, ${i.channels} ch (${i.channelLayout || ''}), ${i.audioStreams} stream(s)` : 'None'],
    ['Timecode', i.timecode || ''], ['Camera', [i.make, i.camera].filter(Boolean).join(' ')], ['Created', i.creationTime || ''], ['Bit rate', i.bitrate ? (i.bitrate / 1e6).toFixed(2) + ' Mb/s' : ''],
    ['Proxy', item.proxy || 'None'], ['Playback copy', item.playback || 'None'], ['Used in', itemUsage(app.store.project, item.id).length + ' clip(s)'],
  ];
  await modal({ title: 'Properties: ' + item.name, width: 640, body: h('table', { style: { width: '100%', borderCollapse: 'collapse' } }, rows.map(([k, v]) => h('tr', h('td', { style: { color: 'var(--muted)', padding: '4px 10px 4px 0', verticalAlign: 'top', width: '130px' } }, k), h('td', { style: { color: 'var(--white)', padding: '4px 0', wordBreak: 'break-all', userSelect: 'text' } }, String(v == null ? '' : v))))) });
}

export { itemDuration };
