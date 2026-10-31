// Signal analysis: audio sync, mask tracking, reframing, auto tone, color match,
// scene edit detection and auto-ducking.
import { app } from '../app-context.js';
import { findClip, clipSourceTime, allTracks, itemFps } from '../core/project.js';
import { fileUrl, clamp, uid } from '../core/util.js';
import { jobs } from './jobs.js';
import { toast } from '../ui/widgets.js';
import { setKey } from '../core/keyframes.js';
import { maskAt, transformPoints } from '../engine/masks.js';
import { razorAt } from '../core/edit.js';

// ---------- FFT cross-correlation ----------
function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function envelope(buf, rate = 500, maxSec = 900) {
  const step = Math.round(buf.sampleRate / rate);
  const n = Math.min(Math.floor(buf.length / step), rate * maxSec);
  const out = new Float32Array(n);
  const ch = []; for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) { let s = 0; for (const d of ch) for (let j = i * step; j < (i + 1) * step; j += 4) s += Math.abs(d[j]); out[i] = s; }
  // high-pass the envelope (onsets) for sharper correlation
  let prev = 0; for (let i = 0; i < n; i++) { const v = out[i]; out[i] = Math.max(0, v - prev); prev = v; }
  let mean = 0; for (const v of out) mean += v; mean /= n || 1;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

// Returns seconds to delay `b` so that it aligns with `a` (b's t0 maps to a's t=offset)
export async function audioOffsetBetween(a, b) {
  const ba = await app.audio.ensure(a, 0), bb = await app.audio.ensure(b, 0);
  if (!ba || !bb) return null;
  const rate = 500;
  const ea = envelope(ba, rate), eb = envelope(bb, rate);
  let n = 1; while (n < ea.length + eb.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(ea); br.set(eb);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i]; const im = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  let best = 0, bv = -Infinity;
  for (let i = 0; i < n; i++) if (ar[i] > bv) { bv = ar[i]; best = i; }
  if (best > n / 2) best -= n;
  return best / rate; // positive: b starts later inside a
}

function tcSeconds(tc, fpsv) { if (!tc) return null; const p = tc.split(/[:;]/).map(Number); return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / Math.round(fpsv || 30); }

// Offsets (seconds) to place each item in a common timeline; first item = reference
export async function computeOffsets(items, mode) {
  const out = new Array(items.length).fill(0);
  if (mode === 'none') return out;
  if (mode === 'timecode') {
    const tcs = items.map((i) => tcSeconds(i.info.timecode, i.info.fps));
    if (tcs.some((x) => x == null)) toast('Some clips have no timecode; they start at zero', 'warn');
    const base = Math.min(...tcs.filter((x) => x != null));
    return tcs.map((x) => (x == null ? 0 : x - base));
  }
  if (mode === 'in' || mode === 'out') {
    const pts = items.map((i) => (mode === 'in' ? i.inPoint || 0 : (i.outPoint != null ? i.outPoint : i.info.duration)));
    const ref = Math.max(...pts);
    return pts.map((p) => ref - p);
  }
  if (mode === 'marker') {
    const pts = items.map((i) => (i.markers && i.markers[0] ? i.markers[0].frame / (i.info.fps || 30) : 0));
    const ref = Math.max(...pts);
    return pts.map((p) => ref - p);
  }
  // audio
  const job = jobs.start('Synchronizing clips by audio', 'sync');
  try {
    const ref = items.find((i) => i.info.hasAudio) || items[0];
    const ri = items.indexOf(ref);
    for (let k = 0; k < items.length; k++) {
      jobs.update(job.id, k / items.length);
      if (k === ri) continue;
      if (!items[k].info.hasAudio) continue;
      const off = await audioOffsetBetween(ref, items[k]);
      out[k] = off == null ? 0 : off;
    }
    const min = Math.min(...out);
    return out.map((o) => o - min);
  } finally { jobs.done(job.id); }
}

// ---------- Frame grabbing ----------
async function grabber(path) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; v.src = fileUrl(path);
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('Cannot decode ' + path)); });
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  return {
    v,
    async at(t, w, h) {
      if (Math.abs(v.currentTime - t) > 0.001) await new Promise((r) => { v.onseeked = r; v.currentTime = Math.max(0, Math.min(t, v.duration - 0.01)); setTimeout(r, 3000); });
      c.width = w; c.height = h; ctx.drawImage(v, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    },
    close() { v.removeAttribute('src'); v.load(); },
  };
}

