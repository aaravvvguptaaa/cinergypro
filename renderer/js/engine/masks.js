// Mask rasterization (ellipse, rectangle, bezier path) with feather, expansion,
// opacity, inversion and add/subtract/intersect modes.
import { evaluate } from '../core/keyframes.js';

export function maskAt(mask, frame) {
  const k = mask.keyframes || {};
  return {
    ...mask,
    points: k.points && k.points.length ? evaluate(k.points, frame, mask.points) : mask.points,
    feather: k.feather && k.feather.length ? evaluate(k.feather, frame, mask.feather) : mask.feather,
    opacity: k.opacity && k.opacity.length ? evaluate(k.opacity, frame, mask.opacity) : mask.opacity,
    expansion: k.expansion && k.expansion.length ? evaluate(k.expansion, frame, mask.expansion) : mask.expansion,
  };
}

export function tracePath(ctx, m, w, h) {
  const pts = m.points.map(([x, y]) => [x * w, y * h]);
  ctx.beginPath();
  if (m.shape === 'ellipse') {
    const [tl, tr, , bl] = pts;
    ctx.save();
    ctx.transform(tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1], tl[0], tl[1]);
    ctx.ellipse(0.5, 0.5, 0.5, 0.5, 0, 0, Math.PI * 2);
    ctx.restore();
    return;
  }
  if (m.shape === 'rect' || m.smooth === false) {
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (m.closed !== false) ctx.closePath();
    return;
  }
  // Catmull-Rom spline through points, converted to bezier segments
  const n = pts.length;
  if (n < 3) { pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); return; }
  ctx.moveTo(pts[0][0], pts[0][1]);
  const t = (m.tension == null ? 0.5 : m.tension) / 3 * 2;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    if (m.closed === false && i === n - 1) break;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t / 2, p1[1] + (p2[1] - p0[1]) * t / 2];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t / 2, p2[1] - (p3[1] - p1[1]) * t / 2];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]);
  }
  if (m.closed !== false) ctx.closePath();
}

let scratch = null;
function scratchCanvas(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  return scratch;
}

// Draw combined masks (white = selected) into a canvas of size w x h.
export function rasterizeMasks(canvas, masks, frame, scale = 1) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  const first = masks[0];
  if (first && (first.mode === 'subtract')) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  for (let i = 0; i < masks.length; i++) {
    const m = maskAt(masks[i], frame);
    const sc = scratchCanvas(w, h);
    const s = sc.getContext('2d');
    s.save(); s.setTransform(1, 0, 0, 1, 0, 0); s.globalCompositeOperation = 'source-over'; s.clearRect(0, 0, w, h);
    s.filter = m.feather > 0 ? `blur(${(m.feather * scale) / 2}px)` : 'none';
    s.globalAlpha = Math.max(0, Math.min(1, m.opacity / 100));
    s.fillStyle = '#fff'; s.strokeStyle = '#fff';
    if (m.invert) { s.fillRect(-w, -h, w * 3, h * 3); s.globalCompositeOperation = 'destination-out'; s.globalAlpha = 1; }
    tracePath(s, m, w, h);
    s.fill();
    if (m.expansion) {
      s.lineJoin = 'round';
      s.lineWidth = Math.abs(m.expansion) * 2 * scale;
      if ((m.expansion > 0) !== !!m.invert) { s.globalCompositeOperation = m.invert ? 'destination-out' : 'source-over'; s.stroke(); }
      else { s.globalCompositeOperation = m.invert ? 'source-over' : 'destination-out'; s.stroke(); }
    }
    s.restore();
    const mode = i === 0 && m.mode !== 'subtract' ? 'add' : m.mode;
    ctx.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : mode === 'intersect' ? 'destination-in' : mode === 'difference' ? 'xor' : 'lighter';
    ctx.drawImage(sc, 0, 0);
  }
  ctx.restore();
  return canvas;
}

export function maskHash(masks, frame) {
  return JSON.stringify(masks.map((m) => { const a = maskAt(m, frame); return [a.shape, a.points, a.feather, a.opacity, a.expansion, a.invert, a.mode, a.tension, a.closed]; }));
}

// Move all points of a mask by (dx, dy) normalized and optionally scale/rotate around its center.
export function transformPoints(points, dx = 0, dy = 0, scale = 1, rot = 0) {
  const cx = points.reduce((a, p) => a + p[0], 0) / points.length;
  const cy = points.reduce((a, p) => a + p[1], 0) / points.length;
  const c = Math.cos(rot), s = Math.sin(rot);
  return points.map(([x, y]) => {
    let px = (x - cx) * scale, py = (y - cy) * scale;
    const rx = px * c - py * s, ry = px * s + py * c;
    return [cx + rx + dx, cy + ry + dy];
  });
}
