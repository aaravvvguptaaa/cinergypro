// Project lifecycle: new, open, save, auto-save, crash recovery, templates, productions.
import { app } from '../app-context.js';
import { createProject, createSequence, createBin, PROJECT_VERSION, allTracks } from '../core/project.js';
import { basename, dirname, stem, deepClone, uid } from '../core/util.js';
import { toast, confirmDialog, modal } from '../ui/widgets.js';
import { h } from '../core/util.js';

let autosaveTimer = null;

export function migrate(p) {
  if (!p || p.format !== 'cinergypro') throw new Error('This file is not a CinergyPro project.');
  if (p.version > PROJECT_VERSION) toast('This project was saved by a newer CinergyPro. Some features may not load.', 'warn', 6000);
  p.libraries = Object.assign({ colors: [], textStyles: [], looks: [], graphics: [], effectPresets: [], transitionPresets: [] }, p.libraries || {});
  p.settings = Object.assign(createProject().settings, p.settings || {});
  for (const it of Object.values(p.items)) {
    if (it.type === 'sequence') {
      it.captionTracks = it.captionTracks || []; it.markers = it.markers || []; it.buses = it.buses || [];
      it.master = Object.assign({ volume: 0, effects: [], keyframes: { volume: [] }, mute: false }, it.master || {});
      it.view = it.view || { zoom: 3, scrollX: 0, scrollY: 0 };
      for (const t of allTracks(it)) { t.transitions = t.transitions || []; t.audio = Object.assign({ volume: 0, pan: 0, effects: [], route: 'master', automation: 'read', keyframes: { volume: [], pan: [] } }, t.audio || {}); }
    }
    if (it.type === 'media') { it.markers = it.markers || []; it.interpret = Object.assign({ fps: null, pixelAspect: null, alpha: 'auto', colorSpace: 'auto' }, it.interpret || {}); }
  }
  p.version = PROJECT_VERSION;
  return p;
}

export function newProjectData(name, settings = {}) {
  const p = createProject(name);
  const footage = createBin('Footage'); const seqs = createBin('Sequences'); const gfx = createBin('Graphics & Audio');
  for (const b of [footage, seqs, gfx]) p.items[b.id] = b;
  const seq = createSequence('Sequence 01', { width: settings.width || 1920, height: settings.height || 1080, fps: settings.fps || 24 }, seqs.id);
  p.items[seq.id] = seq;
  p.activeSequence = seq.id;
  return p;
}

export async function newProject(opts = {}) {
  if (!(await confirmClose())) return false;
  const p = newProjectData(opts.name || 'Untitled Project', opts);
  if (opts.path) { app.store.setProject(p, opts.path); await saveProject(); }
  else app.store.setProject(p, null);
  afterOpen();
  return true;
}

export async function openProject(path) {
  if (!path) {
    const r = await window.native.call('dialog:open', { title: 'Open Project', filters: [{ name: 'CinergyPro Project', extensions: ['cinergy'] }, { name: 'Interchange', extensions: ['otio', 'xml', 'fcpxml', 'edl'] }] });
    if (!r) return false;
    path = r[0];
  }
  if (/\.(otio|xml|fcpxml|edl)$/i.test(path)) { const { importTimeline } = await import('./interchange.js'); return importTimeline(path); }
  if (!(await confirmClose())) return false;
  try {
    const txt = await window.native.call('fs:read-text', path);
    const p = migrate(JSON.parse(txt));
    const lock = await window.native.call('project:lock', path);
    if (lock.locked) {
      const ok = await confirmDialog('This project is open on another system', `Locked by ${lock.by.user} on ${lock.by.host}. Opening it here can overwrite their changes. Open read-only copy?`, 'Open anyway');
      if (!ok) return false;
    }
    if (app.store.path) window.native.call('project:unlock', app.store.path).catch(() => {});
    app.store.setProject(p, path);
    addRecent(path, p.name);
    afterOpen();
    const { checkOffline } = await import('./media.js');
    checkOffline();
    return true;
  } catch (e) { toast('Could not open project: ' + e.message, 'error', 6000); return false; }
}

export async function saveProject(saveAs = false) {
  const st = app.store;
  let path = st.path;
  if (!path || saveAs) {
    const def = (app.prefs.get('export.lastDir') || app.info.documents) + '/' + (st.project.name || 'Untitled Project') + '.cinergy';
    path = await window.native.call('dialog:save', { title: saveAs ? 'Save Project As' : 'Save Project', defaultPath: def, filters: [{ name: 'CinergyPro Project', extensions: ['cinergy'] }] });
    if (!path) return false;
    if (!/\.cinergy$/i.test(path)) path += '.cinergy';
    st.project.name = stem(path);
  }
  try {
    // keep a backup of the previous version
    if (await window.native.call('fs:exists', path)) await window.native.call('fs:copy', path, path + '.bak').catch(() => {});
    await window.native.call('fs:write-text', path, st.serialize());
    if (path !== st.path) { if (st.path) window.native.call('project:unlock', st.path).catch(() => {}); await window.native.call('project:lock', path); }
    st.path = path; st.dirty = false; st.emit('dirty', false);
    addRecent(path, st.project.name);
    updateTitle();
    toast('Project saved');
    return true;
  } catch (e) { toast('Save failed: ' + e.message, 'error', 6000); return false; }
}

