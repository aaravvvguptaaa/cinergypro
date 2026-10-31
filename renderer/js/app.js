// CinergyPro renderer entry: wires engines, commands, menus, workspace and panels.
import { app } from './app-context.js';
import { store } from './core/store.js';
import { prefs } from './core/prefs.js';
import { commands, accelerator, IS_MAC } from './core/commands.js';
import { h, icon, basename, uid } from './core/util.js';
import { GL } from './engine/gl.js';
import { MediaPool } from './engine/media-pool.js';
import { Compositor } from './engine/compositor.js';
import { AudioEngine } from './engine/audio-engine.js';
import { Player } from './engine/player.js';
import { Dock, WORKSPACES } from './ui/dock.js';
import { toast, commandPalette, closeMenus, contextMenu } from './ui/widgets.js';
import { VIDEO_EFFECTS, AUDIO_EFFECTS } from './core/effect-defs.js';
import { jobs } from './actions/jobs.js';
import * as IO from './actions/project-io.js';
import * as M from './actions/media.js';
import * as A from './actions/editing.js';
import * as X from './actions/export.js';
import { createTimeline } from './ui/panels/timeline.js';
import { createSourceMonitor, createProgramMonitor } from './ui/panels/monitor.js';
import { createProjectPanel } from './ui/panels/project.js';
import { createEffectControls } from './ui/panels/effect-controls.js';
import { createEffectsPanel } from './ui/panels/effects.js';
import { createLumetri, createScopes } from './ui/panels/lumetri.js';
import { createTrackMixer, createClipMixer, createMeters, createEssentialSound } from './ui/panels/audio.js';
import * as P from './ui/panels/misc.js';
import { preferencesDialog, shortcutsDialog, aboutDialog, homeScreen, newProjectDialog } from './ui/dialogs.js';
import { seqDuration, clipAt, createClip, allTracks, findClip } from './core/project.js';

const PANELS = {
  project: { title: 'Project', create: createProjectPanel },
  mediaBrowser: { title: 'Media Browser', create: P.createMediaBrowser },
  libraries: { title: 'Libraries', create: P.createLibraries },
  info: { title: 'Info', create: P.createInfo },
  effects: { title: 'Effects', create: createEffectsPanel },
  markers: { title: 'Markers', create: P.createMarkers },
  history: { title: 'History', create: P.createHistory },
  metadata: { title: 'Metadata', create: P.createMetadata },
  production: { title: 'Production', create: P.createProduction },
  source: { title: 'Source', create: createSourceMonitor },
  program: { title: 'Program', create: createProgramMonitor },
  timeline: { title: 'Timeline', create: createTimeline },
  effectControls: { title: 'Effect Controls', create: createEffectControls },
  audioClipMixer: { title: 'Audio Clip Mixer', create: createClipMixer },
  audioTrackMixer: { title: 'Audio Track Mixer', create: createTrackMixer },
  meters: { title: 'Audio Meters', create: createMeters },
  lumetri: { title: 'Lumetri Color', create: createLumetri },
  scopes: { title: 'Lumetri Scopes', create: createScopes },
  essentialSound: { title: 'Essential Sound', create: createEssentialSound },
  text: { title: 'Text', create: P.createText },
  properties: { title: 'Properties', create: P.createProperties },
  tools: { title: 'Tools', create: P.createTools },
  exportQueue: { title: 'Export Queue', create: P.createExportQueue },
  learn: { title: 'Learn', create: P.createLearn },
  scriptConsole: { title: 'Script Console', create: P.createScriptConsole },
};

async function boot() {
  const native = window.native;
  if (IS_MAC) document.documentElement.classList.add('mac');
  app.info = await native.call('app:info');
  app.caps = await native.call('media:capabilities');
  await prefs.load(app.info.userData);
  app.store = store; app.prefs = prefs; app.commands = commands; app.jobs = jobs;
  app.effectDefs = { ...VIDEO_EFFECTS, ...AUDIO_EFFECTS };
  app.audioFxDefs = AUDIO_EFFECTS;
  app.exporter = X;
  app.native = true;

  // engines
  const glCanvas = h('canvas', { width: 1920, height: 1080, style: { position: 'fixed', left: '-10000px', top: 0, width: '16px', height: '16px', pointerEvents: 'none' } });
  document.body.appendChild(glCanvas);
  app.gl = new GL(glCanvas);
  app.pool = new MediaPool(app.gl);
  app.compositor = new Compositor(app.gl, app.pool, () => store.project);
  app.compositor.previewLookup = X.previewLookup;
  app.audio = new AudioEngine(() => store.project);
  app.player = new Player(app.gl, app.compositor, app.pool, app.audio);
  app.pool.on('error', ({ path }) => {
    const it = Object.values(store.project.items).find((i) => i.type === 'media' && (i.path === path) && !i.playback);
    if (it && !app.__transcoding?.has(it.id)) { (app.__transcoding = app.__transcoding || new Set()).add(it.id); M.makePlaybackProxy(it); }
  });
  document.addEventListener('pointerdown', () => app.audio.init().then(() => app.audio.resume()), { once: true });

  app.ui = { openInSource, showHome, hideHome, updateHeader, buildMenu, applyAppearance };
  registerCommands();
  commands.setCustom(prefs.get('shortcuts.custom'));
  buildHeader();
  buildStatus();
  applyAppearance();

  app.dock = new Dock(document.getElementById('dock'), PANELS);
  const ws = prefs.get('workspaces.current') || 'Editing';
  app.dock.setLayout(prefs.get('workspaces.modified')[ws] || prefs.get('workspaces.custom')[ws] || WORKSPACES[ws] || WORKSPACES.Editing);
  app.dock.on('focus', (id) => { store.focusPanel = id; });
  app.dock.on('changed', () => { const cur = prefs.get('workspaces.current'); const mod = prefs.get('workspaces.modified') || {}; mod[cur] = app.dock.serialize(); prefs.set('workspaces.modified', mod); });
  app.dock.focus('timeline');

  // global keyboard
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', (e) => { if (e.code === 'KeyK') app.__kHeld = false; });
  // file drops anywhere
  window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => { if (e.defaultPrevented) return; e.preventDefault(); const paths = [...e.dataTransfer.files].map((f) => native.pathForFile(f)); if (paths.length === 1 && paths[0].endsWith('.cinergy')) IO.openProject(paths[0]); else if (paths.length) M.importPaths(paths); });

  // store reactions
  store.on('dirty', () => IO.updateTitle());
  store.on('change', (e) => { X.seqVideoHash && app.__hashCache && app.__hashCache.clear(); app.player.invalidate(); if (e && (e.scope === 'history' || e.label)) app.audio.playing && !e.transient && reschedule(); });
  store.on('project', () => { app.compositor.useProxies = !!store.project.settings.useProxies; app.pool.invalidateGenerated(); app.timeline && (app.timeline.thumbs.clear()); app.player.invalidate(); updateHeader(); });
  store.on('sequence', () => { app.player.invalidate(); updateHeader(); });

  native.on('menu:command', (id) => commands.run(id));
  native.on('app:request-close', () => quit());
  native.on('app:open-file', (p) => IO.openProject(p));
  native.on('popout:from', (m) => { if (m.type === 'key' && m.key === ' ') app.player.toggle(); });
  buildMenu();

  const { loadPlugins } = await import('./actions/scripting.js');
  loadPlugins().catch((e) => console.warn(e));

  // startup
  const params = new URLSearchParams(location.search);
  if (params.get('test')) { const t = await import('./test-harness.js'); t.run(); return; }
  await native.call('session:mark', { clean: false, at: Date.now() });
  if (await IO.checkRecovery()) return;
  const pending = await native.call('app:take-pending-open').catch(() => null);
  if (pending) { await IO.openProject(pending); return; }
  const startup = prefs.get('general.startup');
  const recent = prefs.get('general.recentProjects') || [];
  if (startup === 'last' && recent[0] && await native.call('fs:exists', recent[0].path)) { await IO.openProject(recent[0].path); return; }
  showHome();
}

