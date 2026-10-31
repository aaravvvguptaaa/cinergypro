// 2D renderer for titles, shapes, lower thirds, captions and burn-in text.
import { evaluate } from '../core/keyframes.js';
import { clamp, hexToRgb } from '../core/util.js';

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function rgba(hex, op = 1) { const [r, g, b] = hexToRgb(hex); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${op})`; }

export function layerProps(layer, frame) {
  const out = { ...layer };
  for (const [k, keys] of Object.entries(layer.keyframes || {})) if (keys && keys.length) out[k] = evaluate(keys, frame, layer[k]);
  return out;
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!maxW) { out.push(para); continue; }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (ctx.measureText(test).width > maxW && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

function animState(l, localSec, durSec) {
  const st = { alpha: 1, dx: 0, dy: 0, scale: 1, chars: Infinity, words: Infinity, blur: 0 };
  if (!l.anim || l.anim === 'none') return st;
  const d = Math.max(0.05, l.animDur || 0.5);
  const tin = clamp(localSec / d, 0, 1);
  const tout = clamp((durSec - localSec) / d, 0, 1);
  const k = easeOut(Math.min(tin, l.animOut === false ? 1 : tout));
  switch (l.anim) {
    case 'fade': st.alpha = k; break;
    case 'slideUp': st.alpha = k; st.dy = (1 - k) * 60; break;
    case 'slideDown': st.alpha = k; st.dy = -(1 - k) * 60; break;
    case 'slideLeft': st.alpha = k; st.dx = (1 - k) * 120; break;
    case 'slideRight': st.alpha = k; st.dx = -(1 - k) * 120; break;
    case 'pop': st.scale = 0.6 + 0.4 * (1 - Math.pow(1 - k, 2)) + Math.sin(k * Math.PI) * 0.08; st.alpha = Math.min(1, k * 2); break;
    case 'blur': st.alpha = k; st.blur = (1 - k) * 18; break;
    case 'typewriter': st.chars = Math.floor(localSec / (d / 10) ); break;
    case 'words': st.words = Math.floor(localSec / Math.max(0.08, d / 4)) + 1; break;
    default: break;
  }
  return st;
}

function applyFill(ctx, l, x, y, w, h) {
  if (l.gradient && l.gradient.stops && l.gradient.stops.length > 1) {
    const g = l.gradient.type === 'radial' ? ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2)
      : (() => { const a = (l.gradient.angle || 90) * Math.PI / 180; const cx = x + w / 2, cy = y + h / 2, r = Math.max(w, h) / 2; return ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r); })();
    for (const s of l.gradient.stops) g.addColorStop(s[0], s[1]);
    return g;
  }
  return l.fill;
}

export function drawGraphic(ctx, graphic, w, h, frame, fps, durFrames, seqScale = 1) {
  ctx.clearRect(0, 0, w, h);
  const localSec = frame / fps, durSec = durFrames / fps;
  const layers = graphic.layers || [];
  // draw bottom-up: first layer in list is on top (like Premiere's Essential Graphics)
  for (let i = layers.length - 1; i >= 0; i--) {
    const base = layers[i];
    if (base.visible === false) continue;
    const l = layerProps(base, frame);
    const st = animState(l, localSec, durSec);
    ctx.save();
    const s = seqScale * (l.scale / 100) * st.scale;
    ctx.globalAlpha = clamp(l.opacity / 100 * st.alpha, 0, 1);
    ctx.translate(l.x * w + st.dx * seqScale, l.y * h + st.dy * seqScale);
    ctx.rotate((l.rotation || 0) * Math.PI / 180);
    ctx.scale(s, s);
    if (st.blur) ctx.filter = `blur(${st.blur}px)`;
    if (l.shadowOn) {
      const a = (l.shadowAngle || 135) * Math.PI / 180;
      ctx.shadowColor = rgba(l.shadow, l.shadowOpacity / 100);
      ctx.shadowBlur = l.shadowBlur * seqScale;
      ctx.shadowOffsetX = Math.cos(a) * l.shadowDist * seqScale; ctx.shadowOffsetY = Math.sin(a) * l.shadowDist * seqScale;
    }
    if (l.type === 'text') drawText(ctx, l, st);
    else if (l.type === 'rect' || l.type === 'ellipse' || l.type === 'roundrect') drawShape(ctx, l);
    else if (l.type === 'line') { ctx.strokeStyle = l.stroke; ctx.lineWidth = l.strokeWidth || 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-l.width / 2, 0); ctx.lineTo(l.width / 2, 0); ctx.stroke(); }
    else if (l.type === 'image' && l.image) { const img = l._img; if (img && img.complete) ctx.drawImage(img, -l.width / 2, -l.height / 2, l.width, l.height); }
    ctx.restore();
  }
}

function drawShape(ctx, l) {
  const W = l.width || 400, H = l.height || 120;
  ctx.beginPath();
  if (l.type === 'ellipse') ctx.ellipse(0, 0, W / 2, H / 2, 0, 0, Math.PI * 2);
  else if (l.radius) { const r = Math.min(l.radius, W / 2, H / 2); ctx.roundRect(-W / 2, -H / 2, W, H, r); }
  else ctx.rect(-W / 2, -H / 2, W, H);
  if (l.fillOn !== false) { ctx.fillStyle = applyFill(ctx, l, -W / 2, -H / 2, W, H); ctx.fill(); }
  ctx.shadowColor = 'transparent';
  if (l.strokeOn && l.strokeWidth) { ctx.strokeStyle = l.stroke; ctx.lineWidth = l.strokeWidth; ctx.stroke(); }
}

function drawText(ctx, l, st) {
  ctx.font = `${l.italic ? 'italic ' : ''}${l.weight || 400} ${l.size}px "${l.font || 'Inter'}", -apple-system, "Helvetica Neue", sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(l.tracking || 0) / 1000 * l.size}px`;
  ctx.textBaseline = 'middle';
  let text = l.text || '';
  if (isFinite(st.chars)) text = text.slice(0, Math.max(0, st.chars));
  if (isFinite(st.words)) text = text.split(/(\s+)/).slice(0, st.words * 2).join('');
  if (l.caps) text = text.toUpperCase();
  const lines = wrapLines(ctx, text, l.boxWidth || 0);
  const lh = l.size * (l.leading || 1.2);
  const totalH = lh * lines.length;
  const widths = lines.map((s) => ctx.measureText(s).width);
  const maxW = Math.max(l.boxWidth || 0, ...widths, 1);
  const align = l.align || 'center';
  // the layer position is the left edge for left-aligned text, the right edge for right-aligned
  const shift = align === 'left' ? maxW / 2 : align === 'right' ? -maxW / 2 : 0;
  ctx.translate(shift, 0);
  const ax = align === 'left' ? -maxW / 2 : align === 'right' ? maxW / 2 : 0;
  ctx.textAlign = align;
  if (l.bgOn) {
    const pad = l.bgPad || 16;
    ctx.save(); ctx.shadowColor = 'transparent';
    ctx.fillStyle = rgba(l.bg, (l.bgOpacity == null ? 100 : l.bgOpacity) / 100);
    if (l.bgPerLine) lines.forEach((s, i) => { const wdt = widths[i]; const x0 = align === 'left' ? ax : align === 'right' ? ax - wdt : -wdt / 2; ctx.fillRect(x0 - pad, -totalH / 2 + i * lh - pad / 3, wdt + pad * 2, lh + pad * 0.66); });
    else { ctx.beginPath(); ctx.roundRect(-maxW / 2 - pad, -totalH / 2 - pad / 2, maxW + pad * 2, totalH + pad, l.bgRadius || 0); ctx.fill(); }
    ctx.restore();
  }
  lines.forEach((s, i) => {
    const y = -totalH / 2 + lh * (i + 0.5);
    if (l.strokeOn && l.strokeWidth) { ctx.lineJoin = 'round'; ctx.strokeStyle = l.stroke; ctx.lineWidth = l.strokeWidth * 2; ctx.strokeText(s, ax, y); }
    if (l.fillOn !== false) { ctx.fillStyle = applyFill(ctx, l, -maxW / 2, -totalH / 2, maxW, totalH); ctx.fillText(s, ax, y); }
  });
}

// Bounding box (normalized) for selection handles in the Program Monitor
export function layerBounds(ctx, layer, w, h, seqScale = 1) {
  const s = seqScale * (layer.scale / 100);
  let bw = 0, bh = 0;
  if (layer.type === 'text') {
    ctx.font = `${layer.italic ? 'italic ' : ''}${layer.weight || 400} ${layer.size}px "${layer.font || 'Inter'}", sans-serif`;
    const lines = wrapLines(ctx, layer.text || '', layer.boxWidth || 0);
    bw = Math.max(layer.boxWidth || 0, ...lines.map((x) => ctx.measureText(x).width)); bh = lines.length * layer.size * (layer.leading || 1.2);
  } else { bw = layer.width || 400; bh = layer.height || 120; }
  let cx = layer.x;
  if (layer.type === 'text' && layer.align === 'left') cx += bw * s / w / 2;
  else if (layer.type === 'text' && layer.align === 'right') cx -= bw * s / w / 2;
  return { x: cx, y: layer.y, w: bw * s / w, h: bh * s / h, rotation: layer.rotation || 0 };
}

export function drawCaption(ctx, cap, style, w, h, opts = {}) {
  ctx.clearRect(0, 0, w, h);
  const st = { font: 'Inter', size: 44, color: '#ffffff', bg: '#000000', bgOpacity: 70, position: 'bottom', align: 'center', margin: 0.08, weight: 600, outline: 0, ...(style || {}), ...(cap.style || {}) };
  const scale = h / 1080;
  const size = st.size * scale;
  ctx.font = `${st.weight} ${size}px "${st.font}", -apple-system, sans-serif`;
  ctx.textAlign = st.align; ctx.textBaseline = 'middle';
  let text = cap.text || '';
  if (opts.wordIndex != null) text = text.split(/\s+/)[opts.wordIndex] || '';
  const lines = wrapLines(ctx, text, w * 0.8);
  const lh = size * 1.25; const totalH = lh * lines.length;
  const marginY = h * st.margin;
  let cy = st.position === 'top' ? marginY + totalH / 2 : st.position === 'middle' ? h / 2 : h - marginY - totalH / 2;
  if (st.y != null) cy = st.y * h;
  const cx = st.align === 'left' ? w * 0.1 : st.align === 'right' ? w * 0.9 : w / 2;
  lines.forEach((s, i) => {
    const y = cy - totalH / 2 + lh * (i + 0.5);
    const tw = ctx.measureText(s).width;
    if (st.bgOpacity > 0) {
      ctx.fillStyle = rgba(st.bg, st.bgOpacity / 100);
      const x0 = st.align === 'left' ? cx : st.align === 'right' ? cx - tw : cx - tw / 2;
      ctx.fillRect(x0 - size * 0.35, y - lh / 2, tw + size * 0.7, lh);
    }
    if (st.outline) { ctx.strokeStyle = '#000'; ctx.lineWidth = st.outline * scale * 2; ctx.lineJoin = 'round'; ctx.strokeText(s, cx, y); }
    ctx.fillStyle = st.color; ctx.fillText(s, cx, y);
  });
}

export function drawOverlayText(ctx, text, p, w, h) {
  ctx.clearRect(0, 0, w, h);
  const size = (p.size / 100) * h;
  ctx.font = `600 ${size}px "SF Mono", Menlo, "Roboto Mono", monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const x = p.position[0] * w, y = p.position[1] * h;
  ctx.fillStyle = `rgba(0,0,0,${(p.opacity / 100) * 0.85})`;
  ctx.fillRect(x - tw / 2 - size * 0.3, y - size * 0.65, tw + size * 0.6, size * 1.3);
  ctx.fillStyle = `rgba(255,255,255,${p.opacity / 100})`;
  ctx.fillText(text, x, y + size * 0.04);
}

