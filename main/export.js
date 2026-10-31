'use strict';
// Export sessions: the renderer streams composited RGBA frames; ffmpeg encodes them
// together with a pre-rendered audio mix.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const media = require('./media');

const sessions = new Map();
let nextId = 1;

function videoCodecArgs(o) {
  const a = [];
  const hw = !!o.hw;
  const tenBit = !!o.hdr || o.bitDepth === 10;
  switch (o.codec) {
    case 'h264':
      if (hw && media.hasEnc('h264_videotoolbox')) a.push('-c:v', 'h264_videotoolbox', ...(o.bitrateMode === 'vbr' || o.videoBitrate ? ['-b:v', `${o.videoBitrate || 16}M`] : ['-q:v', '70']));
      else {
        a.push('-c:v', 'libx264', '-preset', o.preset || 'medium');
        if (o.bitrateMode === 'cbr' && o.videoBitrate) a.push('-b:v', `${o.videoBitrate}M`, '-minrate', `${o.videoBitrate}M`, '-maxrate', `${o.videoBitrate}M`, '-bufsize', `${o.videoBitrate * 2}M`);
        else if (o.bitrateMode === 'vbr' && o.videoBitrate) a.push('-b:v', `${o.videoBitrate}M`, '-maxrate', `${(o.maxBitrate || o.videoBitrate * 1.5)}M`, '-bufsize', `${o.videoBitrate * 2}M`);
        else a.push('-crf', String(o.crf != null ? o.crf : 18));
        if (o.profile) a.push('-profile:v', o.profile);
        if (o.level) a.push('-level', String(o.level));
      }
      a.push('-pix_fmt', 'yuv420p');
      break;
    case 'hevc':
      if (hw && media.hasEnc('hevc_videotoolbox')) a.push('-c:v', 'hevc_videotoolbox', ...(o.videoBitrate ? ['-b:v', `${o.videoBitrate}M`] : ['-q:v', '65']));
      else {
        a.push('-c:v', 'libx265', '-preset', o.preset || 'medium');
        if (o.videoBitrate && o.bitrateMode !== 'crf') a.push('-b:v', `${o.videoBitrate}M`); else a.push('-crf', String(o.crf != null ? o.crf : 22));
        if (o.hdr) a.push('-x265-params', o.hdr === 'pq' ? 'hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc' : 'repeat-headers=1:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc');
      }
      a.push('-tag:v', 'hvc1', '-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p');
      break;
    case 'prores_proxy': case 'prores_lt': case 'prores_422': case 'prores_hq': case 'prores_4444': case 'prores_4444xq': {
      const prof = { prores_proxy: 0, prores_lt: 1, prores_422: 2, prores_hq: 3, prores_4444: 4, prores_4444xq: 5 }[o.codec];
      a.push('-c:v', 'prores_ks', '-profile:v', String(prof), '-vendor', 'apl0', '-pix_fmt', prof >= 4 ? (o.alpha ? 'yuva444p10le' : 'yuv444p10le') : 'yuv422p10le');
      break;
    }
    case 'dnxhr_lb': case 'dnxhr_sq': case 'dnxhr_hq': case 'dnxhr_hqx': case 'dnxhr_444':
      a.push('-c:v', 'dnxhd', '-profile:v', o.codec, '-pix_fmt', o.codec === 'dnxhr_hqx' ? 'yuv422p10le' : o.codec === 'dnxhr_444' ? 'yuv444p10le' : 'yuv422p');
      break;
    case 'vp9':
      a.push('-c:v', 'libvpx-vp9', '-b:v', o.videoBitrate ? `${o.videoBitrate}M` : '0', '-crf', String(o.crf != null ? o.crf : 30), '-row-mt', '1', '-pix_fmt', o.alpha ? 'yuva420p' : 'yuv420p');
      break;
    case 'gif':
      break;
    case 'png': a.push('-c:v', 'png', '-pix_fmt', o.alpha ? 'rgba' : 'rgb24'); break;
    case 'mjpeg': a.push('-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj444p'); break;
    case 'tiff': a.push('-c:v', 'tiff', '-pix_fmt', o.alpha ? 'rgba' : 'rgb24'); break;
    case 'dpx': a.push('-c:v', 'dpx', '-pix_fmt', 'rgb48le'); break;
    default: a.push('-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p');
  }
  if (o.gop && !['png', 'tiff', 'mjpeg', 'dpx'].includes(o.codec)) a.push('-g', String(o.gop));
  if (o.hdr) a.push('-color_primaries', 'bt2020', '-color_trc', o.hdr === 'pq' ? 'smpte2084' : 'arib-std-b67', '-colorspace', 'bt2020nc');
  else if (o.colorSpace === 'rec2020') a.push('-color_primaries', 'bt2020', '-color_trc', 'bt709', '-colorspace', 'bt2020nc');
  else if (!['png', 'tiff', 'dpx', 'gif'].includes(o.codec)) a.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  if (o.pixelAspect && o.pixelAspect !== 1) a.push('-aspect', String((o.width * o.pixelAspect / o.height).toFixed(5)));
  if (o.fieldOrder === 'tff' || o.fieldOrder === 'bff') a.push('-flags', '+ildct+ilme', '-top', o.fieldOrder === 'tff' ? '1' : '0');
  return a;
}

