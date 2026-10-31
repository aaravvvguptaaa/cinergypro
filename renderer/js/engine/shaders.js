// GPU implementations of every video effect and transition.
// Each effect receives a premultiplied RGBA input FBO and returns a new FBO.
import { hexToRgb } from '../core/util.js';

const rgb = (hex) => hexToRgb(hex).slice(0, 3);
const P = (p) => [p[0], 1 - p[1]]; // UI point (y down) -> uv (y up)

export const COPY = `uniform sampler2D uTex; void main(){ fragColor = texture(uTex, vUv); }`;
const COPY_FLIP = `uniform sampler2D uTex; void main(){ fragColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)); }`;

const BLUR1D = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uDir; uniform float uSigma; uniform int uRepeat;
vec4 tap(vec2 uv){ if(uRepeat==0 && (uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)) return vec4(0.); return texture(uTex, uv); }
void main(){
  if(uSigma < 0.3){ fragColor = texture(uTex, vUv); return; }
  vec2 st = uDir / uTexSize; vec4 acc = vec4(0.); float wsum = 0.;
  int r = int(min(ceil(uSigma*3.0), 40.0));
  for(int i=-40;i<=40;i++){ if(i<-r||i>r) continue; float w = exp(-float(i*i)/(2.*uSigma*uSigma)); acc += tap(vUv + st*float(i))*w; wsum += w; }
  fragColor = acc / wsum; }`;

const MIX_MASK = `uniform sampler2D uTex; uniform sampler2D uFx; uniform sampler2D uMask; uniform float uHasMask;
void main(){ vec4 a = texture(uTex, vUv), b = texture(uFx, vUv); float m = uHasMask > 0.5 ? texture(uMask, vec2(vUv.x, vUv.y)).r : 1.0; fragColor = mix(a, b, m); }`;

// ---------------- Helpers ----------------
export function makeCtx(gl) {
  const ctx = {
    gl,
    acquire: (w, h, o) => gl.acquire(w, h, o),
    release: (f) => gl.release(f),
    pass: (key, frag, target, tex, uni) => gl.pass(key, frag, target, tex, uni),
    copy(src, w = src.w, h = src.h) { const o = gl.acquire(w, h); gl.pass('copy', COPY, o, { uTex: src }); return o; },
    blur(src, radius, dims = 'both', repeat = true) {
      const out = gl.acquire(src.w, src.h);
      if (radius < 0.5) { gl.pass('copy', COPY, out, { uTex: src }); return out; }
      let scale = 1;
      while (radius / scale > 10 && scale < 32) scale *= 2;
      const sw = Math.max(1, Math.round(src.w / scale)), sh = Math.max(1, Math.round(src.h / scale));
      let cur = src, tmp = null;
      if (scale > 1) { tmp = gl.acquire(sw, sh); gl.pass('copy', COPY, tmp, { uTex: src }); cur = tmp; }
      const sigma = radius / scale / 2;
      const a = gl.acquire(sw, sh), b = gl.acquire(sw, sh);
      gl.pass('blur1d', BLUR1D, a, { uTex: cur }, { uDir: dims === 'v' ? [0, 0] : [1, 0], uSigma: dims === 'v' ? 0 : sigma, uRepeat: repeat ? 1 : 0 });
      gl.pass('blur1d', BLUR1D, b, { uTex: a }, { uDir: dims === 'h' ? [0, 0] : [0, 1], uSigma: dims === 'h' ? 0 : sigma, uRepeat: repeat ? 1 : 0 });
      gl.pass('copy', COPY, out, { uTex: b });
      gl.release(a); gl.release(b); if (tmp) gl.release(tmp);
      return out;
    },
    mixMask(input, fx, mask) {
      const o = gl.acquire(input.w, input.h);
      gl.pass('mixmask', MIX_MASK, o, { uTex: input, uFx: fx, uMask: mask || gl.white }, { uHasMask: mask ? 1 : 0 });
      return o;
    },
  };
  return ctx;
}

function simple(key, frag, uniformsFn, texFn) {
  return (ctx, inp, p, info) => {
    const o = ctx.acquire(inp.w, inp.h);
    ctx.pass(key, frag, o, { uTex: inp, ...(texFn ? texFn(ctx, inp, p, info) : {}) }, uniformsFn ? uniformsFn(p, info, inp) : {});
    return o;
  };
}

// ---------------- Lumetri ----------------
const LOG_FUNCS = `
float slog3(float x){ return x >= 171.2102946929/1023.0 ? pow(10.0,(x*1023.0-420.0)/261.5)*(0.18+0.01)-0.01 : (x*1023.0-95.0)*0.01125000/(171.2102946929-95.0); }
float clog3(float x){ return x < 0.097465473 ? -(pow(10.0,(0.12783901-x)/0.36726845)-1.0)/14.98325 : (x <= 0.15277891 ? (x-0.12512219)/1.9754798 : (pow(10.0,(x-0.12240537)/0.36726845)-1.0)/14.98325); }
float vlog(float x){ return x < 0.181 ? (x-0.125)/5.6 : pow(10.0,(x-0.598206)/0.241514)-0.00873; }
float logc3(float x){ return x > 0.1496582 ? (pow(10.0,(x-0.385537)/0.2471896)-0.052272)/5.555556 : (x-0.092809)/5.367655; }
float logc4(float x){ float a=(pow(2.0,18.0)-16.0)/117.45; float b=(1023.0-95.0)/1023.0; float c=95.0/1023.0; float s=(7.0*log(2.0)*pow(2.0,7.0-14.0*c/b))/(a*b); float t=(pow(2.0,14.0*(-c/b)+6.0)-64.0)/a; return x>=0.0 ? (pow(2.0,14.0*(x-c)/b+6.0)-64.0)/a : x*s+t; }
float nlog(float x){ return x < 452.0/1023.0 ? pow(x/(650.0/1023.0),3.0)-0.0075 : exp((x-619.0/1023.0)/(150.0/1023.0)); }
float flog(float x){ return x >= 0.100537775223865 ? (pow(10.0,(x-0.790453)/0.344676)-0.009468)/0.555556 : (x-0.092864)/8.735631; }
float dlog(float x){ return x <= 0.14 ? (x-0.0929)/6.025 : (pow(10.0,3.89616*x-2.27752)-0.0108)/0.9892; }
float pqEotf(float x){ float m1=0.1593017578125, m2=78.84375, c1=0.8359375, c2=18.8515625, c3=18.6875; float p=pow(max(x,0.0),1.0/m2); return pow(max(p-c1,0.0)/(c2-c3*p),1.0/m1)*10000.0/203.0; }
float hlgInv(float x){ float a=0.17883277,b=0.28466892,c=0.55991073; return x<=0.5 ? x*x/3.0 : (exp((x-c)/a)+b)/12.0; }
vec3 tonemap(vec3 x){ x *= 0.8; vec3 a = x*(2.51*x+0.03); vec3 b = x*(2.43*x+0.59)+0.14; return clamp(a/b, 0.0, 1.0); }
vec3 oetf709(vec3 l){ return mix(4.5*l, 1.099*pow(max(l,vec3(0.0)),vec3(0.45))-0.099, step(vec3(0.018), l)); }
vec3 bt2020to709(vec3 c){ return mat3(1.6605,-0.1246,-0.0182,-0.5876,1.1329,-0.1006,-0.0728,-0.0083,1.1187)*c; }
vec3 applyInputLut(vec3 c, int m){
  if(m==0) return c;
  vec3 lin;
  if(m==1) lin=vec3(slog3(c.r),slog3(c.g),slog3(c.b));
  else if(m==2) lin=vec3(clog3(c.r),clog3(c.g),clog3(c.b));
  else if(m==3) lin=vec3(vlog(c.r),vlog(c.g),vlog(c.b));
  else if(m==4) lin=vec3(logc3(c.r),logc3(c.g),logc3(c.b));
  else if(m==5) lin=vec3(logc4(c.r),logc4(c.g),logc4(c.b));
  else if(m==6) lin=vec3(nlog(c.r),nlog(c.g),nlog(c.b));
  else if(m==7) lin=vec3(flog(c.r),flog(c.g),flog(c.b));
  else if(m==8) lin=vec3(dlog(c.r),dlog(c.g),dlog(c.b));
  else if(m==9) { lin=vec3(hlgInv(c.r),hlgInv(c.g),hlgInv(c.b))*3.5; lin=bt2020to709(lin); }
  else { lin=vec3(pqEotf(c.r),pqEotf(c.g),pqEotf(c.b)); lin=bt2020to709(lin); }
  return oetf709(tonemap(max(lin,vec3(0.0))*1.8));
}`;

const LUMETRI = LOG_FUNCS + `
uniform sampler2D uTex; uniform vec2 uTexSize; uniform sampler2D uCurves; uniform sampler2D uHue; uniform highp sampler3D uLut;
uniform int uInputLut; uniform float uTemp, uTint, uExposure, uContrast, uHigh, uShad, uWhites, uBlacks, uSat, uVib;
uniform float uLutOn, uLutAmt, uFaded, uSharpen, uTintBal; uniform vec3 uShTint, uHiTint;
uniform float uCurvesOn, uHueOn; uniform vec3 uLift, uGamma, uGain; uniform vec3 uWheelLum;
uniform float uHslOn; uniform vec3 uHk, uSk, uLk; uniform float uHslInvert, uHslShow, uHslTemp, uHslTint, uHslContrast, uHslSat; uniform vec3 uHslShift;
uniform float uVigAmt, uVigMid, uVigRound, uVigFeather;
vec3 wb(vec3 c, float t, float ti){ return c * vec3(1.0+0.22*t+0.05*ti, 1.0-0.12*ti, 1.0-0.22*t+0.05*ti); }
float soft(float x, float lo, float hi, float s){ return smoothstep(lo-s, lo, x) * (1.0 - smoothstep(hi, hi+s, x)); }
float hueKey(float h, vec3 k){ float c=k.x, w=k.y, s=max(k.z,0.001); float d=abs(h-c); d=min(d,1.0-d); return 1.0-smoothstep(w, w+s, d); }
void main(){
  vec4 src = unpm(texture(uTex, vUv));
  vec3 c = src.rgb;
  c = applyInputLut(c, uInputLut);
  // sharpen (unsharp, 4 taps)
  if(abs(uSharpen) > 0.001){ vec2 px = 1.0/uTexSize; vec3 n = unpm(texture(uTex,vUv+vec2(px.x,0))).rgb+unpm(texture(uTex,vUv-vec2(px.x,0))).rgb+unpm(texture(uTex,vUv+vec2(0,px.y))).rgb+unpm(texture(uTex,vUv-vec2(0,px.y))).rgb; c += (c - n*0.25) * uSharpen * 2.0; }
  c = wb(c, uTemp, uTint);
  c *= exp2(uExposure);
  c = (c - 0.5) * (1.0 + uContrast * 0.6) + 0.5;
  float l = luma(c);
  c += uHigh * 0.3 * smoothstep(0.45, 1.0, l) * (1.0 - smoothstep(1.0, 1.4, l));
  c += uShad * 0.3 * (1.0 - smoothstep(0.0, 0.55, l));
  float wp = 1.0 - uWhites * 0.25, bp = -uBlacks * 0.12;
  c = (c - bp) / max(wp - bp, 0.01);
  l = luma(c);
  float sat = length(c - l);
  c = mix(vec3(l), c, uSat);
  c = mix(vec3(l), c, 1.0 + uVib * (1.0 - clamp(sat*2.5,0.0,1.0)));
  // creative
  if(uLutOn > 0.5){ vec3 lc = texture(uLut, clamp(c,0.0,1.0)).rgb; c = mix(c, lc, uLutAmt); }
  c = c * (1.0 - uFaded * 0.18) + uFaded * 0.09;
  l = luma(c);
  float bal = uTintBal * 0.25;
  c += (uShTint - 0.5) * 0.6 * (1.0 - smoothstep(0.0, 0.5 + bal, l));
  c += (uHiTint - 0.5) * 0.6 * smoothstep(0.5 + bal, 1.0, l);
  // wheels (lift/gamma/gain) + luminance sliders
  c = c + uLift * (1.0 - c) + uWheelLum.x * 0.25 * (1.0 - c);
  c = max(c, 0.0);
  c = pow(c, 1.0 / max(vec3(0.05), vec3(1.0) + uGamma * 0.8 + uWheelLum.y * 0.5));
  c = c * (1.0 + uGain + uWheelLum.z * 0.5);
  // curves (r,g,b,master in texture channels)
  if(uCurvesOn > 0.5){
    vec3 cc = clamp(c, 0.0, 1.0);
    cc = vec3(texture(uCurves, vec2(cc.r, 0.5)).a, texture(uCurves, vec2(cc.g, 0.5)).a, texture(uCurves, vec2(cc.b, 0.5)).a);
    cc = vec3(texture(uCurves, vec2(cc.r, 0.5)).r, texture(uCurves, vec2(cc.g, 0.5)).g, texture(uCurves, vec2(cc.b, 0.5)).b);
    c = cc + (c - clamp(c,0.0,1.0));
  }
  if(uHueOn > 0.5){
    vec3 hsl = rgb2hsl(clamp(c,0.0,1.0));
    vec4 hc = texture(uHue, vec2(hsl.x, 0.25));
    vec4 hc2 = texture(uHue, vec2(hsl.z, 0.25));
    vec4 hs2 = texture(uHue, vec2(hsl.y, 0.75));
    hsl.x = fract(hsl.x + (hc.g - 0.5));
    hsl.y = clamp(hsl.y * (hc.r * 2.0) * (hc2.a * 2.0) * (hs2.r * 2.0), 0.0, 1.0);
    hsl.z = clamp(hsl.z + (hc.b - 0.5) * 0.5 * hsl.y, 0.0, 1.0);
    c = hsl2rgb(hsl);
  }
  // HSL secondary
  if(uHslOn > 0.5){
    vec3 hsl = rgb2hsl(clamp(c,0.0,1.0));
    float k = hueKey(hsl.x, uHk) * soft(hsl.y, uSk.x, uSk.y, uSk.z) * soft(hsl.z, uLk.x, uLk.y, uLk.z);
    if(uHslInvert > 0.5) k = 1.0 - k;
    if(uHslShow > 0.5){ fragColor = vec4(vec3(k), 1.0); return; }
    vec3 s2 = wb(c, uHslTemp, uHslTint);
    s2 = (s2 - 0.5) * (1.0 + uHslContrast*0.6) + 0.5;
    float l2 = luma(s2); s2 = mix(vec3(l2), s2, uHslSat) + uHslShift;
    c = mix(c, s2, k);
  }
  // vignette
  if(abs(uVigAmt) > 0.001){
    vec2 p = (vUv - 0.5) * 2.0; float asp = uTexSize.x/uTexSize.y;
    p.x *= mix(1.0, asp, clamp(0.5 - uVigRound*0.5, 0.0, 1.0));
    float d = length(p) / mix(1.4142, 1.0, 0.5);
    float mid = uVigMid; float v = smoothstep(mid, mid + max(uVigFeather, 0.01), d);
    c = uVigAmt < 0.0 ? c * (1.0 + uVigAmt * 0.6 * v) : mix(c, vec3(1.0), uVigAmt * 0.4 * v);
  }
  fragColor = pm(vec4(c, src.a));
}`;

const INPUT_LUTS = { none: 0, slog3: 1, clog3: 2, vlog: 3, logc3: 4, logc4: 5, nlog: 6, flog: 7, dlog: 8, hlg: 9, pq: 10 };

function wheelShift(v) { const [x, y] = v; return [1.402 * y * 0.25, (-0.344 * x - 0.714 * y) * 0.25, 1.772 * x * 0.25]; }

function lumetri(ctx, inp, p, info) {
  const o = ctx.acquire(inp.w, inp.h);
  const textures = info.lumetriTextures(p);
  const w = p.wheels || {};
  const hk = p.hslKey || {};
  ctx.pass('lumetri', LUMETRI, o, { uTex: inp, uCurves: textures.curves, uHue: textures.hue, uLut: textures.lut || info.dummyLut() }, {
    uInputLut: INPUT_LUTS[p.inputLut] || 0, uTemp: p.temperature / 100, uTint: p.tint / 100, uExposure: p.exposure, uContrast: p.contrast / 100,
    uHigh: p.highlights / 100, uShad: p.shadows / 100, uWhites: p.whites / 100, uBlacks: p.blacks / 100, uSat: p.saturation / 100, uVib: p.vibrance / 100,
    uLutOn: textures.lut ? 1 : 0, uLutAmt: p.lookIntensity / 100, uFaded: p.faded / 100, uSharpen: p.sharpen / 100, uTintBal: p.tintBalance / 100,
    uShTint: rgb(p.shadowTint), uHiTint: rgb(p.highlightTint), uCurvesOn: textures.curvesOn ? 1 : 0, uHueOn: textures.hueOn ? 1 : 0,
    uLift: wheelShift(w.shadows || [0, 0]), uGamma: wheelShift(w.midtones || [0, 0]), uGain: wheelShift(w.highlights || [0, 0]),
    uWheelLum: [(w.shadows || [0, 0, 0])[2] || 0, (w.midtones || [0, 0, 0])[2] || 0, (w.highlights || [0, 0, 0])[2] || 0],
    uHslOn: p.hslEnabled ? 1 : 0, uHk: hk.h || [0, 0.1, 0.05], uSk: hk.s || [0, 1, 0.1], uLk: hk.l || [0, 1, 0.1], uHslInvert: hk.invert ? 1 : 0, uHslShow: hk.showMask ? 1 : 0,
    uHslTemp: p.hslTemp / 100, uHslTint: p.hslTint / 100, uHslContrast: p.hslContrast / 100, uHslSat: p.hslSaturation / 100, uHslShift: wheelShift(p.hslWheel || [0, 0]),
    uVigAmt: p.vignetteAmount / 5, uVigMid: p.vignetteMidpoint / 100, uVigRound: p.vignetteRoundness / 100, uVigFeather: p.vignetteFeather / 100,
  });
  return o;
}

// ---------------- Color & channel ----------------
const BC = `uniform sampler2D uTex; uniform float uB, uC; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=s.rgb+uB; c=(c-0.5)*uC+0.5; fragColor=pm(vec4(c,s.a)); }`;
const COLOR_BALANCE = `uniform sampler2D uTex; uniform vec3 uS, uM, uH; uniform float uPres; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=s.rgb; float l=luma(c);
  float sw=1.0-smoothstep(0.0,0.5,l), hw=smoothstep(0.5,1.0,l), mw=1.0-sw-hw; vec3 r=c+uS*sw*0.4+uM*mw*0.4+uH*hw*0.4; if(uPres>0.5) r += l - luma(r); fragColor=pm(vec4(r,s.a)); }`;
const LEVELS = `uniform sampler2D uTex; uniform float uIb,uIw,uG,uOb,uOw; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=clamp((s.rgb-uIb)/max(uIw-uIb,0.001),0.0,1.0); c=pow(c,vec3(1.0/uG)); c=mix(vec3(uOb),vec3(uOw),c); fragColor=pm(vec4(c,s.a)); }`;
const TINT = `uniform sampler2D uTex; uniform vec3 uBlack,uWhite; uniform float uAmt; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 t=mix(uBlack,uWhite,luma(s.rgb)); fragColor=pm(vec4(mix(s.rgb,t,uAmt),s.a)); }`;
const CHANGE_COLOR = `uniform sampler2D uTex; uniform vec3 uFrom,uTo; uniform float uTol,uSoft; uniform int uMode; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 h=rgb2hsl(s.rgb), hf=rgb2hsl(uFrom), ht=rgb2hsl(uTo);
  float d=abs(h.x-hf.x); d=min(d,1.0-d); float dist = d + (uMode>0? abs(h.y-hf.y)*0.5:0.0) + (uMode>1? abs(h.z-hf.z)*0.5:0.0);
  float k=1.0-smoothstep(uTol,uTol+uSoft+0.0001,dist); vec3 nh=h; nh.x=ht.x; if(uMode>0) nh.y=ht.y; if(uMode>1) nh.z=ht.z; fragColor=pm(vec4(mix(s.rgb,hsl2rgb(nh),k),s.a)); }`;
const LEAVE_COLOR = `uniform sampler2D uTex; uniform vec3 uCol; uniform float uAmt,uTol,uSoft; void main(){ vec4 s=unpm(texture(uTex,vUv)); float d=distance(s.rgb,uCol)/1.732; float keep=1.0-smoothstep(uTol,uTol+uSoft+0.0001,d); vec3 g=vec3(luma(s.rgb)); fragColor=pm(vec4(mix(s.rgb,g,uAmt*(1.0-keep)),s.a)); }`;
const CHANNEL_MIX = `uniform sampler2D uTex; uniform mat3 uM; uniform vec3 uK; uniform float uMono; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=uM*s.rgb+uK; if(uMono>0.5) c=vec3(c.r); fragColor=pm(vec4(c,s.a)); }`;
const INVERT = `uniform sampler2D uTex; uniform int uCh; uniform float uBlend; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec4 r=s; if(uCh==0) r.rgb=1.0-s.rgb; else if(uCh==1) r.r=1.0-s.r; else if(uCh==2) r.g=1.0-s.g; else if(uCh==3) r.b=1.0-s.b; else if(uCh==4) r.a=1.0-s.a; else { float l=luma(s.rgb); r.rgb=s.rgb+(1.0-2.0*l); } fragColor=pm(mix(r,s,uBlend)); }`;
const BW = `uniform sampler2D uTex; void main(){ vec4 s=texture(uTex,vUv); fragColor=vec4(vec3(luma(s.rgb)),s.a); }`;
const GAMMA = `uniform sampler2D uTex; uniform float uG; void main(){ vec4 s=unpm(texture(uTex,vUv)); fragColor=pm(vec4(pow(max(s.rgb,0.0),vec3(uG)),s.a)); }`;
const LIMITER = `uniform sampler2D uTex; uniform float uMin,uMax; uniform int uAxis; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=s.rgb; float y=luma(c); vec3 ch=c-y;
  if(uAxis!=1){ float ny=clamp(y,uMin,uMax); c=ny+ch; y=ny; } if(uAxis!=0){ float m=length(ch); float lim=0.45*(uMax-uMin); if(m>lim) c=y+ch*lim/m; } fragColor=pm(vec4(clamp(c,uMin,uMax),s.a)); }`;
const LUT3D = `uniform sampler2D uTex; uniform highp sampler3D uLut; uniform float uAmt; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 l=texture(uLut,clamp(s.rgb,0.0,1.0)).rgb; fragColor=pm(vec4(mix(s.rgb,l,uAmt),s.a)); }`;

// ---------------- Blur & sharpen ----------------
const SHARPEN = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uAmt; void main(){ vec2 p=1.0/uTexSize; vec4 c=texture(uTex,vUv);
  vec4 n=texture(uTex,vUv+vec2(p.x,0))+texture(uTex,vUv-vec2(p.x,0))+texture(uTex,vUv+vec2(0,p.y))+texture(uTex,vUv-vec2(0,p.y)); fragColor=vec4(max(c.rgb+(c.rgb*4.0-n.rgb)*uAmt,0.0),c.a); }`;