function gray(img) { const g = new Float32Array(img.width * img.height); const d = img.data; for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; return g; }

// ---------- Mask tracking ----------
export async function trackMask(clipId, fxId, maskId, dir = 1, method = 'position') {
  const seq = app.store.seq; const f = findClip(seq, clipId); if (!f) return;
  const clip = f.clip; const item = app.store.project.items[clip.src.itemId];
  if (!item || item.type !== 'media' || !item.info.hasVideo) return toast('Mask tracking works on video clips', 'warn');
  const fx = clip.effects.find((e) => e.id === fxId); const mask = fx && fx.masks.find((m) => m.id === maskId);
  if (!mask) return;
  const fps = seq.settings.fps;
  const startLocal = seq.playhead - clip.start;
  const W = 320, H = Math.max(2, Math.round(320 * (item.info.height || 9) / (item.info.width || 16)));
  const g = await grabber(app.compositor.mediaPath(item, clip));
  const job = jobs.start('Tracking mask', 'track');
  let cancelled = false; job.cancel = () => { cancelled = true; };
  const pts0 = maskAt(mask, startLocal).points;
  let pts = pts0.map((p) => [...p]);
  const bbox = (ps) => { const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const mf = itemFps(item), nf = item.info.fps;
  const timeAt = (local) => clipSourceTime(clip, clip.start + local, fps) * (mf && nf ? mf / nf : 1);
  let prev = gray(await g.at(timeAt(startLocal), W, H));
  const results = [];
  const end = dir > 0 ? clip.dur - 1 : 0;
  let scaleAcc = 1;
  try {
    for (let local = startLocal + dir; dir > 0 ? local <= end : local >= end; local += dir) {
      if (cancelled) break;
      jobs.update(job.id, Math.abs(local - startLocal) / Math.max(1, Math.abs(end - startLocal)));
      const cur = gray(await g.at(timeAt(local), W, H));
      const [x0, y0, x1, y1] = bbox(pts);
      const bx = Math.round(clamp(x0, 0, 1) * W), by = Math.round(clamp(y0, 0, 1) * H);
      const bw = Math.max(6, Math.round((clamp(x1, 0, 1) - clamp(x0, 0, 1)) * W)), bh = Math.max(6, Math.round((clamp(y1, 0, 1) - clamp(y0, 0, 1)) * H));
      const R = Math.max(6, Math.round(Math.max(bw, bh) * 0.35));
      let best = [0, 0], bs = Infinity;
      const stepS = Math.max(1, Math.floor(Math.min(bw, bh) / 24));
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        let sad = 0;
        for (let y = 0; y < bh; y += stepS) {
          const sy = by + y, ty = sy + dy; if (sy < 0 || sy >= H || ty < 0 || ty >= H) { sad += 255 * (bw / stepS); continue; }
          for (let x = 0; x < bw; x += stepS) { const sx = bx + x, tx = sx + dx; if (sx < 0 || sx >= W || tx < 0 || tx >= W) { sad += 255; continue; } sad += Math.abs(prev[sy * W + sx] - cur[ty * W + tx]); }
          if (sad >= bs) break;
        }
        if (sad < bs) { bs = sad; best = [dx, dy]; }
      }
      let sc = 1;
      if (method === 'scale') {
        // test small scale changes around best position
        let bsc = bs;
        for (const s of [0.97, 1.03]) {
          let sad = 0; const cx = bx + bw / 2 + best[0], cy = by + bh / 2 + best[1];
          for (let y = 0; y < bh; y += stepS) for (let x = 0; x < bw; x += stepS) {
            const sx = bx + x, sy = by + y; const tx = Math.round(cx + (x - bw / 2) * s), ty = Math.round(cy + (y - bh / 2) * s);
            if (tx < 0 || ty < 0 || tx >= W || ty >= H || sx >= W || sy >= H) { sad += 255; continue; }
            sad += Math.abs(prev[sy * W + sx] - cur[ty * W + tx]);
          }
          if (sad < bsc) { bsc = sad; sc = s; }
        }
      }
      scaleAcc *= sc;
      pts = transformPoints(pts, best[0] / W, best[1] / H, sc, 0);
      results.push({ t: local, v: pts.map((p) => [...p]) });
      prev = cur;
      if (results.length % 10 === 0) await new Promise((r) => setTimeout(r));
    }
  } finally { jobs.done(job.id); g.close(); }
  app.store.transact('Track Mask', () => {
    const ff = findClip(app.store.seq, clipId); const fx2 = ff.clip.effects.find((e) => e.id === fxId); const m = fx2.masks.find((x) => x.id === maskId);
    m.keyframes.points = m.keyframes.points || [];
    setKey(m.keyframes.points, startLocal, pts0.map((p) => [...p]));
    for (const r of results) setKey(m.keyframes.points, r.t, r.v);
  });
  toast(`Tracked ${results.length} frame(s)`);
}

