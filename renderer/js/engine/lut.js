// LUT parsing (.cube / .3dl), built-in creative looks, and curve textures for Lumetri.
import { clamp } from '../core/util.js';

export function parseCube(text) {
  let size = 0; const data = []; let domainMin = [0, 0, 0], domainMax = [1, 1, 1]; let is1D = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (/^TITLE/i.test(line)) continue;
    if (/^LUT_3D_SIZE/i.test(line)) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (/^LUT_1D_SIZE/i.test(line)) { size = parseInt(line.split(/\s+/)[1], 10); is1D = true; continue; }
    if (/^DOMAIN_MIN/i.test(line)) { domainMin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^DOMAIN_MAX/i.test(line)) { domainMax = line.split(/\s+/).slice(1).map(Number); continue; }
    const nums = line.split(/\s+/).map(Number);
    if (nums.length >= 3 && nums.every((n) => !Number.isNaN(n))) data.push(nums[0], nums[1], nums[2]);
  }
  if (!size) throw new Error('Not a valid .cube LUT');
  if (is1D) {
    // expand 1D to 3D 33^3
    const n = 33; const out = new Float32Array(n * n * n * 3);
    const look = (v, ch) => { const x = clamp((v - domainMin[ch]) / (domainMax[ch] - domainMin[ch]), 0, 1) * (size - 1); const i = Math.floor(x), f = x - i; const a = data[i * 3 + ch], b = data[Math.min(size - 1, i + 1) * 3 + ch]; return a + (b - a) * f; };
    let k = 0;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) { out[k++] = look(r / (n - 1), 0); out[k++] = look(g / (n - 1), 1); out[k++] = look(b / (n - 1), 2); }
    return { size: n, data: out };
  }
  return { size, data: Float32Array.from(data) };
}

export function parse3dl(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const header = lines[0].split(/\s+/).map(Number);
  const rows = lines.slice(1).map((l) => l.split(/\s+/).map(Number)).filter((r) => r.length === 3);
  const size = Math.round(Math.cbrt(rows.length));
  const max = Math.max(...rows.flat(), 1);
  const scale = max > 4095 ? 65535 : max > 1023 ? 4095 : max > 1 ? 1023 : 1;
  const data = new Float32Array(size * size * size * 3);
  // .3dl is ordered with blue fastest; convert to red-fastest
  let i = 0;
  for (let r = 0; r < size; r++) for (let g = 0; g < size; g++) for (let b = 0; b < size; b++) {
    const row = rows[i++]; const o = ((b * size + g) * size + r) * 3;
    data[o] = row[0] / scale; data[o + 1] = row[1] / scale; data[o + 2] = row[2] / scale;
  }
  void header;
  return { size, data };
}

