// Playback controller for the Program and Source monitors.
import { Emitter, clamp } from '../core/util.js';
import { seqDuration, itemDuration, createTrack, createClip, itemHasAudio } from '../core/project.js';
import { app } from '../app-context.js';

export class Player extends Emitter {
  constructor(gl, compositor, pool, audio) {
    super();
    this.gl = gl; this.comp = compositor; this.pool = pool; this.audio = audio;
    this.canvas = gl.canvas;
    this.targets = { program: null, source: null }; // {draw(glCanvas, sx, sy, w, h), size(): [w,h], visible()}
    this.extra = new Set(); // extra program consumers (popouts, multicam grid)
    this.state = {
      program: { playing: false, rate: 1, startFrame: 0, startTime: 0, loop: false, inOut: false, aroundEnd: null },
      source: { playing: false, rate: 1, startTime: 0, startPos: 0, loop: false, time: 0 },
    };
    this.dirty = { program: true, source: true };
    this.quality = { program: 'full', source: 'full', pausedProgram: 'full', highQuality: false };
    this.scopeConsumers = new Set();
    this.lastScope = 0;
    this.rendering = false;
    this.frameTimes = [];
    this.droppedFrames = 0;
    pool.on('frame', () => { if (!this.state.program.playing) this.dirty.program = true; if (!this.state.source.playing) this.dirty.source = true; });
    compositor.on('invalidate', () => this.invalidate());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  get seq() { return app.store.seq; }
  get sourceItem() { return app.store.sourceItemId ? app.store.project.items[app.store.sourceItemId] : null; }

  invalidate(which) { if (!which || which === 'program') this.dirty.program = true; if (!which || which === 'source') this.dirty.source = true; }

  // ---------- program transport ----------
  get frame() { const s = this.seq; return s ? s.playhead : 0; }

  seek(frame, opts = {}) {
    const s = this.seq; if (!s) return;
    frame = Math.max(0, Math.round(frame));
    if (s.playhead === frame && !opts.force) return;
    s.playhead = frame;
    if (this.state.program.playing) this.restartProgram();
    else if (opts.scrub && app.prefs.get('playback.audioScrub')) this.audio.scrub(s, frame);
    this.dirty.program = true;
    this.emit('playhead', frame);
  }

  play(rate = 1, opts = {}) {
    const s = this.seq; if (!s) return;
    if (this.state.source.playing) this.stopSource();
    const st = this.state.program;
    st.playing = true; st.rate = rate; st.inOut = !!opts.inOut; st.aroundEnd = opts.until != null ? opts.until : null;
    if (opts.inOut && s.inPoint != null) s.playhead = s.inPoint;
    if (rate > 0 && s.playhead >= seqDuration(s) - 1 && !opts.inOut) s.playhead = 0;
    this.restartProgram();
    app.native && window.native.call('app:prevent-sleep', true).catch(() => {});
    this.emit('state');
  }

  restartProgram() {
    const s = this.seq; const st = this.state.program;
    st.startFrame = s.playhead; st.startTime = performance.now();
    this.audio.stop();
    if (st.rate > 0 && st.rate <= 8) {
      const to = st.inOut && s.outPoint != null ? s.outPoint + 1 : (st.aroundEnd != null ? st.aroundEnd : undefined);
      this.audio.play(s, s.playhead, st.rate, { toFrame: to }).catch((e) => console.warn(e));
    }
  }

  pause() {
    const st = this.state.program;
    if (!st.playing) return;
    st.playing = false; st.rate = 1;
    this.audio.stop();
    this.pool.pauseAll();
    if (this.seq) this.seq.playhead = Math.round(this.seq.playhead);
    this.dirty.program = true;
    window.native.call('app:prevent-sleep', false).catch(() => {});
    this.emit('state');
    this.emit('playhead', this.frame);
  }

  toggle() { if (this.state.program.playing) this.pause(); else this.play(1); }

  shuttle(dir) {
    const st = this.state.program;
    if (!st.playing) { this.play(dir); return; }
    if (Math.sign(st.rate) !== dir) { this.play(dir); return; }
    const next = Math.min(8, Math.abs(st.rate) * 2) * dir;
    this.play(next);
  }

  step(n) { this.pause(); this.seek(this.frame + n); }

  // ---------- source transport ----------
  get sourceTime() { return this.state.source.time; }
  sourceDuration() { const it = this.sourceItem; if (!it) return 0; const d = itemDuration(app.store.project, it); return isFinite(d) ? d : (it.duration || app.prefs.get('timeline.stillDuration') || 5); }
  sourceFps() { const it = this.sourceItem; if (!it) return 30; if (it.type === 'sequence') return it.settings.fps; return (it.interpret && it.interpret.fps) || (it.info && it.info.fps) || (this.seq ? this.seq.settings.fps : 30); }

  seekSource(t, opts = {}) {
    const dur = this.sourceDuration();
    this.state.source.time = clamp(t, 0, Math.max(0, dur - 1 / this.sourceFps()));
    if (this.state.source.playing) this.restartSource();
    else if (opts.scrub && app.prefs.get('playback.audioScrub')) { const fs = this.sourceSeq(); if (fs) this.audio.scrub(fs, Math.round(this.state.source.time * fs.settings.fps)); }
    this.dirty.source = true;
    this.emit('source-time', this.state.source.time);
  }

  sourceSeq() {
    const it = this.sourceItem; if (!it) return null;
    if (it.type === 'sequence') return it;
    if (!itemHasAudio(it)) return null;
    const fps = this.sourceFps();
    if (this._srcSeq && this._srcSeq.__item === it.id && this._srcSeq.settings.fps === fps) return this._srcSeq;
    const seq = { id: 'srcseq', type: 'sequence', settings: { width: 1920, height: 1080, fps, sampleRate: 48000 }, tracks: { video: [], audio: [createTrack('audio', 0)] }, master: { volume: 0, effects: [], keyframes: { volume: [] } }, buses: [], markers: [], captionTracks: [] };
    const dur = Math.round(this.sourceDuration() * fps);
    seq.tracks.audio[0].clips.push(createClip('audio', { type: it.type === 'media' ? 'media' : 'synthetic', itemId: it.id, stream: 0 }, 0, dur, 0));
    seq.__item = it.id;
    this._srcSeq = seq;
    return seq;
  }

  playSource(rate = 1) {
    if (!this.sourceItem) return;
    if (this.state.program.playing) this.pause();
    const st = this.state.source;
    st.playing = true; st.rate = rate;
    if (rate > 0 && st.time >= this.sourceDuration() - 1 / this.sourceFps()) st.time = 0;
    this.restartSource();
    this.emit('state');
  }
  restartSource() {
    const st = this.state.source;
    st.startTime = performance.now(); st.startPos = st.time;
    this.audio.stop();
    const fs = this.sourceSeq();
    if (fs && st.rate > 0 && st.rate <= 8) this.audio.play(fs, Math.round(st.time * fs.settings.fps), st.rate).catch(() => {});
  }
  stopSource() {
    const st = this.state.source; if (!st.playing) return;
    st.playing = false; this.audio.stop(); this.pool.pauseAll(); this.dirty.source = true; this.emit('state');
  }
  toggleSource() { if (this.state.source.playing) this.stopSource(); else this.playSource(1); }
  shuttleSource(dir) { const st = this.state.source; if (!st.playing || Math.sign(st.rate) !== dir) this.playSource(dir); else this.playSource(Math.min(8, Math.abs(st.rate) * 2) * dir); }

  // ---------- render loop ----------
  previewScale(which) {
    const s = which === 'program' ? this.seq : null;
    const playing = which === 'program' ? this.state.program.playing : this.state.source.playing;
    const res = playing ? (app.prefs.get('playback.resolution') || 'full') : (app.prefs.get('playback.pausedResolution') || 'full');
    let f = { full: 1, '1/2': 0.5, '1/4': 0.25, '1/8': 0.125, '1/16': 0.0625 }[res] || 1;
    // never render bigger than the display needs (unless high quality)
    const t = this.targets[which];
    if (t && s && !app.prefs.get('playback.highQuality')) {
      const [w, h] = t.size();
      const need = Math.max(w / s.settings.width, h / s.settings.height) * (window.devicePixelRatio || 1);
      f = Math.min(f, Math.max(0.125, need));
    }
    return f;
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    try { this.tick(now); } catch (e) { console.error('render loop', e); }
  }

  tick(now) {
    const ps = this.state.program, ss = this.state.source;
    const seq = this.seq;
    if (ps.playing && seq) {
      let f = this.audio.playing && ps.rate > 0 && ps.rate <= 8 ? this.audio.currentFrame() : null;
      if (f == null) f = ps.startFrame + (now - ps.startTime) / 1000 * seq.settings.fps * ps.rate;
      const end = seqDuration(seq);
      const outP = ps.inOut && seq.outPoint != null ? seq.outPoint : (ps.aroundEnd != null ? ps.aroundEnd : end - 1);
      const inP = ps.inOut && seq.inPoint != null ? seq.inPoint : 0;
      if (ps.rate > 0 && f > outP) {
        if (ps.loop || app.prefs.get('playback.loop')) { seq.playhead = inP; this.restartProgram(); f = inP; }
        else { seq.playhead = Math.max(0, Math.min(outP, end)); this.pause(); return; }
      } else if (ps.rate < 0 && f <= 0) { seq.playhead = 0; this.pause(); return; }
      const fr = Math.floor(f);
      if (fr !== seq.playhead) { seq.playhead = fr; this.emit('playhead', fr); }
      this.renderProgram(true);
    } else if (this.dirty.program && seq) {
      this.dirty.program = false;
      this.renderProgram(false);
    }
    if (ss.playing && this.sourceItem) {
      const fs = this.audio.playing && ss.rate > 0 ? this.audio.currentFrame() : null;
      let t = fs != null && this._srcSeq ? fs / this._srcSeq.settings.fps : ss.startPos + (now - ss.startTime) / 1000 * ss.rate;
      const it = this.sourceItem;
      const dur = this.sourceDuration();
      const outT = it.outPoint != null ? it.outPoint : dur;
      if (ss.rate > 0 && t >= outT) { if (ss.loop || app.prefs.get('playback.loop')) { ss.time = it.inPoint || 0; this.restartSource(); t = ss.time; } else { ss.time = Math.max(0, outT - 1 / this.sourceFps()); this.stopSource(); return; } }
      if (t < 0) { ss.time = 0; this.stopSource(); return; }
      ss.time = t;
      this.emit('source-time', t);
      this.renderSource(true);
    } else if (this.dirty.source && this.sourceItem) {
      this.dirty.source = false;
      this.renderSource(false);
    }
    if (now - (this._gcAt || 0) > 4000) { this._gcAt = now; this.gl.gc(); this.pool.gc(); }
  }

  ensureCanvas(w, h) {
    const c = this.canvas;
    if (c.width < w || c.height < h) { c.width = Math.max(c.width, Math.ceil(w)); c.height = Math.max(c.height, Math.ceil(h)); }
  }

  presentTo(target, fbo, extraOverlay) {
    if (!target) return;
    const [w, h] = target.size();
    if (w < 2 || h < 2) return;
    this.ensureCanvas(w, h);
    this.comp.present(fbo, [0, 0, w, h]);
    target.draw(this.canvas, 0, this.canvas.height - h, w, h);
  }

  renderProgram(playing) {
    const seq = this.seq; if (!seq) return;
    const gl = this.gl;
    const t0 = performance.now();
    this.pool.beginFrame();
    gl.time = seq.playhead / seq.settings.fps; gl.frame = seq.playhead;
    const scale = this.previewScale('program');
    const ps = this.state.program;
    const fbo = this.comp.renderSequence(seq, seq.playhead, { scale, playing, rate: ps.rate, captions: app.program ? app.program.showCaptions !== false : true });
    const fin = this.comp.finalize(fbo, { checker: app.program && app.program.transparencyGrid });
    const tgt = this.targets.program;
    if (tgt && tgt.visible()) this.presentTo(tgt, fin);
    for (const x of this.extra) { try { x(fin, this); } catch (e) { console.error(e); } }
    if (this.scopeConsumers.size && (!playing || performance.now() - this.lastScope > 120)) {
      this.lastScope = performance.now();
      const sw = 384, sh = Math.max(2, Math.round(384 * fin.h / fin.w));
      const small = gl.acquire(sw, sh, { bytes: true });
      gl.pass('copy', 'uniform sampler2D uTex; void main(){ fragColor = texture(uTex, vUv); }', small, { uTex: fin });
      const data = gl.read(small); gl.release(small);
      for (const c of this.scopeConsumers) c(data, sw, sh);
    }
    gl.release(fbo); gl.release(fin);
    gl.releaseAll();
    const dt = performance.now() - t0;
    this.frameTimes.push(dt); if (this.frameTimes.length > 60) this.frameTimes.shift();
    if (!playing) this.awaitSources('program');
    this.emit('rendered', { which: 'program', ms: dt });
  }

  renderSource(playing) {
    const it = this.sourceItem; if (!it) return;
    const tgt = this.targets.source;
    if (!tgt || !tgt.visible()) return;
    const gl = this.gl;
    this.pool.beginFrame();
    const [w] = tgt.size();
    const nativeW = it.type === 'sequence' ? it.settings.width : (it.info && it.info.width) || it.width || 1920;
    const scale = Math.min(1, Math.max(0.125, (w * (window.devicePixelRatio || 1)) / nativeW));
    const fbo = this.comp.renderSource(it, this.state.source.time, { scale, playing, rate: this.state.source.rate });
    const fin = this.comp.finalize(fbo, { checker: app.source && app.source.transparencyGrid });
    this.presentTo(tgt, fin);
    gl.release(fbo); gl.release(fin); gl.releaseAll();
    if (!playing) this.awaitSources('source');
  }

  awaitSources(which) {
    const waits = this.pool.waits.length;
    if (!waits) return;
    const token = (this._tok = (this._tok || 0) + 1);
    this.pool.waitAll().then(() => { if (token === this._tok || true) { this.dirty[which] = true; } });
  }

  // Exact render for export / stills: waits for all sources, returns RGBA bytes (bottom-up)
  async renderExact(seq, frame, opts = {}) {
    const gl = this.gl;
    let tries = 0, fin = null, fbo = null;
    gl.time = frame / seq.settings.fps; gl.frame = frame;
    while (true) {
      this.pool.beginFrame();
      fbo = this.comp.renderSequence(seq, frame, { scale: opts.scale || 1, playing: false, captions: !!opts.captions, ownerSuffix: ':x' });
      const pending = this.pool.waits.length;
      if (!pending || tries >= 4) break;
      gl.release(fbo); gl.releaseAll();
      await this.pool.waitAll();
      tries++;
    }
    fin = opts.alpha ? fbo : this.comp.finalize(fbo, { background: opts.background || [0, 0, 0] });
    const bytes = this.comp.toBytes(fin);
    const w = fin.w, h = fin.h;
    gl.release(fbo); if (fin !== fbo) gl.release(fin); gl.releaseAll();
    return { bytes, w, h };
  }

  fps() { const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length); return avg; }
}