// ---------- Auto reframe (motion/edge saliency) ----------
export async function analyzeReframe(seq, clip, motion = 'default') {
  const item = app.store.project.items[clip.src.itemId];
  if (!item || item.type !== 'media' || !item.info.hasVideo) return;
  const fps = seq.settings.fps;
  const W = 96, H = Math.max(2, Math.round(96 * item.info.height / item.info.width));
  const g = await grabber(app.compositor.mediaPath(item, clip));
  const step = Math.max(1, Math.round(fps / 4));
  const job = jobs.start(`Auto Reframe: ${clip.name}`, 'reframe');
  const keys = [];
  let prev = null, cx = 0.5, cy = 0.5;
  const smooth = { slow: 0.08, default: 0.2, fast: 0.45 }[motion] || 0.2;
  // keep the subject inside the target crop: crop width fraction in source
  const cropW = Math.min(1, (seq.settings.width / seq.settings.height) / (item.info.width / item.info.height));
  const cropH = Math.min(1, 1 / ((seq.settings.width / seq.settings.height) / (item.info.width / item.info.height)));
  try {
    for (let local = 0; local < clip.dur; local += step) {
      jobs.update(job.id, local / clip.dur);
      const img = await g.at(clipSourceTime(clip, clip.start + local, fps), W, H);
      const gr = gray(img);
      let sx = 0, sy = 0, sw = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const edge = Math.abs(gr[i + 1] - gr[i - 1]) + Math.abs(gr[i + W] - gr[i - W]);
        const mot = prev ? Math.abs(gr[i] - prev[i]) * 3 : 0;
        const center = 1 - Math.hypot(x / W - 0.5, y / H - 0.5) * 0.6;
        const w = (edge * 0.3 + mot) * center;
        sx += x * w; sy += y * w; sw += w;
      }
      const tx = sw ? sx / sw / W : 0.5, ty = sw ? sy / sw / H : 0.5;
      cx += (tx - cx) * smooth; cy += (ty - cy) * smooth;
      const kx = clamp(cx, cropW / 2, 1 - cropW / 2), ky = clamp(cy, cropH / 2, 1 - cropH / 2);
      keys.push({ t: local, v: [kx, ky] });
      prev = gr;
    }
  } finally { jobs.done(job.id); g.close(); }
  app.store.transact('Auto Reframe', () => { const f = findClip(seq, clip.id); if (f) f.clip.reframe = { keys, motion }; }, [seq.id]);
  app.player.invalidate();
}

// ---------- Stabilize ----------
export async function stabilizeClip(clipId) {
  const seq = app.store.seq; const f = findClip(seq, clipId); if (!f) return;
  const clip = f.clip; const item = app.store.project.items[clip.src.itemId];
  const fx = clip.effects.find((e) => e.type === 'warp_stabilizer');
  if (!item || item.type !== 'media' || !fx) return;
  clip.stabilized = { ready: false, analyzing: true };
  app.store.touch('stabilize');
  try {
    await jobs.run(`Stabilizing ${clip.name}`, async (j) => {
      const path = await window.native.call('media:stabilize', item.path, { smoothness: fx.params.smoothness, shakiness: fx.params.shakiness, method: fx.params.method, crop: fx.params.framing === 'keep' ? 'keep' : 'black', zoom: fx.params.framing === 'zoom' ? 'auto' : 0, jobId: j.id });
      const g = findClip(app.store.seq, clipId);
      if (g) { g.clip.stabilized = { path, ready: true, settings: { ...fx.params } }; app.store.markDirty(); }
    }, 'stabilize');
    app.player.invalidate();
    toast('Stabilization finished');
  } catch (e) { clip.stabilized = null; toast('Stabilization failed: ' + e.message, 'error'); }
  app.store.touch('stabilize');
}

