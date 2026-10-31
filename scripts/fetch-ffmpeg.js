#!/usr/bin/env node
// Downloads static ffmpeg and ffprobe builds into bin/<os>-<arch>/ for packaging and local runs.
// Usage: node scripts/fetch-ffmpeg.js [mac-arm64] [mac-x64] [win-x64] [linux-x64] [--force]
// With no targets it fetches the build for the machine it runs on.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
const ASSET = { 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64', 'win-x64': 'win32-x64', 'linux-x64': 'linux-x64' };
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
let targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) targets = [`${{ darwin: 'mac', win32: 'win' }[process.platform] || process.platform}-${process.arch}`];

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  for (const t of targets) {
    const asset = ASSET[t];
    if (!asset) { console.error(`Unknown target "${t}". Use one of: ${Object.keys(ASSET).join(', ')}`); process.exit(1); }
    const dir = path.join(root, 'bin', t);
    fs.mkdirSync(dir, { recursive: true });
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const out = path.join(dir, tool + (t.startsWith('win') ? '.exe' : ''));
      if (fs.existsSync(out) && !force) { console.log(`ok      ${path.relative(root, out)} (already present)`); continue; }
      process.stdout.write(`fetch   ${tool}-${asset} ... `);
      const gz = await download(`${RELEASE}/${tool}-${asset}.gz`);
      fs.writeFileSync(out, zlib.gunzipSync(gz));
      if (!t.startsWith('win')) fs.chmodSync(out, 0o755);
      console.log(`${(fs.statSync(out).size / 1e6).toFixed(1)} MB -> ${path.relative(root, out)}`);
    }
  }
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
