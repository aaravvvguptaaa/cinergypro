'use strict';
// CinergyPro main process: windows, protocols, menus, IPC.
const { app, BrowserWindow, protocol, ipcMain, dialog, Menu, shell, screen, nativeTheme, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const media = require('./media');
const exporter = require('./export');
const psd = require('./psd');

const APP_ROOT = path.join(__dirname, '..');
const RENDERER = path.join(APP_ROOT, 'renderer');
const TEST_MODE = process.argv.includes('--test') || process.env.CINERGY_TEST === '1';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('CinergyPro');

let mainWindow = null;
const popouts = new Map();
let menuCommandsTemplate = null;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.cube': 'text/plain', '.srt': 'text/plain', '.vtt': 'text/vtt', '.glsl': 'text/plain',
};

function mimeFor(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

// Serve a local file with HTTP Range support so <video> can seek.
function serveFile(filePath, request) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return new Response('Not found', { status: 404 }); }
  if (stat.isDirectory()) return new Response('Is a directory', { status: 400 });
  const size = stat.size;
  const range = request.headers.get('range');
  const headers = { 'Content-Type': mimeFor(filePath), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (!m || !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(nodeToWeb(stream), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
  }
  return new Response(nodeToWeb(fs.createReadStream(filePath)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function nodeToWeb(stream) {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      stream.on('end', () => controller.close());
      stream.on('error', (e) => controller.error(e));
    },
    cancel() { stream.destroy(); },
  });
}

function registerProtocols() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.normalize(path.join(RENDERER, rel));
    if (!full.startsWith(RENDERER)) return new Response('Forbidden', { status: 403 });
    return serveFile(full, request);
  });
  // media://local/<encoded absolute path>
  protocol.handle('media', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const abs = process.platform === 'win32' ? p : (p.startsWith('/') ? p : '/' + p);
    return serveFile(abs, request);
  });
}

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1720, width), height: Math.min(1040, height), minWidth: 1100, minHeight: 680,
    backgroundColor: '#0b0c0f', title: 'CinergyPro', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false, webgl: true, spellcheck: false,
    },
  });
  nativeTheme.themeSource = 'dark';
  mainWindow.loadURL('app://cinergy/index.html' + (TEST_MODE ? '?test=1' : ''));
  mainWindow.once('ready-to-show', () => { if (!TEST_MODE || process.env.CINERGY_SHOW) mainWindow.show(); });
  mainWindow.on('close', (e) => {
    if (mainWindow.__allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:request-close');
  });
  mainWindow.on('closed', () => { mainWindow = null; for (const w of popouts.values()) if (!w.isDestroyed()) w.close(); });
  mainWindow.webContents.on('render-process-gone', (_e, d) => console.error('Renderer gone', d));
  if (process.env.CINERGY_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (TEST_MODE || process.env.CINERGY_LOG) console.log(`[renderer:${level}] ${message} (${path.basename(sourceId || '')}:${line})`);
  });
}