const UNSHARP = `uniform sampler2D uTex; uniform sampler2D uBlur; uniform float uAmt, uThr; void main(){ vec4 c=texture(uTex,vUv), b=texture(uBlur,vUv); vec3 d=c.rgb-b.rgb; float m=step(uThr, abs(luma(d))); fragColor=vec4(max(c.rgb+d*uAmt*m,0.0),c.a); }`;
const DIRBLUR = `uniform sampler2D uTex; uniform vec2 uDir; void main(){ vec4 a=vec4(0); for(int i=-24;i<=24;i++){ a+=texture(uTex,vUv+uDir*float(i)/24.0); } fragColor=a/49.0; }`;
const RADIAL_BLUR = `uniform sampler2D uTex; uniform vec2 uC; uniform float uAmt; uniform int uSpin; uniform vec2 uTexSize; void main(){ vec4 a=vec4(0); vec2 d=vUv-uC; float asp=uTexSize.x/uTexSize.y;
  for(int i=0;i<32;i++){ float t=float(i)/31.0-0.5; vec2 uv; if(uSpin==1){ float ang=t*uAmt*0.5; vec2 q=vec2(d.x*asp,d.y); q=mat2(cos(ang),-sin(ang),sin(ang),cos(ang))*q; uv=uC+vec2(q.x/asp,q.y);} else uv=uC+d*(1.0-t*uAmt*0.5); a+=texture(uTex,uv);} fragColor=a/32.0; }`;
