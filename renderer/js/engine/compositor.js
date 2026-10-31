// Sequence compositor: renders any sequence frame into an FBO.
import { EFFECT_IMPL, makeCtx, affineInverse, transitionFrag, transitionUniforms, COPY } from './shaders.js';
import { resolveParams, paramValue } from '../core/keyframes.js';
import { clipSourceTime, itemFps, nativeFps, clipAt } from '../core/project.js';
import { transitionAt } from '../core/edit.js';
import { rasterizeMasks, maskHash } from './masks.js';
import { drawGraphic, drawCaption, drawOverlayText } from './graphics.js';
import { curvesTexture, hueTexture, curvesEmpty, hueCurvesEmpty, parseCube, parse3dl, lutToRGBA, generateLook } from './lut.js';
import { framesToTC } from '../core/timecode.js';
import { hexToRgb, Emitter } from '../core/util.js';
import { PLUGIN_EFFECTS } from '../core/effect-defs.js';

const BLEND_MODES = ['normal', 'dissolve', 'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor', 'lighten', 'screen', 'colorDodge', 'add', 'lighterColor', 'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight', 'hardMix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity'];

const SOURCE = `uniform sampler2D uTex; uniform int uAlpha; uniform int uSpace; uniform vec2 uCropUV0; uniform vec2 uCropUV1;
vec3 pqToSdr(vec3 c){ float m1=0.1593017578125, m2=78.84375, c1=0.8359375, c2=18.8515625, c3=18.6875; vec3 p=pow(max(c,vec3(0.0)),vec3(1.0/m2)); vec3 l=pow(max(p-c1,vec3(0.0))/(c2-c3*p),vec3(1.0/m1))*10000.0/203.0; l=mat3(1.6605,-0.1246,-0.0182,-0.5876,1.1329,-0.1006,-0.0728,-0.0083,1.1187)*l; l*=0.8; vec3 a=l*(2.51*l+0.03), b=l*(2.43*l+0.59)+0.14; l=clamp(a/b,0.0,1.0); return mix(4.5*l,1.099*pow(l,vec3(0.45))-0.099,step(vec3(0.018),l)); }
vec3 hlgToSdr(vec3 c){ vec3 l=mix(c*c/3.0,(exp((c-0.55991073)/0.17883277)+0.28466892)/12.0,step(vec3(0.5),c)); l=mat3(1.6605,-0.1246,-0.0182,-0.5876,1.1329,-0.1006,-0.0728,-0.0083,1.1187)*l*3.0; l=clamp(l/(1.0+l*0.4)*1.3,0.0,1.0); return mix(4.5*l,1.099*pow(l,vec3(0.45))-0.099,step(vec3(0.018),l)); }
void main(){ vec2 uv = mix(uCropUV0, uCropUV1, vUv); vec4 c = texture(uTex, uv);
  if(uAlpha==1) c.a = 1.0; else if(uAlpha==2) c = vec4(c.rgb*(1.0-c.a)/max(1.0-c.a,0.0001)*(1.0-c.a), 1.0-c.a); else if(uAlpha==3) c = vec4(c.rgb, c.a);
  if(uSpace==1){ vec4 u=unpm(c); c=pm(vec4(pqToSdr(u.rgb),u.a)); } else if(uSpace==2){ vec4 u=unpm(c); c=pm(vec4(hlgToSdr(u.rgb),u.a)); }
  fragColor = c; }`;

const MOTION = `uniform sampler2D uTex; uniform mat3 uInv; uniform vec4 uCrop; uniform float uOpacity; uniform vec2 uFlip; uniform float uAA; uniform vec2 uTexSize;
void main(){ vec3 q = uInv * vec3(vUv, 1.0); vec2 uv = q.xy;
  if(uFlip.x>0.5) uv.x = 1.0-uv.x; if(uFlip.y>0.5) uv.y = 1.0-uv.y;
  if(uv.x < uCrop.x || uv.x > 1.0-uCrop.z || uv.y < uCrop.w || uv.y > 1.0-uCrop.y){ fragColor = vec4(0.0); return; }
  vec4 c = texture(uTex, uv);
  if(uAA > 0.0){ vec2 px = uAA/uTexSize; c = c*0.4 + (texture(uTex, uv+vec2(0,px.y)) + texture(uTex, uv-vec2(0,px.y)))*0.3; }
  fragColor = c * uOpacity; }`;