// ---------- Menu ----------
function buildMenu(template) {
  menuCommandsTemplate = template;
  const send = (id) => mainWindow && mainWindow.webContents.send('menu:command', id);
  const toItem = (item) => {
    if (item.type === 'separator') return { type: 'separator' };
    if (item.role) return { role: item.role };
    const out = { label: item.label, enabled: item.enabled !== false };
    if (item.accelerator) { out.accelerator = item.accelerator; out.registerAccelerator = false; }
    if (item.checked !== undefined) { out.type = 'checkbox'; out.checked = item.checked; }
    if (item.submenu) out.submenu = item.submenu.map(toItem);
    else out.click = () => send(item.id);
    return out;
  };
  const menus = template.map(toItem);
  if (process.platform === 'darwin') {
    menus.unshift({ label: 'CinergyPro', submenu: [
      { label: 'About CinergyPro', click: () => send('app.about') },
      { type: 'separator' },
      { label: 'Settings...', accelerator: 'Cmd+,', registerAccelerator: false, click: () => send('app.preferences') },
      { label: 'Keyboard Shortcuts...', accelerator: 'Alt+Cmd+K', registerAccelerator: false, click: () => send('app.shortcuts') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { label: 'Quit CinergyPro', accelerator: 'Cmd+Q', click: () => send('app.quit') },
    ] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
}

// ---------- Paths ----------
function userDir(...p) { const d = path.join(app.getPath('userData'), ...p); fs.mkdirSync(d, { recursive: true }); return d; }

// ---------- IPC ----------
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
    try { return { ok: true, value: await fn(e, ...args) }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });

  h('app:info', () => ({
    platform: process.platform, arch: process.arch, version: app.getVersion(), electron: process.versions.electron,
    userData: app.getPath('userData'), home: os.homedir(), documents: app.getPath('documents'), movies: safePath('videos'),
    desktop: app.getPath('desktop'), cacheDir: userDir('MediaCache'), autosaveDir: userDir('AutoSave'), pluginsDir: userDir('Plugins'),
    presetsDir: userDir('Presets'), test: TEST_MODE, cpus: os.cpus().length, totalmem: os.totalmem(), hostname: os.hostname(),
    ffmpeg: media.ffmpegPath(), ffprobe: media.ffprobePath(), argv: process.argv, testMedia: process.env.CINERGY_TEST_MEDIA || null, testOut: process.env.CINERGY_TEST_OUT || null,
  }));
  h('app:set-menu', (_e, tpl) => { buildMenu(tpl); return true; });
  h('app:allow-close', () => { if (mainWindow) { mainWindow.__allowClose = true; mainWindow.close(); } return true; });
  h('app:quit', () => { if (mainWindow) mainWindow.__allowClose = true; app.quit(); return true; });
  h('app:set-title', (_e, t) => { if (mainWindow) mainWindow.setTitle(t); return true; });
  h('app:take-pending-open', () => { if (mainWindow) mainWindow.__rendererReady = true; const f = app.__pendingOpen || null; app.__pendingOpen = null; return f; });
  h('app:set-edited', (_e, v) => { if (mainWindow && process.platform === 'darwin') mainWindow.setDocumentEdited(!!v); return true; });
  h('app:fullscreen', (_e, v) => { if (mainWindow) mainWindow.setFullScreen(v === undefined ? !mainWindow.isFullScreen() : !!v); return mainWindow && mainWindow.isFullScreen(); });
  h('app:displays', () => screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })));
  h('app:capture', async (_e, file) => { const img = await mainWindow.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); return file; });
  h('app:prevent-sleep', (_e, on) => {
    if (on && app.__psb === undefined) app.__psb = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && app.__psb !== undefined) { powerSaveBlocker.stop(app.__psb); app.__psb = undefined; }
    return true;
  });

  // Dialogs
  h('dialog:open', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters,
      properties: [opts.directory ? 'openDirectory' : 'openFile', ...(opts.multi ? ['multiSelections'] : []), 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths;
  });
  h('dialog:save', async (_e, opts = {}) => {
    const r = await dialog.showSaveDialog(mainWindow, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
    return r.canceled ? null : r.filePath;
  });
  h('dialog:message', async (_e, opts) => {
    const r = await dialog.showMessageBox(mainWindow, { type: opts.type || 'question', buttons: opts.buttons || ['OK'], defaultId: opts.defaultId || 0, cancelId: opts.cancelId, message: opts.message, detail: opts.detail });
    return r.response;
  });

  // File system
  h('fs:read-text', (_e, p) => fs.readFileSync(p, 'utf8'));
  h('fs:write-text', (_e, p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.tmp'; fs.writeFileSync(tmp, s); fs.renameSync(tmp, p); return true; });
  h('fs:read-binary', (_e, p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
  h('fs:write-binary', (_e, p, buf) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(buf)); return true; });
  h('fs:exists', (_e, p) => fs.existsSync(p));
  h('fs:stat', (_e, p) => { const s = fs.statSync(p); return { size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs || s.ctimeMs, dir: s.isDirectory() }; });
  h('fs:mkdir', (_e, p) => { fs.mkdirSync(p, { recursive: true }); return true; });
  h('fs:remove', (_e, p) => { fs.rmSync(p, { recursive: true, force: true }); return true; });
  h('fs:copy', async (_e, a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); await fs.promises.copyFile(a, b); return b; });
  h('fs:list', (_e, dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).map((d) => {
    const full = path.join(dir, d.name); let size = 0, mtime = 0;
    try { const s = fs.statSync(full); size = s.size; mtime = s.mtimeMs; } catch {}
    return { name: d.name, path: full, dir: d.isDirectory(), size, mtime };
  }));
  h('fs:walk', (_e, dir, maxDepth = 8) => walk(dir, maxDepth));
  h('fs:dir-size', (_e, dir) => dirSize(dir));
  h('fs:volumes', () => listVolumes());
  h('fs:find-file', (_e, name, roots, maxDepth = 6) => findFile(name, roots, maxDepth));
  h('fs:disk-free', async (_e, p) => { try { const s = await fs.promises.statfs(p); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; } });
  h('shell:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });
  h('shell:open', (_e, p) => shell.openPath(p));
  h('shell:open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });

  // Project lock files (simple multi-user safety)
  h('project:lock', (_e, p) => {
    const lock = p + '.lock';
    if (fs.existsSync(lock)) {
      try { const info = JSON.parse(fs.readFileSync(lock, 'utf8')); const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }; if (info.host !== os.hostname() || (info.pid !== process.pid && alive(info.pid))) return { locked: true, by: info }; } catch {}
    }
    fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), user: os.userInfo().username, pid: process.pid, at: Date.now() }));
    return { locked: false };
  });
  h('project:unlock', (_e, p) => { try { fs.unlinkSync(p + '.lock'); } catch {} return true; });
  h('session:mark', (_e, state) => { fs.writeFileSync(path.join(userDir(), 'session.json'), JSON.stringify(state)); return true; });
  h('session:read', () => { try { return JSON.parse(fs.readFileSync(path.join(userDir(), 'session.json'), 'utf8')); } catch { return null; } });

  // Media services
  h('media:probe', (_e, p) => media.probe(p));
  h('media:capabilities', () => media.capabilities());
  h('media:decode-audio', (e, p, opts) => media.decodeAudio(p, opts, progressSender(e)));
  h('media:thumbs', (_e, p, opts) => media.thumbnailStrip(p, opts));
  h('media:poster', (_e, p, t, w) => media.poster(p, t, w));
  h('media:proxy', (e, p, opts) => media.createProxy(p, opts, progressSender(e)));
  h('media:transcode', (e, p, opts) => media.transcode(p, opts, progressSender(e)));
  h('media:stabilize', (e, p, opts) => media.stabilize(p, opts, progressSender(e)));
  h('media:retime', (e, p, opts) => media.opticalFlowRetime(p, opts, progressSender(e)));
  h('media:image-sequence', (e, files, opts) => media.imageSequenceToMovie(files, opts, progressSender(e)));
  h('media:loudness', (_e, p) => media.loudness(p));
  h('media:scenes', (_e, p, o) => media.scenes(p, o));
  h('media:cancel', (_e, jobId) => media.cancel(jobId));
  h('media:clear-cache', (_e, dir) => media.clearCache(dir));
  h('media:psd', (_e, p, outDir) => psd.extract(p, outDir));

  // Export
  h('export:start', (e, opts) => exporter.start(opts, progressSender(e)));
  h('export:frame', (_e, id, buf) => exporter.frame(id, buf));
  h('export:finish', (_e, id) => exporter.finish(id));
  h('export:abort', (_e, id) => exporter.abort(id));
  h('export:smart', (e, opts) => exporter.smartRender(opts, progressSender(e)));
  h('export:still', (_e, file, buf, w, hgt, fmt) => exporter.still(file, buf, w, hgt, fmt));

  // Pop-out windows (multi-monitor monitors)
  h('window:popout', (_e, opts) => {
    const displays = screen.getAllDisplays();
    const d = displays.find((x) => x.id === opts.displayId) || displays[displays.length - 1];
    const win = new BrowserWindow({
      x: d.bounds.x + 40, y: d.bounds.y + 40, width: Math.min(1280, d.bounds.width - 80), height: Math.min(760, d.bounds.height - 80),
      backgroundColor: '#000000', title: opts.title || 'CinergyPro', fullscreen: !!opts.fullscreen,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
    });
    win.loadURL('app://cinergy/popout.html?kind=' + encodeURIComponent(opts.kind || 'program'));
    popouts.set(win.webContents.id, win);
    win.on('closed', () => { popouts.delete(win.webContents.id); mainWindow && mainWindow.webContents.send('window:popout-closed', opts.kind); });
    return win.webContents.id;
  });
  h('window:popout-close', () => { for (const w of popouts.values()) if (!w.isDestroyed()) w.close(); return true; });
  // Relay frames/messages main window -> popouts
  ipcMain.on('popout:post', (_e, msg) => { for (const w of popouts.values()) if (!w.isDestroyed()) w.webContents.send('popout:message', msg); });
  ipcMain.on('popout:to-main', (_e, msg) => { mainWindow && mainWindow.webContents.send('popout:from', msg); });
}

