// Web Audio node graphs for each audio effect.
import { dbToGain } from '../core/util.js';

function impulse(ctx, seconds, decay, damping, room) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const early = { small: 0.01, room: 0.02, hall: 0.035, plate: 0.005, cathedral: 0.06 }[room] || 0.02;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0; const a = Math.exp(-2 * Math.PI * damping / sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.pow(1 - i / len, decay) * (t < early ? t / early : 1);
      const n = (Math.random() * 2 - 1);
      lp = (1 - a) * n + a * lp;
      d[i] = lp * env * (room === 'plate' ? 1.2 : 1);
    }
  }
  return buf;
}

const passthrough = (ctx) => { const g = ctx.createGain(); return { input: g, output: g, update() {} }; };

export function buildAudioEffect(ctx, type, p, opts = {}) {
  const worklet = (name, params) => {
    try { const n = new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }); for (const [k, v] of Object.entries(params)) if (n.parameters.get(k)) n.parameters.get(k).value = v; return n; } catch (e) { return null; }
  };
  switch (type) {
    case 'parametric_eq': {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      const ls = ctx.createBiquadFilter(); ls.type = 'lowshelf';
      const b1 = ctx.createBiquadFilter(); b1.type = 'peaking';
      const b2 = ctx.createBiquadFilter(); b2.type = 'peaking';
      const b3 = ctx.createBiquadFilter(); b3.type = 'peaking';
      const hs = ctx.createBiquadFilter(); hs.type = 'highshelf';
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      const out = ctx.createGain();
      hp.connect(ls).connect(b1).connect(b2).connect(b3).connect(hs).connect(lp).connect(out);
      const update = (q) => {
        hp.frequency.value = q.hpOn ? q.hpFreq : 1; hp.Q.value = 0.707;
        ls.frequency.value = q.lsFreq; ls.gain.value = q.lsGain;
        b1.frequency.value = q.p1Freq; b1.gain.value = q.p1Gain; b1.Q.value = q.p1Q;
        b2.frequency.value = q.p2Freq; b2.gain.value = q.p2Gain; b2.Q.value = q.p2Q;
        b3.frequency.value = q.p3Freq; b3.gain.value = q.p3Gain; b3.Q.value = q.p3Q;
        hs.frequency.value = q.hsFreq; hs.gain.value = q.hsGain;
        lp.frequency.value = q.lpOn ? q.lpFreq : Math.min(22000, ctx.sampleRate / 2 - 1);
        out.gain.value = dbToGain(q.output);
      };
      update(p);
      return { input: hp, output: out, update, nodes: { hp, ls, b1, b2, b3, hs, lp } };
    }
    case 'graphic_eq': {
      const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
      const filters = freqs.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === freqs.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.4; return b; });
      const out = ctx.createGain();
      filters.reduce((a, b) => (a.connect(b), b)).connect(out);
      const update = (q) => { freqs.forEach((f, i) => { filters[i].gain.value = q['g' + f] || 0; }); out.gain.value = dbToGain(q.output); };
      update(p);
      return { input: filters[0], output: out, update };
    }
    case 'highpass': case 'lowpass': case 'bandpass': case 'notch': {
      const f = ctx.createBiquadFilter(); f.type = type;
      const update = (q) => { f.frequency.value = q.freq; if (q.q != null) f.Q.value = q.q; };
      update(p);
      return { input: f, output: f, update };
    }
    case 'dehum': {
      const filters = Array.from({ length: 8 }, () => { const b = ctx.createBiquadFilter(); b.type = 'notch'; return b; });
      filters.reduce((a, b) => (a.connect(b), b));
      const update = (q) => filters.forEach((b, i) => { b.frequency.value = i < q.harmonics ? parseInt(q.freq, 10) * (i + 1) : 20000; b.Q.value = i < q.harmonics ? q.q : 0.0001; });
      update(p);
      return { input: filters[0], output: filters[7], update };
    }
    case 'bass': case 'treble': {
      const f = ctx.createBiquadFilter(); f.type = type === 'bass' ? 'lowshelf' : 'highshelf'; f.frequency.value = type === 'bass' ? 200 : 3500;
      const update = (q) => { f.gain.value = q.boost; };
      update(p);
      return { input: f, output: f, update };
    }
    case 'compressor': {
      const c = ctx.createDynamicsCompressor(); const g = ctx.createGain(); c.connect(g);
      const update = (q) => { c.threshold.value = q.threshold; c.ratio.value = q.ratio; c.attack.value = q.attack / 1000; c.release.value = q.release / 1000; c.knee.value = q.knee; g.gain.value = dbToGain(q.makeup); };
      update(p);
      return { input: c, output: g, update, compressor: c };
    }
    case 'limiter': {
      const n = worklet('cp-limiter', { ceiling: p.ceiling, input: p.inputBoost, release: p.release });
      if (!n) return passthrough(ctx);
      return { input: n, output: n, update: (q) => { n.parameters.get('ceiling').value = q.ceiling; n.parameters.get('input').value = q.inputBoost; n.parameters.get('release').value = q.release; } };
    }
    case 'gate': {
      const n = worklet('cp-gate', p);
      if (!n) return passthrough(ctx);
      return { input: n, output: n, update: (q) => { for (const k of ['threshold', 'attack', 'hold', 'release', 'floor']) n.parameters.get(k).value = q[k]; } };
    }
    case 'deesser': {
      const n = worklet('cp-deesser', p);
      if (!n) return passthrough(ctx);
      return { input: n, output: n, update: (q) => { for (const k of ['freq', 'threshold', 'amount']) n.parameters.get(k).value = q[k]; } };
    }
    case 'audio_denoise': {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70;
      const n = worklet('cp-denoise', p);
      if (!n) return { input: hp, output: hp, update() {} };
      hp.connect(n);
      return { input: hp, output: n, update: (q) => { n.parameters.get('amount').value = q.amount; n.parameters.get('floor').value = q.floor; } };
    }
    case 'declick': {
      const n = worklet('cp-declick', p);
      if (!n) return passthrough(ctx);
      return { input: n, output: n, update: (q) => { n.parameters.get('sensitivity').value = q.sensitivity; } };
    }
    case 'pitch_shift': {
      const n = worklet('cp-pitch', { ratio: Math.pow(2, (p.semitones + p.cents / 100) / 12) });
      if (!n) return passthrough(ctx);
      return { input: n, output: n, update: (q) => { n.parameters.get('ratio').value = Math.pow(2, (q.semitones + q.cents / 100) / 12); } };
    }
    case 'distortion': {
      const inp = ctx.createGain(), ws = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), wet = ctx.createGain(), dry = ctx.createGain(), out = ctx.createGain();
      tone.type = 'lowpass'; ws.oversample = '4x';
      inp.connect(ws).connect(tone).connect(wet).connect(out); inp.connect(dry).connect(out);
      const update = (q) => {
        const k = q.amount * 2, n = 2048, curve = new Float32Array(n);
        for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; curve[i] = (1 + k / 10) * x / (1 + (k / 10) * Math.abs(x)); }
        ws.curve = curve; tone.frequency.value = q.tone; wet.gain.value = q.mix / 100; dry.gain.value = 1 - q.mix / 100;
      };
      update(p);
      return { input: inp, output: out, update };
    }
    case 'reverb': {
      const inp = ctx.createGain(), pre = ctx.createDelay(1), conv = ctx.createConvolver(), wet = ctx.createGain(), dry = ctx.createGain(), out = ctx.createGain();
      inp.connect(pre).connect(conv).connect(wet).connect(out); inp.connect(dry).connect(out);
      let last = '';
      const update = (q) => {
        const key = [q.room, q.decay, q.damping].join('|');
        if (key !== last) { conv.buffer = impulse(ctx, Math.min(12, q.decay), 2.5, q.damping, q.room); last = key; }
        pre.delayTime.value = q.predelay / 1000; wet.gain.value = q.mix / 100 * 1.5; dry.gain.value = q.dry / 100;
      };
      update(p);
      return { input: inp, output: out, update };
    }
    case 'delay': {
      const inp = ctx.createGain(), d = ctx.createDelay(2.5), fb = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain();
      inp.connect(out); inp.connect(d); d.connect(fb).connect(d); d.connect(wet).connect(out);
      const update = (q) => { d.delayTime.value = q.time / 1000; fb.gain.value = q.feedback / 100; wet.gain.value = q.mix / 100; };
      update(p);
      return { input: inp, output: out, update };
    }
    case 'echo': {
      const inp = ctx.createGain(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), dl = ctx.createDelay(2.5), dr = ctx.createDelay(2.5), fbl = ctx.createGain(), fbr = ctx.createGain(), tone = ctx.createBiquadFilter(), wet = ctx.createGain(), out = ctx.createGain();
      tone.type = 'lowpass';
      inp.connect(out); inp.connect(split);
      split.connect(dl, 0); split.connect(dr, 1);
      dl.connect(fbl).connect(dr); dr.connect(fbr).connect(dl);
      dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
      merge.connect(tone).connect(wet).connect(out);
      const update = (q) => { dl.delayTime.value = q.left / 1000; dr.delayTime.value = q.right / 1000; fbl.gain.value = fbr.gain.value = q.feedback / 100; tone.frequency.value = q.tone; wet.gain.value = q.mix / 100; };
      update(p);
      return { input: inp, output: out, update };
    }
    case 'chorus': {
      const inp = ctx.createGain(), d = ctx.createDelay(0.1), lfo = ctx.createOscillator(), depth = ctx.createGain(), fb = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain(), out = ctx.createGain();
      lfo.connect(depth).connect(d.delayTime); lfo.start();
      inp.connect(dry).connect(out); inp.connect(d); d.connect(fb).connect(d); d.connect(wet).connect(out);
      const update = (q) => {
        const base = q.mode === 'flanger' ? 0.003 : 0.018;
        d.delayTime.value = base; depth.gain.value = base * q.depth / 100 * 0.9; lfo.frequency.value = q.rate; fb.gain.value = q.feedback / 100 * (q.mode === 'flanger' ? 0.9 : 0.4);
        wet.gain.value = q.mix / 100; dry.gain.value = 1 - q.mix / 200;
      };
      update(p);
      return { input: inp, output: out, update, oscillators: [lfo] };
    }
    case 'stereo_expander': {
      const inp = ctx.createGain(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const ll = ctx.createGain(), lr = ctx.createGain(), rl = ctx.createGain(), rr = ctx.createGain();
      inp.connect(split);
      split.connect(ll, 0); split.connect(lr, 0); split.connect(rl, 1); split.connect(rr, 1);
      ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
      const update = (q) => {
        const w = q.width / 100; // M/S: L' = M + wS, R' = M - wS
        const a = (1 + w) / 2, b = (1 - w) / 2;
        const pan = q.center / 100;
        ll.gain.value = a * (1 - Math.max(0, pan)); rl.gain.value = b * (1 - Math.max(0, pan));
        lr.gain.value = b * (1 + Math.min(0, pan)); rr.gain.value = a * (1 + Math.min(0, pan));
      };
      update(p);
      return { input: inp, output: merge, update };
    }
    case 'channel_tools': {
      const inp = ctx.createGain(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const ll = ctx.createGain(), lr = ctx.createGain(), rl = ctx.createGain(), rr = ctx.createGain();
      inp.connect(split);
      split.connect(ll, 0); split.connect(lr, 0); split.connect(rl, 1); split.connect(rr, 1);
      ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
      const update = (q) => {
        const m = { none: [1, 0, 0, 1], swap: [0, 1, 1, 0], fillLeft: [0, 0, 1, 1], fillRight: [1, 1, 0, 0], mono: [0.5, 0.5, 0.5, 0.5], invertL: [-1, 0, 0, 1], invertR: [1, 0, 0, -1] }[q.mode] || [1, 0, 0, 1];
        ll.gain.value = m[0]; lr.gain.value = m[1]; rl.gain.value = m[2]; rr.gain.value = m[3];
      };
      update(p);
      return { input: inp, output: merge, update };
    }
    case 'dialogue_clarity': {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9;
      const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 10000;
      const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1.2;
      const comp = ctx.createDynamicsCompressor(); const mk = ctx.createGain();
      hp.connect(mud).connect(pres).connect(air).connect(comp).connect(mk);
      const update = (q) => {
        hp.frequency.value = 40 + q.rumble * 1.2; mud.gain.value = -q.rumble * 0.04; pres.gain.value = q.presence * 0.08; air.gain.value = q.air * 0.06;
        comp.threshold.value = -12 - q.leveling * 0.3; comp.ratio.value = 1 + q.leveling * 0.05; comp.attack.value = 0.008; comp.release.value = 0.15; mk.gain.value = dbToGain(q.leveling * 0.08);
      };
      update(p);
      return { input: hp, output: mk, update };
    }
    case 'loudness_radar': return passthrough(ctx);
    default: return passthrough(ctx);
  }
}
