// Audio engine: decoding, waveform peaks, real-time mixing graph, offline mixdown,
// meters, loudness and voice-over recording.
import { Emitter, dbToGain, fileUrl, uid } from '../core/util.js';
import { clipSourceTime, itemFps, nativeFps } from '../core/project.js';
import { evaluate, resolveParams } from '../core/keyframes.js';
import { buildAudioEffect } from './audio-effects.js';
import { AUDIO_TRANSITIONS } from '../core/effect-defs.js';

const SR = 48000;

export class AudioEngine extends Emitter {
  constructor(getProject) {
    super();
    this.getProject = getProject;
    this.ctx = null;
    this.buffers = new Map();
    this.peaks = new Map();
    this.session = null;
    this.workletUrl = new URL('./worklets.js', import.meta.url).href;
    this.loudness = { momentary: -70, shortTerm: -70, integrated: -70, peak: -96 };
    this.masterMute = false;
    this.recorder = null;
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
    try { await this.ctx.audioWorklet.addModule(this.workletUrl); } catch (e) { console.warn('Worklets unavailable', e); }
  }
  async resume() { if (this.ctx && this.ctx.state !== 'running') try { await this.ctx.resume(); } catch {} }

  get project() { return this.getProject(); }

  // ---------- decoding ----------
  key(path, stream, variant) { return `${path}|${stream || 0}|${variant ? JSON.stringify(variant) : ''}`; }

  bufferFor(item, stream = 0, variant = null) {
    if (!item || item.type !== 'media' || item.offline || !item.info.hasAudio) return null;
    const path = item.path;
    const k = this.key(path, stream, variant);
    let e = this.buffers.get(k);
    if (e) return e.buffer;
    e = { buffer: null, promise: null };
    this.buffers.set(k, e);
    e.promise = (async () => {
      try {
        const opts = { stream, jobId: 'aud_' + uid() };
        if (variant && variant.tempo) opts.tempo = variant.tempo;
        if (variant && variant.reverse) opts.reverse = true;
        const wav = await window.native.call('media:decode-audio', path, opts);
        const ab = await (await fetch(fileUrl(wav))).arrayBuffer();
        await this.init();
        e.buffer = await this.ctx.decodeAudioData(ab);
        if (!variant) this.computePeaks(k, e.buffer);
        this.emit('loaded', { item, stream, variant });
      } catch (err) { e.error = String(err); console.warn('Audio decode failed', path, err); }
      return e.buffer;
    })();
    return null;
  }

  async ensure(item, stream = 0, variant = null) {
    this.bufferFor(item, stream, variant);
    const e = this.buffers.get(this.key(item.path, stream, variant));
    if (e && e.promise) await e.promise;
    return e ? e.buffer : null;
  }