const MEDIAN = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uR; void main(){ vec2 p=uR/uTexSize; vec4 v[9]; int k=0; for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ v[k++]=texture(uTex,vUv+vec2(x,y)*p); }
  for(int i=0;i<9;i++) for(int j=i+1;j<9;j++){ if(luma(v[j].rgb)<luma(v[i].rgb)){ vec4 t=v[i]; v[i]=v[j]; v[j]=t; } } fragColor=v[4]; }`;
const BILATERAL = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uS, uR; void main(){ vec4 c=texture(uTex,vUv); vec4 a=vec4(0); float ws=0.; for(int y=-3;y<=3;y++) for(int x=-3;x<=3;x++){ vec2 o=vec2(x,y); vec4 s=texture(uTex,vUv+o*uS/uTexSize); float w=exp(-dot(o,o)/8.0)*exp(-pow(distance(s.rgb,c.rgb),2.0)/(2.0*uR*uR)); a+=s*w; ws+=w; } fragColor=a/ws; }`;

// ---------------- Distort ----------------
const LENS = `uniform sampler2D uTex; uniform float uK, uVx, uVy, uFill; uniform vec2 uTexSize; void main(){ vec2 p=vUv-0.5-vec2(uVx,uVy)*0.25; float asp=uTexSize.x/uTexSize.y; p.x*=asp; float r2=dot(p,p); vec2 q=p*(1.0+uK*r2*1.5); q.x/=asp; vec2 uv=q+0.5+vec2(uVx,uVy)*0.25;
  if(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.){ fragColor = uFill>0.5? texture(uTex,clamp(uv,0.,1.)) : vec4(0); return; } fragColor=texture(uTex,uv); }`;
const TWIRL = `uniform sampler2D uTex; uniform vec2 uC, uTexSize; uniform float uAng, uR; void main(){ float asp=uTexSize.x/uTexSize.y; vec2 d=vUv-uC; d.x*=asp; float r=length(d); float rad=uR; if(r<rad){ float t=1.0-r/rad; float a=uAng*t*t; d=mat2(cos(a),-sin(a),sin(a),cos(a))*d; } d.x/=asp; fragColor=texture(uTex,uC+d); }`;
const WAVE = `uniform sampler2D uTex; uniform float uH, uW, uDir, uPhase; uniform int uType; uniform vec2 uTexSize; float wf(float x){ if(uType==1) return sign(sin(x)); if(uType==2) return asin(sin(x))/1.5708; if(uType==3) return fract(x/6.2831)*2.0-1.0; return sin(x); }
  void main(){ vec2 px=vUv*uTexSize; vec2 dir=vec2(cos(uDir),sin(uDir)); vec2 perp=vec2(-dir.y,dir.x); float coord=dot(px,perp); vec2 off=dir*wf(coord/uW*6.2831+uPhase)*uH; vec2 uv=(px+off)/uTexSize; fragColor=(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)?vec4(0):texture(uTex,uv); }`;
const SPHERIZE = `uniform sampler2D uTex; uniform vec2 uC, uTexSize; uniform float uR, uAmt; void main(){ float asp=uTexSize.x/uTexSize.y; vec2 d=vUv-uC; d.x*=asp; float r=length(d); if(r<uR){ float t=r/uR; float f = mix(1.0, pow(t, 1.0 + uAmt), abs(uAmt)>0.0?1.0:0.0); if(uAmt<0.0) f = pow(t, 1.0/(1.0-uAmt)) / max(t,0.0001); else f = pow(t,1.0+uAmt)/max(t,0.0001); d*=f; } d.x/=asp; fragColor=texture(uTex,uC+d); }`;
const MIRROR = `uniform sampler2D uTex; uniform vec2 uC; uniform float uA; uniform vec2 uTexSize; void main(){ float asp=uTexSize.x/uTexSize.y; vec2 n=vec2(cos(uA),sin(uA)); vec2 p=vUv-uC; p.x*=asp; float d=dot(p,n); if(d>0.0) p-=2.0*d*n; p.x/=asp; fragColor=texture(uTex,uC+p); }`;
const OFFSET = `uniform sampler2D uTex; uniform vec2 uShift; uniform float uBlend; void main(){ vec4 a=texture(uTex,fract(vUv-uShift+0.5)); fragColor=mix(a,texture(uTex,vUv),uBlend); }`;
const CORNER_PIN = `uniform sampler2D uTex; uniform mat3 uH; void main(){ vec3 q=uH*vec3(vUv,1.0); vec2 uv=q.xy/q.z; fragColor=(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)?vec4(0):texture(uTex,uv); }`;
const TRANSFORM_FX = `uniform sampler2D uTex; uniform mat3 uInv[8]; uniform int uN; uniform float uOp; void main(){ vec4 a=vec4(0); for(int i=0;i<8;i++){ if(i>=uN) break; vec3 q=uInv[i]*vec3(vUv,1.0); vec2 uv=q.xy; a += (uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)?vec4(0):texture(uTex,uv); } fragColor=a/float(uN)*uOp; }`;
const MAGNIFY = `uniform sampler2D uTex; uniform vec2 uC, uTexSize; uniform float uMag, uSize, uFeather, uOp, uSquare, uRing; uniform vec3 uRingCol; void main(){ float asp=uTexSize.x/uTexSize.y; vec2 d=vUv-uC; d.x*=asp; float r = uSquare>0.5? max(abs(d.x),abs(d.y)) : length(d);
  float m = 1.0-smoothstep(uSize-uFeather, uSize, r); vec2 sd=d/uMag; sd.x/=asp; vec4 z=texture(uTex,uC+sd); vec4 base=texture(uTex,vUv); vec4 o=mix(base,z,m*uOp); float ring=uRing*(smoothstep(uSize-0.006,uSize-0.003,r)-smoothstep(uSize,uSize+0.003,r)); fragColor=mix(o,vec4(uRingCol,1.0),ring); }`;
const ROLLING = `uniform sampler2D uTex; uniform float uAmt; uniform float uDir; void main(){ float row = uDir>0.5 ? 1.0-vUv.y : vUv.y; vec2 uv=vUv; uv.x += (row-0.5)*uAmt*0.05; fragColor=texture(uTex,uv); }`;

// ---------------- Generate ----------------
const RAMP = `uniform sampler2D uTex; uniform vec2 uS, uE, uTexSize; uniform vec3 uSc, uEc; uniform float uRadial, uBlend; void main(){ float asp=uTexSize.x/uTexSize.y; vec2 p=vUv; float t; if(uRadial>0.5){ vec2 d=(p-uS); d.x*=asp; vec2 e=(uE-uS); e.x*=asp; t=length(d)/max(length(e),0.0001);} else { vec2 e=uE-uS; t=dot(p-uS,e)/max(dot(e,e),0.0001);} t=clamp(t,0.,1.);
  vec4 s=texture(uTex,vUv); vec3 g=mix(uSc,uEc,t); fragColor=vec4(mix(g*max(s.a,1.0),s.rgb,uBlend), max(s.a,1.0-uBlend)); }`;
const FOURCOLOR = `uniform sampler2D uTex; uniform vec3 uC1,uC2,uC3,uC4; uniform float uBlend; uniform int uMode; void main(){ vec3 top=mix(uC1,uC2,vUv.x), bot=mix(uC3,uC4,vUv.x); vec3 g=mix(bot,top,vUv.y); vec4 s=unpm(texture(uTex,vUv)); vec3 r=g;
  if(uMode==1) r=s.rgb*g; else if(uMode==2) r=1.0-(1.0-s.rgb)*(1.0-g); else if(uMode==3) r=mix(2.0*s.rgb*g,1.0-2.0*(1.0-s.rgb)*(1.0-g),step(0.5,s.rgb)); else if(uMode==4) r=mix(s.rgb-(1.0-2.0*g)*s.rgb*(1.0-s.rgb), s.rgb+(2.0*g-1.0)*(sqrt(s.rgb)-s.rgb), step(0.5,g));
  float a = max(s.a, uMode==0 ? uBlend : 0.0); fragColor=pm(vec4(mix(s.rgb,r,uBlend),a)); }`;