const BLEND = `uniform sampler2D uDst; uniform sampler2D uSrc; uniform int uMode; uniform float uOp;
float lumF(vec3 c){ return dot(c, vec3(0.3,0.59,0.11)); }
vec3 clipColor(vec3 c){ float l=lumF(c), n=min(min(c.r,c.g),c.b), x=max(max(c.r,c.g),c.b); if(n<0.0) c=l+(c-l)*l/(l-n); if(x>1.0) c=l+(c-l)*(1.0-l)/(x-l); return c; }
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lumF(c))); }
float satF(vec3 c){ return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b); }
vec3 setSat(vec3 c, float s){ float mx=max(max(c.r,c.g),c.b), mn=min(min(c.r,c.g),c.b); return mx>mn ? (c-mn)*s/(mx-mn) : vec3(0.0); }
vec3 B(vec3 b, vec3 s){
  if(uMode==2) return min(b,s);
  if(uMode==3) return b*s;
  if(uMode==4) return mix(1.0-min(vec3(1.0),(1.0-b)/max(s,0.0001)), vec3(1.0), step(1.0,b));
  if(uMode==5) return max(b+s-1.0, 0.0);
  if(uMode==6) return lumF(s)<lumF(b)? s : b;
  if(uMode==7) return max(b,s);
  if(uMode==8) return b+s-b*s;
  if(uMode==9) return mix(min(vec3(1.0), b/max(1.0-s,0.0001)), vec3(0.0), step(b,vec3(0.0)));
  if(uMode==10) return min(b+s, 1.0);
  if(uMode==11) return lumF(s)>lumF(b)? s : b;
  if(uMode==12) return mix(2.0*b*s, 1.0-2.0*(1.0-b)*(1.0-s), step(0.5,b));
  if(uMode==13){ vec3 d=mix(((16.0*b-12.0)*b+4.0)*b, sqrt(b), step(0.25,b)); return mix(b-(1.0-2.0*s)*b*(1.0-b), b+(2.0*s-1.0)*(d-b), step(0.5,s)); }
  if(uMode==14) return mix(2.0*b*s, 1.0-2.0*(1.0-b)*(1.0-s), step(0.5,s));
  if(uMode==15) return mix(1.0-min(vec3(1.0),(1.0-b)/max(2.0*s,0.0001)), min(vec3(1.0), b/max(2.0*(1.0-s),0.0001)), step(0.5,s));
  if(uMode==16) return clamp(b+2.0*s-1.0, 0.0, 1.0);
  if(uMode==17) return mix(min(b,2.0*s), max(b,2.0*s-1.0), step(0.5,s));
  if(uMode==18) return step(1.0, b+s);
  if(uMode==19) return abs(b-s);
  if(uMode==20) return b+s-2.0*b*s;
  if(uMode==21) return max(b-s, 0.0);
  if(uMode==22) return min(vec3(1.0), b/max(s,0.0001));
  if(uMode==23) return setLum(setSat(s, satF(b)), lumF(b));
  if(uMode==24) return setLum(setSat(b, satF(s)), lumF(b));
  if(uMode==25) return setLum(s, lumF(b));
  if(uMode==26) return setLum(b, lumF(s));
  return s; }
void main(){ vec4 d = texture(uDst, vUv); vec4 s = texture(uSrc, vUv) * uOp;
  if(uMode==1){ float n = hash(vUv*uRes + uFrame); s = n < s.a ? vec4(s.rgb/max(s.a,0.0001),1.0) : vec4(0.0); }
  if(uMode<=1){ fragColor = s + d*(1.0-s.a); return; }
  vec3 cs = s.a>0.0? s.rgb/s.a : vec3(0.0); vec3 cb = d.a>0.0? d.rgb/d.a : vec3(0.0);
  vec3 cr = (1.0-d.a)*cs + d.a*clamp(B(cb,cs),0.0,1.0);
  fragColor = vec4(s.a*cr + d.rgb*(1.0-s.a), s.a + d.a*(1.0-s.a)); }`;