export async function saveCopy() {
  const path = await window.native.call('dialog:save', { title: 'Save a Copy', defaultPath: (app.store.path || app.info.documents + '/Untitled.cinergy').replace(/\.cinergy$/, ' Copy.cinergy'), filters: [{ name: 'CinergyPro Project', extensions: ['cinergy'] }] });
  if (!path) return;
  await window.native.call('fs:write-text', path, app.store.serialize());
  toast('Copy saved');
}

export async function autosave() {
  const st = app.store;
  if (!st.dirty || !app.prefs.get('autosave.enabled')) return;
  const dir = app.info.autosaveDir;
  const name = (st.project.name || 'Untitled').replace(/[^\w\- ]+/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${dir}/${name}-${stamp}.cinergy`;
  try {
    await window.native.call('fs:write-text', file, st.serialize());
    const files = (await window.native.call('fs:list', dir)).filter((f) => f.name.startsWith(name + '-') && f.name.endsWith('.cinergy')).sort((a, b) => b.mtime - a.mtime);
    const max = app.prefs.get('autosave.maxVersions') || 20;
    for (const f of files.slice(max)) await window.native.call('fs:remove', f.path);
    window.native.call('session:mark', { clean: false, autosave: file, project: st.path, at: Date.now() }).catch(() => {});
  } catch (e) { console.warn('autosave failed', e); }
}

export function startAutosave() {
  clearInterval(autosaveTimer);
  const mins = app.prefs.get('autosave.interval') || 5;
  autosaveTimer = setInterval(autosave, mins * 60000);
}

export async function checkRecovery() {
  const s = await window.native.call('session:read').catch(() => null);
  if (!s || s.clean || !s.autosave) return false;
  if (!(await window.native.call('fs:exists', s.autosave))) return false;
  const ok = await confirmDialog('CinergyPro did not close normally', `An auto-saved version from ${new Date(s.at).toLocaleString()} is available. Recover it?`, 'Recover');
  await window.native.call('session:mark', { clean: true });
  if (!ok) return false;
  const p = migrate(JSON.parse(await window.native.call('fs:read-text', s.autosave)));
  app.store.setProject(p, s.project || null);
  app.store.markDirty();
  afterOpen();
  toast('Recovered from auto-save. Save the project to keep it.');
  return true;
}

export async function revertProject() {
  if (!app.store.path) return;
  if (!(await confirmDialog('Revert to the last saved version?', 'Unsaved changes will be lost.', 'Revert', true))) return;
  app.store.dirty = false;
  await openProject(app.store.path);
}

export async function confirmClose() {
  const st = app.store;
  if (!st.dirty || !Object.keys(st.project.items).length) return true;
  const r = await window.native.call('dialog:message', { type: 'warning', message: `Save changes to "${st.project.name}"?`, detail: 'Your changes will be lost if you do not save them.', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2 });
  if (r === 2) return false;
  if (r === 0) return saveProject();
  return true;
}

export async function closeProject() {
  if (!(await confirmClose())) return;
  if (app.store.path) window.native.call('project:unlock', app.store.path).catch(() => {});
  app.store.setProject(createProject('Untitled Project'), null);
  app.ui.showHome();
}

export function addRecent(path, name) {
  const list = (app.prefs.get('general.recentProjects') || []).filter((r) => r.path !== path);
  list.unshift({ path, name, at: Date.now() });
  app.prefs.set('general.recentProjects', list.slice(0, 16));
}

export function updateTitle() {
  const st = app.store;
  const name = st.project.name || 'Untitled Project';
  window.native.call('app:set-title', `CinergyPro - ${name}${st.dirty ? ' (edited)' : ''}`).catch(() => {});
  window.native.call('app:set-edited', st.dirty).catch(() => {});
  if (app.ui) app.ui.updateHeader();
}

function afterOpen() {
  updateTitle();
  if (app.ui) app.ui.hideHome();
  app.player && app.player.invalidate();
  startAutosave();
}

// ---------- Templates ----------
export async function saveAsTemplate() {
  const name = await (await import('../ui/widgets.js')).promptDialog('Save Project as Template', app.store.project.name + ' Template');
  if (!name) return;
  const p = JSON.parse(app.store.serialize());
  p.name = name; p.id = uid('proj');
  await window.native.call('fs:write-text', `${app.info.presetsDir}/Templates/${name}.cinergy`, JSON.stringify(p));
  toast('Template saved');
}

export async function listTemplates() {
  try { return (await window.native.call('fs:list', `${app.info.presetsDir}/Templates`)).filter((f) => f.name.endsWith('.cinergy')); } catch { return []; }
}

export async function newFromTemplate(path) {
  if (!(await confirmClose())) return;
  const p = migrate(JSON.parse(await window.native.call('fs:read-text', path)));
  p.id = uid('proj'); p.name = 'Untitled Project'; p.created = Date.now();
  app.store.setProject(p, null);
  afterOpen();
}

// ---------- Productions (folder of related projects) ----------
export async function newProduction() {
  const dir = await window.native.call('dialog:open', { title: 'Choose a folder for the new production', directory: true });
  if (!dir) return;
  const meta = { format: 'cinergypro-production', name: basename(dir[0]), created: Date.now(), sharedMedia: dir[0] + '/Shared Media' };
  await window.native.call('fs:mkdir', dir[0] + '/Shared Media');
  await window.native.call('fs:write-text', dir[0] + '/production.json', JSON.stringify(meta, null, 2));
  app.prefs.set('general.production', dir[0]);
  app.dock.openPanel('production');
  toast('Production created');
}

export async function openProduction(path) {
  if (!path) { const r = await window.native.call('dialog:open', { title: 'Open Production Folder', directory: true }); if (!r) return; path = r[0]; }
  if (!(await window.native.call('fs:exists', path + '/production.json'))) await window.native.call('fs:write-text', path + '/production.json', JSON.stringify({ format: 'cinergypro-production', name: basename(path), created: Date.now() }, null, 2));
  app.prefs.set('general.production', path);
  app.dock.openPanel('production');
}

export async function projectSettingsDialog() {
  const { formDialog } = await import('../ui/widgets.js');
  const p = app.store.project;
  const r = await formDialog('Project Settings', [
    { type: 'group', label: 'General' },
    { key: 'name', label: 'Project name' },
    { key: 'useProxies', label: 'Proxies', type: 'check', text: 'Use proxies for playback' },
    { type: 'group', label: 'Color management' },
    { key: 'workingSpace', label: 'Working color space', type: 'select', options: [['rec709', 'Rec. 709 (SDR)'], ['rec2100pq', 'Rec. 2100 PQ (HDR)'], ['rec2100hlg', 'Rec. 2100 HLG (HDR)']], string: true },
    { key: 'autoToneMapHDR', label: 'HDR media', type: 'check', text: 'Tone-map HDR media in SDR sequences' },
    { key: 'autoDetectLog', label: 'Log media', type: 'check', text: 'Detect log footage from camera metadata' },
    { type: 'group', label: 'Ingest' },
    { key: 'ingest', label: 'Ingest on import', type: 'check', text: 'Process media when importing' },
    { key: 'ingestMode', label: 'Ingest action', type: 'select', string: true, options: [['copy', 'Copy to destination'], ['transcode', 'Transcode'], ['proxy', 'Create proxies'], ['copyProxy', 'Copy and create proxies']] },
    { key: 'ingestDest', label: 'Destination', type: 'folder' },
    { key: 'proxyHeight', label: 'Proxy size', type: 'select', options: [[360, '640x360'], [540, '960x540'], [720, '1280x720'], [1080, '1920x1080']] },
    { key: 'proxyCodec', label: 'Proxy format', type: 'select', string: true, options: [['h264', 'H.264'], ['prores_proxy', 'Apple ProRes 422 Proxy'], ['prores_lt', 'Apple ProRes 422 LT'], ['dnxhr_lb', 'DNxHR LB']] },
    { key: 'transcodeCodec', label: 'Transcode format', type: 'select', string: true, options: [['prores_422', 'Apple ProRes 422'], ['prores_hq', 'Apple ProRes 422 HQ'], ['dnxhr_hq', 'DNxHR HQ'], ['h264', 'H.264 (high quality)']] },
  ], { name: p.name, useProxies: p.settings.useProxies, workingSpace: p.settings.color.workingSpace, autoToneMapHDR: p.settings.color.autoToneMapHDR, autoDetectLog: p.settings.color.autoDetectLog, ingest: p.settings.ingest.enabled, ingestMode: p.settings.ingest.mode, ingestDest: p.settings.ingest.dest, proxyHeight: p.settings.ingest.proxyHeight, proxyCodec: p.settings.ingest.proxyCodec, transcodeCodec: p.settings.ingest.transcodeCodec });
  if (!r) return;
  app.store.transact('Project Settings', () => {
    p.name = r.name; p.settings.useProxies = r.useProxies;
    Object.assign(p.settings.color, { workingSpace: r.workingSpace, autoToneMapHDR: r.autoToneMapHDR, autoDetectLog: r.autoDetectLog });
    Object.assign(p.settings.ingest, { enabled: r.ingest, mode: r.ingestMode, dest: r.ingestDest, proxyHeight: r.proxyHeight, proxyCodec: r.proxyCodec, transcodeCodec: r.transcodeCodec });
  }, ['project']);
  app.compositor.useProxies = p.settings.useProxies;
  app.player.invalidate();
  updateTitle();
}

export { dirname };