function progressSender(e) {
  return (msg) => { try { if (!e.sender.isDestroyed()) e.sender.send('job:progress', msg); } catch {} };
}

function safePath(name) { try { return app.getPath(name); } catch { return os.homedir(); } }

function walk(dir, maxDepth, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { out.push({ path: full, dir: true, depth }); walk(full, maxDepth, depth + 1, out); }
    else out.push({ path: full, dir: false, depth });
    if (out.length > 20000) break;
  }
  return out;
}

function dirSize(dir) {
  let total = 0, files = 0;
  for (const e of walk(dir, 10)) if (!e.dir) { try { total += fs.statSync(e.path).size; files++; } catch {} }
  return { bytes: total, files };
}

function listVolumes() {
  const vols = [{ name: 'Home', path: os.homedir() }];
  const add = (n, p) => { if (fs.existsSync(p)) vols.push({ name: n, path: p }); };
  add('Desktop', path.join(os.homedir(), 'Desktop'));
  add(process.platform === 'win32' ? 'Videos' : 'Movies', path.join(os.homedir(), process.platform === 'win32' ? 'Videos' : 'Movies'));
  add('Downloads', path.join(os.homedir(), 'Downloads'));
  add('Documents', path.join(os.homedir(), 'Documents'));
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const r = l + ':\\'; try { if (fs.existsSync(r)) vols.push({ name: l + ':', path: r, volume: true }); } catch {} }
  } else if (process.platform === 'darwin' && fs.existsSync('/Volumes')) {
    for (const v of fs.readdirSync('/Volumes')) vols.push({ name: v, path: path.join('/Volumes', v), volume: true });
  } else if (fs.existsSync('/media')) {
    try { for (const v of fs.readdirSync('/media')) vols.push({ name: v, path: path.join('/media', v), volume: true }); } catch {}
  }
  return vols;
}