export function lutToRGBA(lut) {
  const n = lut.size; const out = new Uint8Array(n * n * n * 4);
  for (let i = 0; i < n * n * n; i++) {
    out[i * 4] = clamp(Math.round(lut.data[i * 3] * 255), 0, 255);
    out[i * 4 + 1] = clamp(Math.round(lut.data[i * 3 + 1] * 255), 0, 255);
    out[i * 4 + 2] = clamp(Math.round(lut.data[i * 3 + 2] * 255), 0, 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function lutToCube(lut, title = 'CinergyPro LUT') {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

// ---------- Built-in looks ----------
const sat = (c, s) => { const l = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; return c.map((v) => l + (v - l) * s); };
const contrast = (c, k, pivot = 0.5) => c.map((v) => (v - pivot) * k + pivot);
const sCurve = (v, k = 1) => { const x = clamp(v, 0, 1); return x + k * 0.15 * Math.sin((x - 0.5) * Math.PI * 2) * -1 * 0.5 + k * (x * x * (3 - 2 * x) - x) * 0.6; };
const lift = (c, l) => c.map((v, i) => v + l[i] * (1 - v));
const gain = (c, g) => c.map((v, i) => v * g[i]);
const lum = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

export const BUILTIN_LOOKS = {
  'builtin:teal-orange': { name: 'Teal & Orange', fn: (c) => { const l = lum(c); let o = c.map((v) => sCurve(v, 1)); o = lift(o, [-0.02, 0.03, 0.06].map((x) => x * (1 - l))); o = gain(o, [1.06, 1.0, 0.92].map((x) => 1 + (x - 1) * l)); return sat(o, 1.15); } },
  'builtin:bleach-bypass': { name: 'Bleach Bypass', fn: (c) => { const l = lum(c); return contrast(sat(c, 0.45).map((v) => v * 0.6 + l * 0.4), 1.25); } },
  'builtin:film-warm': { name: 'Warm Film', fn: (c) => { let o = c.map((v) => sCurve(v, 0.6)); o = gain(o, [1.05, 1.0, 0.9]); return lift(o, [0.03, 0.02, 0.0]); } },
  'builtin:cool-night': { name: 'Cool Night', fn: (c) => { let o = gain(c, [0.82, 0.92, 1.12]); o = contrast(o, 1.1, 0.4); return sat(o, 0.85); } },
  'builtin:mono-contrast': { name: 'Monochrome Contrast', fn: (c) => { const l = sCurve(lum(c), 1.4); return [l, l, l]; } },
  'builtin:vintage-fade': { name: 'Vintage Fade', fn: (c) => { let o = c.map((v) => v * 0.85 + 0.08); o = gain(o, [1.04, 1.0, 0.88]); return sat(o, 0.75); } },
  'builtin:cinematic-green': { name: 'Cinematic Green', fn: (c) => { let o = c.map((v) => sCurve(v, 0.8)); o = gain(o, [0.95, 1.04, 0.96]); return lift(o, [0.0, 0.03, 0.02]); } },
  'builtin:sepia': { name: 'Sepia', fn: (c) => { const l = lum(c); return [l * 1.07 + 0.03, l * 0.95 + 0.01, l * 0.78]; } },
  'builtin:high-key': { name: 'High Key', fn: (c) => sat(c.map((v) => Math.pow(clamp(v, 0, 1), 0.75)), 0.9) },
  'builtin:low-key': { name: 'Low Key Noir', fn: (c) => sat(contrast(c.map((v) => Math.pow(clamp(v, 0, 1), 1.4)), 1.2), 0.7) },
  'builtin:pastel': { name: 'Soft Pastel', fn: (c) => sat(c.map((v) => v * 0.8 + 0.15), 0.8) },
  'builtin:punchy': { name: 'Punchy Vivid', fn: (c) => sat(c.map((v) => sCurve(v, 1.2)), 1.35) },
  'builtin:rec709-from-slog3': { name: 'S-Log3 to Rec.709 (technical)', fn: (c) => c.map((x) => { const lin = x >= 171.2102946929 / 1023 ? Math.pow(10, (x * 1023 - 420) / 261.5) * 0.19 - 0.01 : (x * 1023 - 95) * 0.01125 / 76.21; const t = Math.max(0, lin) * 1.8 * 0.8; const v = clamp((t * (2.51 * t + 0.03)) / (t * (2.43 * t + 0.59) + 0.14), 0, 1); return v < 0.018 ? 4.5 * v : 1.099 * Math.pow(v, 0.45) - 0.099; }) },
};

export function generateLook(key, size = 33) {
  const def = BUILTIN_LOOKS[key];
  if (!def) return null;
  const data = new Float32Array(size * size * size * 3);
  let k = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = def.fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
    data[k++] = clamp(o[0], 0, 1); data[k++] = clamp(o[1], 0, 1); data[k++] = clamp(o[2], 0, 1);
  }
  return { size, data };
}

// ---------- Curves ----------
// Monotone cubic interpolation through sorted control points [[x,y],...] in 0..1
export function curveSampler(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return (x) => x;
  const n = pts.length; const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// Periodic (hue) curve: points [[hue,value]] where neutral value = 0.5
export function hueCurveSampler(points) {
  if (!points || !points.length) return () => 0.5;
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const ext = [[pts[pts.length - 1][0] - 1, pts[pts.length - 1][1]], ...pts, [pts[0][0] + 1, pts[0][1]]];
  const s = curveSampler(ext);
  return (x) => s(x);
}

export function isIdentityCurve(pts) { return !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1); }

export function curvesTexture(curves) {
  const data = new Uint8Array(256 * 4);
  const r = curveSampler(curves.r || [[0, 0], [1, 1]]), g = curveSampler(curves.g || [[0, 0], [1, 1]]), b = curveSampler(curves.b || [[0, 0], [1, 1]]), m = curveSampler(curves.master || [[0, 0], [1, 1]]);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    data[i * 4] = clamp(Math.round(r(x) * 255), 0, 255);
    data[i * 4 + 1] = clamp(Math.round(g(x) * 255), 0, 255);
    data[i * 4 + 2] = clamp(Math.round(b(x) * 255), 0, 255);
    data[i * 4 + 3] = clamp(Math.round(m(x) * 255), 0, 255);
  }
  return data;
}

export function hueTexture(hc) {
  const data = new Uint8Array(256 * 2 * 4);
  const hs = hueCurveSampler(hc.hueSat), hh = hueCurveSampler(hc.hueHue), hl = hueCurveSampler(hc.hueLuma);
  const ls = hc.lumaSat && hc.lumaSat.length ? curveSampler(hc.lumaSat) : () => 0.5;
  const ss = hc.satSat && hc.satSat.length ? curveSampler(hc.satSat) : () => 0.5;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    data[i * 4] = clamp(Math.round(hs(x) * 255), 0, 255);
    data[i * 4 + 1] = clamp(Math.round(hh(x) * 255), 0, 255);
    data[i * 4 + 2] = clamp(Math.round(hl(x) * 255), 0, 255);
    data[i * 4 + 3] = clamp(Math.round(ls(x) * 255), 0, 255);
    const j = (256 + i) * 4;
    data[j] = clamp(Math.round(ss(x) * 255), 0, 255); data[j + 1] = 128; data[j + 2] = 128; data[j + 3] = 128;
  }
  return data;
}

export function hueCurvesEmpty(hc) { return !hc || ['hueSat', 'hueHue', 'hueLuma', 'lumaSat', 'satSat'].every((k) => !hc[k] || !hc[k].length); }
export function curvesEmpty(c) { return !c || ['master', 'r', 'g', 'b'].every((k) => isIdentityCurve(c[k])); }