const OVER = `uniform sampler2D uDst; uniform sampler2D uSrc; void main(){ vec4 d=texture(uDst,vUv), s=texture(uSrc,vUv); fragColor = s + d*(1.0-s.a); }`;
const MULALPHA = `uniform sampler2D uTex; uniform sampler2D uMask; uniform float uOp; void main(){ fragColor = texture(uTex,vUv) * texture(uMask,vUv).r * uOp; }`;
const MATTE = `uniform sampler2D uTex; uniform sampler2D uMatte; uniform int uLuma; uniform float uRev; void main(){ vec4 m=texture(uMatte,vUv); float a = uLuma==1 ? (m.a>0.0? dot(m.rgb/m.a, vec3(0.2126,0.7152,0.0722))*m.a : 0.0) : m.a; if(uRev>0.5) a=1.0-a; fragColor = texture(uTex,vUv)*a; }`;
const ADJ = `uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uMask; uniform float uOp; void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); float m=texture(uMask,vUv).r; fragColor = mix(a,b,uOp*m); }`;
const BG = `uniform sampler2D uTex; uniform vec3 uBg; void main(){ vec4 c=texture(uTex,vUv); fragColor = vec4(c.rgb + uBg*(1.0-c.a), 1.0); }`;
const SOLID = `uniform vec4 uColor; void main(){ fragColor = vec4(uColor.rgb*uColor.a, uColor.a); }`;
const CHECKER = `uniform sampler2D uTex; void main(){ vec4 c=texture(uTex,vUv); vec2 g=floor(vUv*uRes/12.0); float k=mod(g.x+g.y,2.0); vec3 bg=mix(vec3(0.32),vec3(0.45),k); fragColor=vec4(c.rgb+bg*(1.0-c.a),1.0); }`;
const TOBYTES = `uniform sampler2D uTex; void main(){ vec4 c=texture(uTex,vUv); fragColor=vec4(clamp(c.rgb,0.0,1.0), clamp(c.a,0.0,1.0)); }`;

export class Compositor extends Emitter {
  constructor(gl, pool, getProject) {
    super();
    this.gl = gl; this.pool = pool; this.getProject = getProject;
    this.ctx = makeCtx(gl);
    this.luts = new Map();
    this.lumetriCache = new Map();
    this.maskCanvas = document.createElement('canvas');
    this.gfxCanvas = document.createElement('canvas');
    this.useProxies = false;
    this.dummy3d = null;
    this.depth = 0;
    this.onPluginFrag = null;
  }

  get project() { return this.getProject(); }

  dummyLut() { if (!this.dummy3d) this.dummy3d = this.gl.upload3D(2, new Uint8Array(32).fill(255)); return this.dummy3d; }

  loadLut(path) {
    if (!path) return null;
    let e = this.luts.get(path);
    if (e) return e.tex;
    e = { tex: null };
    this.luts.set(path, e);
    if (path.startsWith('builtin:')) {
      const lut = generateLook(path);
      if (lut) e.tex = this.gl.upload3D(lut.size, lutToRGBA(lut));
      return e.tex;
    }
    window.native.call('fs:read-text', path).then((txt) => {
      const lut = /\.3dl$/i.test(path) ? parse3dl(txt) : parseCube(txt);
      e.tex = this.gl.upload3D(lut.size, lutToRGBA(lut));
      this.emit('invalidate');
    }).catch((err) => { console.warn('LUT load failed', path, err); });
    return null;
  }

  lumetriTextures(p) {
    const key = JSON.stringify([p.curves, p.hueCurves]);
    let e = this.lumetriCache.get(key);
    if (!e) {
      e = {
        curves: this.gl.uploadData(null, 256, 1, curvesTexture(p.curves || {})), curvesOn: !curvesEmpty(p.curves),
        hue: this.gl.uploadData(null, 256, 2, hueTexture(p.hueCurves || {})), hueOn: !hueCurvesEmpty(p.hueCurves),
      };
      this.lumetriCache.set(key, e);
      if (this.lumetriCache.size > 64) { const [k, v] = this.lumetriCache.entries().next().value; this.gl.deleteTexture(v.curves); this.gl.deleteTexture(v.hue); this.lumetriCache.delete(k); }
    }
    return { ...e, lut: p.look ? this.loadLut(p.look) : null };
  }

  mediaPath(item, clip) {
    if (clip && clip.stabilized && clip.stabilized.path && clip.stabilized.ready) return clip.stabilized.path;
    if (clip && clip.retimed && clip.retimed.path && clip.retimed.ready) return clip.retimed.path;
    if (this.useProxies && item.proxy) return item.proxy;
    if (item.playback) return item.playback;
    return item.path;
  }