// ---------- Frame statistics for color ----------
async function frameStats(clip, seq) {
  const item = app.store.project.items[clip.src.itemId];
  if (!item || item.type !== 'media') return null;
  const t = clipSourceTime(clip, Math.max(clip.start, Math.min(seq.playhead, clip.start + clip.dur - 1)), seq.settings.fps);
  if (item.info.kind === 'image') {
    const img = new Image(); img.src = fileUrl(item.path); await img.decode();
    const c = document.createElement('canvas'); c.width = 160; c.height = 90; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 160, 90);
    return stats(x.getImageData(0, 0, 160, 90));
  }
  const g = await grabber(app.compositor.mediaPath(item, clip));
  const img = await g.at(t, 160, 90); g.close();
  return stats(img);
}

function stats(img) {
  const d = img.data; const n = img.width * img.height;
  const hist = new Uint32Array(256); let r = 0, gg = 0, b = 0;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const R = d[i * 4] / 255, G = d[i * 4 + 1] / 255, B = d[i * 4 + 2] / 255;
    r += R; gg += G; b += B;
    const l = 0.2126 * R + 0.7152 * G + 0.0722 * B; lum[i] = l; hist[Math.min(255, Math.round(l * 255))]++;
  }
  const pct = (p) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= p * n) return i / 255; } return 1; };
  let mean = 0; for (const l of lum) mean += l; mean /= n;
  let sd = 0; for (const l of lum) sd += (l - mean) ** 2; sd = Math.sqrt(sd / n);
  let sat = 0; for (let i = 0; i < n; i++) { const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2]; const mx = Math.max(R, G, B), mn = Math.min(R, G, B); sat += mx ? (mx - mn) / mx : 0; } sat /= n;
  return { r: r / n, g: gg / n, b: b / n, mean, sd, p01: pct(0.01), p99: pct(0.99), sat };
}

export async function autoTone(clipId) {
  const seq = app.store.seq; const f = findClip(seq, clipId); if (!f) return null;
  const s = await frameStats(f.clip, seq); if (!s) return null;
  const temp = clamp(((s.b - s.r) / Math.max(0.05, (s.r + s.b) / 2)) * 60, -60, 60);
  const tint = clamp(((s.r + s.b) / 2 - s.g) / Math.max(0.05, s.g) * 60, -50, 50);
  const exposure = clamp(Math.log2(0.45 / Math.max(0.03, s.mean)) * 0.7, -2.5, 2.5);
  const whites = clamp((0.96 - s.p99) * 220, -60, 80);
  const blacks = clamp((0.03 - s.p01) * 260, -60, 60);
  const contrast = clamp((0.2 - s.sd) * 150, -30, 40);
  return { temperature: +temp.toFixed(1), tint: +tint.toFixed(1), exposure: +exposure.toFixed(2), whites: +whites.toFixed(1), blacks: +blacks.toFixed(1), contrast: +contrast.toFixed(1) };
}

export async function colorMatch(refClipId, refFrame, clipId) {
  const seq = app.store.seq;
  const rf = findClip(seq, refClipId), tf = findClip(seq, clipId);
  if (!rf || !tf) return null;
  const savedHead = seq.playhead;
  seq.playhead = refFrame;
  const a = await frameStats(rf.clip, seq);
  seq.playhead = savedHead;
  const b = await frameStats(tf.clip, seq);
  if (!a || !b) return null;
  const exposure = clamp(Math.log2(Math.max(0.02, a.mean) / Math.max(0.02, b.mean)), -3, 3);
  const temp = clamp(((a.b - a.r) - (b.b - b.r)) * -120, -80, 80);
  const tint = clamp((((a.r + a.b) / 2 - a.g) - ((b.r + b.b) / 2 - b.g)) * 120, -80, 80);
  const contrast = clamp((a.sd - b.sd) * 200, -50, 50);
  const saturation = clamp(100 * (a.sat / Math.max(0.01, b.sat)), 30, 200);
  return { exposure: +exposure.toFixed(2), temperature: +temp.toFixed(1), tint: +tint.toFixed(1), contrast: +contrast.toFixed(1), saturation: +saturation.toFixed(1) };
}

