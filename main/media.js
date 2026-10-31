'use strict';
// Media services built on ffmpeg/ffprobe: probing, audio decode, thumbnails, proxies,
// transcoding, stabilization, optical-flow retiming, image sequences, loudness.
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app } = require('electron');

const jobs = new Map();
let caps = null;

function binPath(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  const candidates = [];
  if (process.env['CINERGY_' + name.toUpperCase()]) candidates.push(process.env['CINERGY_' + name.toUpperCase()]);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', exe));
  candidates.push(path.join(__dirname, '..', 'bin', `${{ darwin: 'mac', win32: 'win' }[process.platform] || process.platform}-${process.arch}`, exe));
  candidates.push(path.join(__dirname, '..', 'bin', exe));
  candidates.push('/opt/homebrew/bin/' + exe, '/usr/local/bin/' + exe, '/usr/bin/' + exe);
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return exe; // rely on PATH
}
const ffmpegPath = () => binPath('ffmpeg');
const ffprobePath = () => binPath('ffprobe');

function cacheDir(...p) {
  const d = path.join(app.getPath('userData'), 'MediaCache', ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function keyFor(file, extra = '') {
  let st = { size: 0, mtimeMs: 0 };
  try { st = fs.statSync(file); } catch {}
  return crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs + '|' + extra).digest('hex').slice(0, 20);
}

function capabilities() {
  if (caps) return caps;
  const out = { encoders: [], filters: [], hwaccels: [], ffmpeg: ffmpegPath(), ok: false };
  try {
    const enc = execFileSync(ffmpegPath(), ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
    out.encoders = enc.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
    const fil = execFileSync(ffmpegPath(), ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true });
    out.filters = fil.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
    const hw = execFileSync(ffmpegPath(), ['-hide_banner', '-hwaccels'], { encoding: 'utf8', windowsHide: true });
    out.hwaccels = hw.split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
    out.ok = true;
  } catch (e) { out.error = String(e.message || e); }
  out.has = (n) => out.encoders.includes(n) || out.filters.includes(n);
  caps = out;
  return { ...out, has: undefined };
}
function hasEnc(n) { capabilities(); return caps.encoders.includes(n); }
function hasFilter(n) { capabilities(); return caps.filters.includes(n); }

function run(bin, args, { jobId, onProgress, duration, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (jobId) jobs.set(jobId, proc);
    let stdout = [], stderr = '';
    proc.stdout.on('data', (d) => stdout.push(d));
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s; if (stderr.length > 200000) stderr = stderr.slice(-100000);
      if (onStderr) onStderr(s);
      if (onProgress && duration) {
        const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
        if (m) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration));
      }
    });
    proc.on('error', (e) => { jobs.delete(jobId); reject(e); });
    proc.on('close', (code, signal) => {
      jobs.delete(jobId);
      if (signal === 'SIGKILL' || signal === 'SIGTERM') return reject(new Error('Cancelled'));
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else reject(new Error(`${path.basename(bin)} exited with ${code}: ${stderr.split('\n').filter(Boolean).slice(-4).join(' | ')}`));
    });
  });
}

function cancel(jobId) { const p = jobs.get(jobId); if (p) { p.kill('SIGKILL'); jobs.delete(jobId); return true; } return false; }
function cancelAll() { for (const p of jobs.values()) try { p.kill('SIGKILL'); } catch {} jobs.clear(); }

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.svg', '.psd', '.exr', '.dpx', '.tga', '.heic']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.aac', '.m4a', '.aif', '.aiff', '.flac', '.ogg', '.opus', '.wma', '.caf']);