function findFile(name, roots, maxDepth) {
  const lower = name.toLowerCase();
  for (const r of roots) {
    if (!r || !fs.existsSync(r)) continue;
    for (const e of walk(r, maxDepth)) if (!e.dir && path.basename(e.path).toLowerCase() === lower) return e.path;
  }
  return null;
}

app.whenReady().then(() => {
  registerProtocols();
  registerIpc();
  buildMenu([{ label: 'File', submenu: [{ role: 'quit' }] }]);
  createMainWindow();
  app.on('activate', () => { if (!mainWindow) createMainWindow(); });
});

app.on('open-file', (e, file) => { e.preventDefault(); if (mainWindow && mainWindow.__rendererReady) mainWindow.webContents.send('app:open-file', file); else app.__pendingOpen = file; });
// Windows and Linux pass a double-clicked project as a command-line argument
const projectArg = (argv) => argv.slice(1).find((a) => /\.cinergy$/i.test(a) && fs.existsSync(a));
if (process.platform !== 'darwin' && !TEST_MODE) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) app.quit();
  else {
    app.__pendingOpen = projectArg(process.argv) || null;
    app.on('second-instance', (_e, argv) => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const f = projectArg(argv); if (f) mainWindow.webContents.send('app:open-file', f);
    });
  }
}
app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { media.cancelAll(); exporter.abortAll(); });