const FLARE = `uniform sampler2D uTex; uniform vec2 uC, uTexSize; uniform float uB, uBlend; uniform int uType; void main(){ float asp=uTexSize.x/uTexSize.y; vec2 p=vUv; vec2 d=p-uC; d.x*=asp; float r=length(d); vec3 col=vec3(0);
  col += vec3(1.0,0.9,0.75)*0.08/(r+0.02); col += vec3(1.0,0.6,0.3)*exp(-r*r*40.0)*0.8;
  vec2 axis=(vec2(0.5)-uC); for(int i=1;i<6;i++){ float fi=float(i); vec2 g=uC+axis*(fi*0.42); vec2 gd=p-g; gd.x*=asp; float gr=length(gd); float sz=0.02+0.025*fract(fi*0.37+float(uType)*0.2); col += mix(vec3(0.3,0.6,1.0),vec3(1.0,0.5,0.3),fract(fi*0.29))*smoothstep(sz,sz*0.6,gr)*0.25; }
  float ang=atan(d.y,d.x); col += vec3(1.0,0.85,0.7)*pow(abs(cos(ang*float(3+uType))),40.0)*exp(-r*6.0)*0.3; col*=uB;
  vec4 s=texture(uTex,vUv); fragColor=vec4(s.rgb+col*(1.0-uBlend), s.a); }`;
const GRID = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uSize, uBorder, uOp, uInv; uniform vec3 uCol; void main(){ vec2 px=vUv*uTexSize; float cell=uTexSize.x*uSize/100.0; vec2 f=mod(px,cell); float g=step(f.x,uBorder)+step(f.y,uBorder); g=clamp(g,0.,1.); if(uInv>0.5) g=1.0-g; vec4 s=texture(uTex,vUv); fragColor=mix(s,vec4(uCol,1.0),g*uOp); }`;
const CIRCLE = `uniform sampler2D uTex; uniform vec2 uC, uTexSize; uniform float uR, uF, uOp, uInv; uniform vec3 uCol; void main(){ float asp=uTexSize.x/uTexSize.y; vec2 d=vUv-uC; d.x*=asp; float m=1.0-smoothstep(uR-uF,uR+0.0001,length(d)); if(uInv>0.5) m=1.0-m; vec4 s=texture(uTex,vUv); fragColor=mix(s,vec4(uCol,1.0),m*uOp); }`;
const FILL = `uniform sampler2D uTex; uniform vec3 uCol; uniform float uOp; void main(){ vec4 s=texture(uTex,vUv); fragColor=vec4(mix(s.rgb, uCol*s.a, uOp), s.a); }`;

// ---------------- Keying ----------------
const ULTRA_KEY_MATTE = `uniform sampler2D uTex; uniform vec3 uKey; uniform float uTransp, uHigh, uShad, uTol, uPed, uDesat, uRange, uSpill, uLuma;
vec2 cbcr(vec3 c){ return vec2(-0.1146*c.r-0.3854*c.g+0.5*c.b, 0.5*c.r-0.4542*c.g-0.0458*c.b); }
void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=s.rgb; vec2 kc=cbcr(uKey), pc=cbcr(c); float kl=length(kc);
  vec2 kn = kl>0.0001? kc/kl : vec2(0.); float proj = dot(pc, kn); float perp = length(pc - kn*proj);
  float keyness = clamp((proj - perp*(1.0+uTol*2.0)) / max(kl,0.0001), 0.0, 1.0);
  float y=luma(c); keyness *= mix(1.0, smoothstep(0.0, 0.4, y), uShad*0.6); keyness *= mix(1.0, 1.0-smoothstep(0.75, 1.0, y), uHigh*0.6);
  float a = 1.0 - clamp(keyness * (1.0 + uTransp*3.0), 0.0, 1.0);
  a = clamp((a - uPed*0.5) / max(1.0 - uPed*0.5, 0.0001), 0.0, 1.0);
  // spill suppression toward key hue
  float spillAmt = clamp(dot(pc, kn) * (1.0 + uRange) , 0.0, 1.0) * uSpill;
  vec3 dc = c - (uKey - luma(uKey)) * spillAmt * 1.2; float ny = luma(dc); dc = mix(dc, vec3(ny), uDesat*spillAmt*2.0); dc += (y - ny) * uLuma;
  fragColor = vec4(dc, a * s.a); }`;
const ULTRA_KEY_FINISH = `uniform sampler2D uMatte; uniform sampler2D uSoft; uniform float uChoke, uContrast, uMid, uSoftOn; uniform int uOut; uniform float uSat, uHue, uLum;
void main(){ vec4 m=texture(uMatte,vUv); float a = uSoftOn>0.5 ? texture(uSoft,vUv).a : m.a; a = clamp((a - uChoke*0.5)/max(1.0-uChoke*0.5,0.001),0.0,1.0); a = clamp((a - uMid)*(1.0+uContrast*8.0)+uMid, 0.0, 1.0);
  vec3 c=m.rgb; vec3 hsl=rgb2hsl(clamp(c,0.,1.)); hsl.x=fract(hsl.x+uHue/360.0); hsl.y=clamp(hsl.y*uSat,0.,1.); c=hsl2rgb(hsl)+uLum;
  if(uOut==1){ fragColor=vec4(vec3(a),1.0); return; } if(uOut==2){ fragColor=vec4(c,1.0); return; } fragColor=vec4(c*a,a); }`;
const COLOR_KEY = `uniform sampler2D uTex; uniform vec3 uKey; uniform float uTol, uThin; void main(){ vec4 s=unpm(texture(uTex,vUv)); float d=distance(s.rgb,uKey); float a=smoothstep(uTol, uTol+0.04+uThin, d); fragColor=pm(vec4(s.rgb, s.a*a)); }`;
const LUMA_KEY = `uniform sampler2D uTex; uniform float uThr, uCut; void main(){ vec4 s=unpm(texture(uTex,vUv)); float l=luma(s.rgb); float a=smoothstep(uCut, max(uThr,uCut+0.001), l); fragColor=pm(vec4(s.rgb,s.a*a)); }`;
const ALPHA_ADJ = `uniform sampler2D uTex; uniform float uOp, uIgn, uInv, uMask; void main(){ vec4 s=unpm(texture(uTex,vUv)); float a=uIgn>0.5?1.0:s.a; if(uInv>0.5) a=1.0-a; a*=uOp; if(uMask>0.5){ fragColor=vec4(vec3(a),a); return; } fragColor=pm(vec4(s.rgb,a)); }`;
const SPILL = `uniform sampler2D uTex; uniform vec3 uKey; uniform float uAmt; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=s.rgb; int ch = uKey.g>=uKey.r && uKey.g>=uKey.b ? 1 : (uKey.b>=uKey.r ? 2 : 0);
  if(ch==1){ float lim=(c.r+c.b)*0.5; c.g = mix(c.g, min(c.g,lim), uAmt);} else if(ch==2){ float lim=(c.r+c.g)*0.5; c.b=mix(c.b,min(c.b,lim),uAmt);} else { float lim=(c.g+c.b)*0.5; c.r=mix(c.r,min(c.r,lim),uAmt);} fragColor=pm(vec4(c,s.a)); }`;
const CHOKE = `uniform sampler2D uTex; uniform sampler2D uBlur; uniform float uChoke; void main(){ vec4 s=unpm(texture(uTex,vUv)); float a=texture(uBlur,vUv).a; a=clamp((a-0.5)*(1.0+abs(uChoke)*4.0)+0.5 - uChoke*0.4,0.0,1.0); fragColor=pm(vec4(s.rgb,min(a, uChoke>0.0? s.a : 1.0))); }`;

// ---------------- Noise & stylize ----------------
const NOISE = `uniform sampler2D uTex; uniform float uAmt, uColor, uClip; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec2 px=vUv*uRes; float t=uFrame*1.618; vec3 n = uColor>0.5 ? vec3(hash(px+t),hash(px+t+17.1),hash(px+t+43.7)) : vec3(hash(px+t)); vec3 c=s.rgb+(n-0.5)*uAmt; if(uClip>0.5) c=clamp(c,0.,1.); fragColor=pm(vec4(c,s.a)); }`;
const GRAIN = `uniform sampler2D uTex; uniform float uI, uSize, uSoft, uMono; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec2 px=vUv*uRes/uSize; float t=uFrame*7.31; float g=noise2(px+t)*0.7+hash(px+t)*0.3*(1.0-uSoft); vec3 n = uMono>0.5? vec3(g) : vec3(g, noise2(px+t+11.3), noise2(px+t+29.1));
  float l=luma(s.rgb); float amt = uI * (0.6 + 0.4*(1.0-abs(l-0.5)*2.0)); fragColor=pm(vec4(s.rgb+(n-0.5)*amt, s.a)); }`;
const DROP_SHADOW = `uniform sampler2D uTex; uniform sampler2D uBlur; uniform vec2 uOff; uniform vec3 uCol; uniform float uOp, uOnly; void main(){ vec4 s=texture(uTex,vUv); float sa=texture(uBlur,vUv-uOff).a*uOp; vec4 sh=vec4(uCol*sa,sa); fragColor = uOnly>0.5 ? sh*(1.0-s.a) : s + sh*(1.0-s.a); }`;
const BASIC3D = `uniform sampler2D uTex; uniform mat3 uH; uniform float uSpec; void main(){ vec3 q=uH*vec3(vUv,1.0); vec2 uv=q.xy/q.z; vec4 c=(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)?vec4(0):texture(uTex,uv); if(uSpec>0.5){ float sp=pow(max(0.0,1.0-distance(uv,vec2(0.35,0.65))*2.0),8.0); c.rgb+=sp*c.a*0.6; } fragColor=c; }`;
const BEVEL = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uT, uAng, uI; void main(){ vec2 p=uT/uTexSize; vec4 s=texture(uTex,vUv); float ax=texture(uTex,vUv+vec2(p.x,0)).a-texture(uTex,vUv-vec2(p.x,0)).a; float ay=texture(uTex,vUv+vec2(0,p.y)).a-texture(uTex,vUv-vec2(0,p.y)).a; float l=dot(vec2(ax,ay),vec2(cos(uAng),sin(uAng))); fragColor=vec4(clamp(s.rgb + l*uI*s.a, 0.0, 1.0), s.a); }`;
const MOSAIC = `uniform sampler2D uTex; uniform vec2 uBlocks; uniform float uSharp; void main(){ vec2 b=floor(vUv*uBlocks); vec2 uv=(b+0.5)/uBlocks; fragColor=texture(uTex,uv); }`;
const POSTERIZE = `uniform sampler2D uTex; uniform float uL; void main(){ vec4 s=unpm(texture(uTex,vUv)); fragColor=pm(vec4(floor(s.rgb*uL)/(uL-1.0),s.a)); }`;
const EDGES = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uInv, uBlend; void main(){ vec2 p=1.0/uTexSize; float tl=luma(texture(uTex,vUv+vec2(-p.x,p.y)).rgb), t=luma(texture(uTex,vUv+vec2(0,p.y)).rgb), tr=luma(texture(uTex,vUv+p).rgb), l=luma(texture(uTex,vUv-vec2(p.x,0)).rgb), r=luma(texture(uTex,vUv+vec2(p.x,0)).rgb), bl=luma(texture(uTex,vUv-p).rgb), b=luma(texture(uTex,vUv-vec2(0,p.y)).rgb), br=luma(texture(uTex,vUv+vec2(p.x,-p.y)).rgb);
  float gx=-tl-2.0*l-bl+tr+2.0*r+br, gy=-bl-2.0*b-br+tl+2.0*t+tr; float e=clamp(length(vec2(gx,gy)),0.,1.); vec3 c = uInv>0.5? vec3(e) : vec3(1.0-e); vec4 s=texture(uTex,vUv); fragColor=vec4(mix(c*s.a, s.rgb, uBlend), s.a); }`;
const EMBOSS = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uDir, uRelief, uCon, uBlend; void main(){ vec2 d=vec2(cos(uDir),sin(uDir))*uRelief/uTexSize; float e=luma(texture(uTex,vUv+d).rgb)-luma(texture(uTex,vUv-d).rgb); vec4 s=texture(uTex,vUv); vec3 c=vec3(0.5+e*uCon); fragColor=vec4(mix(c*s.a,s.rgb,uBlend),s.a); }`;
const BRIGHT = `uniform sampler2D uTex; uniform float uThr; void main(){ vec4 s=texture(uTex,vUv); float l=luma(s.rgb); fragColor=s*smoothstep(uThr, uThr+0.1, l); }`;
const ADD_GLOW = `uniform sampler2D uTex; uniform sampler2D uGlow; uniform float uI; uniform vec3 uTint; void main(){ vec4 s=texture(uTex,vUv), g=texture(uGlow,vUv); fragColor=vec4(s.rgb+g.rgb*uTint*uI, max(s.a, clamp(g.a*uI,0.,1.))); }`;
const VIGNETTE = `uniform sampler2D uTex; uniform vec2 uTexSize; uniform float uAmt, uMid, uRound, uFeather; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec2 p=(vUv-0.5)*2.0; float asp=uTexSize.x/uTexSize.y; p.x*=mix(1.0, asp, clamp(0.5-uRound*0.5,0.,1.)); float d=length(p)/1.2; float v=smoothstep(uMid, uMid+max(uFeather,0.01), d); vec3 c = uAmt>0.0 ? s.rgb*(1.0-uAmt*v) : mix(s.rgb, vec3(1.0), -uAmt*v); fragColor=pm(vec4(c,s.a)); }`;
const REPLICATE = `uniform sampler2D uTex; uniform float uN; void main(){ fragColor=texture(uTex,fract(vUv*uN)); }`;
const SOLARIZE = `uniform sampler2D uTex; uniform float uT; void main(){ vec4 s=unpm(texture(uTex,vUv)); vec3 c=mix(s.rgb,1.0-s.rgb,step(uT,s.rgb)); fragColor=pm(vec4(c,s.a)); }`;
const HALFTONE = `uniform sampler2D uTex; uniform float uSize, uAng, uColor; void main(){ vec2 px=vUv*uRes; mat2 r=mat2(cos(uAng),-sin(uAng),sin(uAng),cos(uAng)); vec2 q=r*px; vec2 cell=floor(q/uSize)*uSize+uSize*0.5; vec2 cuv=(transpose(r)*cell)/uRes; vec4 s=unpm(texture(uTex,cuv)); float d=length(q-cell)/(uSize*0.5);
  vec3 c; if(uColor>0.5){ c = vec3(step(d, sqrt(s.r)*1.1), step(d, sqrt(s.g)*1.1), step(d, sqrt(s.b)*1.1)); } else { float l=luma(s.rgb); c=vec3(step(d, sqrt(l)*1.2)); } fragColor=vec4(c*texture(uTex,vUv).a, texture(uTex,vUv).a); }`;
