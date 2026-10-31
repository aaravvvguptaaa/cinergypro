// WebGL2 foundation: programs, textures, framebuffer pool and a full-screen pass runner.
export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uRes;      // output size in pixels
uniform float uTime;    // seconds
uniform float uFrame;   // frame index
vec4 unpm(vec4 c){ return c.a > 0.0001 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 pm(vec4 c){ return vec4(c.rgb * c.a, c.a); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); float e=1.0e-10; return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)), d/(q.x+e), q.x); }
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
vec3 rgb2hsl(vec3 c){ float mx=max(max(c.r,c.g),c.b), mn=min(min(c.r,c.g),c.b); float l=(mx+mn)*0.5; float h=0., s=0.; if(mx>mn){ float d=mx-mn; s = l>0.5 ? d/(2.-mx-mn) : d/(mx+mn); if(mx==c.r) h=(c.g-c.b)/d+(c.g<c.b?6.:0.); else if(mx==c.g) h=(c.b-c.r)/d+2.; else h=(c.r-c.g)/d+4.; h/=6.; } return vec3(h,s,l); }
float hue2rgb(float p,float q,float t){ if(t<0.)t+=1.; if(t>1.)t-=1.; if(t<1./6.)return p+(q-p)*6.*t; if(t<.5)return q; if(t<2./3.)return p+(q-p)*(2./3.-t)*6.; return p; }
vec3 hsl2rgb(vec3 c){ if(c.y==0.) return vec3(c.z); float q=c.z<.5?c.z*(1.+c.y):c.z+c.y-c.z*c.y; float p=2.*c.z-q; return vec3(hue2rgb(p,q,c.x+1./3.),hue2rgb(p,q,c.x),hue2rgb(p,q,c.x-1./3.)); }
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise2(vec2 p){ vec2 i=floor(p), f=fract(p); float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1)); vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
`;

export class GL {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance', desynchronized: true });
    if (!gl) throw new Error('WebGL2 is not available on this system.');
    this.gl = gl;
    this.floatFbo = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.programs = new Map();
    this.pool = [];
    this.inUse = new Set();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.white = this.solidTexture([255, 255, 255, 255]);
    this.transparent = this.solidTexture([0, 0, 0, 0]);
    this.black = this.solidTexture([0, 0, 0, 255]);
    this.time = 0; this.frame = 0;
  }

  solidTexture(rgba) {
    const gl = this.gl; const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    this._params(gl.LINEAR);
    return { tex: t, w: 1, h: 1 };
  }

  _params(filter, wrap) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
  }

  createTexture(w = 1, h = 1, opts = {}) {
    const gl = this.gl; const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (opts.float && this.floatFbo) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this._params(opts.nearest ? gl.NEAREST : gl.LINEAR);
    return { tex: t, w, h };
  }

  // Upload an image/video/canvas source into a texture object (reuses storage)
  upload(texObj, source, opts = {}) {
    const gl = this.gl;
    if (!texObj) texObj = { tex: gl.createTexture(), w: 0, h: 0 };
    gl.bindTexture(gl.TEXTURE_2D, texObj.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, opts.premultiply !== false);
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this._params(gl.LINEAR);
    texObj.w = w; texObj.h = h;
    return texObj;
  }

  uploadData(texObj, w, h, data, opts = {}) {
    const gl = this.gl;
    if (!texObj) texObj = { tex: gl.createTexture(), w, h };
    gl.bindTexture(gl.TEXTURE_2D, texObj.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this._params(opts.nearest ? gl.NEAREST : gl.LINEAR, opts.repeat ? gl.REPEAT : undefined);
    texObj.w = w; texObj.h = h;
    return texObj;
  }

  upload3D(size, data) {
    const gl = this.gl; const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    return { tex3d: t, size };
  }

  deleteTexture(t) { if (t && t.tex) this.gl.deleteTexture(t.tex); if (t && t.tex3d) this.gl.deleteTexture(t.tex3d); }

  // ---- FBO pool ----
  acquire(w, h, opts = {}) {
    w = Math.max(1, Math.min(this.maxTex, Math.round(w)));
    h = Math.max(1, Math.min(this.maxTex, Math.round(h)));
    const float = opts.float !== false && this.floatFbo && !opts.bytes;
    let fb = this.pool.find((f) => !this.inUse.has(f) && f.w === w && f.h === h && f.float === float);
    if (!fb) {
      const gl = this.gl;
      const t = this.createTexture(w, h, { float });
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      fb = { fbo, tex: t.tex, w, h, float, lastUse: 0 };
      this.pool.push(fb);
      if (this.pool.length > 120) this.gc();
    }
    fb.lastUse = performance.now();
    this.inUse.add(fb);
    return fb;
  }
  release(fb) { if (fb) this.inUse.delete(fb); }
  releaseAll() { this.inUse.clear(); }
  gc() {
    const now = performance.now();
    const gl = this.gl;
    this.pool = this.pool.filter((f) => {
      if (!this.inUse.has(f) && now - f.lastUse > 5000) { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); return false; }
      return true;
    });
  }

  program(key, fragSrc) {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        console.error('Shader compile error', key, log, lines.slice(0, 4000));
        throw new Error('Shader ' + key + ': ' + log);
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc.startsWith('#version') ? fragSrc : PRELUDE + fragSrc));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link ' + key + ': ' + gl.getProgramInfoLog(prog));
    const uniforms = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
    }
    p = { prog, uniforms };
    this.programs.set(key, p);
    return p;
  }

  /**
   * Run a full-screen pass.
   * textures: {uniformName: texObj|fbo}; uniforms: {name: value}; target: fbo or null (canvas)
   */
  pass(key, frag, target, textures = {}, uniforms = {}, opts = {}) {
    const gl = this.gl;
    const p = this.program(key, frag);
    gl.useProgram(p.prog);
    const w = target ? target.w : (opts.w || this.canvas.width);
    const h = target ? target.h : (opts.h || this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    if (opts.viewport) gl.viewport(...opts.viewport); else gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) {
      const u = p.uniforms[name];
      if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (t && t.tex3d) gl.bindTexture(gl.TEXTURE_3D, t.tex3d);
      else gl.bindTexture(gl.TEXTURE_2D, t ? t.tex : this.transparent.tex);
      gl.uniform1i(u.loc, unit);
      const sz = p.uniforms[name + 'Size'];
      if (sz && t) gl.uniform2f(sz.loc, t.w || 1, t.h || 1);
      unit++;
    }
    const set = (name, v) => {
      const u = p.uniforms[name]; if (!u) return;
      const T = gl;
      switch (u.type) {
        case T.FLOAT: if (u.size > 1) gl.uniform1fv(u.loc, v); else gl.uniform1f(u.loc, +v || 0); break;
        case T.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case T.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case T.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case T.INT: case T.BOOL: if (u.size > 1) gl.uniform1iv(u.loc, v); else gl.uniform1i(u.loc, v | 0); break;
        case T.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
        case T.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
        default: break;
      }
    };
    set('uRes', [w, h]); set('uTime', this.time); set('uFrame', this.frame);
    for (const [k, v] of Object.entries(uniforms)) if (v !== undefined) set(k, typeof v === 'boolean' ? (v ? 1 : 0) : v);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  clear(target, rgba = [0, 0, 0, 0]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.clearColor(...rgba);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  read(target, x = 0, y = 0, w = target.w, h = target.h, out = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    const buf = out || new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }
}