function audioCodecArgs(o) {
  const ch = String(o.channels || 2), sr = String(o.sampleRate || 48000);
  const br = `${o.audioBitrate || 320}k`;
  switch (o.audioCodec) {
    case 'none': return ['-an'];
    case 'pcm16': return ['-c:a', 'pcm_s16le', '-ar', sr, '-ac', ch];
    case 'pcm24': return ['-c:a', 'pcm_s24le', '-ar', sr, '-ac', ch];
    case 'pcm24be': return ['-c:a', 'pcm_s24be', '-ar', sr, '-ac', ch];
    case 'pcm32f': return ['-c:a', 'pcm_f32le', '-ar', sr, '-ac', ch];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', br, '-ar', sr, '-ac', ch];
    case 'flac': return ['-c:a', 'flac', '-ar', sr, '-ac', ch];
    case 'opus': return ['-c:a', 'libopus', '-b:a', br, '-ac', ch];
    case 'aac': default: return ['-c:a', 'aac', '-b:a', br, '-ar', sr, '-ac', ch];
  }
}

function metadataArgs(md = {}) {
  const out = [];
  for (const [k, v] of Object.entries(md)) if (v) out.push('-metadata', `${k}=${String(v).replace(/\n/g, ' ')}`);
  return out;
}

async function start(o, progress) {
  const id = String(nextId++);
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  const args = ['-y', '-v', 'error', '-stats'];
  if (o.audioOnly) {
    args.push('-i', o.audioWav, ...audioCodecArgs(o), ...metadataArgs(o.metadata), o.out);
    const proc = spawn(media.ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const s = makeSession(id, proc, o, progress);
    await s.done;
    return { id, done: true, out: o.out };
  }
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-framerate', String(o.fps), '-i', 'pipe:0');
  const hasAudio = o.audioWav && o.audioCodec !== 'none' && !o.imageSequence && o.codec !== 'gif';
  if (hasAudio) args.push('-i', o.audioWav);
  const vf = ['vflip'];
  if (o.outWidth && o.outHeight && (o.outWidth !== o.width || o.outHeight !== o.height)) vf.push(`scale=${o.outWidth}:${o.outHeight}:flags=lanczos`);
  if (o.codec === 'gif') {
    vf.push('split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a');
    args.push('-filter_complex', '[0:v]' + vf.join(','));
  } else args.push('-vf', vf.join(','));
  args.push(...videoCodecArgs(o));
  if (hasAudio) { args.push('-map', '0:v:0', '-map', '1:a:0', ...audioCodecArgs(o), '-shortest'); }
  if (!o.imageSequence) {
    args.push(...metadataArgs(o.metadata));
    if (/\.(mp4|mov|m4v)$/i.test(o.out)) args.push('-movflags', '+faststart+write_colr');
    if (o.timecode && /\.(mov|mxf|mp4)$/i.test(o.out)) args.push('-timecode', o.timecode);
  } else {
    args.push('-start_number', String(o.startNumber || 0));
  }
  args.push(o.out);
  const proc = spawn(media.ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const s = makeSession(id, proc, o, progress);
  s.done.catch(() => {});
  return { id };
}

function makeSession(id, proc, o, progress) {
  let stderr = '';
  const s = { id, proc, o, frames: 0, error: null };
  s.done = new Promise((resolve, reject) => {
    proc.stderr.on('data', (d) => {
      const t = d.toString(); stderr += t; if (stderr.length > 50000) stderr = stderr.slice(-20000);
      if (o.audioOnly && o.duration) { const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(t); if (m) progress({ exportId: id, progress: (+m[1] * 3600 + +m[2] * 60 + +m[3]) / o.duration }); }
    });
    proc.on('error', (e) => { s.error = e; reject(e); });
    proc.on('close', (code, sig) => {
      sessions.delete(id);
      if (code === 0) resolve(true);
      else { s.error = new Error(sig ? 'Export cancelled' : 'ffmpeg failed: ' + stderr.split('\n').filter(Boolean).slice(-5).join(' | ')); reject(s.error); }
    });
  });
  if (proc.stdin) proc.stdin.on('error', (e) => { s.error = s.error || e; });
  sessions.set(id, s);
  return s;
}

async function frame(id, buf) {
  const s = sessions.get(id);
  if (!s) throw new Error('Export session ended' );
  if (s.error) throw s.error;
  const ok = s.proc.stdin.write(Buffer.from(buf));
  s.frames++;
  if (!ok) await new Promise((r) => s.proc.stdin.once('drain', r));
  return s.frames;
}

async function finish(id) {
  const s = sessions.get(id);
  if (!s) return true;
  s.proc.stdin.end();
  await s.done;
  return { frames: s.frames, out: s.o.out };
}

function abort(id) {
  const s = sessions.get(id);
  if (s) { try { s.proc.kill('SIGKILL'); } catch {} sessions.delete(id); }
  try { if (s && s.o.out && !s.o.imageSequence) fs.unlinkSync(s.o.out); } catch {}
  return true;
}
function abortAll() { for (const id of [...sessions.keys()]) abort(id); }

// Stream-copy cut for untouched single-clip sequences.
async function smartRender(o, progress) {
  const args = ['-y', '-v', 'error', '-stats', '-ss', String(o.start), '-i', o.source, '-t', String(o.duration), '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...metadataArgs(o.metadata), o.out];
  await media.run(media.ffmpegPath(), args, { duration: o.duration, onProgress: (p) => progress({ exportId: 'smart', progress: p }) });
  return o.out;
}

async function still(file, buf, w, h, fmt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new Promise((resolve, reject) => {
    const codec = { png: 'png', tiff: 'tiff', jpg: 'mjpeg', jpeg: 'mjpeg', dpx: 'dpx', bmp: 'bmp' }[fmt] || 'png';
    const pf = codec === 'mjpeg' ? 'yuvj444p' : codec === 'dpx' ? 'rgb48le' : codec === 'bmp' ? 'bgr24' : 'rgba';
    const p = spawn(media.ffmpegPath(), ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-vf', 'vflip', '-frames:v', '1', '-c:v', codec, '-pix_fmt', pf, ...(codec === 'mjpeg' ? ['-q:v', '2'] : []), file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err))));
    p.stdin.end(Buffer.from(buf));
  });
  return file;
}

module.exports = { start, frame, finish, abort, abortAll, smartRender, still };