async function probe(file) {
  const ext = path.extname(file).toLowerCase();
  const st = fs.statSync(file);
  const base = { path: file, name: path.basename(file), ext, size: st.size, mtime: st.mtimeMs, created: st.birthtimeMs || st.ctimeMs };
  if (ext === '.svg') return { ...base, kind: 'image', width: 1920, height: 1080, duration: 0, hasVideo: true, hasAudio: false, alpha: true, codec: 'svg', streams: [] };
  if (ext === '.psd') return { ...base, kind: 'psd', width: 0, height: 0, duration: 0, hasVideo: true, hasAudio: false, alpha: true, codec: 'psd', streams: [] };
  const { stdout } = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout.toString() || '{}');
  const streams = info.streams || [];
  const fmt = info.format || {};
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const a = audioStreams[0];
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const tags = Object.assign({}, fmt.tags || {}, v && v.tags || {});
  const tcStream = streams.find((s) => s.tags && s.tags.timecode);
  let duration = parseFloat(fmt.duration || (v && v.duration) || (a && a.duration) || 0) || 0;
  const isImage = IMAGE_EXT.has(ext) || (v && (fmt.format_name || '').includes('image2')) || (v && duration <= 0.05 && !a);
  const fps = v ? (parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 0) : 0;
  const pixfmt = v && v.pix_fmt || '';
  const alpha = /a|rgba|argb|bgra|yuva|gbrap|ya/.test(pixfmt.replace(/^yuv(?!a)/, 'yuv')) && /(rgba|argb|bgra|abgr|yuva|gbrap|ya8|ya16|pal8)/.test(pixfmt);
  let rotation = 0;
  if (v) {
    if (v.tags && v.tags.rotate) rotation = parseInt(v.tags.rotate, 10) || 0;
    const sd = (v.side_data_list || []).find((d) => d.rotation !== undefined);
    if (sd) rotation = -parseInt(sd.rotation, 10) || 0;
  }
  const sar = v && v.sample_aspect_ratio && v.sample_aspect_ratio !== '0:1' ? v.sample_aspect_ratio.split(':').map(Number) : [1, 1];
  return {
    ...base,
    kind: isImage ? 'image' : (v ? 'video' : (a ? 'audio' : 'unknown')),
    duration: isImage ? 0 : duration,
    format: fmt.format_long_name || fmt.format_name, formatName: fmt.format_name,
    bitrate: parseInt(fmt.bit_rate || 0, 10),
    hasVideo: !!v, hasAudio: !!a,
    width: v ? v.width : 0, height: v ? v.height : 0, rotation,
    pixelAspect: sar[1] ? sar[0] / sar[1] : 1,
    fps, frames: v && v.nb_frames ? parseInt(v.nb_frames, 10) : Math.round(duration * fps),
    codec: v ? v.codec_name : (a ? a.codec_name : ''), codecLong: v ? v.codec_long_name : '', profile: v && v.profile,
    pixfmt, alpha: !!alpha, bitDepth: v && (parseInt(v.bits_per_raw_sample, 10) || (/(10|12|16)le/.exec(pixfmt) || [0, 8])[1] * 1),
    fieldOrder: v && v.field_order || 'progressive',
    colorSpace: v && v.color_space, colorTransfer: v && v.color_transfer, colorPrimaries: v && v.color_primaries, colorRange: v && v.color_range,
    hdr: !!(v && /smpte2084|arib-std-b67/.test(v.color_transfer || '')),
    audioCodec: a && a.codec_name, sampleRate: a ? parseInt(a.sample_rate, 10) : 0, channels: a ? a.channels : 0,
    channelLayout: a && a.channel_layout, audioStreams: audioStreams.length,
    audioTracks: audioStreams.map((s) => ({ index: s.index, channels: s.channels, layout: s.channel_layout, codec: s.codec_name, language: s.tags && s.tags.language })),
    subtitles: subs.map((s) => ({ index: s.index, codec: s.codec_name, language: s.tags && s.tags.language })),
    timecode: tcStream ? tcStream.tags.timecode : (tags.timecode || null),
    creationTime: tags.creation_time || null,
    camera: tags['com.apple.quicktime.model'] || tags.model || tags.encoder || null,
    make: tags['com.apple.quicktime.make'] || tags.make || null,
    tags,
    streams: streams.map((s) => ({ index: s.index, type: s.codec_type, codec: s.codec_name, profile: s.profile })),
  };
}