const CHROMA_AB = `uniform sampler2D uTex; uniform vec2 uC; uniform float uAmt; void main(){ vec2 d=(vUv-uC)*uAmt*0.01; vec4 g=texture(uTex,vUv); fragColor=vec4(texture(uTex,vUv-d).r, g.g, texture(uTex,vUv+d).b, g.a); }`;
const STROBE = `uniform sampler2D uTex; uniform vec3 uCol; uniform float uOn, uBlend; void main(){ vec4 s=texture(uTex,vUv); fragColor = uOn>0.5 ? mix(vec4(uCol,1.0), s, uBlend) : s; }`;
const FILM_DAMAGE = `uniform sampler2D uTex; uniform float uScr, uDust, uFlick, uJit, uSep; void main(){ float t=uFrame; vec2 j=vec2(hash(vec2(t,1.0))-0.5, hash(vec2(t,2.0))-0.5)*uJit*0.006; vec4 s=unpm(texture(uTex,vUv+j)); vec3 c=s.rgb;
  vec3 sep=vec3(luma(c))*vec3(1.07,0.95,0.78); c=mix(c,sep,uSep); c*=1.0+(hash(vec2(t,7.0))-0.5)*uFlick*0.3;
  float x=hash(vec2(floor(t/3.0),3.0)); float line=smoothstep(0.0015,0.0,abs(vUv.x-x))*step(hash(vec2(floor(t/3.0),5.0)),uScr); c*=1.0-line*0.6;
  float dn=hash(floor(vUv*uRes/3.0)+t*13.1); c*=1.0-step(1.0-uDust*0.004,dn)*0.8; fragColor=pm(vec4(c,s.a)); }`;
const GLITCH = `uniform sampler2D uTex; uniform float uAmt, uBlock, uSplit, uSpeed; void main(){ float t=floor(uTime*uSpeed); vec2 b=floor(vUv*uRes/uBlock); float r=hash(b.yy+t); vec2 uv=vUv; if(r<uAmt*0.3) uv.x+= (hash(b+t)-0.5)*uAmt*0.2; float sp=uSplit*0.002*(hash(vec2(t,9.0))+0.2);
  vec4 g=texture(uTex,uv); fragColor=vec4(texture(uTex,uv+vec2(sp,0)).r, g.g, texture(uTex,uv-vec2(sp,0)).b, g.a); }`;
const CROP = `uniform sampler2D uTex; uniform vec4 uC; uniform float uZoom, uF; uniform vec2 uTexSize; void main(){ vec2 uv=vUv; if(uZoom>0.5){ uv = vec2(mix(uC.x, 1.0-uC.z, vUv.x), mix(uC.w, 1.0-uC.y, vUv.y)); fragColor=texture(uTex,uv); return; }
  vec2 px=uF/uTexSize; float m = smoothstep(uC.x-px.x, uC.x+0.0001, uv.x) * smoothstep(uC.z-px.x, uC.z+0.0001, 1.0-uv.x) * smoothstep(uC.w-px.y, uC.w+0.0001, uv.y) * smoothstep(uC.y-px.y, uC.y+0.0001, 1.0-uv.y); fragColor=texture(uTex,uv)*m; }`;
const FLIP = `uniform sampler2D uTex; uniform vec2 uF; void main(){ vec2 uv=vUv; if(uF.x>0.5) uv.x=1.0-uv.x; if(uF.y>0.5) uv.y=1.0-uv.y; fragColor=texture(uTex,uv); }`;
const VR_ROT = `uniform sampler2D uTex; uniform mat3 uR; const float PI=3.14159265; void main(){ float lon=(vUv.x-0.5)*2.0*PI, lat=(vUv.y-0.5)*PI; vec3 d=vec3(cos(lat)*sin(lon), sin(lat), cos(lat)*cos(lon)); d=uR*d; float nl=atan(d.x,d.z), nt=asin(clamp(d.y,-1.,1.)); fragColor=texture(uTex, vec2(nl/(2.0*PI)+0.5, nt/PI+0.5)); }`;
const VR_FLAT = `uniform sampler2D uTex; uniform mat3 uR; uniform float uFov; uniform vec2 uTexSize; const float PI=3.14159265; void main(){ vec2 p=(vUv-0.5)*2.0; float asp=uRes.x/uRes.y; float f=1.0/tan(uFov*0.5); vec3 d=normalize(vec3(p.x*asp, p.y, f)); d=uR*d; float lon=atan(d.x,d.z), lat=asin(clamp(d.y,-1.,1.)); fragColor=texture(uTex, vec2(lon/(2.0*PI)+0.5, lat/PI+0.5)); }`;
const LITTLE_PLANET = `uniform sampler2D uTex; uniform float uZoom, uRot; const float PI=3.14159265; void main(){ vec2 p=(vUv-0.5)*2.0; p.x*=uRes.x/uRes.y; float r=length(p); float lat=PI*0.5-2.0*atan(r/uZoom); float lon=atan(p.y,p.x)+uRot; fragColor=texture(uTex, vec2(fract(lon/(2.0*PI)+0.5), lat/PI+0.5)); }`;
const POSTERIZE_TIME = COPY;

function mat3Homography(src, dst) {
  // compute homography mapping dst quad (output uv) -> src quad (input uv)
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  if (!h) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // column-major for GLSL mat3
  return [h[0], h[3], h[6], h[1], h[4], h[7], h[2], h[5], 1];
}
function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function rotMat(tilt, pan, roll) {
  const [a, b, c] = [tilt, pan, roll].map((d) => d * Math.PI / 180);
  const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b), cz = Math.cos(c), sz = Math.sin(c);
  const Rx = [1, 0, 0, 0, cx, sx, 0, -sx, cx];
  const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const Rz = [cz, sz, 0, -sz, cz, 0, 0, 0, 1];
  return mul3(mul3(Ry, Rx), Rz);
}
function mul3(a, b) { // column-major 3x3
  const o = new Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
  return o;
}

// Inverse affine (uv space) for transform: maps output uv -> input uv. Column-major mat3.
export function affineInverse({ anchor, position, scaleX, scaleY, rotation, skew = 0, skewAxis = 0, srcW, srcH, dstW, dstH }) {
  // forward: dst_px = position_px + R * S * K * (src_px - anchor_px)
  const r = rotation * Math.PI / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const k = Math.tan(skew * Math.PI / 180);
  // forward linear part M = R * S * K   (K shear in x)
  const a = scaleX, d = scaleY;
  const M = [cos * a, sin * a, cos * (a * k) - sin * d, sin * (a * k) + cos * d]; // [m00,m10,m01,m11]
  void skewAxis;
  const det = M[0] * M[3] - M[2] * M[1] || 1e-9;
  const inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
  // input_px = anchor_px + inv * (out_px - pos_px); uv conversions
  const ax = anchor[0] * srcW, ay = anchor[1] * srcH, px = position[0] * dstW, py = position[1] * dstH;
  // out_px = uv_out * dstSize ; in_uv = in_px / srcSize
  const m00 = inv[0] * dstW / srcW, m01 = inv[2] * dstH / srcW, m10 = inv[1] * dstW / srcH, m11 = inv[3] * dstH / srcH;
  const tx = (ax - inv[0] * px - inv[2] * py) / srcW;
  const ty = (ay - inv[1] * px - inv[3] * py) / srcH;
  return [m00, m10, 0, m01, m11, 0, tx, ty, 1];
}

