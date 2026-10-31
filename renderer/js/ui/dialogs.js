// Preferences, keyboard shortcuts editor, About and the Home screen.
const IS_MAC_UI = (window.native && window.native.platform === 'darwin');
import { app } from '../app-context.js';
import { h, icon, deepClone, basename, formatBytes } from '../core/util.js';
import { modal, form, toast, confirmDialog } from './widgets.js';
import { commands, displayCombo, normalizeCombo, comboFromEvent } from '../core/commands.js';
import { DEFAULT_PREFS } from '../core/prefs.js';

// ---------- Preferences ----------
export async function preferencesDialog(section = 'general') {
  const P = deepClone(app.prefs.data);
  const sections = {
    general: ['General', [
      { key: 'general.startup', label: 'At startup', type: 'select', string: true, options: [['home', 'Show Home'], ['last', 'Open most recent project']] },
      { key: 'general.timeDisplay', label: 'Time display', type: 'select', string: true, options: [['tc', 'Timecode'], ['frames', 'Frames'], ['seconds', 'Seconds'], ['feet', 'Feet + Frames']] },
      { key: 'general.showTooltips', label: 'Tool tips', type: 'check', text: 'Show tool tips' },
      { key: 'general.confirmDeletes', label: 'Confirmations', type: 'check', text: 'Ask before deleting items used in sequences' },
    ]],
    appearance: ['Appearance', [
      { key: 'appearance.brightness', label: 'Brightness', type: 'select', options: [[0, 'Darkest'], [1, 'Dark'], [2, 'Medium dark']] },
      { key: 'appearance.highContrast', label: 'Contrast', type: 'check', text: 'Increase contrast' },
      { key: 'appearance.interfaceScale', label: 'Interface scale', type: 'select', options: [[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%']] },
      { key: 'appearance.reduceMotion', label: 'Motion', type: 'check', text: 'Reduce interface animation' },
    ]],
    autosave: ['Auto Save', [
      { key: 'autosave.enabled', label: 'Auto save', type: 'check', text: 'Automatically save projects' },
      { key: 'autosave.interval', label: 'Every (minutes)', type: 'number', min: 1, max: 120 },
      { key: 'autosave.maxVersions', label: 'Maximum versions', type: 'number', min: 1, max: 200 },
    ]],
    timeline: ['Timeline', [
      { key: 'timeline.videoTransitionDur', label: 'Video transition (frames)', type: 'number', min: 1, max: 600 },
      { key: 'timeline.audioTransitionDur', label: 'Audio transition (frames)', type: 'number', min: 1, max: 600 },
      { key: 'timeline.stillDuration', label: 'Still image duration (s)', type: 'number', min: 0.1, max: 600, step: 0.1 },
      { key: 'timeline.autoscroll', label: 'Playback auto-scroll', type: 'select', string: true, options: [['page', 'Page scroll'], ['smooth', 'Smooth scroll'], ['none', 'No scroll']] },
      { key: 'timeline.defaultScaleToFrame', label: 'Default media scaling', type: 'select', string: true, options: [['none', 'None'], ['set', 'Set to frame size']] },
      { key: 'timeline.autoCreateTracks', label: 'Tracks', type: 'check', text: 'Create tracks when dragging above the top track' },
      { key: 'timeline.playheadSnapOnEdit', label: 'Edits', type: 'check', text: 'Move playhead to the end of each edit' },
      { key: 'timeline.selectionFollowsPlayhead', label: 'Selection', type: 'check', text: 'Selection follows playhead' },
      { key: 'timeline.keyframeInterp', label: 'Default keyframe interpolation', type: 'select', string: true, options: [['linear', 'Linear'], ['bezier', 'Bezier'], ['hold', 'Hold'], ['easeInOut', 'Ease In and Out']] },
    ]],
    playback: ['Playback', [
      { key: 'playback.preroll', label: 'Preroll (s)', type: 'number', min: 0, max: 10 },
      { key: 'playback.postroll', label: 'Postroll (s)', type: 'number', min: 0, max: 10 },
      { key: 'playback.stepFrames', label: 'Shift+arrow step (frames)', type: 'number', min: 1, max: 100 },
      { key: 'playback.resolution', label: 'Playback resolution', type: 'select', string: true, options: [['full', 'Full'], ['1/2', '1/2'], ['1/4', '1/4'], ['1/8', '1/8']] },
      { key: 'playback.pausedResolution', label: 'Paused resolution', type: 'select', string: true, options: [['full', 'Full'], ['1/2', '1/2'], ['1/4', '1/4']] },
      { key: 'playback.audioScrub', label: 'Audio scrubbing', type: 'check', text: 'Play audio while scrubbing' },
      { key: 'playback.highQuality', label: 'Quality', type: 'check', text: 'High quality playback (render at full size)' },
    ]],
    audio: ['Audio', [
      { key: 'audio.outputDevice', label: 'Output device', type: 'select', string: true, options: () => app.__audioOutputs || [['default', 'System default']] },
      { key: 'audio.inputDevice', label: 'Input device (voice-over)', type: 'select', string: true, options: () => app.__audioInputs || [['default', 'System default']] },
      { key: 'audio.loudnessTarget', label: 'Loudness target (LUFS)', type: 'number', min: -40, max: -5, step: 0.5 },
    ]],
    media: ['Media', [
      { key: 'media.importSubfolders', label: 'Folders', type: 'check', text: 'Import subfolders' },
      { key: 'media.createBinsFromFolders', label: '', type: 'check', text: 'Create bins from folders' },
      { key: 'media.imageSequenceFps', label: 'Image sequence frame rate', type: 'number', min: 1, max: 120 },
      { key: 'media.autoProxy', label: 'Automatic proxies', type: 'select', string: true, options: [['unsupported', 'Only for media that cannot play directly'], ['large', 'For media larger than 3K'], ['always', 'For all video']] },
      { key: 'media.generateWaveforms', label: 'Waveforms', type: 'check', text: 'Generate audio waveforms on import' },
      { key: 'media.relinkSearchDepth', label: 'Relink search depth', type: 'number', min: 1, max: 12 },
    ]],
    cache: ['Media Cache', [
      { type: 'note', label: 'Cache files hold decoded audio, waveforms, thumbnails, proxies and render previews.' },
      { key: 'cache.maxGB', label: 'Size limit (GB)', type: 'number', min: 1, max: 2000 },
      { key: 'cache.autoDeleteDays', label: 'Delete files older than (days)', type: 'number', min: 1, max: 3650 },
    ]],
    color: ['Color', [
      { key: 'color.displayColorManagement', label: 'Display', type: 'check', text: 'Display color management' },
      { key: 'color.hdrGraphicsWhite', label: 'HDR graphics white (nits)', type: 'select', options: [[100, '100'], [203, '203 (ITU BT.2408)'], [300, '300']] },
      { key: 'color.scopesQuality', label: 'Scopes quality', type: 'select', string: true, options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
    ]],
    graphics: ['Graphics', [
      { key: 'graphics.defaultFont', label: 'Default font', type: 'select', string: true, options: [['Inter', 'Inter'], ['Plex', 'IBM Plex Sans'], ['Helvetica Neue', 'Helvetica Neue'], ['Avenir Next', 'Avenir Next'], ['Georgia', 'Georgia']] },
      { key: 'graphics.defaultSize', label: 'Default size', type: 'number', min: 8, max: 400 },
    ]],
    export: ['Export', [
      { key: 'export.hardwareEncoding', label: 'Encoding', type: 'check', text: 'Use hardware encoding when available' },
      { key: 'export.openAfterExport', label: 'After export', type: 'check', text: (IS_MAC_UI ? 'Reveal file in Finder' : 'Show file in Explorer') },
    ]],
    scripting: ['Plugins & Scripts', [
      { key: 'scripting.enablePlugins', label: 'Plugins', type: 'check', text: 'Load plugins at startup' },
      { key: 'scripting.enableScripts', label: 'Scripts', type: 'check', text: 'Allow scripts' },
      { type: 'note', label: 'Plugins live in your CinergyPro Plugins folder. Each plugin is a folder with a manifest.json describing GLSL effects, transitions and scripts.' },
    ]],
  };
  try { const d = await app.audio.listDevices(); app.__audioOutputs = [['default', 'System default'], ...d.outputs.filter((o) => o.deviceId !== 'default').map((o) => [o.deviceId, o.label || 'Output'])]; app.__audioInputs = [['default', 'System default'], ...d.inputs.filter((o) => o.deviceId !== 'default').map((o) => [o.deviceId, o.label || 'Input'])]; } catch {}
  const flat = {};
  const get = (k) => k.split('.').reduce((o, x) => (o == null ? o : o[x]), P);
  for (const [, [, spec]] of Object.entries(sections)) for (const s of spec) if (s.key) flat[s.key] = get(s.key);
  const nav = h('div', { style: { width: '170px', borderRight: '1px solid var(--line-soft)', paddingRight: '8px' } });
  const pane = h('div', { style: { flex: 1, minHeight: '420px', paddingLeft: '16px', overflow: 'auto', maxHeight: '64vh' } });
  let current = section;
  const forms = {};
  const show = (k) => {
    current = k; nav.innerHTML = '';
    for (const [key, [label]] of Object.entries(sections)) nav.appendChild(h('div.list-row' + (key === k ? '.sel' : ''), { style: { borderBottom: 0, borderRadius: '4px', cursor: 'pointer' }, on: { click: () => show(key) } }, label));
    pane.innerHTML = '';
    forms[k] = forms[k] || form(sections[k][1], flat);
    pane.appendChild(forms[k].el);
    if (k === 'cache') pane.appendChild(h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, h('button.btn', { on: { click: async () => { const r = await window.native.call('fs:dir-size', app.info.cacheDir); toast(`Media cache: ${formatBytes(r.bytes)} in ${r.files} files`); } } }, 'Show Size'), h('button.btn.danger', { on: { click: async () => { if (await confirmDialog('Delete all media cache files?', 'Waveforms, thumbnails and proxies in the cache are rebuilt when needed.', 'Delete', true)) { await window.native.call('media:clear-cache'); toast('Media cache cleared'); } } } }, 'Delete Cache Files'), h('button.btn', { on: { click: () => window.native.call('shell:reveal', app.info.cacheDir) } }, 'Reveal Folder')));
    if (k === 'scripting') pane.appendChild(h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, h('button.btn', { on: { click: () => window.native.call('shell:open', app.info.pluginsDir) } }, 'Open Plugins Folder'), h('button.btn', { on: { click: () => import('../actions/scripting.js').then((m) => m.installSamplePlugin()) } }, 'Install Sample Plugin')));
  };
  show(section);
  const r = await modal({ title: 'Settings', width: 820, body: h('div', { style: { display: 'flex', width: '780px' } }, nav, pane), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: true }], left: [{ label: 'Reset Section', action: () => { app.prefs.reset(current); toast('Section reset'); } }] });
  if (!r) return;
  for (const f of Object.values(forms)) Object.assign(flat, f.values);
  for (const [k, v] of Object.entries(flat)) app.prefs.set(k, v);
  app.ui.applyAppearance();
  if (flat['audio.outputDevice']) app.audio.setOutputDevice(flat['audio.outputDevice']);
  (await import('../actions/project-io.js')).startAutosave();
  app.player.invalidate();
}