// Decode audio to a float WAV in cache (optionally time-stretched with pitch preserved).
async function decodeAudio(file, opts = {}, progress) {
  const sr = opts.sampleRate || 48000;
  const tempo = opts.tempo || 1;
  const stream = opts.stream || 0;
  const pitch = opts.pitch || 0; // semitones
  const key = keyFor(file, `a|${sr}|${tempo}|${stream}|${pitch}|${opts.reverse ? 1 : 0}`);
  const out = path.join(cacheDir('audio'), key + '.wav');
  if (fs.existsSync(out) && fs.statSync(out).size > 44) return out;
  const filters = [];
  if (pitch) { const ratio = Math.pow(2, pitch / 12); filters.push(`asetrate=${sr * ratio}`, `aresample=${sr}`); filters.push(...atempoChain(1 / ratio)); }
  if (tempo !== 1) filters.push(...atempoChain(tempo));
  if (opts.reverse) filters.push('areverse');
  const args = ['-y', '-v', 'error', '-stats', '-i', file, '-map', `0:a:${stream}?`, '-vn', '-ac', String(opts.channels || 2), '-ar', String(sr)];
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-c:a', 'pcm_s16le', out + '.part.wav');
  const info = await probe(file).catch(() => ({ duration: 0 }));
  await run(ffmpegPath(), args, { jobId: opts.jobId, duration: info.duration, onProgress: (p) => progress && progress({ jobId: opts.jobId, kind: 'audio', progress: p }) });
  fs.renameSync(out + '.part.wav', out);
  return out;
}

function atempoChain(t) {
  const out = [];
  while (t > 2.0) { out.push('atempo=2.0'); t /= 2.0; }
  while (t < 0.5) { out.push('atempo=0.5'); t /= 0.5; }
  out.push('atempo=' + t.toFixed(6));
  return out;
}

async function thumbnailStrip(file, opts = {}) {
  const count = opts.count || 60;
  const h = opts.height || 54;
  const info = await probe(file);
  if (!info.hasVideo) return null;
  if (info.kind === 'image') return { path: file, count: 1, image: true };
  const n = Math.max(1, Math.min(count, Math.floor(info.duration * 2) || 1));
  const key = keyFor(file, `t|${n}|${h}`);
  const out = path.join(cacheDir('thumbs'), key + '.jpg');
  if (fs.existsSync(out)) return { path: out, count: n };
  const rate = n / Math.max(0.1, info.duration);
  await run(ffmpegPath(), ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', `fps=${rate.toFixed(6)},scale=-2:${h},tile=${n}x1`, '-q:v', '4', out + '.part.jpg']);
  fs.renameSync(out + '.part.jpg', out);
  return { path: out, count: n };
}

async function poster(file, t = 0, w = 320) {
  const key = keyFor(file, `p|${t}|${w}`);
  const out = path.join(cacheDir('posters'), key + '.jpg');
  if (fs.existsSync(out)) return out;
  await run(ffmpegPath(), ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '3', out + '.part.jpg']);
  fs.renameSync(out + '.part.jpg', out);
  return out;
}