  // ---------- public ----------
  /**
   * Render a sequence frame. Returns a seq-space FBO (caller must release).
   * opts: {scale, playing, rate, captions, background, angleOnly}
   */
  renderSequence(seq, frame, opts = {}) {
    const gl = this.gl;
    const scale = opts.scale || 1;
    const W = Math.max(2, Math.round(seq.settings.width * scale)), H = Math.max(2, Math.round(seq.settings.height * scale));
    let acc = gl.acquire(W, H);
    gl.clear(acc, [0, 0, 0, 0]);
    this.depth++;
    try {
      if (opts.playing && this.depth === 1 && this.previewLookup) {
        const pv = this.previewLookup(seq, frame);
        if (pv) {
          const r = this.pool.videoTexture(pv.path, pv.t, 'preview:' + seq.id, { playing: true, rate: opts.rate || 1, fps: seq.settings.fps });
          if (r.tex && !r.error) { gl.pass('source', SOURCE, acc, { uTex: r.tex }, { uAlpha: 1, uSpace: 0, uCropUV0: [0, 0], uCropUV1: [1, 1] }); return acc; }
        }
      }
      const tracks = seq.tracks.video;
      const only = opts.angleOnly != null ? tracks[opts.angleOnly] : null;
      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (only && track !== only) continue;
        if (!only && track.hidden) continue;
        const tr = transitionAt(track, frame);
        if (tr) {
          const A = tr.clipA ? track.clips.find((c) => c.id === tr.clipA) : null;
          const B = tr.clipB ? track.clips.find((c) => c.id === tr.clipB) : null;
          const la = A && A.enabled ? this.clipLayer(seq, track, A, frame, W, H, opts) : null;
          const lb = B && B.enabled ? this.clipLayer(seq, track, B, frame, W, H, opts) : null;
          let prog = (frame - tr.start + 0.5) / tr.dur;
          if (tr.reverse) prog = 1 - prog;
          const out = gl.acquire(W, H);
          const plugin = this.onPluginFrag ? this.onPluginFrag(tr.type) : null;
          gl.pass('tr:' + tr.type, transitionFrag(tr.type, plugin), out, { uA: la ? la.fbo : gl.transparent, uB: lb ? lb.fbo : gl.transparent }, { uP: Math.max(0, Math.min(1, prog)), ...transitionUniforms(tr.type, tr.params || {}) });
          acc = this.blend(acc, out, 'normal', 1);
          gl.release(out); if (la) gl.release(la.fbo); if (lb) gl.release(lb.fbo);
          continue;
        }
        const clip = clipAt(track, frame);
        if (!clip || !clip.enabled) continue;
        const item = this.project.items[clip.src.itemId];
        if (clip.src.type === 'synthetic' && item && item.generator === 'adjustment') { acc = this.adjustment(seq, clip, frame, acc, W, H, opts); continue; }
        const layer = this.clipLayer(seq, track, clip, frame, W, H, opts);
        if (!layer) continue;
        let lf = layer.fbo;
        const tm = clip.effects.find((e) => e.type === 'track_matte' && e.enabled);
        if (tm) {
          const idx = (tm.params.track | 0) - 1;
          const mt = idx >= 0 ? tracks[idx] : tracks[ti + 1];
          const mc = mt && mt !== track ? clipAt(mt, frame) : null;
          const ml = mc ? this.clipLayer(seq, mt, mc, frame, W, H, opts) : null;
          const o = gl.acquire(W, H);
          gl.pass('matte', MATTE, o, { uTex: lf, uMatte: ml ? ml.fbo : gl.transparent }, { uLuma: tm.params.composite === 'luma' ? 1 : 0, uRev: tm.params.reverse });
          gl.release(lf); if (ml) gl.release(ml.fbo); lf = o;
        }
        acc = this.blend(acc, lf, layer.blend, 1);
        gl.release(lf);
      }
      if (opts.captions && seq.captionTracks && seq.captionTracks.length) acc = this.captions(seq, frame, acc, W, H);
      if (this.__burnTC && this.depth === 1) {
        const p = this.__burnTC.params;
        const text = framesToTC(frame + (seq.settings.startTC || 0), seq.settings.fps);
        const key = 'tcb:' + W + 'x' + H + ':' + text;
        const e = this.pool.canvasTexture(key, W, H, (ctx) => drawOverlayText(ctx, text, p, W, H));
        const o = gl.acquire(W, H); gl.pass('over', OVER, o, { uDst: acc, uSrc: e.tex }); gl.release(acc); acc = o;
      }
    } finally { this.depth--; }
    return acc;
  }

  blend(acc, layer, mode, op) {
    const gl = this.gl;
    const out = gl.acquire(acc.w, acc.h);
    if (!mode || mode === 'normal') gl.pass('over', OVER, out, { uDst: acc, uSrc: layer });
    else gl.pass('blend', BLEND, out, { uDst: acc, uSrc: layer }, { uMode: Math.max(0, BLEND_MODES.indexOf(mode)), uOp: op });
    gl.release(acc);
    return out;
  }

  // Composite to display: add background, return bytes-capable FBO
  finalize(fbo, opts = {}) {
    const gl = this.gl;
    const out = gl.acquire(fbo.w, fbo.h, { bytes: !!opts.bytes });
    if (opts.checker) gl.pass('checker', CHECKER, out, { uTex: fbo });
    else gl.pass('bg', BG, out, { uTex: fbo }, { uBg: opts.background || [0, 0, 0] });
    return out;
  }

  // ---------- clip rendering ----------
  sourceLayer(seq, clip, frame, opts) {
    const gl = this.gl;
    const project = this.project;
    const item = project.items[clip.src.itemId];
    const fps = seq.settings.fps;
    const scale = opts.scale || 1;
    const local = frame - clip.start;
    let srcTime = clipSourceTime(clip, frame, fps);
    const pt = clip.effects.find((e) => e.type === 'posterize_time' && e.enabled);
    if (pt) { const q = 1 / Math.max(1, paramValue(pt, 'fps', local)); srcTime = Math.floor(srcTime / q) * q; }
    let tex = null, w = seq.settings.width, h = seq.settings.height, alpha = 0, space = 0, par = 1;
    if (!item) {
      if (clip.src.type === 'graphic' && clip.graphic) {
        // standalone graphic clip
      } else return { tex: this.pool.offline('Media Offline'), w: 640, h: 360, scale: 1 };
    }
    const type = clip.src.type;
    if (type === 'media') {
      if (item.offline) return { tex: this.pool.offline('Media Offline'), w: 640, h: 360, scale };
      const info = item.info;
      par = item.interpret.pixelAspect || info.pixelAspect || 1;
      alpha = { auto: 0, ignore: 1, invert: 2, premultiplied: 3 }[item.interpret.alpha] || 0;
      const cs = item.interpret.colorSpace;
      const autoTm = this.project.settings.color.autoToneMapHDR !== false && seq.settings.colorSpace === 'rec709';
      if (cs === 'pq' || (cs === 'auto' && autoTm && info.colorTransfer === 'smpte2084')) space = 1;
      else if (cs === 'hlg' || (cs === 'auto' && autoTm && info.colorTransfer === 'arib-std-b67')) space = 2;
      if (info.kind === 'image' || info.kind === 'psd') {
        const p = info.kind === 'psd' ? item.psdComposite : item.path;
        const r = p ? this.pool.imageTexture(p) : { tex: this.pool.offline('Importing') };
        tex = r.tex; w = r.w || info.width || 1920; h = r.h || info.height || 1080;
      } else {
        const mf = itemFps(item), nf = nativeFps(item);
        const mediaTime = mf && nf ? srcTime * mf / nf : srcTime;
        const r = this.pool.videoTexture(this.mediaPath(item, clip), mediaTime, clip.id + (opts.ownerSuffix || ''), { playing: opts.playing && !clip.reverse && !clip.timeRemap && clip.frameHold == null && !pt, rate: (opts.rate || 1) * clip.speed * (mf && nf ? mf / nf : 1), fps: nf || 30 });
        tex = r.tex; w = info.width || r.w || 1920; h = info.height || r.h || 1080;
        if (info.rotation && Math.abs(info.rotation) % 180 === 90) { /* Chromium applies rotation to decoded frames */ const t = w; w = h; h = t; }
        if (r.error) { tex = this.pool.offline('Unsupported codec - creating proxy'); }
      }
      if (!tex) return null;
      return { tex: { tex: tex.tex || tex, w, h }, w: w * par, h, alpha, space, scale };
    }
    if (type === 'sequence') {
      const nested = item;
      if (!nested || this.depth > 12) return null;
      const nf = Math.round(srcTime * nested.settings.fps);
      const angle = nested.multicam ? (clip.angle != null ? clip.angle : 0) : null;
      const fbo = this.renderSequence(nested, nf, { ...opts, captions: false, angleOnly: angle, ownerSuffix: (opts.ownerSuffix || '') + ':' + clip.id });
      return { fbo, tex: fbo, w: nested.settings.width, h: nested.settings.height, scale, nestedScale: scale };
    }
    if (type === 'graphic' || (item && item.type === 'graphic')) {
      const g = clip.graphic || (item && item.graphic);
      const W = Math.round(seq.settings.width * scale), H = Math.round(seq.settings.height * scale);
      const animated = g.layers.some((l) => (l.anim && l.anim !== 'none') || Object.values(l.keyframes || {}).some((k) => k && k.length));
      const key = 'gfx:' + clip.id + ':' + W + 'x' + H + ':' + (animated ? local + ':' + clip.dur : '') + ':' + hashStr(JSON.stringify(g));
      const e = this.pool.canvasTexture(key, W, H, (ctx) => drawGraphic(ctx, g, W, H, local, fps, clip.dur, scale * seq.settings.height / 1080 * (1080 / seq.settings.height)));
      return { tex: e.tex, w: seq.settings.width, h: seq.settings.height, scale, graphic: true };
    }
    if (type === 'synthetic') {
      const g = item.generator;
      const W = seq.settings.width, H = seq.settings.height;
      if (g === 'bars') return { tex: this.pool.barsTexture(Math.round(W * scale), Math.round(H * scale)), w: W, h: H, scale };
      if (g === 'countdown') { const sec = Math.floor(local / fps); return { tex: this.pool.countdownTexture(Math.round(W * scale), Math.round(H * scale), sec, (local % fps) / fps), w: W, h: H, scale }; }
      const fbo = gl.acquire(Math.round(W * scale), Math.round(H * scale));
      const c = g === 'matte' ? [...hexToRgb(item.color).slice(0, 3), 1] : g === 'black' ? [0, 0, 0, 1] : [0, 0, 0, 0];
      gl.pass('solid', SOLID, fbo, {}, { uColor: c });
      return { fbo, tex: fbo, w: W, h: H, scale };
    }
    return null;
  }

  clipLayer(seq, track, clip, frame, W, H, opts) {
    const gl = this.gl;
    const src = this.sourceLayer(seq, clip, frame, opts);
    if (!src || !src.tex) { if (src && src.fbo) gl.release(src.fbo); return null; }
    const scale = opts.scale || 1;
    const local = frame - clip.start;
    const fps = seq.settings.fps;
    // Layer resolution: source size at preview scale, limited for performance
    const maxDim = Math.max(W, H) * 2;
    let lw = Math.max(2, Math.round(src.w * scale)), lh = Math.max(2, Math.round(src.h * scale));
    const lim = Math.min(1, maxDim / Math.max(lw, lh));
    lw = Math.round(lw * lim); lh = Math.round(lh * lim);
    const pxScale = scale * lim;
    let cur = gl.acquire(lw, lh);
    gl.pass('source', SOURCE, cur, { uTex: src.tex }, { uAlpha: src.alpha || 0, uSpace: src.space || 0, uCropUV0: [0, 0], uCropUV1: [1, 1] });
    if (src.fbo) gl.release(src.fbo);

    const item = this.project.items[clip.src.itemId];
    const info = this.effectInfo(seq, clip, frame, local, pxScale, item);
    // Effects (non-intrinsic) in order
    for (const fx of clip.effects) {
      if (!fx.enabled || fx.type === 'motion' || fx.type === 'opacity' || fx.type === 'timeremap' || fx.type === 'track_matte' || fx.type === 'posterize_time') continue;
      const impl = EFFECT_IMPL[fx.type] || (PLUGIN_EFFECTS[fx.type] && PLUGIN_EFFECTS[fx.type].impl);
      if (!impl) continue;
      const p = resolveParams(fx, local);
      if (fx.type === 'transform') info.sample = (dt) => resolveParams(fx, local + dt);
      let out;
      try { out = impl(this.ctx, cur, p, info); } catch (e) { console.error('Effect failed', fx.type, e); continue; }
      if (fx.masks && fx.masks.length) {
        const mtex = this.maskTexture(fx.masks, local, lw, lh, pxScale);
        const mixed = this.ctx.mixMask(cur, out, mtex);
        gl.release(out); out = mixed;
      }
      gl.release(cur); cur = out;
    }
    // Opacity masks (layer space)
    const opFx = clip.effects.find((e) => e.type === 'opacity');
    const opP = opFx && opFx.enabled ? resolveParams(opFx, local) : { opacity: 100, blendMode: 'normal' };
    if (opFx && opFx.enabled && opFx.masks && opFx.masks.length) {
      const mtex = this.maskTexture(opFx.masks, local, lw, lh, pxScale);
      const o = gl.acquire(lw, lh); gl.pass('mulalpha', MULALPHA, o, { uTex: cur, uMask: mtex }, { uOp: 1 }); gl.release(cur); cur = o;
    }
    // Motion into sequence space
    const mo = clip.effects.find((e) => e.type === 'motion');
    const m = mo && mo.enabled ? resolveParams(mo, local) : { position: [0.5, 0.5], scale: 100, scaleWidth: 100, uniform: true, rotation: 0, anchor: [0.5, 0.5], cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0, flipH: false, flipV: false, antiFlicker: 0 };
    let base = 1;
    const seqW = seq.settings.width, seqH = seq.settings.height;
    if (clip.setToFrame || clip.scaleToFrame || src.graphic) base = src.graphic ? 1 : Math.min(seqW / src.w, seqH / src.h);
    if (clip.reframe && clip.reframe.keys && clip.reframe.keys.length) {
      // auto reframe: fill frame and follow analysed subject center
      base = Math.max(seqW / src.w, seqH / src.h);
    }
    const sx = base * (m.scale / 100) * ((m.uniform ? m.scale : m.scaleWidth) / Math.max(0.0001, m.scale));
    const sy = base * (m.scale / 100);
    let pos = [m.position[0], 1 - m.position[1]];
    let anchor = [m.anchor[0], 1 - m.anchor[1]];
    if (clip.reframe && clip.reframe.keys && clip.reframe.keys.length) {
      const rf = clip.effects.find((e) => e.type === 'auto_reframe');
      const k = sampleReframe(clip.reframe.keys, local);
      anchor = [k[0], 1 - k[1]];
      if (rf) { const rp = resolveParams(rf, local); pos = [0.5 + rp.offset[0], 0.5 - rp.offset[1]]; }
    }
    // Express layer->seq mapping in sequence pixel units (full res) then normalized
    const inv = affineInverse({ anchor, position: pos, scaleX: sx * src.w / seqW * seqW, scaleY: sy * src.h / seqH * seqH, rotation: -m.rotation, srcW: src.w, srcH: src.h, dstW: seqW, dstH: seqH });
    // inv maps out uv -> in uv where scale factors were given in pixel ratio; fix: affineInverse expects scale as px/px
    const inv2 = affineInverse({ anchor, position: pos, scaleX: sx, scaleY: sy, rotation: -m.rotation, srcW: src.w, srcH: src.h, dstW: seqW, dstH: seqH });
    void inv;
    const out = gl.acquire(W, H);
    const opacity = (opP.opacity == null ? 100 : opP.opacity) / 100;
    const needsBlend = opP.blendMode && opP.blendMode !== 'normal';
    gl.pass('motion', MOTION, out, { uTex: cur }, {
      uInv: inv2, uCrop: [m.cropLeft / 100, m.cropTop / 100, m.cropRight / 100, m.cropBottom / 100], uOpacity: opacity,
      uFlip: [m.flipH ? 1 : 0, m.flipV ? 1 : 0], uAA: m.antiFlicker || 0,
    });
    gl.release(cur);
    return { fbo: out, blend: needsBlend ? opP.blendMode : 'normal' };
  }

  adjustment(seq, clip, frame, acc, W, H, opts) {
    const gl = this.gl;
    const local = frame - clip.start;
    let cur = this.ctx.copy(acc);
    const info = this.effectInfo(seq, clip, frame, local, opts.scale || 1, null);
    for (const fx of clip.effects) {
      if (!fx.enabled || ['motion', 'opacity', 'timeremap', 'track_matte', 'posterize_time'].includes(fx.type)) continue;
      const impl = EFFECT_IMPL[fx.type] || (PLUGIN_EFFECTS[fx.type] && PLUGIN_EFFECTS[fx.type].impl);
      if (!impl) continue;
      let out = impl(this.ctx, cur, resolveParams(fx, local), info);
      if (fx.masks && fx.masks.length) { const mt = this.maskTexture(fx.masks, local, W, H, opts.scale || 1); const mx = this.ctx.mixMask(cur, out, mt); gl.release(out); out = mx; }
      gl.release(cur); cur = out;
    }
    const opFx = clip.effects.find((e) => e.type === 'opacity');
    const op = opFx && opFx.enabled ? resolveParams(opFx, local).opacity / 100 : 1;
    const mt = opFx && opFx.masks && opFx.masks.length ? this.maskTexture(opFx.masks, local, W, H, opts.scale || 1) : gl.white;
    const out = gl.acquire(W, H);
    gl.pass('adj', ADJ, out, { uA: acc, uB: cur, uMask: mt }, { uOp: op });
    gl.release(cur); gl.release(acc);
    return out;
  }

  effectInfo(seq, clip, frame, local, pxScale, item) {
    const fps = seq.settings.fps;
    return {
      scale: pxScale, frame, localFrame: local, fps, time: local / fps, seqW: seq.settings.width, seqH: seq.settings.height,
      lumetriTextures: (p) => this.lumetriTextures(p), dummyLut: () => this.dummyLut(), loadLut: (p) => this.loadLut(p),
      clipName: clip.name || (item && item.name) || '',
      timecodeText: (p) => (p.prefix || '') + framesToTC(p.source === 'media' ? Math.round(clipSourceTime(clip, frame, fps) * fps) : frame + (seq.settings.startTC || 0), fps),
      overlayText: (inp, p, text) => {
        const w = inp.w, h = inp.h;
        const key = 'ovl:' + w + 'x' + h + ':' + text + ':' + JSON.stringify(p);
        const e = this.pool.canvasTexture(key, w, h, (ctx) => drawOverlayText(ctx, text, p, w, h));
        const o = this.gl.acquire(w, h); this.gl.pass('over', OVER, o, { uDst: inp, uSrc: e.tex }); return o;
      },
    };
  }

  maskTexture(masks, local, w, h, scale) {
    const key = 'mask:' + w + 'x' + h + ':' + hashStr(maskHash(masks, local));
    return this.pool.canvasTexture(key, w, h, (ctx) => {
      const c = ctx.canvas; rasterizeMasks(c, masks, local, scale);
    }).tex;
  }

  captions(seq, frame, acc, W, H) {
    const gl = this.gl;
    for (const ct of seq.captionTracks) {
      if (!ct.visible) continue;
      const cap = ct.captions.find((c) => frame >= c.start && frame < c.end);
      if (!cap) continue;
      let wordIndex = null;
      if (ct.style && ct.style.wordByWord) { const words = cap.text.split(/\s+/).length; wordIndex = Math.min(words - 1, Math.floor((frame - cap.start) / Math.max(1, (cap.end - cap.start) / words))); }
      const key = 'cap:' + W + 'x' + H + ':' + hashStr(JSON.stringify([cap.text, cap.style, ct.style, wordIndex]));
      const e = this.pool.canvasTexture(key, W, H, (ctx) => drawCaption(ctx, cap, ct.style, W, H, { wordIndex }));
      const o = gl.acquire(W, H); gl.pass('over', OVER, o, { uDst: acc, uSrc: e.tex }); gl.release(acc); acc = o;
    }
    return acc;
  }

  // Render one source item frame (Source Monitor)
  renderSource(item, t, opts = {}) {
    const gl = this.gl;
    const scale = opts.scale || 1;
    if (item.type === 'sequence') return this.renderSequence(item, Math.round(t * item.settings.fps), { ...opts, captions: true });
    const fakeSeq = { settings: { width: item.info ? item.info.width || 1920 : item.width || 1920, height: item.info ? item.info.height || 1080 : item.height || 1080, fps: (item.info && item.info.fps) || 30 } };
    if (item.type === 'graphic') { fakeSeq.settings.width = 1920; fakeSeq.settings.height = 1080; }
    const clip = { id: 'source:' + item.id, src: { type: item.type === 'media' ? 'media' : item.type === 'graphic' ? 'graphic' : 'synthetic', itemId: item.id }, start: 0, dur: 1e9, srcIn: 0, speed: 1, reverse: false, effects: [], graphic: item.graphic };
    const W = Math.max(2, Math.round(fakeSeq.settings.width * scale)), H = Math.max(2, Math.round(fakeSeq.settings.height * scale));
    const frame = Math.round(t * fakeSeq.settings.fps);
    const src = this.sourceLayer(fakeSeq, clip, frame, { ...opts, ownerSuffix: ':src' });
    const out = gl.acquire(W, H);
    gl.clear(out, [0, 0, 0, 0]);
    if (src && src.tex) gl.pass('source', SOURCE, out, { uTex: src.tex }, { uAlpha: src.alpha || 0, uSpace: src.space || 0, uCropUV0: [0, 0], uCropUV1: [1, 1] });
    if (src && src.fbo) gl.release(src.fbo);
    return out;
  }

  toBytes(fbo) {
    const gl = this.gl;
    const o = gl.acquire(fbo.w, fbo.h, { bytes: true });
    gl.pass('tobytes', TOBYTES, o, { uTex: fbo });
    const data = gl.read(o);
    gl.release(o);
    return data;
  }

  present(fbo, viewport) {
    // draw to the canvas (default framebuffer)
    this.gl.pass('present', COPY, null, { uTex: fbo }, {}, { viewport });
  }
}

function sampleReframe(keys, t) {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) if (keys[i].t >= t) { const a = keys[i - 1], b = keys[i]; const u = (t - a.t) / Math.max(1, b.t - a.t); return [a.v[0] + (b.v[0] - a.v[0]) * u, a.v[1] + (b.v[1] - a.v[1]) * u]; }
  return keys[keys.length - 1].v;
}

export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
export { BLEND_MODES };