// ---------- Keyboard shortcuts ----------
const KB_ROWS = [
  ['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'],
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Backspace'],
  ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'ArrowUp'],
  ['Space', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Home', 'End', 'Delete'],
];

export async function shortcutsDialog() {
  let custom = deepClone(app.prefs.get('shortcuts.custom') || {});
  const keysFor = (id) => (custom[id] !== undefined ? custom[id] : (commands.map.get(id) || {}).keys || []);
  let mods = { Mod: false, Shift: false, Alt: false, Ctrl: false };
  let selKey = null, query = '', recording = null;
  const kb = h('div.kb'); const tableWrap = h('div', { style: { maxHeight: '38vh', overflow: 'auto', border: '1px solid var(--line-soft)', borderRadius: '6px' } });
  const modBar = h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center' } });
  const search = h('input.field', { placeholder: 'Search commands', style: { flex: 1 }, on: { input: (e) => { query = e.target.value.toLowerCase(); renderTable(); }, keydown: (e) => e.stopPropagation() } });
  const presetSel = h('select.field', { on: { change: (e) => { if (e.target.value === 'premiere') custom = presetPremiereLike(); else if (e.target.value === 'fcp') custom = presetFcpLike(); else if (e.target.value === 'avid') custom = presetAvidLike(); else custom = {}; renderAll(); } } }, [['cinergy', 'CinergyPro Default'], ['premiere', 'Premiere-style'], ['fcp', 'Final Cut-style'], ['avid', 'Avid-style']].map(([v, l]) => h('option', { value: v }, l)));
  const comboMods = () => ['Mod', 'Ctrl', 'Alt', 'Shift'].filter((m) => mods[m]);
  const bindingMap = () => { const m = new Map(); for (const c of commands.list()) for (const k of keysFor(c.id)) { const n = normalizeCombo(k); (m.get(n) || m.set(n, []).get(n)).push(c); } return m; };
  const renderKB = () => {
    kb.innerHTML = ''; const bm = bindingMap();
    for (const row of KB_ROWS) {
      const r = h('div.kb-row');
      for (const k of row) {
        const combo = [...comboMods(), k].join('+');
        const used = bm.get(normalizeCombo(combo));
        const key = h('div.kb-key' + (used ? '.used' : '') + (selKey === k ? '.sel' : ''), { style: { flex: k === 'Space' ? 6 : ['Backspace', 'Enter', 'Tab'].includes(k) ? 1.6 : 1 }, title: used ? used.map((c) => c.label).join(', ') : '' }, h('b', displayCombo(k)), used ? h('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } }, used[0].label) : '');
        key.addEventListener('click', () => { selKey = selKey === k ? null : k; renderKB(); renderTable(); });
        r.appendChild(key);
      }
      kb.appendChild(r);
    }
  };
  const renderMods = () => { modBar.innerHTML = ''; modBar.append(...(IS_MAC_UI ? ['Mod', 'Shift', 'Alt', 'Ctrl'] : ['Mod', 'Shift', 'Alt']).map((m) => h('button.btn.small' + (mods[m] ? '.primary' : ''), { on: { click: () => { mods[m] = !mods[m]; renderMods(); renderKB(); } } }, { Mod: displayCombo('Mod+X').slice(0, -1) || 'Cmd', Shift: 'Shift', Alt: IS_MAC_UI ? 'Option' : 'Alt', Ctrl: 'Control' }[m])), search, presetSel); };
  const renderTable = () => {
    tableWrap.innerHTML = '';
    const conflicts = new Map(); const bm = bindingMap();
    for (const [k, list] of bm) { const byCtx = {}; for (const c of list) (byCtx[c.context] = byCtx[c.context] || []).push(c); for (const arr of Object.values(byCtx)) if (arr.length > 1) for (const c of arr) conflicts.set(c.id, k); }
    const t = h('table.sc-table');
    const list = commands.list().filter((c) => c.label && (!query || (c.label + ' ' + c.category).toLowerCase().includes(query)) && (!selKey || keysFor(c.id).some((k) => normalizeCombo(k).split('+').pop() === normalizeCombo(selKey))));
    list.sort((a, b) => (a.category + a.label).localeCompare(b.category + b.label));
    for (const c of list) {
      const keys = keysFor(c.id);
      const kcell = h('td.k' + (recording === c.id ? '.rec' : ''), recording === c.id ? 'Press keys...' : keys.map(displayCombo).join(', ') || '-');
      kcell.addEventListener('click', () => { recording = c.id; renderTable(); });
      const row = h('tr' + (conflicts.has(c.id) ? '.conflict' : ''), h('td', c.label), h('td.c', c.category), kcell, h('td', { style: { width: '60px' } }, h('button.btn.small', { on: { click: () => { custom[c.id] = []; renderAll(); } } }, 'Clear')));
      t.appendChild(row);
    }
    tableWrap.appendChild(t);
  };
  const renderAll = () => { renderMods(); renderKB(); renderTable(); };
  const onKey = (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
    if (e.key === 'Escape') { recording = null; renderTable(); return; }
    const combo = comboFromEvent(e);
    custom[recording] = e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && keysFor(recording).length ? [] : [combo];
    recording = null; renderAll();
  };
  document.addEventListener('keydown', onKey, true);
  renderAll();
  const r = await modal({ title: 'Keyboard Shortcuts', width: 980, body: h('div', { style: { width: '940px' } }, modBar, kb, tableWrap, h('div', { style: { color: 'var(--dim)', fontSize: '11px', marginTop: '8px' } }, 'Click a shortcut cell and press a key combination to assign it. Red rows have conflicting shortcuts.')),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: true }],
    left: [{ label: 'Export...', action: async () => { const p = await window.native.call('dialog:save', { defaultPath: `${app.info.desktop}/CinergyPro Shortcuts.json` }); if (p) { await window.native.call('fs:write-text', p, JSON.stringify(custom, null, 2)); toast('Shortcuts exported'); } } }, { label: 'Import...', action: async () => { const p = await window.native.call('dialog:open', { filters: [{ name: 'JSON', extensions: ['json'] }] }); if (p) { custom = JSON.parse(await window.native.call('fs:read-text', p[0])); renderAll(); } } }] });
  document.removeEventListener('keydown', onKey, true);
  if (!r) return;
  app.prefs.set('shortcuts.custom', custom);
  commands.setCustom(custom);
  app.ui.buildMenu();
}