function codecArgs(codec, quality = 'high', hw = false) {
  switch (codec) {
    case 'prores_proxy': return ['-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le'];
    case 'prores_lt': return ['-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le'];
    case 'prores': case 'prores_422': return ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'];
    case 'prores_hq': return ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'];
    case 'prores_4444': return ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'];
    case 'dnxhr_lb': return ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p'];
    case 'dnxhr_sq': return ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq', '-pix_fmt', 'yuv422p'];
    case 'dnxhr_hq': return ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p'];
    case 'hevc': return hw && hasEnc('hevc_videotoolbox') ? ['-c:v', 'hevc_videotoolbox', '-q:v', '65', '-tag:v', 'hvc1'] : ['-c:v', 'libx265', '-crf', quality === 'low' ? '30' : '22', '-preset', 'fast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'];
    case 'intra': return ['-c:v', 'libx264', '-crf', '14', '-g', '1', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    case 'h264': default:
      if (hw && hasEnc('h264_videotoolbox')) return ['-c:v', 'h264_videotoolbox', '-q:v', quality === 'low' ? '45' : '65', '-pix_fmt', 'yuv420p'];
      return ['-c:v', 'libx264', '-crf', quality === 'low' ? '28' : '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '15'];
  }
}

async function createProxy(file, opts = {}, progress) {
  const height = opts.height || 720;
  const codec = opts.codec || 'h264';
  const ext = codec.startsWith('prores') || codec.startsWith('dnx') ? '.mov' : '.mp4';
  const outDir = opts.dir || cacheDir('proxies');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, path.parse(file).name + `_proxy_${height}p_` + keyFor(file, `${height}|${codec}`).slice(0, 6) + ext);
  if (fs.existsSync(out) && !opts.force) return out;
  const info = await probe(file);
  const vf = [`scale=-2:'min(${height},ih)'`];
  if (info.fieldOrder && !/progressive|unknown/.test(info.fieldOrder)) vf.unshift('yadif');
  const args = ['-y', '-v', 'error', '-stats', '-i', file, '-map', '0:v:0?', '-map', '0:a?', '-vf', vf.join(','), ...codecArgs(codec, 'low', opts.hw !== false), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out + '.part' + ext];
  await run(ffmpegPath(), args, { jobId: opts.jobId, duration: info.duration, onProgress: (p) => progress && progress({ jobId: opts.jobId, kind: 'proxy', file, progress: p }) });
  fs.renameSync(out + '.part' + ext, out);
  return out;
}

async function transcode(file, opts = {}, progress) {
  const info = await probe(file);
  const codec = opts.codec || 'h264';
  const ext = opts.ext || (codec.startsWith('prores') || codec.startsWith('dnx') ? '.mov' : '.mp4');
  const out = opts.out || path.join(opts.dir || cacheDir('transcodes'), path.parse(file).name + '_' + codec + ext);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const vf = [];
  if (opts.deinterlace || (info.fieldOrder && !/progressive|unknown/.test(info.fieldOrder))) vf.push('yadif');
  if (opts.height) vf.push(`scale=-2:${opts.height}`);
  if (info.kind === 'image') vf.push('loop=loop=-1:size=1');
  const args = ['-y', '-v', 'error', '-stats', '-i', file];
  if (vf.length) args.push('-vf', vf.join(','));
  args.push(...codecArgs(codec, opts.quality || 'high', opts.hw !== false));
  if (info.hasAudio) args.push('-c:a', ext === '.mov' && codec.startsWith('prores') ? 'pcm_s16le' : 'aac', '-b:a', '256k');
  args.push(out);
  await run(ffmpegPath(), args, { jobId: opts.jobId, duration: info.duration, onProgress: (p) => progress && progress({ jobId: opts.jobId, kind: 'transcode', file, progress: p }) });
  return out;
}

// Stabilize: vid.stab two-pass when available, otherwise (or if it fails) deshake.
async function stabilize(file, opts = {}, progress) {
  const smooth = Math.round(opts.smoothness || 15);
  const crop = opts.crop || 'black';
  const zoom = opts.zoom == null ? 0 : opts.zoom;
  const key = keyFor(file, `stab|${smooth}|${crop}|${zoom}|${opts.method || ''}|${opts.in || 0}|${opts.out || 0}`);
  const out = path.join(cacheDir('stabilized'), key + '.mp4');
  if (fs.existsSync(out)) return out;
  const tmp = path.join(cacheDir('stabilized'), key + '.part.mp4');
  const info = await probe(file);
  const report = (stage, p) => progress && progress({ jobId: opts.jobId, kind: 'stabilize', stage, progress: p });
  const trf = path.join(cacheDir('stabilized'), key + '.trf');
  const useVidstab = hasFilter('vidstabdetect') && opts.method !== 'deshake';
  const range16 = Math.max(16, Math.min(64, Math.round((smooth * 2) / 16) * 16)); // ffmpeg 6.0 needs a multiple of 16
  const deshake = () => run(ffmpegPath(), ['-y', '-v', 'error', '-stats', '-i', file, '-vf', `deshake=rx=${range16}:ry=${range16}:edge=${crop === 'keep' ? 1 : 0}`, ...codecArgs('intra'), '-c:a', 'copy', tmp],
    { jobId: opts.jobId, duration: info.duration, onProgress: (p) => report('render', p) });
  if (useVidstab) {
    try {
      await vidstab();
    } catch (e) {
      // some static ffmpeg builds write vid.stab motion files they cannot read back; deshake still works
      if (e.message === 'Cancelled') throw e;
      console.warn('vid.stab failed, using deshake:', e.message);
      try { fs.unlinkSync(tmp); } catch {}
      await deshake();
    }
  } else {
    await deshake();
  }
  fs.renameSync(tmp, out); // only finished renders land at the cached path
  return out;

  async function vidstab() {
    await run(ffmpegPath(), ['-y', '-v', 'error', '-stats', '-i', file, '-vf', `vidstabdetect=shakiness=${opts.shakiness || 6}:accuracy=12:result='${trf.replace(/\\/g, '/').replace(/'/g, "\\'")}'`, '-f', 'null', '-'],
      { jobId: opts.jobId, duration: info.duration, onProgress: (p) => report('analyze', p * 0.5) });
    await run(ffmpegPath(), ['-y', '-v', 'error', '-stats', '-i', file, '-vf', `vidstabtransform=input='${trf.replace(/\\/g, '/').replace(/'/g, "\\'")}':smoothing=${smooth}:crop=${crop === 'keep' ? 'keep' : 'black'}:optzoom=${zoom === 'auto' ? 1 : 0}:zoom=${typeof zoom === 'number' ? zoom : 0},unsharp=5:5:0.6:3:3:0.3`, ...codecArgs('intra'), '-c:a', 'copy', tmp],
      { jobId: opts.jobId, duration: info.duration, onProgress: (p) => report('render', 0.5 + p * 0.5) });
  }
}

// Optical-flow (motion interpolated) retime for slow motion.
async function opticalFlowRetime(file, opts = {}, progress) {
  const speed = opts.speed || 0.5;
  const method = opts.method || 'optical'; // optical | blend
  const key = keyFor(file, `rt|${speed}|${method}|${opts.fps}`);
  const out = path.join(cacheDir('retimed'), key + '.mp4');
  if (fs.existsSync(out)) return out;
  const info = await probe(file);
  const fps = opts.fps || info.fps || 30;
  const mi = method === 'blend' ? `minterpolate=fps=${fps / speed}:mi_mode=blend` : `minterpolate=fps=${fps / speed}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
  const vf = `${mi},setpts=${(1 / speed).toFixed(6)}*PTS,fps=${fps}`;
  await run(ffmpegPath(), ['-y', '-v', 'error', '-stats', '-i', file, '-an', '-vf', vf, ...codecArgs('intra'), out + '.part.mp4'],
    { jobId: opts.jobId, duration: info.duration / speed, onProgress: (p) => progress && progress({ jobId: opts.jobId, kind: 'retime', progress: p }) });
  fs.renameSync(out + '.part.mp4', out);
  return out;
}

async function imageSequenceToMovie(files, opts = {}, progress) {
  const fps = opts.fps || 24;
  const list = path.join(cacheDir('sequences'), keyFor(files[0], String(files.length)) + '.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration ${(1 / fps).toFixed(6)}`).join('\n') + `\nfile '${files[files.length - 1].replace(/'/g, "'\\''")}'\n`);
  const alpha = /\.(png|tif|tiff|tga|exr)$/i.test(files[0]) && opts.alpha !== false;
  const out = list.replace(/\.txt$/, alpha ? '.mov' : '.mp4');
  if (fs.existsSync(out)) return out;
  await run(ffmpegPath(), ['-y', '-v', 'error', '-stats', '-f', 'concat', '-safe', '0', '-i', list, '-r', String(fps), '-vsync', 'cfr',
    ...(alpha ? ['-c:v', 'png', '-pix_fmt', 'rgba'] : codecArgs('intra')), out + '.part' + path.extname(out)],
  { jobId: opts.jobId, duration: files.length / fps, onProgress: (p) => progress && progress({ jobId: opts.jobId, kind: 'sequence', progress: p }) });
  fs.renameSync(out + '.part' + path.extname(out), out);
  return out;
}

