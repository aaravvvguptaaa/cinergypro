// Decoders for timeline sources: pooled <video> elements, images, generated frames.
import { Emitter, fileUrl } from '../core/util.js';

const MAX_VIDEOS = 16;

class VideoSlot {
  constructor(pool, path) {
    this.pool = pool; this.path = path;
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.disableRemotePlayback = true;
    v.src = fileUrl(path);
    this.el = v; this.tex = null; this.owner = null; this.lastUse = 0; this.ready = false; this.error = null;
    this.pending = null; this.target = -1; this.presentedTime = -1; this.dirty = true;
    v.addEventListener('loadeddata', () => { this.ready = true; this.dirty = true; pool.emit('frame'); });
    v.addEventListener('seeked', () => { this.dirty = true; this._resolveSeek(); pool.emit('frame'); });
    v.addEventListener('error', () => { this.error = v.error ? v.error.message || ('code ' + v.error.code) : 'decode error'; pool.emit('error', { path, error: this.error }); this._resolveSeek(); });
    if (v.requestVideoFrameCallback) {
      const cb = (_now, meta) => { this.presentedTime = meta.mediaTime; this.dirty = true; if (!v.paused) pool.emit('frame'); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    }
  }
  _resolveSeek() {
    if (this.pending) { const p = this.pending; this.pending = null; p.resolve(); }
  }
  seek(t) {
    const v = this.el;
    this.target = t;
    if (!this.pending) { let res; const pr = new Promise((r) => { res = r; }); this.pending = { promise: pr, resolve: res }; }
    try { v.currentTime = t; } catch { this._resolveSeek(); }
    const pend = this.pending;
    setTimeout(() => { if (this.pending === pend) this._resolveSeek(); }, 4000);
    return pend.promise;
  }
  destroy() {
    try { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); } catch {}
    if (this.tex) this.pool.gl.deleteTexture(this.tex);
  }
}

export class MediaPool extends Emitter {
  constructor(gl) {
    super();
    this.gl = gl;
    this.slots = [];
    this.images = new Map(); // path -> {img, tex, ready}
    this.generated = new Map();
    this.frameUse = new Set();
    this.waits = [];
    this.offlineTex = null;
    this.unsupported = new Set();
  }

  beginFrame() { this.frameUse.clear(); this.waits = []; }

  _slotFor(path, owner) {
    let s = this.slots.find((x) => x.path === path && x.owner === owner && !this.frameUse.has(x));
    if (!s) s = this.slots.find((x) => x.path === path && !this.frameUse.has(x) && (!x.owner || performance.now() - x.lastUse > 500));
    if (!s) s = this.slots.find((x) => x.path === path && !this.frameUse.has(x));
    if (!s) {
      if (this.slots.length >= MAX_VIDEOS) {
        const victim = this.slots.filter((x) => !this.frameUse.has(x)).sort((a, b) => a.lastUse - b.lastUse)[0];
        if (victim) { victim.destroy(); this.slots.splice(this.slots.indexOf(victim), 1); }
      }
      s = new VideoSlot(this, path);
      this.slots.push(s);
    }
    s.owner = owner; s.lastUse = performance.now();
    this.frameUse.add(s);
    return s;
  }