function presetPremiereLike() { return {}; }
function presetFcpLike() { return { 'edit.insert': ['W'], 'edit.overwrite': ['D'], 'edit.addEdit': ['Mod+B'], 'tool.razor': ['B'], 'tool.ripple': ['Shift+B'], 'tool.roll': ['R'], 'tool.rate': ['Shift+R'], 'tool.slip': ['Shift+S'], 'tool.slide': ['Shift+L'], 'mark.clip': ['X'], 'timeline.snap': ['N'], 'edit.applyVideoTransition': ['Mod+T'], 'tool.select': ['A'], 'tool.trackFwd': ['Shift+T'], 'nav.matchFrame': ['Shift+F'] }; }
function presetAvidLike() { return { 'edit.insert': ['V'], 'edit.overwrite': ['B'], 'edit.lift': ['Z'], 'edit.extract': ['X'], 'mark.in': ['E'], 'mark.out': ['R'], 'mark.clear': ['G'], 'edit.addEdit': ['H'], 'tool.ripple': ['U'], 'tool.select': ['F'], 'mark.clip': ['T'] }; }

// ---------- About ----------
export async function aboutDialog() {
  const i = app.info;
  await modal({ title: '', width: 460, body: h('div', { style: { textAlign: 'center', padding: '6px 10px 4px' } },
    icon('logo', 64),
    h('div', { style: { fontSize: '22px', color: 'var(--white)', fontWeight: 600, marginTop: '10px' } }, 'CinergyPro'),
    h('div', { style: { color: 'var(--muted)', marginTop: '2px' } }, 'Craft Every Frame.'),
    h('div', { style: { color: 'var(--dim)', fontSize: '11px', marginTop: '14px', lineHeight: 1.7, fontFamily: 'var(--mono)' } }, `Version ${i.version}  -  Electron ${i.electron}`, h('br'), `${i.platform} ${i.arch}  -  ${i.cpus} cores  -  ${formatBytes(i.totalmem)} RAM`, h('br'), `GPU float pipeline: ${app.gl.floatFbo ? 'yes' : 'no'}  -  ffmpeg: ${app.caps && app.caps.ok ? 'ready' : 'missing'}`)) });
}