  computePeaks(k, buf) {
    const win = 256; const n = Math.ceil(buf.length / win);
    const out = new Float32Array(n * 2);
    const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      let mn = 1, mx = -1;
      const a = i * win, b = Math.min(buf.length, a + win);
      for (let c = 0; c < chs.length; c++) { const d = chs[c]; for (let j = a; j < b; j += 2) { const v = d[j]; if (v < mn) mn = v; if (v > mx) mx = v; } }
      out[i * 2] = mn; out[i * 2 + 1] = mx;
    }
    this.peaks.set(k, { data: out, rate: buf.sampleRate / win, duration: buf.duration });
  }

  peaksFor(item, stream = 0) {
    if (!item || item.type !== 'media') return null;
    const k = this.key(item.path, stream, null);
    if (!this.peaks.has(k)) this.bufferFor(item, stream);
    return this.peaks.get(k) || null;
  }

  toneBuffer(ctx) {
    if (this._tone && this._tone.sampleRate === ctx.sampleRate) return this._tone;
    const b = ctx.createBuffer(2, ctx.sampleRate, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * 1000 * i / ctx.sampleRate) * 0.1; }
    this._tone = b; return b;
  }

  // Collect and preload all buffers needed for a sequence range
  async preload(seq, from = 0, to = Infinity, depth = 0) {
    const promises = [];
    const fps = seq.settings.fps;
    for (const t of seq.tracks.audio) for (const c of t.clips) {
      if (c.start + c.dur <= from || c.start >= to) continue;
      const item = this.project.items[c.src.itemId];
      if (!item) continue;
      if (item.type === 'sequence' && depth < 8) {
        const a = Math.max(0, Math.floor(clipSourceTime(c, Math.max(from, c.start), fps) * item.settings.fps));
        promises.push(this.preload(item, a, a + Math.ceil((Math.min(to, c.start + c.dur) - Math.max(from, c.start)) / fps * Math.abs(c.speed) * item.settings.fps) + 2, depth + 1));
      } else if (item.type === 'media') {
        promises.push(this.ensure(item, c.src.stream || 0));
        if (c.reverse) promises.push(this.ensure(item, c.src.stream || 0, { reverse: true }));
        if (c.maintainPitch && Math.abs(c.speed - 1) > 0.001) promises.push(this.ensure(item, c.src.stream || 0, { tempo: +c.speed.toFixed(4) }));
      }
    }
    await Promise.all(promises);
  }

  // ---------- graph ----------
  buildMaster(ctx, seq, dest, when, from, rate, live) {
    const input = ctx.createGain();
    let node = input;
    const fxNodes = [];
    for (const fx of seq.master.effects || []) {
      if (!fx.enabled) continue;
      const e = buildAudioEffect(ctx, fx.type, resolveParams(fx, 0));
      node.connect(e.input); node = e.output; fxNodes.push({ fx, e });
    }
    const fader = ctx.createGain();
    this.automate(ctx, fader.gain, seq.master.keyframes && seq.master.keyframes.volume, seq.master.volume, from, when, rate, seq.settings.fps, dbToGain);
    const mute = ctx.createGain(); mute.gain.value = this.masterMute || seq.master.mute ? 0 : 1;
    node.connect(fader).connect(mute);
    const split = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(), aR = ctx.createAnalyser(); aL.fftSize = aR.fftSize = 2048;
    mute.connect(split); split.connect(aL, 0); split.connect(aR, 1);
    mute.connect(dest);
    if (live && ctx instanceof AudioContext) {
      try {
        const kw1 = ctx.createBiquadFilter(); kw1.type = 'highshelf'; kw1.frequency.value = 1681; kw1.gain.value = 4;
        const kw2 = ctx.createBiquadFilter(); kw2.type = 'highpass'; kw2.frequency.value = 38; kw2.Q.value = 0.5;
        const loud = new AudioWorkletNode(ctx, 'cp-loudness', { numberOfInputs: 1, numberOfOutputs: 0 });
        loud.port.onmessage = (e) => { this.loudness = e.data; };
        mute.connect(kw1).connect(kw2).connect(loud);
        live.loudnessNode = loud;
      } catch {}
    }
    if (live) live.master = { input, fader, mute, analysers: [aL, aR], fxNodes };
    return input;
  }

  automate(ctx, param, keys, base, from, when, rate, fps, map = (v) => v, extraScale = 1) {
    param.cancelScheduledValues(0);
    if (!keys || !keys.length) { param.setValueAtTime(map(base) * extraScale, when); return; }
    const first = Math.max(from, 0);
    param.setValueAtTime(map(evaluate(keys, first, base)) * extraScale, when);
    const last = keys[keys.length - 1].t;
    const step = Math.max(1, Math.round(fps / 30));
    for (let f = first + step; f <= last + step; f += step) {
      const t = when + (f - from) / fps / rate;
      param.linearRampToValueAtTime(map(evaluate(keys, f, base)) * extraScale, t);
    }
  }

  soloState(seq) { return seq.tracks.audio.some((t) => t.solo); }

  /**
   * Build a mix graph for seq frames [from, to) starting at context time `when`.
   * dest: node to connect the sequence output into.
   */
  buildSequence(ctx, seq, from, to, when, rate, dest, live = null, depth = 0) {
    const fps = seq.settings.fps;
    const anySolo = this.soloState(seq);
    const busInputs = new Map();
    for (const bus of seq.buses || []) {
      const g = ctx.createGain(); g.gain.value = bus.mute ? 0 : dbToGain(bus.volume || 0);
      const pan = ctx.createStereoPanner(); pan.pan.value = (bus.pan || 0) / 100;
      let n = g; for (const fx of bus.effects || []) { if (!fx.enabled) continue; const e = buildAudioEffect(ctx, fx.type, resolveParams(fx, 0)); n.connect(e.input); n = e.output; }
      n.connect(pan).connect(dest);
      busInputs.set(bus.id, g);
      if (live) live.buses.set(bus.id, { gain: g, pan });
    }
    const sources = [];
    for (const track of seq.tracks.audio) {
      const muted = track.muted || (anySolo && !track.solo);
      const tin = ctx.createGain();
      if (track.audio.channelType === 'mono') { tin.channelCount = 1; tin.channelCountMode = 'explicit'; tin.channelInterpretation = 'speakers'; }
      let n = tin;
      const tfx = [];
      for (const fx of track.audio.effects || []) { if (!fx.enabled) continue; const e = buildAudioEffect(ctx, fx.type, resolveParams(fx, 0)); n.connect(e.input); n = e.output; tfx.push({ fx, e }); }
      const pan = ctx.createStereoPanner();
      this.automate(ctx, pan.pan, track.audio.keyframes && track.audio.keyframes.pan, track.audio.pan || 0, from, when, rate, fps, (v) => v / 100);
      const fader = ctx.createGain();
      this.automate(ctx, fader.gain, track.audio.automation !== 'off' ? track.audio.keyframes && track.audio.keyframes.volume : null, track.audio.volume || 0, from, when, rate, fps, dbToGain);
      const mute = ctx.createGain(); mute.gain.value = muted ? 0 : 1;
      const meter = ctx.createAnalyser(); meter.fftSize = 1024;
      n.connect(pan).connect(fader).connect(mute);
      mute.connect(meter);
      mute.connect(track.audio.route && busInputs.get(track.audio.route) || dest);
      if (live && depth === 0) live.tracks.set(track.id, { input: tin, pan, fader, mute, meter, fx: tfx });
      // clips
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        const cs = clip.start, ce = clip.start + clip.dur;
        if (ce <= from || cs >= to) continue;
        const s = this.scheduleClip(ctx, seq, track, clip, from, to, when, rate, tin, live, depth);
        if (s) sources.push(...s);
      }
    }
    return sources;
  }

  scheduleClip(ctx, seq, track, clip, from, to, when, rate, dest, live, depth) {
    const fps = seq.settings.fps;
    const project = this.project;
    const item = project.items[clip.src.itemId];
    if (!item) return null;
    if (clip.frameHold != null || clip.timeRemap) return null;
    const a = Math.max(from, clip.start), b = Math.min(to, clip.start + clip.dur);
    if (b <= a) return null;
    const startAt = when + (a - from) / fps / rate;
    const local = a - clip.start;
    // clip chain: gain(volume) -> fades -> channel volume -> panner -> effects -> dest
    const vol = clip.effects.find((e) => e.type === 'volume');
    const chv = clip.effects.find((e) => e.type === 'channel_volume');
    const pnr = clip.effects.find((e) => e.type === 'panner');
    const g = ctx.createGain();
    const clipGain = dbToGain(clip.gain || 0);
    if (vol && vol.enabled && !vol.params.bypass) {
      // keyframes are in clip-local frames; shift to sequence frames
      const keys = (vol.keyframes.level || []).map((k) => ({ ...k, t: k.t + clip.start }));
      this.automate(ctx, g.gain, keys.length ? keys : null, vol.params.level, a, startAt, rate, fps, dbToGain, clipGain);
    } else g.gain.value = clipGain;
    const fade = ctx.createGain();
    this.scheduleFades(ctx, fade.gain, seq, track, clip, a, startAt, rate);
    let n = g; g.connect(fade); n = fade;
    if (chv && chv.enabled && (chv.params.left || chv.params.right)) {
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), gl = ctx.createGain(), gr = ctx.createGain();
      gl.gain.value = dbToGain(chv.params.left); gr.gain.value = dbToGain(chv.params.right);
      n.connect(sp); sp.connect(gl, 0); sp.connect(gr, 1); gl.connect(mg, 0, 0); gr.connect(mg, 0, 1); n = mg;
    }
    if (pnr && pnr.enabled) {
      const p = ctx.createStereoPanner();
      const keys = (pnr.keyframes.balance || []).map((k) => ({ ...k, t: k.t + clip.start }));
      this.automate(ctx, p.pan, keys.length ? keys : null, pnr.params.balance, a, startAt, rate, fps, (v) => v / 100);
      n.connect(p); n = p;
    }
    const cfx = [];
    for (const fx of clip.effects) {
      if (!fx.enabled || ['volume', 'channel_volume', 'panner'].includes(fx.type)) continue;
      const e = buildAudioEffect(ctx, fx.type, resolveParams(fx, local));
      n.connect(e.input); n = e.output; cfx.push({ fx, e });
    }
    n.connect(dest);
    if (live) live.clips.set(clip.id, { gain: g, fx: cfx });

    const durSeq = (b - a) / fps; // sequence seconds
    if (item.type === 'sequence') {
      if (depth > 8) return null;
      const nf = item.settings.fps;
      const nFrom = Math.floor(clipSourceTime(clip, a, fps) * nf);
      const nTo = nFrom + Math.ceil(durSeq * clip.speed * nf);
      return this.buildSequence(ctx, item, nFrom, nTo, startAt, rate * clip.speed, g, null, depth + 1);
    }
    if (item.type === 'synthetic') {
      if (item.generator !== 'bars' && item.generator !== 'countdown') return null;
      const src = ctx.createBufferSource(); src.buffer = this.toneBuffer(ctx); src.loop = item.generator === 'bars';
      src.connect(g);
      if (item.generator === 'countdown') {
        // single beep at the "2"
        const beepAt = clip.start + fps * 6;
        if (beepAt >= a && beepAt < b) { src.start(when + (beepAt - from) / fps / rate); src.stop(when + (beepAt - from) / fps / rate + 1 / 30); } else return null;
      } else { src.start(startAt); src.stop(startAt + durSeq / rate); }
      return [src];
    }
    if (item.type !== 'media' || !item.info.hasAudio) return null;
    const stream = clip.src.stream || 0;
    const mf = itemFps(item) || 0, nfps = nativeFps(item) || 0;
    const interp = mf && nfps ? mf / nfps : 1;
    let srcT = clipSourceTime(clip, a, fps) * interp; // media seconds
    let playRate = rate * clip.speed * interp;
    let buffer = this.bufferFor(item, stream);
    let offset = srcT;
    if (clip.reverse) {
      const rb = this.bufferFor(item, stream, { reverse: true });
      if (!rb) return null;
      buffer = rb; offset = Math.max(0, rb.duration - srcT);
    } else if (clip.maintainPitch && Math.abs(clip.speed - 1) > 0.001) {
      const tb = this.bufferFor(item, stream, { tempo: +clip.speed.toFixed(4) });
      if (tb) { buffer = tb; offset = srcT / clip.speed; playRate = rate * interp; }
    }
    if (!buffer) return null;
    if (offset >= buffer.duration) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = playRate;
    src.connect(g);
    const consumed = durSeq * playRate / rate;
    src.start(Math.max(ctx.currentTime, startAt), Math.max(0, offset), Math.max(0.001, consumed));
    return [src];
  }

  scheduleFades(ctx, param, seq, track, clip, a, startAt, rate) {
    const fps = seq.settings.fps;
    param.setValueAtTime(1, 0);
    for (const tr of track.transitions) {
      if (!AUDIO_TRANSITIONS[tr.type]) continue;
      const isOut = tr.clipA === clip.id, isIn = tr.clipB === clip.id;
      if (!isOut && !isIn) continue;
      const n = 32; const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1); const p = isIn ? x : 1 - x;
        curve[i] = tr.type === 'constant_gain' ? p : tr.type === 'exponential' ? p * p : Math.sin(p * Math.PI / 2);
      }
      const t0 = startAt + (tr.start - a) / fps / rate, d = tr.dur / fps / rate;
      if (t0 + d <= ctx.currentTime) continue;
      if (t0 >= ctx.currentTime || ctx instanceof OfflineAudioContext) {
        try { param.setValueCurveAtTime(curve, Math.max(t0, 0), d); } catch {}
      } else {
        const p = (ctx.currentTime - t0) / d; const v = curve[Math.min(n - 1, Math.floor(p * n))];
        param.setValueAtTime(v, ctx.currentTime);
        try { param.setValueCurveAtTime(curve.slice(Math.floor(p * n)), ctx.currentTime + 0.001, d * (1 - p)); } catch {}
      }
    }
  }

  // ---------- playback ----------
  async play(seq, fromFrame, rate = 1, opts = {}) {
    await this.init(); await this.resume();
    this.stop();
    if (rate <= 0) return;
    const ctx = this.ctx;
    const fps = seq.settings.fps;
    const to = opts.toFrame || Infinity;
    const when = ctx.currentTime + 0.06;
    const live = { tracks: new Map(), clips: new Map(), buses: new Map(), master: null };
    const out = ctx.createGain();
    out.connect(ctx.destination);
    const master = this.buildMaster(ctx, seq, out, when, fromFrame, rate, live);
    const sources = this.buildSequence(ctx, seq, fromFrame, to, when, rate, master, live);
    this.session = { seq, from: fromFrame, when, rate, fps, sources, live, out, to };
    this.emit('play');
  }

  stop() {
    const s = this.session;
    if (!s) return;
    for (const src of s.sources) { try { src.stop(); } catch {} try { src.disconnect(); } catch {} }
    try { s.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01); setTimeout(() => { try { s.out.disconnect(); } catch {} }, 100); } catch {}
    if (s.live && s.live.loudnessNode) try { s.live.loudnessNode.disconnect(); } catch {}
    this.session = null;
  }

  get playing() { return !!this.session; }

  // Current playhead (fractional frame) from the audio clock
  currentFrame() {
    const s = this.session;
    if (!s) return null;
    return s.from + Math.max(0, this.ctx.currentTime - s.when) * s.fps * s.rate;
  }

  // Apply mute/solo/fader without rebuilding
  liveUpdate(seq) {
    const s = this.session;
    if (!s || s.seq !== seq) return;
    const anySolo = this.soloState(seq);
    for (const t of seq.tracks.audio) {
      const n = s.live.tracks.get(t.id); if (!n) continue;
      n.mute.gain.setTargetAtTime(t.muted || (anySolo && !t.solo) ? 0 : 1, this.ctx.currentTime, 0.01);
      if (!t.audio.keyframes.volume.length || t.audio.automation === 'off') n.fader.gain.setTargetAtTime(dbToGain(t.audio.volume), this.ctx.currentTime, 0.02);
      if (!t.audio.keyframes.pan.length) n.pan.pan.setTargetAtTime(t.audio.pan / 100, this.ctx.currentTime, 0.02);
      for (const { fx, e } of n.fx) e.update(resolveParams(fx, 0));
    }
    if (s.live.master) {
      s.live.master.mute.gain.value = this.masterMute || seq.master.mute ? 0 : 1;
      if (!seq.master.keyframes.volume.length) s.live.master.fader.gain.setTargetAtTime(dbToGain(seq.master.volume), this.ctx.currentTime, 0.02);
      for (const { fx, e } of s.live.master.fxNodes) e.update(resolveParams(fx, 0));
    }
    for (const bus of seq.buses || []) { const b = s.live.buses.get(bus.id); if (b) { b.gain.gain.value = bus.mute ? 0 : dbToGain(bus.volume); b.pan.pan.value = bus.pan / 100; } }
  }

  updateClipEffects(clip) {
    const s = this.session; if (!s) return;
    const c = s.live.clips.get(clip.id); if (!c) return;
    for (const { fx, e } of c.fx) { const cur = clip.effects.find((x) => x.id === fx.id); if (cur) e.update(resolveParams(cur, 0)); }
  }

  meters() {
    const s = this.session;
    const out = { tracks: {}, master: [-96, -96] };
    if (!s) return out;
    const buf = new Float32Array(1024);
    const level = (an) => { an.getFloatTimeDomainData(buf); let pk = 0, sum = 0; for (let i = 0; i < an.fftSize && i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; sum += v * v; } return { peak: 20 * Math.log10(Math.max(pk, 1e-6)), rms: 10 * Math.log10(Math.max(sum / Math.min(an.fftSize, buf.length), 1e-12)) }; };
    for (const [id, n] of s.live.tracks) out.tracks[id] = level(n.meter);
    if (s.live.master) out.master = s.live.master.analysers.map((a) => level(a).peak);
    return out;
  }

  async scrub(seq, frame) {
    if (this.session) return;
    await this.init(); await this.resume();
    const ctx = this.ctx;
    const fps = seq.settings.fps;
    const len = Math.max(2, Math.round(fps * 0.08));
    const when = ctx.currentTime + 0.01;
    const out = ctx.createGain(); out.connect(ctx.destination);
    out.gain.setValueAtTime(1, when); out.gain.linearRampToValueAtTime(0, when + len / fps);
    const master = this.buildMaster(ctx, seq, out, when, frame, 1, null);
    const srcs = this.buildSequence(ctx, seq, frame, frame + len, when, 1, master, null);
    setTimeout(() => { for (const s of srcs) try { s.stop(); } catch {} try { out.disconnect(); } catch {} }, 300);
  }

  // ---------- offline ----------
  async renderOffline(seq, from, to, opts = {}) {
    await this.init();
    await this.preload(seq, from, to);
    const fps = seq.settings.fps;
    const sr = opts.sampleRate || SR;
    const channels = opts.channels || 2;
    const length = Math.max(1, Math.ceil((to - from) / fps * sr));
    const ctx = new OfflineAudioContext(channels, length, sr);
    try { await ctx.audioWorklet.addModule(this.workletUrl); } catch {}
    const master = this.buildMaster(ctx, seq, ctx.destination, 0, from, 1, null);
    this.buildSequence(ctx, seq, from, to, 0, 1, master, null);
    return ctx.startRendering();
  }

  // Render a single item's audio region (for clip loudness/normalize)
  static toWav(buffer, bits = 32) {
    const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length;
    const bps = bits / 8;
    const dataLen = n * ch * bps;
    const ab = new ArrayBuffer(44 + dataLen);
    const v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * bps, true); v.setUint16(32, ch * bps, true); v.setUint16(34, bits, true); w(36, 'data'); v.setUint32(40, dataLen, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      const s = chans[c][i];
      if (bits === 32) { v.setFloat32(o, s, true); o += 4; }
      else { v.setInt16(o, Math.max(-1, Math.min(1, s)) * 0x7fff, true); o += 2; }
    }
    return ab;
  }

  static measure(buffer) {
    // EBU R128 integrated loudness (approximate K-weighting via biquads applied in JS)
    const sr = buffer.sampleRate;
    const kw = (x) => {
      const out = new Float32Array(x.length);
      // pre-filter (high shelf) and RLB (high-pass) coefficients for 48k
      const s1 = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
      const s2 = [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621];
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, w1 = 0, w2 = 0;
      for (let i = 0; i < x.length; i++) {
        const y = s1[0] * x[i] + s1[1] * x1 + s1[2] * x2 - s1[3] * y1 - s1[4] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
        const w = s2[0] * y + s2[1] * z1 + s2[2] * z2 - s2[3] * w1 - s2[4] * w2; z2 = z1; z1 = y; w2 = w1; w1 = w;
        out[i] = w;
      }
      return out;
    };
    const chans = []; for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(kw(buffer.getChannelData(c)));
    const block = Math.round(sr * 0.4), hop = Math.round(sr * 0.1);
    const ms = [];
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
    for (let s = 0; s + block <= buffer.length; s += hop) {
      let sum = 0; for (const d of chans) for (let i = s; i < s + block; i++) sum += d[i] * d[i];
      ms.push(sum / block);
    }
    const L = (v) => -0.691 + 10 * Math.log10(Math.max(v, 1e-12));
    const abs = ms.filter((v) => L(v) > -70);
    if (!abs.length) return { integrated: -70, peak: 20 * Math.log10(Math.max(peak, 1e-6)) };
    const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((v) => L(v) > rel);
    return { integrated: L(gated.reduce((a, b) => a + b, 0) / gated.length), peak: 20 * Math.log10(Math.max(peak, 1e-6)) };
  }

  // ---------- recording ----------
  async listDevices() {
    try { const d = await navigator.mediaDevices.enumerateDevices(); return { inputs: d.filter((x) => x.kind === 'audioinput'), outputs: d.filter((x) => x.kind === 'audiooutput') }; } catch { return { inputs: [], outputs: [] }; }
  }
  async setOutputDevice(id) { await this.init(); if (this.ctx.setSinkId) try { await this.ctx.setSinkId(id === 'default' ? '' : id); } catch (e) { console.warn(e); } }

  async startRecording(deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1 } });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 256000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    await this.init();
    const srcNode = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser(); an.fftSize = 1024; srcNode.connect(an);
    rec.start(250);
    this.recorder = { rec, stream, chunks, analyser: an, startedAt: performance.now() };
    return this.recorder;
  }
  async stopRecording(outPath) {
    const r = this.recorder; if (!r) return null;
    await new Promise((res) => { r.rec.onstop = res; r.rec.stop(); });
    r.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(r.chunks, { type: r.rec.mimeType });
    const buf = await blob.arrayBuffer();
    await window.native.call('fs:write-binary', outPath, buf);
    this.recorder = null;
    return outPath;
  }
  inputLevel() {
    const r = this.recorder; if (!r) return -96;
    const b = new Float32Array(1024); r.analyser.getFloatTimeDomainData(b);
    let pk = 0; for (const v of b) pk = Math.max(pk, Math.abs(v));
    return 20 * Math.log10(Math.max(pk, 1e-6));
  }
}