// Built-in graphic templates (CinergyPro templates, editable parameters)
export const GRAPHIC_TEMPLATES = {
  lower_third: { name: 'Lower Third - Modern', make: () => ({ layers: [
    { id: 'lt_name', type: 'text', name: 'Name', text: 'Alex Morgan', x: 0.08, y: 0.8, font: 'Inter', size: 64, weight: 700, align: 'left', fill: '#ffffff', fillOn: true, opacity: 100, rotation: 0, scale: 100, anim: 'slideRight', animDur: 0.5, keyframes: {}, visible: true, leading: 1.15, tracking: 0, boxWidth: 0 },
    { id: 'lt_title', type: 'text', name: 'Title', text: 'Director of Photography', x: 0.08, y: 0.865, font: 'Inter', size: 36, weight: 500, align: 'left', fill: '#c8d0dc', fillOn: true, opacity: 100, rotation: 0, scale: 100, anim: 'slideRight', animDur: 0.65, keyframes: {}, visible: true, leading: 1.15, tracking: 20, boxWidth: 0 },
    { id: 'lt_bar', type: 'rect', name: 'Accent Bar', x: 0.072, y: 0.83, width: 8, height: 130, fill: '#2f7cff', fillOn: true, opacity: 100, rotation: 0, scale: 100, anim: 'fade', animDur: 0.4, keyframes: {}, visible: true },
  ] }) },
  title_card: { name: 'Title Card - Cinematic', make: () => ({ layers: [
    { id: 'tc_title', type: 'text', name: 'Title', text: 'CRAFT EVERY FRAME', x: 0.5, y: 0.48, font: 'Inter', size: 120, weight: 800, align: 'center', fill: '#ffffff', fillOn: true, tracking: 180, opacity: 100, rotation: 0, scale: 100, anim: 'blur', animDur: 0.9, keyframes: {}, visible: true, leading: 1.1, boxWidth: 0 },
    { id: 'tc_sub', type: 'text', name: 'Subtitle', text: 'A film by Your Name', x: 0.5, y: 0.58, font: 'Inter', size: 40, weight: 400, align: 'center', fill: '#9aa3b2', fillOn: true, tracking: 60, opacity: 100, rotation: 0, scale: 100, anim: 'fade', animDur: 1.2, keyframes: {}, visible: true, leading: 1.1, boxWidth: 0 },
  ] }) },
  end_card: { name: 'End Card', make: () => ({ layers: [
    { id: 'ec_bg', type: 'rect', name: 'Background', x: 0.5, y: 0.5, width: 1920, height: 1080, fill: '#0b0c0f', fillOn: true, opacity: 92, rotation: 0, scale: 100, anim: 'fade', animDur: 0.6, keyframes: {}, visible: true },
    { id: 'ec_title', type: 'text', name: 'Thanks', text: 'Thanks for watching', x: 0.5, y: 0.42, font: 'Inter', size: 84, weight: 700, align: 'center', fill: '#ffffff', fillOn: true, opacity: 100, rotation: 0, scale: 100, anim: 'slideUp', animDur: 0.6, keyframes: {}, visible: true, leading: 1.1, tracking: 0, boxWidth: 0 },
    { id: 'ec_cta', type: 'text', name: 'Call to action', text: 'Subscribe for more', x: 0.5, y: 0.55, font: 'Inter', size: 44, weight: 500, align: 'center', fill: '#2f7cff', fillOn: true, opacity: 100, rotation: 0, scale: 100, anim: 'slideUp', animDur: 0.8, keyframes: {}, visible: true, leading: 1.1, tracking: 0, boxWidth: 0, bgOn: false },
  ] }) },
  caption_box: { name: 'Text Box', make: () => ({ layers: [
    { id: 'tb_text', type: 'text', name: 'Paragraph', text: 'Paragraph text wraps inside its box.\nEdit me in the Properties panel.', x: 0.5, y: 0.5, font: 'Inter', size: 48, weight: 500, align: 'left', fill: '#ffffff', fillOn: true, opacity: 100, rotation: 0, scale: 100, boxWidth: 900, bgOn: true, bg: '#000000', bgOpacity: 55, bgPad: 28, bgRadius: 12, anim: 'fade', animDur: 0.4, keyframes: {}, visible: true, leading: 1.3, tracking: 0 },
  ] }) },
  logo_bug: { name: 'Corner Bug', make: () => ({ layers: [
    { id: 'lb_shape', type: 'roundrect', name: 'Badge', x: 0.9, y: 0.1, width: 220, height: 64, radius: 32, fill: '#2f7cff', fillOn: true, opacity: 85, rotation: 0, scale: 100, anim: 'pop', animDur: 0.5, keyframes: {}, visible: true },
    { id: 'lb_text', type: 'text', name: 'Label', text: 'LIVE', x: 0.9, y: 0.1, font: 'Inter', size: 32, weight: 800, align: 'center', fill: '#ffffff', fillOn: true, tracking: 120, opacity: 100, rotation: 0, scale: 100, anim: 'pop', animDur: 0.5, keyframes: {}, visible: true, leading: 1, boxWidth: 0 },
  ] }) },
  news_strap: { name: 'News Strap', make: () => ({ layers: [
    { id: 'ns_head', type: 'text', name: 'Headline', text: 'BREAKING: Headline goes here', x: 0.07, y: 0.86, font: 'Inter', size: 46, weight: 800, align: 'left', fill: '#ffffff', fillOn: true, opacity: 100, rotation: 0, scale: 100, anim: 'slideRight', animDur: 0.4, keyframes: {}, visible: true, leading: 1.1, tracking: 0, boxWidth: 0 },
    { id: 'ns_bar', type: 'rect', name: 'Strap', x: 0.5, y: 0.86, width: 1920, height: 90, fill: '#b3121f', fillOn: true, opacity: 95, rotation: 0, scale: 100, anim: 'slideRight', animDur: 0.3, keyframes: {}, visible: true, gradient: { type: 'linear', angle: 0, stops: [[0, '#b3121f'], [1, '#5a0a10']] } },
  ] }) },
};
