#!/usr/bin/env node
// Generates synthetic test media with ffmpeg, then runs the in-app end-to-end test harness.
// Usage: node scripts/run-tests.js [--quick]   (--quick skips the long export renders)
// Results and screenshots go to test-output/.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'test-output');
const mediaDir = path.join(outDir, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

const plat = `${{ darwin: 'mac', win32: 'win' }[process.platform] || process.platform}-${process.arch}`;
const local = path.join(root, 'bin', plat, 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
const ffmpeg = process.env.CINERGY_FFMPEG || (fs.existsSync(local) ? local : 'ffmpeg');

const make = (name, args) => {
  const file = path.join(mediaDir, name);
  if (fs.existsSync(file)) return;
  console.log('making', name);
  execFileSync(ffmpeg, ['-y', '-v', 'error', ...args, file], { stdio: 'inherit' });
};
make('clipA.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-shortest']);
make('clipB.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=size=1920x1080:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=5', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-shortest']);
make('clipC_prores.mov', ['-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=30:duration=4', '-c:v', 'prores_ks', '-profile:v', '2']);
make('green.mp4', ['-f', 'lavfi', '-i', 'color=c=0x00b140:size=1280x720:rate=24:duration=4', '-vf', 'drawbox=x=480:y=200:w=320:h=320:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
make('music.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le']);
make('still.png', ['-f', 'lavfi', '-i', 'testsrc=size=1600x900:rate=1', '-frames:v', '1']);

const electron = require('electron');
const args = ['.', '--test', ...process.argv.slice(2)];
if (process.platform === 'linux') args.push('--no-sandbox');
const child = spawn(electron, args, {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CINERGY_TEST: '1', CINERGY_TEST_MEDIA: mediaDir, CINERGY_TEST_OUT: outDir },
});
let summary = '';
const onData = (d) => {
  for (const line of d.toString().split('\n')) {
    if (line.includes('[TEST]')) { console.log(line.replace(/^.*\[TEST\]\s*/, '').replace(/\s*\(test-harness\.js:\d+\)$/, '')); if (line.includes('SUMMARY')) summary = line; }
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', () => {
  console.log(`\nScreenshots and exports: ${outDir}`);
  const m = /SUMMARY (\d+)\/(\d+)/.exec(summary);
  process.exit(m && m[1] === m[2] ? 0 : 1);
});