// ---------- Home screen ----------
export function homeScreen() {
  const recent = app.prefs.get('general.recentProjects') || [];
  const el = h('div.home');
  const io = () => import('../actions/project-io.js');
  const left = h('div.home-left',
    h('div.home-mark', icon('logo', 44), h('div', h('div.t1', 'CinergyPro'), h('div.t2', 'Craft Every Frame.'))),
    h('div.home-actions',
      h('button.btn.primary', { on: { click: () => newProjectDialog() } }, icon('plus', 16), 'New Project'),
      h('button.btn', { on: { click: async () => (await io()).openProject() } }, icon('folder', 16), 'Open Project'),
      h('button.btn', { on: { click: async () => (await io()).openProduction() } }, icon('layers', 16), 'Open Production'),
      h('button.btn', { on: { click: async () => { const m = await io(); const list = await m.listTemplates(); if (!list.length) return toast('No project templates yet. Use File > Save as Template.'); const { contextMenu } = await import('./widgets.js'); contextMenu(320, 300, list.map((t) => ({ label: t.name.replace(/\.cinergy$/, ''), action: () => m.newFromTemplate(t.path) }))); } } }, icon('book', 16), 'New from Template')),
    h('div', { style: { flex: 1 } }),
    h('div', { style: { color: 'var(--dim)', fontSize: '11px', lineHeight: 1.6 } }, 'Drop media anywhere on this window to start a new project with it.'));
  const cards = h('div.recent', recent.length ? recent.map((r) => { const c = h('div.card', h('div.n', r.name || basename(r.path)), h('div.p', r.path), h('div.p', new Date(r.at).toLocaleString())); c.addEventListener('click', async () => (await io()).openProject(r.path)); return c; }) : h('div', { style: { color: 'var(--dim)' } }, 'Projects you open appear here.'));
  const right = h('div.home-right', h('h2', 'Recent projects'), cards);
  el.append(left, right);
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => window.native.pathForFile(f));
    if (paths.length === 1 && paths[0].endsWith('.cinergy')) return (await io()).openProject(paths[0]);
    await (await io()).newProject({ name: 'Untitled Project' });
    const { importPaths } = await import('../actions/media.js'); const items = await importPaths(paths);
    if (items.length) (await import('../actions/editing.js')).newSequenceFromItems(items);
  });
  return el;
}