// ---------- Scene edit detection ----------
export async function sceneEditDetection(clipId, opts = {}) {
  const seq = app.store.seq; const f = findClip(seq, clipId); if (!f) return;
  const clip = f.clip; const item = app.store.project.items[clip.src.itemId];
  if (!item || item.type !== 'media' || item.info.kind !== 'video') return toast('Scene detection works on video clips', 'warn');
  const times = await jobs.run(`Detecting scene edits in ${clip.name}`, (j) => window.native.call('media:scenes', item.path, { threshold: opts.threshold || 0.3, jobId: j.id }), 'scenes');
  const fps = seq.settings.fps;
  const cuts = times.map((t) => clip.start + Math.round((t - clip.srcIn) / clip.speed * fps)).filter((x) => x > clip.start && x < clip.start + clip.dur);
  if (!cuts.length) return toast('No scene edits found');
  app.store.transact('Scene Edit Detection', () => {
    if (opts.markers) { for (const c of cuts) clip.markers.push({ id: uid('mk'), frame: c - clip.start, dur: 0, name: 'Scene', comment: '', color: 'cerulean', type: 'comment' }); return; }
    for (const c of cuts) razorAt(seq, c, [f.track, ...allTracks(seq).filter((t) => t.clips.some((x) => x.linkId && x.linkId === clip.linkId && x !== clip))]);
  }, [seq.id]);
  toast(`Found ${cuts.length} scene edit(s)`);
}

// ---------- Auto ducking ----------
export async function autoDuck(opts = {}) {
  const seq = app.store.seq; if (!seq) return;
  const fps = seq.settings.fps;
  const duckDb = opts.amount != null ? opts.amount : -15, fade = Math.round((opts.fade || 0.8) * fps), sens = opts.sensitivity != null ? opts.sensitivity : 6;
  const dialogue = [], music = [];
  for (const t of seq.tracks.audio) for (const c of t.clips) { if (c.audioType === 'dialogue') dialogue.push(c); else if (c.audioType === 'music') music.push(c); }
  if (!dialogue.length || !music.length) return toast('Tag clips as Dialogue and Music in Essential Sound first', 'warn');
  // activity mask per sequence frame
  const end = Math.max(...dialogue.map((c) => c.start + c.dur));
  const active = new Uint8Array(end + 1);
  for (const c of dialogue) {
    const item = app.store.project.items[c.src.itemId]; const buf = await app.audio.ensure(item, c.src.stream || 0);
    if (!buf) continue;
    const thr = Math.pow(10, (-50 + sens * 3) / 20);
    const d = buf.getChannelData(0);
    for (let f = c.start; f < c.start + c.dur; f++) {
      const t = clipSourceTime(c, f, fps); const a = Math.floor(t * buf.sampleRate), b = Math.min(d.length, a + Math.floor(buf.sampleRate / fps));
      let pk = 0; for (let i = a; i < b; i += 8) pk = Math.max(pk, Math.abs(d[i]));
      if (pk > thr) active[f] = 1;
    }
  }
  // close short gaps
  const hold = Math.round(fps * 0.6);
  for (let f = 0, last = -1e9; f <= end; f++) { if (active[f]) { if (f - last < hold) for (let k = last + 1; k < f; k++) active[k] = 1; last = f; } }
  app.store.transact('Auto Duck', () => {
    for (const m of music) {
      const vol = m.effects.find((e) => e.type === 'volume');
      const base = vol.params.level;
      const keys = [];
      let state = 0;
      for (let f = m.start; f < m.start + m.dur; f++) {
        const a = f <= end ? active[f] : 0;
        if (a !== state) {
          const local = f - m.start;
          if (a) { keys.push({ t: Math.max(0, local - fade), v: base, interp: 'linear' }, { t: local, v: base + duckDb, interp: 'linear' }); }
          else { keys.push({ t: local, v: base + duckDb, interp: 'linear' }, { t: local + fade, v: base, interp: 'linear' }); }
          state = a;
        }
      }
      vol.keyframes.level = keys.length ? [{ t: 0, v: base, interp: 'linear' }, ...keys].sort((x, y) => x.t - y.t) : [];
    }
  }, [seq.id]);
  toast('Ducking keyframes added to music clips');
}
