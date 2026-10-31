// Keyframe evaluation with linear, hold, bezier (influence-based) temporal easing
// and optional Catmull-Rom spatial interpolation for 2D values.
import { clamp } from './util.js';

export const INTERP = ['linear', 'bezier', 'autobezier', 'hold', 'easeIn', 'easeOut', 'easeInOut'];

function cubicBezierY(x, x1, y1, x2, y2) {
  // Solve bezier(t).x = x via Newton, return y.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const xt = ((ax * t + bx) * t + cx) * t - x;
    const dx = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(xt) < 1e-6) break;
    if (Math.abs(dx) < 1e-6) break;
    t -= xt / dx;
  }
  t = clamp(t, 0, 1);
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  return ((ay * t + by) * t + cy) * t;
}

function outInfluence(k) {
  if (k.interp === 'easeOut' || k.interp === 'easeInOut' || k.interp === 'bezier') return k.outInf != null ? k.outInf : 0.33;
  return 0;
}
function inInfluence(k) {
  if (k.interp === 'easeIn' || k.interp === 'easeInOut' || k.interp === 'bezier') return k.inInf != null ? k.inInf : 0.33;
  return 0;
}

function easeT(a, b, u) {
  const o = outInfluence(a), i = inInfluence(b);
  if (!o && !i) return u;
  return cubicBezierY(u, o, o ? 0 : o, 1 - i, i ? 1 : 1);
}

function lerpVal(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => (typeof v === 'number' ? v + ((b[i] ?? v) - v) * t : (t < 1 ? v : b[i])));
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    // e.g. mask paths {points:[...]} or curve objects; interpolate numeric leaves
    const out = Array.isArray(a) ? [] : {};
    for (const k of Object.keys(a)) out[k] = k in b ? lerpVal(a[k], b[k], t) : a[k];
    return out;
  }
  return t < 1 ? a : b;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return p1.map((_, i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3));
}

// keys: sorted [{t, v, interp, spatial}]; t in clip-local frames
export function evaluate(keys, t, fallback) {
  if (!keys || !keys.length) return fallback;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  // binary search
  let lo = 0, hi = keys.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
  i = lo;
  const a = keys[i], b = keys[i + 1];
  if (a.interp === 'hold') return a.v;
  const u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  const e = easeT(a, b, u);
  if (Array.isArray(a.v) && a.v.length === 2 && a.spatial === 'bezier' && keys.length > 2) {
    const p0 = (keys[i - 1] || a).v, p3 = (keys[i + 2] || b).v;
    return catmull(p0, a.v, b.v, p3, e);
  }
  return lerpVal(a.v, b.v, e);
}

export function setKey(keys, t, v, interp = 'linear') {
  const idx = keys.findIndex((k) => Math.abs(k.t - t) < 0.5);
  if (idx >= 0) { keys[idx].v = v; return keys[idx]; }
  const k = { t, v, interp };
  keys.push(k);
  keys.sort((x, y) => x.t - y.t);
  return k;
}

export function removeKey(keys, t) {
  const idx = keys.findIndex((k) => Math.abs(k.t - t) < 0.5);
  if (idx >= 0) keys.splice(idx, 1);
  return idx >= 0;
}

export function prevKeyTime(keys, t) { let r = null; for (const k of keys) if (k.t < t - 0.5) r = k.t; return r; }
export function nextKeyTime(keys, t) { for (const k of keys) if (k.t > t + 0.5) return k.t; return null; }

// Param value at clip-local frame t.
export function paramValue(effect, name, t) {
  const kf = effect.keyframes && effect.keyframes[name];
  if (kf && kf.length) return evaluate(kf, t, effect.params[name]);
  return effect.params[name];
}

export function resolveParams(effect, t) {
  const out = {};
  for (const k of Object.keys(effect.params)) out[k] = paramValue(effect, k, t);
  return out;
}

export function hasKeys(effect, name) { return !!(effect.keyframes && effect.keyframes[name] && effect.keyframes[name].length); }

// Sample a curve for the speed graph / value graph display
export function sampleCurve(keys, t0, t1, n = 100) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * (i / n); const v = evaluate(keys, t, 0); out.push([t, typeof v === 'number' ? v : (Array.isArray(v) ? v[0] : 0)]); }
  return out;
}

// Time remap: keys map clip-local frame -> source seconds. Speed = derivative.
export function remapTime(keys, t) { return evaluate(keys, t, 0); }
