// AudioWorklet processors used by CinergyPro audio effects.
const dbToGain = (db) => Math.pow(10, db / 20);

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: -45 }, { name: 'attack', defaultValue: 2 }, { name: 'hold', defaultValue: 50 }, { name: 'release', defaultValue: 150 }, { name: 'floor', defaultValue: -80 }]; }
  constructor() { super(); this.env = 0; this.gain = 0; this.holdCount = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const thr = dbToGain(p.threshold[0]), floor = dbToGain(p.floor[0]);
    const att = Math.exp(-1 / (sampleRate * Math.max(0.0001, p.attack[0] / 1000)));
    const rel = Math.exp(-1 / (sampleRate * Math.max(0.0001, p.release[0] / 1000)));
    const holdS = p.hold[0] / 1000 * sampleRate;
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0; for (let c = 0; c < inp.length; c++) peak = Math.max(peak, Math.abs(inp[c][i]));
      this.env = Math.max(peak, this.env * 0.9995);
      let target;
      if (this.env > thr) { target = 1; this.holdCount = holdS; } else if (this.holdCount > 0) { target = 1; this.holdCount--; } else target = floor;
      const coef = target > this.gain ? att : rel;
      this.gain = target + (this.gain - target) * coef;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain;
    }
    return true;
  }
}

// Split-band de-esser: detects sibilance energy above `freq` and ducks the high band.
class DeEsserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'freq', defaultValue: 6500 }, { name: 'threshold', defaultValue: -30 }, { name: 'amount', defaultValue: 6 }]; }
  constructor() { super(); this.z = []; this.env = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const f = p.freq[0]; const a = Math.exp(-2 * Math.PI * f / sampleRate);
    const thr = dbToGain(p.threshold[0]); const maxRed = dbToGain(-p.amount[0]);
    for (let c = 0; c < inp.length; c++) if (this.z[c] == null) this.z[c] = 0;
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let hiPeak = 0;
      const lows = [], highs = [];
      for (let c = 0; c < inp.length; c++) {
        const x = inp[c][i];
        this.z[c] = (1 - a) * x + a * this.z[c];
        const lo = this.z[c], hi = x - lo;
        lows.push(lo); highs.push(hi); hiPeak = Math.max(hiPeak, Math.abs(hi));
      }
      this.env = Math.max(hiPeak, this.env * 0.999);
      const g = this.env > thr ? Math.max(maxRed, thr / this.env) : 1;
      for (let c = 0; c < out.length; c++) { const k = Math.min(c, lows.length - 1); out[c][i] = lows[k] + highs[k] * g; }
    }
    return true;
  }
}

// Downward expander + spectral-tilt hiss reduction (single-band, low latency).
class DenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'amount', defaultValue: 40 }, { name: 'floor', defaultValue: -50 }]; }
  constructor() { super(); this.env = 0; this.lp = []; this.g = 1; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const amt = p.amount[0] / 100; const floor = dbToGain(p.floor[0]);
    const n = inp[0].length;
    const a = Math.exp(-2 * Math.PI * (9000 - amt * 5000) / sampleRate);
    for (let c = 0; c < inp.length; c++) if (this.lp[c] == null) this.lp[c] = 0;
    for (let i = 0; i < n; i++) {
      let pk = 0; for (let c = 0; c < inp.length; c++) pk = Math.max(pk, Math.abs(inp[c][i]));
      this.env = pk > this.env ? pk : this.env * 0.9993;
      const ratio = this.env < floor * 4 ? Math.pow(Math.max(this.env, 1e-6) / (floor * 4), amt * 1.5) : 1;
      this.g = this.g * 0.995 + Math.min(1, ratio) * 0.005;
      for (let c = 0; c < out.length; c++) {
        const k = Math.min(c, inp.length - 1); const x = inp[k][i];
        this.lp[k] = (1 - a) * x + a * this.lp[k];
        const quiet = 1 - Math.min(1, this.env / (floor * 8));
        const y = x * (1 - quiet * amt) + this.lp[k] * quiet * amt;
        out[c][i] = y * this.g;
      }
    }
    return true;
  }
}

class DeclickProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'sensitivity', defaultValue: 50 }]; }
  constructor() { super(); this.prev = []; this.prev2 = []; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const thr = 0.02 + (1 - p.sensitivity[0] / 100) * 0.3;
    for (let c = 0; c < out.length; c++) {
      const x = inp[Math.min(c, inp.length - 1)], y = out[c];
      let a = this.prev[c] || 0, b = this.prev2[c] || 0;
      for (let i = 0; i < x.length; i++) {
        const pred = 2 * a - b;
        const v = Math.abs(x[i] - pred) > thr && Math.abs(x[i]) > thr ? (a + (x[i + 1] !== undefined ? x[i + 1] : a)) / 2 : x[i];
        y[i] = v; b = a; a = v;
      }
      this.prev[c] = a; this.prev2[c] = b;
    }
    return true;
  }
}