let rescheduleTimer = null;
function reschedule() { clearTimeout(rescheduleTimer); rescheduleTimer = setTimeout(() => { if (app.player.state.program.playing) app.player.restartProgram(); }, 60); }

async function quit() {
  app.player.pause();
  if (!(await IO.confirmClose())) return;
  await window.native.call('session:mark', { clean: true });
  if (store.path) await window.native.call('project:unlock', store.path).catch(() => {});
  window.native.call('app:allow-close');
}

// ---------- Header & status ----------
let headerEls = {};
function buildHeader() {
  const hd = document.getElementById('header');
  hd.innerHTML = '';
  const tabs = h('div.ws-tabs');
  headerEls.tabs = tabs;
  headerEls.title = h('div.header-title');
  headerEls.proxy = h('button.hdr-btn', { title: 'Toggle proxies', on: { click: () => { M.toggleProxies(); updateHeader(); } } }, icon('proxy', 14), 'Proxies');
  hd.append(h('div.brand', icon('logo', 20), 'CinergyPro'), tabs, h('div.header-spacer'), headerEls.title,
    h('button.hdr-btn', { title: 'Search commands', on: { click: () => commandPalette(paletteExtras()) } }, icon('search', 14)),
    headerEls.proxy,
    h('button.hdr-btn.primary', { on: { click: () => X.exportDialog() } }, icon('export', 14), 'Export'));
  renderWorkspaceTabs();
}

function renderWorkspaceTabs() {
  const tabs = headerEls.tabs; tabs.innerHTML = '';
  const cur = prefs.get('workspaces.current');
  const names = [...(prefs.get('workspaces.order') || Object.keys(WORKSPACES)), ...Object.keys(prefs.get('workspaces.custom') || {})].filter((n, i, a) => a.indexOf(n) === i);
  for (const n of names.slice(0, 9)) {
    const t = h('button.ws-tab' + (n === cur ? '.active' : ''), n);
    t.addEventListener('click', () => switchWorkspace(n));
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, workspaceMenu()); });
    tabs.appendChild(t);
  }
}

function switchWorkspace(n, reset = false) {
  prefs.set('workspaces.current', n);
  const mod = prefs.get('workspaces.modified') || {};
  if (reset) { delete mod[n]; prefs.set('workspaces.modified', mod); }
  app.dock.setLayout((!reset && mod[n]) || prefs.get('workspaces.custom')[n] || WORKSPACES[n] || WORKSPACES.Editing);
  renderWorkspaceTabs();
  buildMenu();
}

function workspaceMenu() {
  const names = [...Object.keys(WORKSPACES), ...Object.keys(prefs.get('workspaces.custom') || {})];
  return [
    ...names.map((n) => ({ label: n, checked: n === prefs.get('workspaces.current'), action: () => switchWorkspace(n) })),
    '-',
    { label: 'Reset to Saved Layout', action: () => switchWorkspace(prefs.get('workspaces.current'), true) },
    { label: 'Save Changes to This Workspace', action: () => { const n = prefs.get('workspaces.current'); const c = prefs.get('workspaces.custom') || {}; c[n] = app.dock.serialize(); prefs.set('workspaces.custom', c); toast('Workspace saved'); } },
    { label: 'Save as New Workspace...', action: async () => { const { promptDialog } = await import('./ui/widgets.js'); const n = await promptDialog('Workspace name', 'My Workspace'); if (!n) return; const c = prefs.get('workspaces.custom') || {}; c[n] = app.dock.serialize(); prefs.set('workspaces.custom', c); switchWorkspace(n); } },
    { label: 'Delete Custom Workspace', disabled: !(prefs.get('workspaces.custom') || {})[prefs.get('workspaces.current')] || !!WORKSPACES[prefs.get('workspaces.current')], action: () => { const c = prefs.get('workspaces.custom'); delete c[prefs.get('workspaces.current')]; prefs.set('workspaces.custom', c); switchWorkspace('Editing'); } },
  ];
}