// ---------------- Registry ----------------
export const EFFECT_IMPL = {
  lumetri,
  brightness_contrast: simple('bc', BC, (p) => ({ uB: p.brightness / 100 * 0.5, uC: 1 + p.contrast / 100 })),
  color_balance: simple('cbal', COLOR_BALANCE, (p) => ({ uS: [p.sr, p.sg, p.sb].map((v) => v / 100), uM: [p.mr, p.mg, p.mb].map((v) => v / 100), uH: [p.hr, p.hg, p.hb].map((v) => v / 100), uPres: p.preserveLum })),
  levels: simple('levels', LEVELS, (p) => ({ uIb: p.inBlack / 255, uIw: p.inWhite / 255, uG: p.gamma, uOb: p.outBlack / 255, uOw: p.outWhite / 255 })),
  tint: simple('tint', TINT, (p) => ({ uBlack: rgb(p.black), uWhite: rgb(p.white), uAmt: p.amount / 100 })),
  change_to_color: simple('chcol', CHANGE_COLOR, (p) => ({ uFrom: rgb(p.from), uTo: rgb(p.to), uTol: p.tolerance / 200, uSoft: p.softness / 200, uMode: { hue: 0, hs: 1, hsl: 2 }[p.change] || 0 })),
  leave_color: simple('leavecol', LEAVE_COLOR, (p) => ({ uCol: rgb(p.color), uAmt: p.amount / 100, uTol: p.tolerance / 100, uSoft: p.softness / 100 })),
  channel_mixer: simple('chmix', CHANNEL_MIX, (p) => ({ uM: [p.rr, p.gr, p.br, p.rg, p.gg, p.bg, p.rb, p.gb, p.bb].map((v) => v / 100), uK: [p.rc, p.gc, p.bc].map((v) => v / 100), uMono: p.mono })),
  invert: simple('invert', INVERT, (p) => ({ uCh: { rgb: 0, r: 1, g: 2, b: 3, a: 4, luma: 5 }[p.channel] || 0, uBlend: p.blend / 100 })),
  black_white: simple('bw', BW),
  gamma: simple('gamma', GAMMA, (p) => ({ uG: p.gamma / 10 })),
  video_limiter: simple('limiter', LIMITER, (p) => ({ uMin: p.min / 100, uMax: p.max / 100, uAxis: { luma: 0, chroma: 1, both: 2 }[p.axis] })),
  lut(ctx, inp, p, info) {
    const lut = info.loadLut(p.file);
    if (!lut) return ctx.copy(inp);
    const o = ctx.acquire(inp.w, inp.h); ctx.pass('lut3d', LUT3D, o, { uTex: inp, uLut: lut }, { uAmt: p.intensity / 100 }); return o;
  },
  gaussian_blur: (ctx, inp, p, info) => ctx.blur(inp, p.blurriness * info.scale, p.dimensions, p.repeatEdges),
  camera_blur: (ctx, inp, p, info) => ctx.blur(inp, p.percent * 0.6 * info.scale, 'both', true),
  vr_blur: (ctx, inp, p, info) => ctx.blur(inp, p.blurriness * info.scale, 'both', true),
  directional_blur: simple('dirblur', DIRBLUR, (p, info, inp) => { const a = (p.direction - 90) * Math.PI / 180; return { uDir: [Math.cos(a) * p.length * info.scale / inp.w, -Math.sin(a) * p.length * info.scale / inp.h] }; }),
  radial_blur: simple('radblur', RADIAL_BLUR, (p) => ({ uC: P(p.center), uAmt: p.amount / 100, uSpin: p.type === 'spin' ? 1 : 0 })),
  sharpen: simple('sharpen', SHARPEN, (p) => ({ uAmt: p.amount / 100 })),
  unsharp_mask(ctx, inp, p, info) {
    const b = ctx.blur(inp, p.radius * 2 * info.scale);
    const o = ctx.acquire(inp.w, inp.h); ctx.pass('unsharp', UNSHARP, o, { uTex: inp, uBlur: b }, { uAmt: p.amount / 100, uThr: p.threshold / 255 }); ctx.release(b); return o;
  },
  median: simple('median', MEDIAN, (p) => ({ uR: Math.max(1, p.radius) })),
  denoise: simple('bilateral', BILATERAL, (p) => ({ uS: 1 + p.strength / 40, uR: 0.02 + (1 - p.detail / 100) * 0.15 * p.strength / 50 })),
  lens_distortion: simple('lens', LENS, (p) => ({ uK: p.curvature / 100, uVx: p.hDecenter / 100, uVy: -p.vDecenter / 100, uFill: p.fill })),
  twirl: simple('twirl', TWIRL, (p) => ({ uC: P(p.center), uAng: p.angle * Math.PI / 180, uR: p.radius / 100 })),
  wave_warp: simple('wave', WAVE, (p, info) => ({ uH: p.height * info.scale, uW: p.width * info.scale, uDir: (p.direction - 90) * Math.PI / 180, uPhase: info.time * p.speed * 6.2831, uType: { sine: 0, square: 1, triangle: 2, sawtooth: 3 }[p.wave] })),
  spherize: simple('spherize', SPHERIZE, (p) => ({ uC: P(p.center), uR: p.radius / 100, uAmt: p.amount / 100 })),
  mirror: simple('mirror', MIRROR, (p) => ({ uC: P(p.center), uA: -p.angle * Math.PI / 180 })),
  offset: simple('offset', OFFSET, (p) => ({ uShift: [p.shift[0] - 0.5, -(p.shift[1] - 0.5)], uBlend: p.blend / 100 })),
  corner_pin: simple('cornerpin', CORNER_PIN, (p) => ({ uH: mat3Homography([[0, 1], [1, 1], [0, 0], [1, 0]], [P(p.ul), P(p.ur), P(p.ll), P(p.lr)]) })),
  transform(ctx, inp, p, info) {
    const o = ctx.acquire(inp.w, inp.h);
    const n = p.shutter > 0 && info.sample ? 8 : 1;
    const mats = [];
    for (let i = 0; i < n; i++) {
      const q = n > 1 ? info.sample(i / n * p.shutter / 360) : p;
      mats.push(...affineInverse({ anchor: P(q.anchor), position: P(q.position), scaleX: q.scale / 100, scaleY: q.scale / 100, rotation: -q.rotation, skew: q.skew, srcW: inp.w, srcH: inp.h, dstW: inp.w, dstH: inp.h }));
    }
    while (mats.length < 72) mats.push(0);
    ctx.pass('transformfx', TRANSFORM_FX, o, { uTex: inp }, { uInv: mats, uN: n, uOp: p.opacity / 100 });
    return o;
  },
  magnify: simple('magnify', MAGNIFY, (p) => ({ uC: P(p.center), uMag: p.magnification / 100, uSize: p.size / 100, uFeather: p.feather / 100, uOp: p.opacity / 100, uSquare: p.shape === 'square' ? 1 : 0, uRing: p.ring, uRingCol: rgb(p.ringColor) })),
  rolling_shutter: simple('rolling', ROLLING, (p) => ({ uAmt: p.amount / 100, uDir: p.direction === 'bt' ? 1 : 0 })),
  warp_stabilizer: (ctx, inp, p) => {
    // stabilization swaps the clip source to an analysed render; here apply the extra framing scale
    if (p.framing !== 'zoom' && p.additionalScale === 100) return ctx.copy(inp);
    const s = (p.framing === 'zoom' ? 1.08 : 1) * p.additionalScale / 100;
    const o = ctx.acquire(inp.w, inp.h);
    ctx.pass('transformfx', TRANSFORM_FX, o, { uTex: inp }, { uInv: [...affineInverse({ anchor: [0.5, 0.5], position: [0.5, 0.5], scaleX: s, scaleY: s, rotation: 0, srcW: inp.w, srcH: inp.h, dstW: inp.w, dstH: inp.h }), ...new Array(63).fill(0)], uN: 1, uOp: 1 });
    return o;
  },
  auto_reframe: (ctx, inp) => ctx.copy(inp), // applied through motion keyframes generated by analysis
  ramp: simple('ramp', RAMP, (p) => ({ uS: P(p.start), uE: P(p.end), uSc: rgb(p.startColor), uEc: rgb(p.endColor), uRadial: p.shape === 'radial' ? 1 : 0, uBlend: p.blend / 100 })),
  four_color_gradient: simple('fourcol', FOURCOLOR, (p) => ({ uC1: rgb(p.c1), uC2: rgb(p.c2), uC3: rgb(p.c3), uC4: rgb(p.c4), uBlend: p.blend / 100, uMode: { normal: 0, multiply: 1, screen: 2, overlay: 3, softLight: 4 }[p.mode] || 0 })),
  lens_flare: simple('flare', FLARE, (p) => ({ uC: P(p.center), uB: p.brightness / 100, uBlend: p.blend / 100, uType: { 50: 0, 35: 1, 105: 2 }[p.type] || 0 })),
  grid: simple('grid', GRID, (p, info) => ({ uSize: p.size, uBorder: p.border * info.scale, uOp: p.opacity / 100, uInv: p.invert, uCol: rgb(p.color) })),
  circle: simple('circle', CIRCLE, (p) => ({ uC: P(p.center), uR: p.radius / 100, uF: p.feather / 100, uOp: p.opacity / 100, uInv: p.invert, uCol: rgb(p.color) })),
  color_fill: simple('fill', FILL, (p) => ({ uCol: rgb(p.color), uOp: p.opacity / 100 })),
  ultra_key(ctx, inp, p) {
    const preset = { default: 1, relaxed: 0.7, aggressive: 1.4 }[p.setting] || 1;
    const matte = ctx.acquire(inp.w, inp.h);
    ctx.pass('ukmatte', ULTRA_KEY_MATTE, matte, { uTex: inp }, {
      uKey: rgb(p.keyColor), uTransp: p.transparency / 100 * preset, uHigh: p.highlight / 100, uShad: p.shadow / 100, uTol: p.tolerance / 100, uPed: p.pedestal / 100,
      uDesat: p.desaturate / 100, uRange: p.range / 100, uSpill: p.spill / 100, uLuma: p.luma / 100 - 0.5,
    });
    const soft = p.soften > 0 ? ctx.blur(matte, p.soften * 0.3) : null;
    const o = ctx.acquire(inp.w, inp.h);
    ctx.pass('ukfinish', ULTRA_KEY_FINISH, o, { uMatte: matte, uSoft: soft || matte }, { uChoke: p.choke / 100, uContrast: p.mattContrast / 100, uMid: p.midpoint / 100, uSoftOn: soft ? 1 : 0, uOut: { composite: 0, alpha: 1, color: 2 }[p.output], uSat: p.ccSaturation / 100, uHue: p.ccHue, uLum: p.ccLuminance / 200 });
    ctx.release(matte); if (soft) ctx.release(soft);
    return o;
  },
  color_key(ctx, inp, p) {
    const o = ctx.acquire(inp.w, inp.h);
    ctx.pass('colorkey', COLOR_KEY, o, { uTex: inp }, { uKey: rgb(p.keyColor), uTol: p.tolerance / 255 * 1.732, uThin: p.thinning * 0.01 });
    if (p.feather > 0) { const b = ctx.blur(o, p.feather); ctx.release(o); return b; }
    return o;
  },
  luma_key: simple('lumakey', LUMA_KEY, (p) => ({ uThr: p.threshold / 100, uCut: p.cutoff / 100 })),
  track_matte: (ctx, inp) => ctx.copy(inp), // handled by compositor
  alpha_adjust: simple('alphaadj', ALPHA_ADJ, (p) => ({ uOp: p.opacity / 100, uIgn: p.ignore, uInv: p.invert, uMask: p.maskOnly })),
  spill_suppressor: simple('spill', SPILL, (p) => ({ uKey: rgb(p.color), uAmt: p.amount / 100 })),
  matte_choker(ctx, inp, p) {
    const b = ctx.blur(inp, Math.abs(p.choke) * 0.08 + p.softness * 0.2 + 0.5);
    const o = ctx.acquire(inp.w, inp.h); ctx.pass('choke', CHOKE, o, { uTex: inp, uBlur: b }, { uChoke: p.choke / 100 }); ctx.release(b); return o;
  },
  noise: simple('noise', NOISE, (p) => ({ uAmt: p.amount / 100, uColor: p.color, uClip: p.clip })),
  film_grain: simple('grain', GRAIN, (p) => ({ uI: p.intensity / 100 * 0.5, uSize: p.size, uSoft: p.softness / 100, uMono: p.mono })),
  drop_shadow(ctx, inp, p, info) {
    const b = ctx.blur(inp, p.softness * info.scale * 0.5 + 0.5);
    const a = (p.direction - 90) * Math.PI / 180;
    const o = ctx.acquire(inp.w, inp.h);
    ctx.pass('dropshadow', DROP_SHADOW, o, { uTex: inp, uBlur: b }, { uOff: [Math.cos(a) * p.distance * info.scale / inp.w, -Math.sin(a) * p.distance * info.scale / inp.h], uCol: rgb(p.color), uOp: p.opacity / 100, uOnly: p.only });
    ctx.release(b); return o;
  },
  basic_3d: simple('basic3d', BASIC3D, (p) => {
    const sw = p.swivel * Math.PI / 180, ti = p.tilt * Math.PI / 180, dist = 1 + p.distance / 100;
    const proj = (x, y) => { // rotate quad corner in 3D and project
      let X = (x - 0.5), Y = (y - 0.5), Z = 0;
      let x1 = X * Math.cos(sw) + Z * Math.sin(sw), z1 = -X * Math.sin(sw) + Z * Math.cos(sw);
      let y2 = Y * Math.cos(ti) - z1 * Math.sin(ti), z2 = Y * Math.sin(ti) + z1 * Math.cos(ti);
      const f = 1.6 / (1.6 + z2 + (dist - 1)); return [x1 * f + 0.5, y2 * f + 0.5];
    };
    return { uH: mat3Homography([[0, 0], [1, 0], [0, 1], [1, 1]], [proj(0, 0), proj(1, 0), proj(0, 1), proj(1, 1)]), uSpec: p.specular };
  }),
  bevel_alpha: simple('bevel', BEVEL, (p, info) => ({ uT: p.thickness * info.scale, uAng: p.angle * Math.PI / 180, uI: p.intensity / 100 })),
  mosaic: simple('mosaic', MOSAIC, (p) => ({ uBlocks: [p.hBlocks, p.vBlocks], uSharp: p.sharp })),
  posterize: simple('posterize', POSTERIZE, (p) => ({ uL: p.levels })),
  find_edges: simple('edges', EDGES, (p) => ({ uInv: p.invert, uBlend: p.blend / 100 })),
  emboss: simple('emboss', EMBOSS, (p) => ({ uDir: p.direction * Math.PI / 180, uRelief: p.relief, uCon: p.contrast / 100, uBlend: p.blend / 100 })),
  glow(ctx, inp, p, info) {
    const br = ctx.acquire(inp.w, inp.h); ctx.pass('bright', BRIGHT, br, { uTex: inp }, { uThr: p.threshold / 100 });
    const b = ctx.blur(br, p.radius * info.scale); ctx.release(br);
    const o = ctx.acquire(inp.w, inp.h); ctx.pass('addglow', ADD_GLOW, o, { uTex: inp, uGlow: b }, { uI: p.intensity, uTint: rgb(p.tint) }); ctx.release(b); return o;
  },
  vignette: simple('vignette', VIGNETTE, (p) => ({ uAmt: p.amount / 100, uMid: p.midpoint / 100, uRound: p.roundness / 100, uFeather: p.feather / 100 })),
  replicate: simple('replicate', REPLICATE, (p) => ({ uN: p.count })),
  solarize: simple('solarize', SOLARIZE, (p) => ({ uT: p.threshold / 100 })),
  halftone: simple('halftone', HALFTONE, (p, info) => ({ uSize: p.size * info.scale, uAng: p.angle * Math.PI / 180, uColor: p.color })),
  chromatic_aberration: simple('chromab', CHROMA_AB, (p) => ({ uC: P(p.center), uAmt: p.amount })),
  strobe: simple('strobe', STROBE, (p, info) => ({ uCol: rgb(p.color), uOn: (Math.floor(info.localFrame) % Math.max(2, p.period)) < p.duration ? 1 : 0, uBlend: p.blend / 100 })),
  film_damage: simple('filmdamage', FILM_DAMAGE, (p) => ({ uScr: p.scratches / 100, uDust: p.dust, uFlick: p.flicker / 100, uJit: p.jitter / 10, uSep: p.sepia / 100 })),
  glitch: simple('glitchfx', GLITCH, (p) => ({ uAmt: p.amount / 100, uBlock: p.blocks, uSplit: p.rgbSplit, uSpeed: p.speed })),
  posterize_time: simple('postime', POSTERIZE_TIME),
  crop: simple('crop', CROP, (p) => ({ uC: [p.left / 100, p.top / 100, p.right / 100, p.bottom / 100], uZoom: p.zoom, uF: p.feather })),
  horizontal_flip: simple('flip', FLIP, () => ({ uF: [1, 0] })),
  vertical_flip: simple('flip', FLIP, () => ({ uF: [0, 1] })),
  vr_rotate: simple('vrrot', VR_ROT, (p) => ({ uR: rotMat(p.tilt, p.pan, p.roll) })),
  vr_projection: simple('vrflat', VR_FLAT, (p) => ({ uR: rotMat(p.tilt, p.pan, p.roll), uFov: p.fov * Math.PI / 180 })),
  little_planet: simple('planet', LITTLE_PLANET, (p) => ({ uZoom: p.zoom, uRot: p.rotate * Math.PI / 180 })),
  timecode_burnin: (ctx, inp, p, info) => info.overlayText(inp, p, info.timecodeText(p)),
  clip_name: (ctx, inp, p, info) => info.overlayText(inp, p, info.clipName),
};