async function loudness(file) {
  const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re) => { const m = re.exec(summary); return m ? parseFloat(m[1]) : null; };
  return {
    integrated: num(/I:\s+(-?[\d.]+) LUFS/), range: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/),
    threshold: num(/Threshold:\s+(-?[\d.]+) LUFS/),
  };
}

async function scenes(file, opts = {}) {
  const info = await probe(file);
  const thr = opts.threshold || 0.3;
  const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene,${thr})',showinfo`, '-f', 'null', '-'],
    { jobId: opts.jobId, duration: info.duration, onStderr: () => {}, onProgress: () => {} });
  const times = [];
  const re = /pts_time:([\d.]+)/g; let m;
  while ((m = re.exec(stderr))) times.push(parseFloat(m[1]));
  return times;
}

function clearCache(sub) {
  const d = sub ? path.join(app.getPath('userData'), 'MediaCache', sub) : path.join(app.getPath('userData'), 'MediaCache');
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return true;
}

module.exports = {
  ffmpegPath, ffprobePath, capabilities, probe, decodeAudio, thumbnailStrip, poster, createProxy, transcode, stabilize,
  opticalFlowRetime, imageSequenceToMovie, loudness, scenes, cancel, cancelAll, clearCache, codecArgs, hasEnc, hasFilter, run, cacheDir,
};