// Granular pitch shifter (two overlapping read heads with crossfade)
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1 }]; }
  constructor() { super(); this.size = 4096; this.buf = [new Float32Array(this.size), new Float32Array(this.size)]; this.w = 0; this.r = 0; this.win = 2048; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const ratio = p.ratio[0];
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) this.buf[c][this.w] = (inp[c] || inp[0])[i];
      this.r += ratio; if (this.r >= this.win) this.r -= this.win;
      const r1 = this.r, r2 = (this.r + this.win / 2) % this.win;
      const g1 = Math.sin(Math.PI * r1 / this.win), g2 = Math.sin(Math.PI * r2 / this.win);
      for (let c = 0; c < out.length; c++) {
        const b = this.buf[Math.min(c, 1)];
        const i1 = (this.w - this.win + Math.floor(r1) + this.size) % this.size;
        const i2 = (this.w - this.win + Math.floor(r2) + this.size) % this.size;
        out[c][i] = b[i1] * g1 * g1 + b[i2] * g2 * g2;
      }
      this.w = (this.w + 1) % this.size;
    }
    return true;
  }
}

// Brick-wall lookahead limiter
class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ceiling', defaultValue: -0.3 }, { name: 'input', defaultValue: 0 }, { name: 'release', defaultValue: 80 }]; }
  constructor() { super(); this.look = 64; this.dl = [new Float32Array(this.look), new Float32Array(this.look)]; this.i = 0; this.g = 1; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const ceil = dbToGain(p.ceiling[0]), ig = dbToGain(p.input[0]);
    const rel = Math.exp(-1 / (sampleRate * p.release[0] / 1000));
    const n = inp[0].length;
    for (let s = 0; s < n; s++) {
      let pk = 0;
      for (let c = 0; c < 2; c++) { const x = (inp[c] || inp[0])[s] * ig; pk = Math.max(pk, Math.abs(x)); }
      const target = pk > ceil ? ceil / pk : 1;
      this.g = target < this.g ? target : target + (this.g - target) * rel;
      for (let c = 0; c < out.length; c++) {
        const d = this.dl[Math.min(c, 1)];
        const delayed = d[this.i];
        d[this.i] = (inp[c] || inp[0])[s] * ig;
        out[c][s] = Math.max(-ceil, Math.min(ceil, delayed * this.g));
      }
      this.i = (this.i + 1) % this.look;
    }
    return true;
  }
}

// Loudness tap: K-weighted mean square accumulator posting momentary/short-term LUFS
class LoudnessProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.count = 0; this.blocks = []; this.st = []; this.integ = []; this.port.onmessage = (e) => { if (e.data === 'reset') { this.integ = []; this.blocks = []; this.st = []; } }; this.posted = 0; this.peak = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (inp.length) {
      for (let c = 0; c < Math.min(2, inp.length); c++) { const x = inp[c]; for (let i = 0; i < x.length; i++) { this.sum += x[i] * x[i]; this.peak = Math.max(this.peak, Math.abs(x[i])); } }
      this.count += inp[0].length;
    }
    if (this.count >= sampleRate * 0.1) {
      const ms = this.sum / this.count; this.sum = 0; this.count = 0;
      this.blocks.push(ms); if (this.blocks.length > 4) this.blocks.shift();
      this.st.push(ms); if (this.st.length > 30) this.st.shift();
      const m = this.blocks.reduce((a, b) => a + b, 0) / this.blocks.length;
      const s = this.st.reduce((a, b) => a + b, 0) / this.st.length;
      const lufs = (v) => -0.691 + 10 * Math.log10(Math.max(v, 1e-10));
      if (lufs(m) > -70) this.integ.push(m);
      const rel = this.integ.length ? lufs(this.integ.reduce((a, b) => a + b, 0) / this.integ.length) - 10 : -70;
      const gated = this.integ.filter((v) => lufs(v) > rel);
      const I = gated.length ? lufs(gated.reduce((a, b) => a + b, 0) / gated.length) : -70;
      this.port.postMessage({ momentary: lufs(m), shortTerm: lufs(s), integrated: I, peak: 20 * Math.log10(Math.max(this.peak, 1e-6)) });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('cp-gate', GateProcessor);
registerProcessor('cp-deesser', DeEsserProcessor);
registerProcessor('cp-denoise', DenoiseProcessor);
registerProcessor('cp-declick', DeclickProcessor);
registerProcessor('cp-pitch', PitchProcessor);
registerProcessor('cp-limiter', LimiterProcessor);
registerProcessor('cp-loudness', LoudnessProcessor);
