// Compiles build/installer.nsi into dist/<name>-setup.exe with makensis (native on macOS/Linux/Windows).
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');
const root = path.join(__dirname, '..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(require('os').homedir(), process.platform === 'darwin' ? 'Library/Caches/electron-builder' : process.platform === 'win32' ? 'AppData/Local/electron-builder/Cache' : '.cache/electron-builder');
let nsisDir = null;
const rel = process.platform === 'win32' ? 'makensis.exe' : process.platform === 'darwin' ? 'mac/makensis' : 'linux/makensis';
for (const d of fs.existsSync(cache) ? fs.readdirSync(cache) : []) if (d.startsWith('nsis-') && !d.includes('resources')) for (const s of fs.readdirSync(path.join(cache, d))) if (fs.existsSync(path.join(cache, d, s, rel))) nsisDir = path.join(cache, d, s);
const systemNsis = ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe', '/opt/homebrew/bin/makensis', '/usr/local/bin/makensis', '/usr/bin/makensis'].find((p) => fs.existsSync(p));
const bin = process.env.MAKENSIS || (nsisDir ? path.join(nsisDir, rel) : systemNsis || 'makensis');
if (!nsisDir && !systemNsis && !process.env.MAKENSIS) console.log('makensis not found in the electron-builder cache; trying PATH (install NSIS: brew install makensis / choco install nsis / apt install nsis)');
if (nsisDir && process.platform !== 'win32') fs.chmodSync(bin, 0o755);
const out = path.join(root, 'dist', `${pkg.build.productName}-${pkg.version}-win-x64-setup.exe`);
execFileSync(bin, ['-V2', `-DVERSION=${pkg.version}`, `-DSRCDIR=${path.join(root, 'dist', 'win-unpacked')}`, `-DOUTFILE=${out}`, path.join(__dirname, 'installer.nsi')],
  { stdio: 'inherit', cwd: __dirname, env: { ...process.env, ...(nsisDir ? { NSISDIR: nsisDir } : {}) } });
console.log('Built', out);