function updateHeader() {
  if (!headerEls.title) return;
  const s = store.seq;
  headerEls.title.innerHTML = '';
  headerEls.title.append(h('b', store.project.name || 'Untitled Project'), store.dirty ? ' (edited)' : '', s ? `  -  ${s.name}` : '');
  headerEls.proxy.classList.toggle('on', !!store.project.settings.useProxies);
}

function buildStatus() {
  const st = document.getElementById('status');
  const jobsEl = h('div.jobs'); const msg = h('div.msg', h('span.dot'), ' Ready');
  const right = h('div', { style: { fontFamily: 'var(--mono)' } });
  st.append(jobsEl, msg, right);
  const render = () => {
    jobsEl.innerHTML = '';
    for (const j of jobs.list.values()) jobsEl.appendChild(h('div.job', h('span', j.label), h('div.bar', h('i', { style: { width: Math.round((j.progress || 0) * 100) + '%' } })), h('span', { style: { cursor: 'pointer', color: 'var(--dim)' }, title: 'Cancel', on: { click: () => j.cancel && j.cancel() } }, '×')));
    msg.style.display = jobs.list.size ? 'none' : '';
  };
  jobs.on('change', render);
  setInterval(() => { const s = store.seq; right.textContent = s ? `${s.settings.width}x${s.settings.height}  ${s.settings.fps} fps  ${app.player.state.program.playing ? Math.round(app.player.fps()) + ' ms' : ''}` : ''; }, 500);
}

function applyAppearance() {
  const r = document.documentElement;
  r.classList.toggle('high-contrast', !!prefs.get('appearance.highContrast'));
  r.classList.remove('bright-1', 'bright-2');
  const b = prefs.get('appearance.brightness'); if (b) r.classList.add('bright-' + b);
  r.style.zoom = prefs.get('appearance.interfaceScale') || 1;
  window.__noTips = prefs.get('general.showTooltips') === false;
}

let homeEl = null;
function showHome() { if (homeEl) homeEl.remove(); homeEl = homeScreen(); document.body.appendChild(homeEl); }
function hideHome() { if (homeEl) { homeEl.remove(); homeEl = null; } }

function openInSource(id, t = null) {
  const it = store.project.items[id]; if (!it) return;
  app.player.stopSource();
  store.sourceItemId = id;
  store.emit('source');
  app.dock.activate('source');
  app.player.state.source.time = 0;
  app.player.seekSource(t != null ? t : (it.inPoint || 0));
  app.dock.focus('source');
}

function paletteExtras() {
  const out = [];
  for (const [id, p] of Object.entries(PANELS)) out.push({ label: p.title, cat: 'Panel', run: () => app.dock.openPanel(id) });
  for (const [k, d] of Object.entries(app.effectDefs)) if (!d.intrinsic) out.push({ label: d.name, cat: 'Effect', run: () => A.applyEffect(k) });
  for (const n of Object.keys(WORKSPACES)) out.push({ label: n, cat: 'Workspace', run: () => switchWorkspace(n) });
  return out;
}

// ---------- Keyboard ----------
function onKey(e) {
  if (document.querySelector('.modal-back')) return;
  const t = e.target;
  const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (inField && (e.metaKey || e.ctrlKey) && ['c', 'v', 'x', 'a', 'z'].includes(e.key.toLowerCase())) {
    const map = { c: 'copy', v: 'paste', x: 'cut', a: 'selectAll', z: e.shiftKey ? 'redo' : 'undo' };
    document.execCommand(map[e.key.toLowerCase()]); e.preventDefault(); return;
  }
  if (e.key === 'Escape') closeMenus();
  if (e.code === 'KeyK' && !inField) app.__kHeld = true;
  // map Program focus for multicam angle keys
  let focus = store.focusPanel;
  if (['source', 'program'].includes(focus) === false && ['timeline', 'tools'].includes(focus)) focus = 'timeline';
  commands.handleKey(e, focus);
}

// Transport routes to the focused monitor (source or program)
function transport(fnProgram, fnSource) { return () => (store.focusPanel === 'source' ? fnSource() : fnProgram()); }

// ---------- Voice-over ----------
let recording = null;
async function toggleVoiceOver() {
  const s = store.seq; if (!s) return;
  if (recording) {
    const r = recording; recording = null;
    app.player.pause();
    const dir = store.path ? store.path.replace(/[^/]+$/, '') + 'Recorded Audio' : app.info.userData + '/Recorded Audio';
    const path = await app.audio.stopRecording(`${dir}/Voice Over ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`);
    const items = await M.importPaths([path], { allowDuplicates: true });
    if (!items[0]) return;
    store.transact('Record Voice-over', () => {
      const t = s.tracks.audio.find((x) => x.id === r.trackId) || s.tracks.audio[0];
      const dur = Math.max(1, Math.round((items[0].info.duration || 1) * s.settings.fps));
      const c = createClip('audio', { type: 'media', itemId: items[0].id, stream: 0 }, r.start, dur, 0, { name: items[0].name });
      const E = app.__edit; E.placeClips(s, [{ track: t, clip: c }], 'overwrite');
    });
    toast('Voice-over recorded');
    return;
  }
  const t = s.tracks.audio.find((x) => x.audio.recordArm);
  if (!t) return toast('Arm an audio track for recording first (the microphone button in the track header)', 'warn');
  try {
    await app.audio.startRecording(prefs.get('audio.inputDevice'));
    recording = { trackId: t.id, start: s.playhead };
    toast('Recording... press the record shortcut again to stop', 'warn', 4000);
    app.player.play(1);
  } catch (e) { toast('Could not access the microphone: ' + e.message, 'error'); }
}