export async function newProjectDialog() {
  const r = await modal({
    title: 'New Project',
    width: 560,
    body: (() => { const f = form([
      { key: 'name', label: 'Project name' },
      { key: 'folder', label: 'Location', type: 'folder' },
      { key: 'preset', label: 'First sequence', type: 'select', string: true, options: [['1920x1080x24', 'HD 1080p 24'], ['1920x1080x23.976', 'HD 1080p 23.976'], ['1920x1080x25', 'HD 1080p 25'], ['1920x1080x29.97', 'HD 1080p 29.97'], ['1920x1080x30', 'HD 1080p 30'], ['1920x1080x60', 'HD 1080p 60'], ['3840x2160x24', 'UHD 4K 24'], ['3840x2160x30', 'UHD 4K 30'], ['1080x1920x30', 'Vertical 1080x1920 30'], ['1080x1080x30', 'Square 1080 30']] },
    ], { name: 'Untitled Project', folder: app.info.documents + '/CinergyPro', preset: '1920x1080x24' }); newProjectDialog.f = f; return f.el; })(),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create', primary: true, value: () => newProjectDialog.f.values }],
  });
  if (!r) return;
  const [w, hh, fps] = r.preset.split('x').map(Number);
  const io = await import('../actions/project-io.js');
  await window.native.call('fs:mkdir', r.folder);
  await io.newProject({ name: r.name, width: w, height: hh, fps, path: `${r.folder}/${r.name}.cinergy` });
}

export { DEFAULT_PREFS };