  /**
   * Get a texture for a video source at time t (seconds of the media file).
   * mode.playing: element plays in real time; otherwise exact seek.
   */
  videoTexture(path, t, owner, mode = {}) {
    const s = this._slotFor(path, owner);
    const v = s.el;
    if (s.error) return { tex: this.offline('Unsupported media'), error: s.error };
    const fps = mode.fps || 30;
    const dur = v.duration || Infinity;
    t = Math.max(0, Math.min(t, (isFinite(dur) ? dur - 0.5 / fps : t)));
    const target = t + 0.2 / fps;
    if (mode.playing && mode.rate > 0 && mode.rate <= 16) {
      if (Math.abs(v.playbackRate - mode.rate) > 0.001) v.playbackRate = mode.rate;
      const drift = Math.abs(v.currentTime - t);
      if (v.paused) { if (drift > 0.5 / fps) s.seek(target); v.play().catch(() => {}); }
      else if (drift > Math.max(0.12, 3 / fps) * Math.max(1, mode.rate)) s.seek(target);
    } else {
      if (!v.paused) v.pause();
      const shown = s.presentedTime >= 0 && !s.pending ? s.presentedTime : v.currentTime;
      if (Math.abs(shown - target) > 0.45 / fps || (s.pending && Math.abs(s.target - target) > 0.45 / fps)) {
        if (!s.pending || Math.abs(s.target - target) > 0.45 / fps) this.waits.push(s.seek(target));
        else this.waits.push(s.pending.promise);
      } else if (s.pending) this.waits.push(s.pending.promise);
      else if (!s.ready) this.waits.push(new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 4000); }));
    }
    if (v.readyState >= 2 && (s.dirty || !s.tex)) {
      try { s.tex = this.gl.upload(s.tex, v); s.dirty = mode.playing; } catch (e) { /* not ready */ }
    }
    return { tex: s.tex, w: v.videoWidth, h: v.videoHeight, slot: s };
  }

  imageTexture(path) {
    let e = this.images.get(path);
    if (!e) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      e = { img, tex: null, ready: false, error: null };
      e.promise = new Promise((res) => {
        img.onload = () => { e.ready = true; try { e.tex = this.gl.upload(null, img); } catch (er) { e.error = String(er); } this.emit('frame'); res(); };
        img.onerror = () => { e.error = 'Cannot load image'; this.emit('error', { path, error: e.error }); res(); };
      });
      img.src = fileUrl(path);
      this.images.set(path, e);
    }
    if (!e.ready) this.waits.push(e.promise);
    if (e.error) return { tex: this.offline('Media Offline'), error: e.error };
    return { tex: e.tex, w: e.img.naturalWidth, h: e.img.naturalHeight };
  }

  canvasTexture(key, w, h, draw) {
    let e = this.generated.get(key);
    if (!e) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      e = { tex: this.gl.upload(null, c), w, h, used: performance.now() };
      this.generated.set(key, e);
      if (this.generated.size > 300) this._gcGenerated();
    }
    e.used = performance.now();
    return e;
  }
  _gcGenerated() {
    const arr = [...this.generated.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of arr.slice(0, arr.length - 200)) { this.gl.deleteTexture(v.tex); this.generated.delete(k); }
  }
  invalidateGenerated(prefix) {
    for (const [k, v] of [...this.generated.entries()]) if (!prefix || k.startsWith(prefix)) { this.gl.deleteTexture(v.tex); this.generated.delete(k); }
  }

  offline(text = 'Media Offline') {
    return this.canvasTexture('offline:' + text, 640, 360, (ctx, w, h) => {
      ctx.fillStyle = '#5a0f14'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff'; ctx.font = '600 34px Inter, -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2);
    }).tex;
  }

  barsTexture(w, h) {
    return this.canvasTexture(`bars:${w}x${h}`, w, h, (ctx) => {
      const top = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      const bw = w / 7;
      top.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.floor(i * bw), 0, Math.ceil(bw), h * 0.67); });
      const mid = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
      mid.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.floor(i * bw), h * 0.67, Math.ceil(bw), h * 0.08); });
      const bot = [['#00214c', 1.25], ['#ffffff', 1.25], ['#32006a', 1.25], ['#131313', 1.25], ['#090909', 0.33], ['#131313', 0.34], ['#1d1d1d', 0.33], ['#131313', 1]];
      let x = 0; for (const [c, f] of bot) { ctx.fillStyle = c; ctx.fillRect(Math.floor(x), h * 0.75, Math.ceil(bw * f), h * 0.25); x += bw * f; }
    }).tex;
  }

  countdownTexture(w, h, sec, frac) {
    const n = Math.max(0, 8 - sec);
    const key = `count:${w}x${h}:${n}:${Math.floor(frac * 24)}`;
    return this.canvasTexture(key, w, h, (ctx) => {
      ctx.fillStyle = '#1a1c22'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#8f96a3'; ctx.lineWidth = h * 0.006;
      ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.36, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(47,124,255,0.35)';
      ctx.beginPath(); ctx.moveTo(w / 2, h / 2); ctx.arc(w / 2, h / 2, h * 0.36, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#e8ecf3'; ctx.font = `700 ${Math.round(h * 0.42)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(n > 1 ? String(n) : '', w / 2, h / 2 + h * 0.02);
    }).tex;
  }

  async waitAll() {
    const w = this.waits; this.waits = [];
    if (w.length) await Promise.all(w);
    return w.length;
  }

  pauseAll() { for (const s of this.slots) if (!s.el.paused) s.el.pause(); }

  dropPath(path) {
    for (const s of [...this.slots]) if (s.path === path) { s.destroy(); this.slots.splice(this.slots.indexOf(s), 1); }
    const im = this.images.get(path); if (im) { if (im.tex) this.gl.deleteTexture(im.tex); this.images.delete(path); }
  }

  gc() {
    const now = performance.now();
    for (const s of [...this.slots]) if (now - s.lastUse > 20000) { s.destroy(); this.slots.splice(this.slots.indexOf(s), 1); }
  }

  // Probe whether Chromium can decode a file (used to decide on playback proxies)
  static canPlay(path) {
    return new Promise((resolve) => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
      let done = false;
      const fin = (ok, why) => { if (done) return; done = true; v.removeAttribute('src'); v.load(); resolve({ ok, why, w: v.videoWidth, h: v.videoHeight }); };
      v.onloadeddata = () => fin(v.videoWidth > 0, v.videoWidth > 0 ? null : 'no video frames');
      v.onerror = () => fin(false, v.error ? v.error.message || 'code ' + v.error.code : 'error');
      setTimeout(() => fin(false, 'timeout'), 8000);
      v.src = fileUrl(path);
    });
  }
}