// ---------- Commands ----------
function registerCommands() {
  const seq = () => store.seq;
  const P = 'program';
  const C = (label, category, keys, run, extra = {}) => ({ label, category, keys: keys ? (Array.isArray(keys) ? keys : [keys]) : [], run, ...extra });
  const panel = (id) => () => app.dock.openPanel(id);
  const def = {
    // File
    'file.new': C('New Project...', 'File', 'Mod+Alt+N', () => newProjectDialog()),
    'file.newSequence': C('New Sequence...', 'File', 'Mod+N', () => A.newSequenceDialog()),
    'file.open': C('Open Project...', 'File', 'Mod+O', () => IO.openProject()),
    'file.save': C('Save', 'File', 'Mod+S', () => IO.saveProject()),
    'file.saveAs': C('Save As...', 'File', 'Mod+Shift+S', () => IO.saveProject(true)),
    'file.saveCopy': C('Save a Copy...', 'File', 'Mod+Alt+S', () => IO.saveCopy()),
    'file.revert': C('Revert', 'File', null, () => IO.revertProject()),
    'file.close': C('Close Project', 'File', 'Mod+Shift+W', () => IO.closeProject()),
    'file.import': C('Import...', 'File', 'Mod+I', () => M.importDialog()),
    'file.importFolder': C('Import Folder...', 'File', null, () => M.importDialog({ folder: true })),
    'file.export': C('Export Media...', 'File', 'Mod+M', () => X.exportDialog()),
    'file.exportFrame': C('Export Frame...', 'File', 'Mod+Shift+E', () => X.exportFrame()),
    'file.exportQueue': C('Export Queue', 'File', null, panel('exportQueue')),
    'file.exportOTIO': C('Export OpenTimelineIO...', 'File', null, () => import('./actions/interchange.js').then((m) => m.exportTimeline('otio'))),
    'file.exportEDL': C('Export EDL...', 'File', null, () => import('./actions/interchange.js').then((m) => m.exportTimeline('edl'))),
    'file.exportXML': C('Export Final Cut Pro 7 XML...', 'File', null, () => import('./actions/interchange.js').then((m) => m.exportTimeline('xml'))),
    'file.exportFCPXML': C('Export FCPXML...', 'File', null, () => import('./actions/interchange.js').then((m) => m.exportTimeline('fcpxml'))),
    'file.importTimeline': C('Import Timeline (OTIO, EDL, XML)...', 'File', null, async () => { const r = await window.native.call('dialog:open', { filters: [{ name: 'Timelines', extensions: ['otio', 'edl', 'xml', 'fcpxml'] }] }); if (r) (await import('./actions/interchange.js')).importTimeline(r[0]); }),
    'file.exportCaptions': C('Export Captions...', 'File', null, () => import('./actions/captions.js').then((m) => m.exportCaptionsDialog())),
    'file.importCaptions': C('Import Captions...', 'File', null, () => import('./actions/captions.js').then((m) => m.importCaptions())),
    'file.exportStems': C('Export Audio Stems...', 'File', null, () => X.exportAudioStems()),
    'file.projectSettings': C('Project Settings...', 'File', null, () => IO.projectSettingsDialog()),
    'file.projectManager': C('Project Manager...', 'File', null, () => M.projectManager()),
    'file.saveTemplate': C('Save as Template...', 'File', null, () => IO.saveAsTemplate()),
    'file.newProduction': C('New Production...', 'File', null, () => IO.newProduction()),
    'file.openProduction': C('Open Production...', 'File', null, () => IO.openProduction()),
    'file.relink': C('Link Media...', 'File', null, () => { const off = Object.values(store.project.items).filter((i) => i.offline); off.length ? M.relinkDialog(off) : toast('No offline media'); }),
    'file.home': C('Home', 'File', null, () => showHome()),
    // Edit
    'edit.undo': C('Undo', 'Edit', 'Mod+Z', () => { const l = store.undo(); if (l) toast('Undo ' + l); app.player.invalidate(); }),
    'edit.redo': C('Redo', 'Edit', 'Mod+Shift+Z', () => { const l = store.redo(); if (l) toast('Redo ' + l); app.player.invalidate(); }),
    'edit.cut': C('Cut', 'Edit', 'Mod+X', () => A.copy(true)),
    'edit.copy': C('Copy', 'Edit', 'Mod+C', () => A.copy()),
    'edit.paste': C('Paste', 'Edit', 'Mod+V', () => A.paste('overwrite')),
    'edit.pasteInsert': C('Paste Insert', 'Edit', 'Mod+Shift+V', () => A.paste('insert')),
    'edit.pasteAttributes': C('Paste Attributes...', 'Edit', 'Mod+Alt+V', () => A.pasteAttributes()),
    'edit.clear': C('Clear', 'Edit', ['Backspace', 'Delete'], () => { if (store.focusPanel === 'project') M.deleteItems([...store.selection.items]); else if (store.focusPanel === 'effectControls' && app.panels.effectControls.deleteKeys()) {} else A.deleteSelection(false); }),
    'edit.rippleDelete': C('Ripple Delete', 'Edit', ['Shift+Backspace', 'Shift+Delete'], () => A.deleteSelection(true)),
    'edit.duplicate': C('Duplicate', 'Edit', 'Mod+Shift+/', () => (store.focusPanel === 'project' ? M.duplicateItems([...store.selection.items]) : A.duplicateInPlace())),
    'edit.selectAll': C('Select All', 'Edit', 'Mod+A', () => (store.focusPanel === 'project' ? store.selectItems(Object.keys(store.project.items)) : A.selectAll())),
    'edit.deselectAll': C('Deselect All', 'Edit', 'Mod+Shift+A', () => A.deselectAll()),
    'edit.find': C('Find...', 'Edit', 'Mod+F', () => { app.dock.openPanel('project'); app.panels.project.search.focus(); }),
    'edit.insert': C('Insert', 'Edit', ',', () => A.sourceEdit('insert')),
    'edit.overwrite': C('Overwrite', 'Edit', '.', () => A.sourceEdit('overwrite')),
    'edit.replace': C('Replace Edit', 'Edit', null, () => A.replaceEdit()),
    'edit.fitToFill': C('Fit to Fill', 'Edit', null, () => A.fitToFill()),
    'edit.lift': C('Lift', 'Edit', ';', () => A.liftExtract(false)),
    'edit.extract': C('Extract', 'Edit', "'", () => A.liftExtract(true)),
    'edit.addEdit': C('Add Edit', 'Edit', 'Mod+K', () => A.addEdit(false)),
    'edit.addEditAll': C('Add Edit to All Tracks', 'Edit', 'Mod+Shift+K', () => A.addEdit(true)),
    'edit.applyVideoTransition': C('Apply Video Transition', 'Edit', 'Mod+D', () => A.applyDefaultTransition('video')),
    'edit.applyAudioTransition': C('Apply Audio Transition', 'Edit', 'Mod+Shift+D', () => A.applyDefaultTransition('audio')),
    'edit.applyTransitions': C('Apply Default Transitions to Selection', 'Edit', 'Shift+D', () => A.applyDefaultTransition('both')),
    'edit.rippleTrimPrev': C('Ripple Trim Previous Edit to Playhead', 'Edit', 'Q', () => A.trimToPlayhead('start', true)),
    'edit.rippleTrimNext': C('Ripple Trim Next Edit to Playhead', 'Edit', 'W', () => A.trimToPlayhead('end', true)),
    'edit.trimPrev': C('Trim Previous Edit to Playhead', 'Edit', 'Alt+Q', () => A.trimToPlayhead('start', false)),
    'edit.trimNext': C('Trim Next Edit to Playhead', 'Edit', 'Alt+W', () => A.trimToPlayhead('end', false)),
    'edit.extendEdit': C('Extend Selected Edit to Playhead', 'Edit', 'E', () => A.extendToPlayhead()),
    'edit.nudgeLeft': C('Nudge Clip Selection Left 1 Frame', 'Edit', 'Alt+ArrowLeft', () => A.nudgeSelection(-1)),
    'edit.nudgeRight': C('Nudge Clip Selection Right 1 Frame', 'Edit', 'Alt+ArrowRight', () => A.nudgeSelection(1)),
    'edit.nudgeLeft5': C('Nudge Clip Selection Left 5 Frames', 'Edit', 'Alt+Shift+ArrowLeft', () => A.nudgeSelection(-5)),
    'edit.nudgeRight5': C('Nudge Clip Selection Right 5 Frames', 'Edit', 'Alt+Shift+ArrowRight', () => A.nudgeSelection(5)),
    'edit.nudgeUp': C('Nudge Clip Selection Up', 'Edit', 'Alt+ArrowUp', () => A.nudgeTrack(1)),
    'edit.nudgeDown': C('Nudge Clip Selection Down', 'Edit', 'Alt+ArrowDown', () => A.nudgeTrack(-1)),
    'edit.removeGap': C('Ripple Delete Gap at Playhead', 'Edit', null, () => A.removeGapAtPlayhead()),
    'edit.closeGaps': C('Close All Gaps on Targeted Tracks', 'Edit', null, () => A.closeAllGaps()),
    'edit.fillGaps': C('Fill Gaps by Extending Clips', 'Edit', null, () => A.fillGaps()),
    // Clip
    'clip.speed': C('Speed/Duration...', 'Clip', 'Mod+R', () => A.speedDialog()),
    'clip.enable': C('Enable', 'Clip', 'Shift+E', () => A.toggleEnable()),
    'clip.link': C('Link / Unlink', 'Clip', 'Mod+L', () => A.toggleLink()),
    'clip.group': C('Group', 'Clip', 'Mod+G', () => A.toggleGroup(false)),
    'clip.ungroup': C('Ungroup', 'Clip', 'Mod+Shift+G', () => A.toggleGroup(true)),
    'clip.nest': C('Nest...', 'Clip', null, () => A.nest()),
    'clip.frameHold': C('Add Frame Hold', 'Clip', null, () => A.addFrameHold('segment')),
    'clip.frameHoldSegment': C('Insert Frame Hold Segment', 'Clip', null, () => A.addFrameHold('insert')),
    'clip.reverse': C('Reverse Speed', 'Clip', null, () => A.reverseClips()),
    'clip.timeRemap': C('Time Remapping', 'Clip', null, () => A.toggleTimeRemap()),
    'clip.scaleToFrame': C('Scale to Frame Size', 'Clip', null, () => A.scaleToFrame('set')),
    'clip.reveal': C('Reveal in Project', 'Clip', null, () => A.revealInProject()),
    'clip.openNested': C('Open Nested Sequence', 'Clip', null, () => A.openNested()),
    'clip.removeEffects': C('Remove Attributes', 'Clip', null, () => A.removeEffects()),
    'clip.multicamFlatten': C('Flatten Multi-Camera', 'Clip', null, () => A.flattenMulticam()),
    'clip.multicamEnable': C('Enable Multi-Camera', 'Clip', null, () => A.enableMulticam()),
    'clip.sync': C('Synchronize...', 'Clip', null, () => A.syncSelectedClips()),
    'clip.stabilize': C('Warp Stabilize Selected Clips', 'Clip', null, async () => { for (const s of A.selectedClips().filter((x) => x.clip.kind === 'video')) { if (!s.clip.effects.some((e) => e.type === 'warp_stabilizer')) A.applyEffect('warp_stabilizer', [s.clip.id]); const an = await import('./actions/analysis.js'); an.stabilizeClip(s.clip.id); } }),
    'clip.sceneDetect': C('Scene Edit Detection...', 'Clip', null, async () => { const sel = A.selectedClips().find((x) => x.clip.kind === 'video'); if (!sel) return toast('Select a video clip', 'warn'); (await import('./actions/analysis.js')).sceneEditDetection(sel.clip.id); }),
    'clip.adjustment': C('New Adjustment Layer at Playhead', 'Clip', null, () => A.addAdjustmentLayer()),
    // Sequence
    'sequence.settings': C('Sequence Settings...', 'Sequence', null, () => A.sequenceSettingsDialog()),
    'sequence.renderInOut': C('Render In to Out', 'Sequence', 'Enter', () => X.renderPreviews(seq())),
    'sequence.renderAll': C('Render Entire Sequence', 'Sequence', null, () => X.renderPreviews(seq(), true)),
    'sequence.deletePreviews': C('Delete Render Files', 'Sequence', null, () => X.deletePreviews(seq())),
    'sequence.addTracks': C('Add Tracks...', 'Sequence', null, () => A.addTracksDialog()),
    'sequence.deleteEmptyTracks': C('Delete Empty Tracks', 'Sequence', null, () => A.deleteEmptyTracks()),
    'sequence.autoReframe': C('Auto Reframe Sequence...', 'Sequence', null, () => A.autoReframeSequence()),
    'sequence.makeSubsequence': C('Make Subsequence', 'Sequence', null, () => A.makeSubsequence()),
    'sequence.duplicate': C('Duplicate Sequence', 'Sequence', null, () => A.duplicateSequence()),
    'sequence.duck': C('Auto Duck Music', 'Sequence', null, () => import('./actions/analysis.js').then((m) => m.autoDuck())),
    // Markers & marks
    'marker.add': C('Add Marker', 'Markers', 'M', () => A.addMarker()),
    'marker.next': C('Go to Next Marker', 'Markers', 'Shift+M', () => A.gotoMarker(1)),
    'marker.prev': C('Go to Previous Marker', 'Markers', 'Mod+Shift+M', () => A.gotoMarker(-1)),
    'marker.clear': C('Clear Selected Marker', 'Markers', 'Mod+Alt+M', () => A.clearMarkers(false)),
    'marker.clearAll': C('Clear All Markers', 'Markers', 'Mod+Alt+Shift+M', () => A.clearMarkers(true)),
    'marker.chapter': C('Add Chapter Marker', 'Markers', null, () => A.addMarker({ type: 'chapter', color: 'cerulean', edit: false })),
    'mark.in': C('Mark In', 'Markers', 'I', () => A.markIn()),
    'mark.out': C('Mark Out', 'Markers', 'O', () => A.markOut()),
    'mark.clip': C('Mark Clip', 'Markers', 'X', () => A.markClip()),
    'mark.clear': C('Clear In and Out', 'Markers', ['Mod+Shift+X', 'Alt+X'], () => A.clearInOut('both')),
    'mark.clearIn': C('Clear In', 'Markers', 'Alt+I', () => A.clearInOut('in')),
    'mark.clearOut': C('Clear Out', 'Markers', 'Alt+O', () => A.clearInOut('out')),
    'mark.gotoIn': C('Go to In', 'Markers', 'Shift+I', () => A.gotoInOut('in')),
    'mark.gotoOut': C('Go to Out', 'Markers', 'Shift+O', () => A.gotoInOut('out')),
    // Playback & navigation
    'play.toggle': C('Play/Stop', 'Playback', 'Space', transport(() => app.player.toggle(), () => app.player.toggleSource())),
    'play.forward': C('Shuttle Right', 'Playback', 'L', transport(() => (app.__kHeld ? app.player.step(1) : app.player.shuttle(1)), () => (app.__kHeld ? app.source.step(1) : app.player.shuttleSource(1)))),
    'play.reverse': C('Shuttle Left', 'Playback', 'J', transport(() => (app.__kHeld ? app.player.step(-1) : app.player.shuttle(-1)), () => (app.__kHeld ? app.source.step(-1) : app.player.shuttleSource(-1)))),
    'play.stop': C('Shuttle Stop', 'Playback', 'K', transport(() => app.player.pause(), () => app.player.stopSource())),
    'play.inOut': C('Play In to Out', 'Playback', 'Mod+Shift+Space', () => app.player.play(1, { inOut: true })),
    'play.around': C('Play Around', 'Playback', 'Shift+K', () => { const s = seq(); if (!s) return; const f = s.playhead; const pre = Math.round(prefs.get('playback.preroll') * s.settings.fps), post = Math.round(prefs.get('playback.postroll') * s.settings.fps); app.player.seek(Math.max(0, f - pre)); app.player.play(1, { until: f + post }); }),
    'play.loop': C('Loop Playback', 'Playback', null, () => { prefs.set('playback.loop', !prefs.get('playback.loop')); toast(prefs.get('playback.loop') ? 'Loop on' : 'Loop off'); }),
    'nav.stepBack': C('Step Back 1 Frame', 'Navigation', 'ArrowLeft', transport(() => app.player.step(-1), () => app.source.step(-1))),
    'nav.stepFwd': C('Step Forward 1 Frame', 'Navigation', 'ArrowRight', transport(() => app.player.step(1), () => app.source.step(1))),
    'nav.stepBack5': C('Step Back Many Frames', 'Navigation', 'Shift+ArrowLeft', transport(() => app.player.step(-prefs.get('playback.stepFrames')), () => app.source.step(-prefs.get('playback.stepFrames')))),
    'nav.stepFwd5': C('Step Forward Many Frames', 'Navigation', 'Shift+ArrowRight', transport(() => app.player.step(prefs.get('playback.stepFrames')), () => app.source.step(prefs.get('playback.stepFrames')))),
    'nav.prevEdit': C('Go to Previous Edit Point', 'Navigation', 'ArrowUp', () => A.gotoEdit(-1)),
    'nav.nextEdit': C('Go to Next Edit Point', 'Navigation', 'ArrowDown', () => A.gotoEdit(1)),
    'nav.start': C('Go to Sequence Start', 'Navigation', 'Home', transport(() => app.player.seek(0), () => app.player.seekSource(0))),
    'nav.end': C('Go to Sequence End', 'Navigation', 'End', transport(() => { const s = seq(); if (s) app.player.seek(Math.max(0, seqDuration(s) - 1)); }, () => app.player.seekSource(app.player.sourceDuration()))),
    'nav.matchFrame': C('Match Frame', 'Navigation', 'F', () => A.matchFrame()),
    'nav.reverseMatch': C('Reverse Match Frame', 'Navigation', 'Shift+R', () => A.reverseMatchFrame()),
    'nav.selectAtPlayhead': C('Select Clip at Playhead', 'Navigation', 'D', () => A.selectAtPlayhead()),
    // Timeline view
    'timeline.zoomIn': C('Zoom In', 'Timeline', '=', () => app.timeline && app.timeline.zoomBy(1.5)),
    'timeline.zoomOut': C('Zoom Out', 'Timeline', '-', () => app.timeline && app.timeline.zoomBy(1 / 1.5)),
    'timeline.zoomFit': C('Zoom to Sequence', 'Timeline', '\\', () => app.timeline && app.timeline.zoomFit()),
    'timeline.snap': C('Snap in Timeline', 'Timeline', 'S', () => { prefs.set('timeline.snapping', !prefs.get('timeline.snapping')); app.timeline && app.timeline.updateToggles(); }),
    'timeline.linkedSelection': C('Linked Selection', 'Timeline', null, () => { prefs.set('timeline.linkedSelection', !prefs.get('timeline.linkedSelection')); app.timeline && app.timeline.updateToggles(); }),
    'timeline.toggleTrackOutput': C('Toggle All Video Track Outputs', 'Timeline', null, () => store.transact('Toggle Outputs', () => { const s = seq(); const v = !s.tracks.video[0].hidden; for (const t of s.tracks.video) t.hidden = v; })),
    // View
    'view.multicam': C('Multi-Camera View', 'View', 'Shift+0', () => app.program && app.program.toggleMulticam()),
    'view.safeMargins': C('Safe Margins', 'View', null, () => { if (app.program) { app.program.safe = !app.program.safe; app.program.drawOverlay(); } }),
    'view.compare': C('Comparison View', 'View', null, () => app.program && app.program.toggleCompare()),
    'view.fullscreen': C('Toggle Full Screen', 'View', 'Ctrl+`', () => window.native.call('app:fullscreen')),
    'view.maximize': C('Maximize or Restore Frame', 'View', '`', () => app.dock.toggleMaximize()),
    'view.palette': C('Search Commands...', 'View', 'Mod+Shift+P', () => commandPalette(paletteExtras()), { palette: false }),
    'view.playbackRes': C('Cycle Playback Resolution', 'View', null, () => { const order = ['full', '1/2', '1/4', '1/8']; const i = order.indexOf(prefs.get('playback.resolution')); prefs.set('playback.resolution', order[(i + 1) % order.length]); toast('Playback resolution ' + prefs.get('playback.resolution')); app.player.invalidate(); }),
    // Tools
    ...Object.fromEntries([['select', 'Selection Tool', 'V'], ['trackFwd', 'Track Select Forward Tool', 'A'], ['trackBack', 'Track Select Backward Tool', 'Shift+A'], ['ripple', 'Ripple Edit Tool', 'B'], ['roll', 'Rolling Edit Tool', 'N'], ['rate', 'Rate Stretch Tool', 'R'], ['razor', 'Razor Tool', 'C'], ['slip', 'Slip Tool', 'Y'], ['slide', 'Slide Tool', 'U'], ['pen', 'Pen Tool', 'P'], ['hand', 'Hand Tool', 'H'], ['zoom', 'Zoom Tool', 'Z'], ['type', 'Type Tool', 'T']]
      .map(([id, label, key]) => ['tool.' + id, C(label, 'Tools', key, () => app.timeline && app.timeline.setTool(id))])),
    // Multicam angles (when program monitor focused)
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ['multicam.' + n, C(`Cut to Camera ${n}`, 'Multi-Camera', String(n), () => A.multicamSwitch(n - 1, app.player.state.program.playing), { context: P })])),
    // Graphics, captions & audio
    'graphics.newText': C('New Text Layer', 'Graphics', 'Mod+T', () => A.newGraphicAtPlayhead()),
    'captions.add': C('Add Caption', 'Captions', null, () => import('./actions/captions.js').then((m) => m.addCaption())),
    'audio.gain': C('Audio Gain...', 'Audio', 'G', () => A.audioGainDialog()),
    'audio.channels': C('Audio Channels...', 'Audio', null, () => A.audioChannelsDialog()),
    'audio.record': C('Record Voice-over', 'Audio', 'Mod+Alt+R', () => toggleVoiceOver()),
    'audio.masterMute': C('Mute All Audio', 'Audio', null, () => { app.audio.masterMute = !app.audio.masterMute; app.audio.liveUpdate(seq()); toast(app.audio.masterMute ? 'Audio muted' : 'Audio unmuted'); }),
    'proxy.toggle': C('Toggle Proxies', 'Media', null, () => { M.toggleProxies(); updateHeader(); }),
    'proxy.create': C('Create Proxies...', 'Media', null, () => { const sel = [...store.selection.items].map((id) => store.project.items[id]).filter(Boolean); M.createProxies(sel.length ? sel : Object.values(store.project.items).filter((i) => i.type === 'media'), { ask: true }); }),
    'media.interpret': C('Interpret Footage...', 'Media', null, () => M.interpretFootage([...store.selection.items].map((id) => store.project.items[id]).filter(Boolean))),
    'media.removeUnused': C('Remove Unused', 'Media', null, () => M.removeUnused()),
    // Window
    ...Object.fromEntries(Object.entries(PANELS).map(([id, p], i) => ['window.' + id, C(p.title, 'Window', { project: 'Shift+1', source: 'Shift+2', timeline: 'Shift+3', program: 'Shift+4', effectControls: 'Shift+5', audioClipMixer: 'Shift+6', effects: 'Shift+7', mediaBrowser: 'Shift+8', audioTrackMixer: 'Shift+9' }[id] || null, panel(id))])),
    ...Object.fromEntries(Object.keys(WORKSPACES).map((n, i) => ['workspace.' + n, C(n + ' Workspace', 'Workspaces', i < 9 ? `Alt+Shift+${i + 1}` : null, () => switchWorkspace(n))])),
    'workspace.reset': C('Reset to Saved Layout', 'Workspaces', null, () => switchWorkspace(prefs.get('workspaces.current'), true)),
    // App
    'app.preferences': C('Settings...', 'Application', 'Mod+,', () => preferencesDialog()),
    'app.shortcuts': C('Keyboard Shortcuts...', 'Application', 'Mod+Alt+K', () => shortcutsDialog()),
    'app.about': C('About CinergyPro', 'Application', null, () => aboutDialog()),
    'app.quit': C('Quit', 'Application', IS_MAC ? 'Mod+Q' : 'Ctrl+Q', () => quit()),
    'app.scriptConsole': C('Script Console', 'Application', null, panel('scriptConsole')),
    'app.devtools': C('Reveal Logs Folder', 'Application', null, () => window.native.call('shell:open', app.info.userData)),
  };
  commands.registerMany(def);
  import('./core/edit.js').then((E) => { app.__edit = E; });
}