// Effects whose output depends on the time sample of the source rather than pixels
export const TIME_EFFECTS = new Set(['posterize_time']);

// ---------------- Transitions ----------------
const TRANS_PRE = `uniform sampler2D uA; uniform sampler2D uB; uniform float uP; uniform vec2 uTexSize; `;
export const TRANSITION_SRC = {
  cross_dissolve: `void main(){ fragColor = mix(texture(uA,vUv), texture(uB,vUv), uP); }`,
  additive_dissolve: `void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); fragColor = clamp(a*min(1.0,2.0-2.0*uP) + b*min(1.0,2.0*uP), 0.0, 1.0); }`,
  film_dissolve: `void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); vec3 la=pow(max(a.rgb,0.0),vec3(2.2)), lb=pow(max(b.rgb,0.0),vec3(2.2)); fragColor = vec4(pow(mix(la,lb,uP),vec3(1.0/2.2)), mix(a.a,b.a,uP)); }`,
  morph_blur: `uniform float uBlur; void main(){ float s=sin(uP*3.14159)*uBlur/uTexSize.x; vec4 a=vec4(0), b=vec4(0); for(int i=-6;i<=6;i++) for(int j=-6;j<=6;j+=3){ vec2 o=vec2(float(i),float(j))*s; a+=texture(uA,vUv+o); b+=texture(uB,vUv+o);} a/=65.0; b/=65.0; fragColor=mix(a,b,uP); }`,
  dip_black: `void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); vec4 k=vec4(0,0,0,1); fragColor = uP<0.5 ? mix(a, k*max(a.a,b.a), uP*2.0) : mix(k*max(a.a,b.a), b, uP*2.0-1.0); }`,
  dip_white: `void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); vec4 k=vec4(1); fragColor = uP<0.5 ? mix(a, k, uP*2.0) : mix(k, b, uP*2.0-1.0); }`,
  dip_color: `uniform vec3 uColor; void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); vec4 k=vec4(uColor,1); fragColor = uP<0.5 ? mix(a, k, uP*2.0) : mix(k, b, uP*2.0-1.0); }`,
  wipe: `uniform float uAngle, uFeather, uBorder; uniform vec3 uBorderColor; void main(){ vec2 d=vec2(cos(uAngle),sin(uAngle)); float span=abs(d.x)+abs(d.y); float x=dot(vUv-0.5,d)/span+0.5; float f=max(uFeather,0.0005); float e=uP*(1.0+2.0*f)-f; float m=smoothstep(e-f,e+f,x);
    float bd = uBorder>0.0 ? (1.0-smoothstep(0.0,uBorder,abs(x-e))) : 0.0; vec4 c = mix(texture(uB,vUv), texture(uA,vUv), m); fragColor = mix(c, vec4(uBorderColor,1.0), bd*step(0.001,uP)*step(uP,0.999)); }`,
  barn_doors: `uniform float uVertical, uFeather; void main(){ float x = uVertical>0.5 ? abs(vUv.y-0.5) : abs(vUv.x-0.5); float f=max(uFeather,0.001); float m=smoothstep(uP*0.5-f, uP*0.5+f, x); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  clock_wipe: `uniform float uFeather; void main(){ vec2 d=vUv-0.5; float a=fract(atan(d.x,d.y)/6.28318+1.0); float f=max(uFeather,0.001); float m=smoothstep(uP-f,uP+f,a); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  radial_wipe: `uniform float uFeather; void main(){ float a=atan(1.0-vUv.y, vUv.x)/1.5708; float f=max(uFeather,0.001); float m=smoothstep(uP-f,uP+f,a); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  venetian_blinds: `uniform float uCount, uVertical; void main(){ float x = uVertical>0.5 ? vUv.x : vUv.y; float m=step(uP, fract(x*uCount)); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  checker_wipe: `uniform float uCount; void main(){ vec2 c=floor(vUv*uCount); float off=mod(c.x+c.y,2.0)*0.5; float x=fract(vUv.x*uCount); float m=step(clamp(uP*2.0-off,0.0,1.0), x); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  iris_round: `uniform vec2 uCenter; uniform float uFeather; void main(){ vec2 d=vUv-uCenter; d.x*=uTexSize.x/uTexSize.y; float r=uP*1.6; float f=max(uFeather,0.001); float m=smoothstep(r-f,r+f,length(d)); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  iris_box: `uniform vec2 uCenter; uniform float uFeather; void main(){ vec2 d=abs(vUv-uCenter); float r=uP*1.05; float f=max(uFeather,0.001); float m=smoothstep(r-f,r+f,max(d.x,d.y)); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  iris_diamond: `uniform vec2 uCenter; uniform float uFeather; void main(){ vec2 d=abs(vUv-uCenter); float r=uP*1.6; float f=max(uFeather,0.001); float m=smoothstep(r-f,r+f,d.x+d.y); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  iris_cross: `uniform vec2 uCenter; uniform float uFeather; void main(){ vec2 d=abs(vUv-uCenter); float r=uP*1.05; float f=max(uFeather,0.001); float m=smoothstep(r-f,r+f,min(d.x,d.y)*3.0); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  slide: `uniform int uDir; void main(){ vec2 o = uDir==0? vec2(1.0-uP,0) : uDir==1? vec2(uP-1.0,0) : uDir==2? vec2(0,uP-1.0) : vec2(0,1.0-uP); vec2 uv=vUv-o; vec4 b=(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)?vec4(0):texture(uB,uv); vec4 a=texture(uA,vUv); fragColor=b+a*(1.0-b.a); }`,
  push: `uniform int uDir; void main(){ vec2 d = uDir==0? vec2(-1,0) : uDir==1? vec2(1,0) : uDir==2? vec2(0,1) : vec2(0,-1); vec2 ua=vUv-d*uP, ub=vUv-d*(uP-1.0); vec4 a=(ua.x<0.||ua.y<0.||ua.x>1.||ua.y>1.)?vec4(0):texture(uA,ua); vec4 b=(ub.x<0.||ub.y<0.||ub.x>1.||ub.y>1.)?vec4(0):texture(uB,ub); fragColor=a+b; }`,
  split: `uniform float uVertical; void main(){ float x = uVertical>0.5 ? vUv.y : vUv.x; float off=uP*0.5; vec2 uv=vUv; if(x<0.5){ if(uVertical>0.5) uv.y+=off; else uv.x+=off; if((uVertical>0.5?uv.y:uv.x)>0.5){ fragColor=texture(uB,vUv); return; } } else { if(uVertical>0.5) uv.y-=off; else uv.x-=off; if((uVertical>0.5?uv.y:uv.x)<0.5){ fragColor=texture(uB,vUv); return; } } fragColor=texture(uA,uv); }`,
  whip_pan: `uniform int uDir; uniform float uBlur; void main(){ vec2 d = uDir==0? vec2(-1,0) : uDir==1? vec2(1,0) : uDir==2? vec2(0,1) : vec2(0,-1); float e=uP*uP*(3.0-2.0*uP); float bl=sin(uP*3.14159)*uBlur*0.004; vec4 acc=vec4(0); for(int i=0;i<16;i++){ float o=(float(i)/15.0-0.5)*bl; vec2 ua=fract(vUv-d*(e+o)), ub=fract(vUv-d*(e-1.0+o)); acc += e<0.5 ? texture(uA,ua) : texture(uB,ub); } fragColor=acc/16.0; }`,
  cross_zoom: `uniform float uStrength; void main(){ float s=sin(uP*3.14159)*uStrength*0.01; vec4 a=vec4(0), b=vec4(0); vec2 c=vec2(0.5); for(int i=0;i<16;i++){ float t=float(i)/15.0; vec2 uv=c+(vUv-c)*(1.0-s*t); a+=texture(uA,uv); b+=texture(uB,uv);} fragColor=mix(a/16.0,b/16.0,smoothstep(0.3,0.7,uP)); }`,
  zoom_in: `uniform vec2 uCenter; void main(){ float s=mix(0.0001,1.0,uP); vec2 uv=uCenter+(vUv-uCenter)/s; vec4 b=(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)?vec4(0):texture(uB,uv); vec4 a=texture(uA,vUv); fragColor=b+a*(1.0-b.a); }`,
  spin: `uniform float uTurns; void main(){ float ang=uP*6.28318*uTurns; float s=1.0-sin(uP*3.14159)*0.8; vec2 d=vUv-0.5; d.x*=uTexSize.x/uTexSize.y; d=mat2(cos(ang),-sin(ang),sin(ang),cos(ang))*d/s; d.x/=uTexSize.x/uTexSize.y; vec2 uv=d+0.5; vec4 c = uP<0.5 ? texture(uA,uv) : texture(uB,uv); fragColor=(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)?vec4(0,0,0,1):c; }`,
  light_leak: `uniform vec3 uColor; uniform float uIntensity; void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); float w=sin(uP*3.14159); vec2 c=vec2(mix(-0.2,1.2,uP), 0.6+0.2*sin(uP*5.0)); float g=exp(-pow(distance(vUv,c)*1.6,2.0))*w*uIntensity; float flare=noise2(vUv*3.0+uP*2.0)*w*0.5*uIntensity; vec4 m=mix(a,b,smoothstep(0.35,0.65,uP)); fragColor=vec4(m.rgb + uColor*(g+flare), m.a); }`,
  film_burn: `uniform float uIntensity; void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); float w=sin(uP*3.14159); float n=noise2(vUv*4.0+vec2(uP*3.0,0.0))*0.7+noise2(vUv*12.0-uP*5.0)*0.3; float burn=smoothstep(1.0-w*1.2, 1.0-w*0.5, n)*uIntensity; vec3 hot=mix(vec3(1.0,0.35,0.05), vec3(1.0,0.95,0.7), burn); vec4 m=mix(a,b,smoothstep(0.4,0.6,uP)); fragColor=vec4(mix(m.rgb, hot, clamp(burn,0.0,1.0)), m.a); }`,
  flash: `uniform vec3 uColor; void main(){ vec4 a=texture(uA,vUv), b=texture(uB,vUv); float w=1.0-abs(uP-0.5)*2.0; w=pow(w,3.0); vec4 m=uP<0.5?a:b; fragColor=vec4(mix(m.rgb,uColor,w), max(m.a,w)); }`,
  glitch: `uniform float uAmount; void main(){ float w=sin(uP*3.14159)*uAmount; float row=floor(vUv.y*24.0); float sh=(hash(vec2(row, floor(uP*20.0)))-0.5)*w*0.3; vec2 uv=vec2(fract(vUv.x+sh), vUv.y); vec4 m = hash(vec2(row,floor(uP*30.0))) < uP ? texture(uB,uv) : texture(uA,uv); float s=w*0.02; fragColor=vec4((uP<0.5?texture(uA,uv+vec2(s,0)):texture(uB,uv+vec2(s,0))).r, m.g, (uP<0.5?texture(uA,uv-vec2(s,0)):texture(uB,uv-vec2(s,0))).b, m.a); }`,
  pixelate: `uniform float uSize; void main(){ float s=max(1.0, sin(uP*3.14159)*uSize); vec2 b=uTexSize/s; vec2 uv=(floor(vUv*b)+0.5)/b; fragColor=mix(texture(uA,uv),texture(uB,uv),smoothstep(0.4,0.6,uP)); }`,
  page_turn: `void main(){ float x = vUv.x + (1.0-vUv.y)*0.25; float edge = mix(1.3, -0.3, uP); if(x > edge){ fragColor = texture(uA, vUv); } else { float d=edge-x; vec4 b=texture(uB,vUv); float sh = smoothstep(0.0,0.08,d); fragColor = vec4(b.rgb*mix(0.5,1.0,sh), b.a); } if(abs(x-edge)<0.004) fragColor=vec4(0.95,0.95,0.95,1.0); }`,
  shape_circle: `uniform float uCount; void main(){ vec2 g=vUv*uCount; g.x*=uTexSize.x/uTexSize.y; vec2 f=fract(g)-0.5; float d=length(f); float r=uP*0.75; float m=step(r,d); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
  shape_hex: `uniform float uCount; float hexd(vec2 p){ p=abs(p); return max(dot(p,normalize(vec2(1.0,1.732))),p.x); } void main(){ vec2 g=vUv*uCount; g.x*=uTexSize.x/uTexSize.y; vec2 r=vec2(1.0,1.732); vec2 h=r*0.5; vec2 a=mod(g,r)-h, b=mod(g-h,r)-h; vec2 gv=dot(a,a)<dot(b,b)?a:b; float m=step(uP*0.6, hexd(gv)); fragColor=mix(texture(uB,vUv), texture(uA,vUv), m); }`,
};

export function transitionUniforms(type, p) {
  const dir = { left: 0, right: 1, up: 2, down: 3 };
  switch (type) {
    case 'morph_blur': return { uBlur: p.blur };
    case 'dip_color': return { uColor: rgb(p.color) };
    case 'wipe': return { uAngle: p.angle * Math.PI / 180, uFeather: p.feather / 200, uBorder: p.border / 400, uBorderColor: rgb(p.borderColor) };
    case 'barn_doors': return { uVertical: p.vertical, uFeather: p.feather / 200 };
    case 'clock_wipe': case 'radial_wipe': return { uFeather: p.feather / 200 };
    case 'venetian_blinds': return { uCount: p.count, uVertical: p.vertical };
    case 'checker_wipe': return { uCount: p.count };
    case 'iris_round': case 'iris_box': case 'iris_diamond': case 'iris_cross': return { uCenter: P(p.center), uFeather: p.feather / 200 };
    case 'slide': case 'push': return { uDir: dir[p.direction] || 0 };
    case 'split': return { uVertical: p.vertical };
    case 'whip_pan': return { uDir: dir[p.direction] || 0, uBlur: p.blur };
    case 'cross_zoom': return { uStrength: p.strength };
    case 'zoom_in': return { uCenter: P(p.center) };
    case 'spin': return { uTurns: p.turns };
    case 'light_leak': return { uColor: rgb(p.color), uIntensity: p.intensity / 100 };
    case 'film_burn': return { uIntensity: p.intensity / 100 };
    case 'flash': return { uColor: rgb(p.color) };
    case 'glitch': return { uAmount: p.amount / 100 };
    case 'pixelate': return { uSize: p.size };
    case 'shape_circle': case 'shape_hex': return { uCount: p.count };
    default: return {};
  }
}

export function transitionFrag(type, pluginSrc) { return TRANS_PRE + (pluginSrc || TRANSITION_SRC[type] || TRANSITION_SRC.cross_dissolve); }

export { mat3Homography, rotMat, COPY_FLIP };