function buildMenu() {
  const it = (id, extra = {}) => { const c = commands.map.get(id); return c ? { id, label: c.label, accelerator: accelerator(commands.keysFor(id)[0]), ...extra } : null; };
  const sep = { type: 'separator' };
  const tpl = [
    { label: 'File', submenu: [it('file.new'), it('file.newSequence'), it('file.open'), it('file.home'), sep, it('file.newProduction'), it('file.openProduction'), sep, it('file.close'), it('file.save'), it('file.saveAs'), it('file.saveCopy'), it('file.saveTemplate'), it('file.revert'), sep, it('file.import'), it('file.importFolder'), it('file.importTimeline'), it('file.importCaptions'), sep,
      { label: 'Export', submenu: [it('file.export'), it('file.exportFrame'), it('file.exportQueue'), it('file.exportStems'), it('file.exportCaptions'), sep, it('file.exportOTIO'), it('file.exportEDL'), it('file.exportXML'), it('file.exportFCPXML')] },
      sep, it('file.relink'), it('file.projectSettings'), it('file.projectManager'), ...(IS_MAC ? [] : [sep, it('app.preferences'), it('app.quit')])] },
    { label: 'Edit', submenu: [it('edit.undo'), it('edit.redo'), sep, it('edit.cut'), it('edit.copy'), it('edit.paste'), it('edit.pasteInsert'), it('edit.pasteAttributes'), sep, it('edit.clear'), it('edit.rippleDelete'), it('edit.duplicate'), sep, it('edit.selectAll'), it('edit.deselectAll'), it('edit.find'), sep, it('app.shortcuts')] },
    { label: 'Clip', submenu: [it('clip.speed'), it('clip.timeRemap'), it('clip.reverse'), it('clip.frameHold'), it('clip.frameHoldSegment'), sep, it('clip.enable'), it('clip.link'), it('clip.group'), it('clip.ungroup'), it('clip.sync'), it('clip.nest'), sep, it('clip.scaleToFrame'), it('clip.stabilize'), it('clip.sceneDetect'), it('clip.adjustment'), sep, it('clip.multicamEnable'), it('clip.multicamFlatten'), sep, it('audio.gain'), it('audio.channels'), it('clip.removeEffects'), it('clip.reveal'), it('clip.openNested')] },
    { label: 'Sequence', submenu: [it('sequence.settings'), sep, it('sequence.renderInOut'), it('sequence.renderAll'), it('sequence.deletePreviews'), sep, it('edit.insert'), it('edit.overwrite'), it('edit.replace'), it('edit.fitToFill'), it('edit.lift'), it('edit.extract'), sep, it('edit.addEdit'), it('edit.addEditAll'), it('edit.rippleTrimPrev'), it('edit.rippleTrimNext'), it('edit.extendEdit'), sep, it('edit.applyVideoTransition'), it('edit.applyAudioTransition'), it('edit.applyTransitions'), sep, it('edit.removeGap'), it('edit.closeGaps'), it('edit.fillGaps'), sep, it('timeline.snap'), it('timeline.linkedSelection'), it('nav.matchFrame'), it('nav.reverseMatch'), sep, it('sequence.makeSubsequence'), it('sequence.autoReframe'), it('sequence.duck'), it('sequence.addTracks'), it('sequence.deleteEmptyTracks'), it('sequence.duplicate')] },
    { label: 'Markers', submenu: [it('mark.in'), it('mark.out'), it('mark.clip'), it('mark.gotoIn'), it('mark.gotoOut'), it('mark.clearIn'), it('mark.clearOut'), it('mark.clear'), sep, it('marker.add'), it('marker.chapter'), it('marker.next'), it('marker.prev'), it('marker.clear'), it('marker.clearAll')] },
    { label: 'Graphics and Titles', submenu: [it('graphics.newText'), it('captions.add'), { label: 'Templates', id: 'window.properties' }] },
    { label: 'View', submenu: [it('play.toggle'), it('play.inOut'), it('play.around'), it('play.loop'), sep, it('view.multicam'), it('view.compare'), it('view.safeMargins'), it('view.playbackRes'), sep, it('proxy.toggle'), it('proxy.create'), sep, it('timeline.zoomIn'), it('timeline.zoomOut'), it('timeline.zoomFit'), sep, it('view.maximize'), it('view.fullscreen'), it('view.palette')] },
    { label: 'Window', submenu: [
      { label: 'Workspaces', submenu: [...Object.keys(WORKSPACES).map((n) => it('workspace.' + n, { checked: prefs.get('workspaces.current') === n })), sep, it('workspace.reset')] }, sep,
      ...Object.keys(PANELS).map((id) => it('window.' + id, { checked: app.dock ? app.dock.isOpen(id) : false })), sep, it('app.scriptConsole')] },
    { label: 'Help', submenu: [it('window.learn'), it('app.shortcuts'), it('app.about'), it('app.devtools')] },
  ];
  const clean = (arr) => arr.filter(Boolean).map((x) => (x.submenu ? { ...x, submenu: clean(x.submenu) } : x));
  window.native.call('app:set-menu', clean(tpl)).catch((e) => console.warn(e));
}

boot().catch((e) => {
  console.error('Boot failed', e);
  document.body.innerHTML = `<div style="padding:40px;color:#e6ebf2;font:14px Plex,sans-serif"><h2>CinergyPro could not start</h2><pre style="white-space:pre-wrap;color:#f0505a">${String(e && e.stack || e)}</pre></div>`;
});
