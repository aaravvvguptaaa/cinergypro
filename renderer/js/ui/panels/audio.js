// Audio Track Mixer, Audio Clip Mixer, audio meters and Essential Sound.
import { app } from '../../app-context.js';
import { h, icon, clamp, dbToGain, gainToDb, uid } from '../../core/util.js';
import { clipAt, findClip } from '../../core/project.js';
import { AUDIO_EFFECTS, makeEffect } from '../../core/effect-defs.js';
import { evaluate, setKey } from '../../core/keyframes.js';
import { contextMenu, ibtn, section, sliderRow, toast } from '../widgets.js';

// fader position <-> dB (0..1 track, +6 dB at top)
const faderToDb = (u) => (u <= 0.001 ? -96 : 40 * Math.log10(u) + 6 * u - 0.0001 + (u >= 1 ? 0 : 0));
function dbToFader(db) { let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (faderToDb(m) < db) lo = m; else hi = m; } return (lo + hi) / 2; }

function meterCanvas() {
  const c = h('canvas', { width: 10, height: 200 });
  c.peakHold = -96; c.holdAt = 0;
  c.set = (db) => {
    const ctx = c.getContext('2d'); const r = c.getBoundingClientRect(); const H = Math.max(10, Math.round(r.height)); if (c.height !== H) c.height = H;
    const W = c.width;
    ctx.fillStyle = '#0a0b0e'; ctx.fillRect(0, 0, W, H);
    const u = clamp((db + 60) / 66, 0, 1);
    const g = ctx.createLinearGradient(0, H, 0, 0); g.addColorStop(0, '#2fae62'); g.addColorStop(0.7, '#3fcf7f'); g.addColorStop(0.85, '#f2b33d'); g.addColorStop(1, '#f0505a');
    ctx.fillStyle = g; ctx.fillRect(0, H - u * H, W, u * H);
    const now = performance.now();
    if (db > c.peakHold || now - c.holdAt > 1500) { c.peakHold = db; c.holdAt = now; }
    const pu = clamp((c.peakHold + 60) / 66, 0, 1); ctx.fillStyle = c.peakHold > -0.3 ? '#f0505a' : '#e6ebf2'; ctx.fillRect(0, H - pu * H, W, 2);
  };
  return c;
}

function fader(db, onChange) {
  const f = h('div.fader', h('div.rail'));
  const cap = h('div.cap'); f.appendChild(cap);
  let cur = db;
  const place = () => { const u = dbToFader(cur); cap.style.top = `calc(${(1 - u) * 100}% )`; };
  f.set = (v) => { cur = v; place(); };
  requestAnimationFrame(place);
  f.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const r = f.getBoundingClientRect();
    const set = (ev, fin) => { const u = clamp(1 - (ev.clientY - r.top) / r.height, 0, 1); cur = +clamp(faderToDb(u), -96, 6).toFixed(1); if (ev.altKey) cur = 0; place(); onChange(cur, fin, true); };
    set(e, false);
    const mv = (ev) => set(ev, false); const up = (ev) => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); onChange(cur, true, false); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  f.addEventListener('dblclick', () => { cur = 0; place(); onChange(0, true, false); });
  return f;
}

function knob(value, onChange, range = 100) {
  const c = h('canvas.knob', { width: 68, height: 68, title: 'Pan (double-click to center)' });
  let v = value;
  const draw = () => {
    const ctx = c.getContext('2d'); ctx.clearRect(0, 0, 68, 68);
    ctx.strokeStyle = '#0a0b0e'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(34, 34, 24, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke();
    ctx.strokeStyle = '#5c9bff'; ctx.beginPath(); const mid = Math.PI * 1.5, a = mid + v / range * Math.PI * 0.75; ctx.arc(34, 34, 24, Math.min(mid, a), Math.max(mid, a)); ctx.stroke();
    ctx.fillStyle = '#e6ebf2'; ctx.font = '600 15px Plex'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(Math.round(v)), 34, 35);
  };
  draw();
  c.set = (nv) => { v = nv; draw(); };
  c.addEventListener('mousedown', (e) => {
    const y0 = e.clientY, v0 = v;
    const mv = (ev) => { v = clamp(Math.round(v0 + (y0 - ev.clientY) * (ev.shiftKey ? 0.2 : 1)), -range, range); draw(); onChange(v, false); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); onChange(v, true); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  c.addEventListener('dblclick', () => { v = 0; draw(); onChange(0, true); });
  return c;
}

// ---------------- Track mixer ----------------
export class TrackMixer {
  constructor(el) {
    this.el = el; this.body = h('div.mixer'); el.appendChild(this.body);
    this.meters = new Map();
    app.store.on('change', (e) => { if (!this.busy && !(e && e.transient)) this.render(); });
    app.store.on('sequence', () => this.render());
    this.render();
    const tick = () => { requestAnimationFrame(tick); if (!this.el.offsetParent) return; const m = app.audio.meters(); for (const [id, c] of this.meters) { if (id === '__L') c.set(m.master[0]); else if (id === '__R') c.set(m.master[1]); else c.set(m.tracks[id] ? m.tracks[id].peak : -96); } this.followAutomation(); };
    requestAnimationFrame(tick);
  }
  get seq() { return app.store.seq; }

  followAutomation() {
    const s = this.seq; if (!s || !this.faders) return;
    for (const t of s.tracks.audio) { const f = this.faders.get(t.id); if (f && t.audio.keyframes.volume.length && t.audio.automation !== 'off' && !this.dragging) f.set(evaluate(t.audio.keyframes.volume, s.playhead, t.audio.volume)); }
  }

  render() {
    const s = this.seq;
    this.body.innerHTML = ''; this.meters.clear(); this.faders = new Map();
    if (!s) { this.body.appendChild(h('div.empty', 'Open a sequence to mix its audio')); return; }
    for (const t of s.tracks.audio) this.body.appendChild(this.strip(t, 'track'));
    for (const b of s.buses) this.body.appendChild(this.strip(b, 'bus'));
    this.body.appendChild(this.masterStrip());
    this.body.appendChild(h('div', { style: { display: 'flex', alignItems: 'flex-start', padding: '6px' } }, ibtn('plus', 'Add submix', () => app.store.transact('Add Submix', () => { s.buses.push({ id: uid('bus'), name: `Submix ${s.buses.length + 1}`, volume: 0, pan: 0, effects: [], mute: false }); }))));
  }

  automationWrite(t, db) {
    const s = this.seq; const mode = t.audio.automation;
    if (!app.player.state.program.playing || !['write', 'touch', 'latch'].includes(mode)) return false;
    const f = s.playhead;
    const keys = t.audio.keyframes.volume;
    if (mode === 'write' && this.lastWrite != null) { for (let i = keys.length - 1; i >= 0; i--) if (keys[i].t > this.lastWrite && keys[i].t < f) keys.splice(i, 1); }
    setKey(keys, f, db);
    this.lastWrite = f;
    return true;
  }

  strip(t, kind) {
    const s = this.seq;
    const a = kind === 'track' ? t.audio : t;
    const name = kind === 'track' ? (t.name.match(/^A\d+$/) ? `Audio ${t.name.slice(1)}` : t.name) : t.name;
    const db = h('div.db', (a.volume >= 0 ? '+' : '') + a.volume.toFixed(1));
    const fx = (a.effects || []).map((e) => { const row = h('div.fxslot', { title: AUDIO_EFFECTS[e.type] ? AUDIO_EFFECTS[e.type].name : e.type }, (e.enabled ? '' : '(off) ') + (AUDIO_EFFECTS[e.type] || { name: e.type }).name); row.addEventListener('click', (ev) => this.fxMenu(ev, a, e)); return row; });
    const addFx = h('div.fxslot', { style: { color: 'var(--dim)' } }, '+ Add effect');
    addFx.addEventListener('click', (ev) => this.addFxMenu(ev, a));
    const route = kind === 'track' ? h('select.field', { title: 'Output', on: { change: (e) => { app.store.transact('Route', () => { a.route = e.target.value; }); } } }, [['master', 'Mix'], ...s.buses.map((b) => [b.id, b.name])].map(([v, l]) => h('option', { value: v, selected: a.route === v }, l))) : null;
    const auto = kind === 'track' ? h('select.field', { title: 'Automation mode', on: { change: (e) => app.store.transact('Automation Mode', () => { a.automation = e.target.value; }) } }, [['off', 'Off'], ['read', 'Read'], ['latch', 'Latch'], ['touch', 'Touch'], ['write', 'Write']].map(([v, l]) => h('option', { value: v, selected: a.automation === v }, l))) : null;
    const pan = knob(a.pan || 0, (v, fin) => { a.pan = v; app.audio.liveUpdate(s); if (fin) { app.store.markDirty(); } });
    const msr = h('div.msr');
    if (kind === 'track') {
      const m = h('div.tbtn.m' + (t.muted ? '.on' : ''), 'M'); m.addEventListener('click', () => { app.store.transact('Mute', () => { t.muted = !t.muted; }); app.audio.liveUpdate(s); });
      const so = h('div.tbtn.s' + (t.solo ? '.on' : ''), 'S'); so.addEventListener('click', () => { app.store.transact('Solo', () => { t.solo = !t.solo; }); app.audio.liveUpdate(s); });
      const r = h('div.tbtn.r' + (a.recordArm ? '.on' : ''), 'R'); r.addEventListener('click', () => { for (const x of s.tracks.audio) x.audio.recordArm = x === t ? !a.recordArm : false; app.store.markDirty(); this.render(); app.timeline && app.timeline.renderHeaders(); });
      msr.append(m, so, r);
    } else { const m = h('div.tbtn.m' + (t.mute ? '.on' : ''), 'M'); m.addEventListener('click', () => { app.store.transact('Mute', () => { t.mute = !t.mute; }); app.audio.liveUpdate(s); }); msr.append(m); }
    const fd = fader(kind === 'track' && a.keyframes.volume.length && a.automation !== 'off' ? evaluate(a.keyframes.volume, s.playhead, a.volume) : a.volume, (v, fin, dragging) => {
      this.busy = true; this.dragging = dragging;
      db.textContent = (v >= 0 ? '+' : '') + v.toFixed(1);
      if (kind === 'track' && this.automationWrite(t, v)) { /* recorded */ }
      else a.volume = v;
      app.audio.liveUpdate(s);
      if (fin) { app.store.markDirty(); this.busy = false; this.lastWrite = null; app.timeline && (app.timeline.dirty = true); if (kind === 'track' && app.player.state.program.playing && a.automation === 'latch') setKey(a.keyframes.volume, s.playhead, v); }
    });
    if (kind === 'track') this.faders.set(t.id, fd);
    const meter = meterCanvas(); if (kind === 'track') this.meters.set(t.id, meter);
    const strip = h('div.strip', h('div.nm', { title: name }, name), ...fx, addFx, route, auto, pan, msr, h('div.fader-area', fd, h('div.meter', meter)), db);
    strip.addEventListener('dblclick', (e) => { if (e.target.classList.contains('nm') && kind === 'bus') { const n = prompt('Name', t.name); if (n) app.store.transact('Rename', () => { t.name = n; }); } });
    return strip;
  }

  masterStrip() {
    const s = this.seq; const m = s.master;
    const db = h('div.db', (m.volume >= 0 ? '+' : '') + m.volume.toFixed(1));
    const fx = (m.effects || []).map((e) => { const row = h('div.fxslot', (AUDIO_EFFECTS[e.type] || { name: e.type }).name); row.addEventListener('click', (ev) => this.fxMenu(ev, m, e)); return row; });
    const addFx = h('div.fxslot', { style: { color: 'var(--dim)' } }, '+ Add effect'); addFx.addEventListener('click', (ev) => this.addFxMenu(ev, m));
    const L = meterCanvas(), R = meterCanvas(); this.meters.set('__L', L); this.meters.set('__R', R);
    const fd = fader(m.volume, (v, fin) => { m.volume = v; db.textContent = (v >= 0 ? '+' : '') + v.toFixed(1); app.audio.liveUpdate(s); if (fin) app.store.markDirty(); });
    const mute = h('div.tbtn.m' + (m.mute ? '.on' : ''), 'M'); mute.addEventListener('click', () => { app.store.transact('Mute Mix', () => { m.mute = !m.mute; }); app.audio.liveUpdate(s); });
    return h('div.strip.master', h('div.nm', 'Mix'), ...fx, addFx, h('div.msr', mute), h('div.fader-area', fd, h('div.meter', { style: { width: '22px' } }, L, R)), db);
  }

  addFxMenu(e, target) {
    const cats = {};
    for (const [k, d] of Object.entries(AUDIO_EFFECTS)) { if (d.intrinsic) continue; (cats[d.category] = cats[d.category] || []).push([k, d.name]); }
    contextMenu(e.clientX, e.clientY, Object.entries(cats).map(([c, list]) => ({ label: c, submenu: list.map(([k, n]) => ({ label: n, action: () => app.store.transact('Add Track Effect', () => { target.effects.push(makeEffect(k)); }) })) })));
  }
  fxMenu(e, target, fx) {
    contextMenu(e.clientX, e.clientY, [
      { label: fx.enabled ? 'Bypass' : 'Enable', action: () => app.store.transact('Bypass Effect', () => { fx.enabled = !fx.enabled; }) },
      { label: 'Edit Parameters...', action: () => editFxDialog(fx, () => app.audio.liveUpdate(this.seq)) },
      { label: 'Remove', action: () => app.store.transact('Remove Track Effect', () => { target.effects = target.effects.filter((x) => x !== fx); }) },
    ]);
  }
  resize() {}
}

async function editFxDialog(fx, onLive) {
  const { formDialog } = await import('../widgets.js');
  const def = AUDIO_EFFECTS[fx.type];
  const spec = def.params.map((p) => (p.type === 'number' ? { key: p.name, label: p.label + (p.unit ? ` (${p.unit})` : ''), type: 'range', min: p.min, max: p.max, step: p.step, onChange: (v) => { fx.params[p.name] = v; onLive(); } } : p.type === 'bool' ? { key: p.name, label: p.label, type: 'check', onChange: (v) => { fx.params[p.name] = v; onLive(); } } : { key: p.name, label: p.label, type: 'select', string: true, options: p.options, onChange: (v) => { fx.params[p.name] = v; onLive(); } }));
  const before = JSON.parse(JSON.stringify(fx.params));
  const r = await formDialog(def.name, spec, { ...fx.params });
  if (!r) { fx.params = before; onLive(); return; }
  const after = JSON.parse(JSON.stringify(fx.params)); fx.params = before;
  app.store.transact('Edit ' + def.name, () => { fx.params = after; });
}

// ---------------- Clip mixer ----------------
export class ClipMixer {
  constructor(el) {
    this.el = el; this.body = h('div.mixer'); el.appendChild(this.body);
    app.store.on('change', (e) => { if (!this.busy) this.render(); });
    app.player.on('playhead', () => { const k = this.key(); if (k !== this.lastKey) this.render(); });
    app.store.on('sequence', () => this.render());
    this.render();
  }
  get seq() { return app.store.seq; }
  key() { const s = this.seq; return s ? s.tracks.audio.map((t) => (clipAt(t, s.playhead) || {}).id).join(',') : ''; }
  render() {
    const s = this.seq; this.lastKey = this.key();
    this.body.innerHTML = '';
    if (!s) return;
    for (const t of s.tracks.audio) {
      const c = clipAt(t, s.playhead);
      const name = t.name;
      if (!c) { this.body.appendChild(h('div.strip', { style: { opacity: 0.45 } }, h('div.nm', name), h('div', { style: { color: 'var(--dim)', fontSize: '10px', textAlign: 'center', marginTop: '20px' } }, 'No clip'))); continue; }
      const vol = c.effects.find((e) => e.type === 'volume'), pn = c.effects.find((e) => e.type === 'panner');
      const lf = s.playhead - c.start;
      const cur = vol.keyframes.level && vol.keyframes.level.length ? evaluate(vol.keyframes.level, lf, vol.params.level) : vol.params.level;
      const db = h('div.db', (cur >= 0 ? '+' : '') + cur.toFixed(1));
      const snap = () => JSON.stringify(s.tracks);
      let before = null;
      const fd = fader(cur, (v, fin) => {
        this.busy = true; if (!before) before = snap();
        const writeKeys = (vol.keyframes.level && vol.keyframes.level.length) || app.player.state.program.playing;
        if (writeKeys) { vol.keyframes.level = vol.keyframes.level || []; setKey(vol.keyframes.level, s.playhead - c.start, v); } else vol.params.level = v;
        db.textContent = (v >= 0 ? '+' : '') + v.toFixed(1);
        if (fin) { const after = snap(); s.tracks = JSON.parse(before); before = null; app.store.transact('Clip Volume', () => { s.tracks = JSON.parse(after); }); this.busy = false; }
      });
      const pan = knob(pn.params.balance, (v, fin) => { pn.params.balance = v; if (fin) app.store.markDirty(); });
      const m = h('div.tbtn.m' + (!c.enabled ? '.on' : ''), 'M'); m.addEventListener('click', () => app.store.transact('Mute Clip', () => { c.enabled = !c.enabled; }));
      this.body.appendChild(h('div.strip', h('div.nm', { title: c.name }, c.name), h('div', { style: { color: 'var(--dim)', fontSize: '10px', textAlign: 'center' } }, name), pan, h('div.msr', m), h('div.fader-area', fd), db));
    }
  }
  resize() {}
}

// ---------------- Meters ----------------
export class MetersPanel {
  constructor(el) {
    this.el = el;
    this.L = meterCanvas(); this.R = meterCanvas();
    this.L.style.width = '100%'; this.R.style.width = '100%';
    this.loud = h('div.loud');
    const scale = h('div', { style: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: '9px', color: 'var(--dim)', padding: '0 2px' } }, ['+6', '0', '-6', '-12', '-18', '-24', '-30', '-36', '-42', '-48', '-54', '-60'].map((t) => h('span', t)));
    el.append(h('div.meters-panel', h('div', { style: { width: '12px' } }, this.L), h('div', { style: { width: '12px' } }, this.R), scale), this.loud);
    this.loud.style.padding = '4px 6px';
    this.loud.addEventListener('dblclick', () => { app.audio.loudness = { momentary: -70, shortTerm: -70, integrated: -70, peak: -96 }; });
    const tick = () => {
      requestAnimationFrame(tick);
      if (!this.el.offsetParent) return;
      const m = app.audio.meters(); this.L.set(m.master[0]); this.R.set(m.master[1]);
      const l = app.audio.loudness;
      const f = (v) => (v <= -69 ? '--' : v.toFixed(1));
      this.loud.innerHTML = `M <b>${f(l.momentary)}</b><br>S <b>${f(l.shortTerm)}</b><br>I <b>${f(l.integrated)}</b><br>LUFS`;
    };
    requestAnimationFrame(tick);
  }
  resize() {}
}

// ---------------- Essential Sound ----------------
const TYPES = [['dialogue', 'Dialogue', -23], ['music', 'Music', -25], ['sfx', 'SFX', -20], ['ambience', 'Ambience', -30]];

export class EssentialSound {
  constructor(el) {
    this.el = el; this.body = h('div.scroll'); el.appendChild(this.body);
    app.store.on('selection', () => this.render());
    app.store.on('change', (e) => { if (!this.busy && !(e && e.transient)) this.render(); });
    this.render();
  }
  get seq() { return app.store.seq; }
  clips() { const s = this.seq; if (!s) return []; return [...app.store.selection.clips].map((id) => findClip(s, id)).filter((f) => f && f.kind === 'audio'); }

  ensure(type, defaults = {}) {
    // apply/modify an effect on all selected clips
    return (param, value, final) => {
      const s = this.seq; if (!this.snap) this.snap = JSON.stringify(s.tracks);
      this.busy = true;
      for (const f of this.clips()) {
        const live = findClip(s, f.clip.id).clip;
        let fx = live.effects.find((e) => e.type === type);
        if (!fx) { fx = makeEffect(type, defaults); live.effects.push(fx); }
        fx.params[param] = value;
        if (value === 0 && param === 'amount' && type !== 'reverb') fx.enabled = false; else fx.enabled = true;
        app.audio.updateClipEffects(live);
      }
      if (final) { const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(this.snap); this.snap = null; app.store.transact('Essential Sound', () => { s.tracks = JSON.parse(after); }); this.busy = false; }
    };
  }

  param(clip, type, param, def) { const fx = clip.effects.find((e) => e.type === type && e.enabled); return fx ? fx.params[param] : def; }

  setType(type) {
    const s = this.seq;
    app.store.transact('Audio Type', () => { for (const f of this.clips()) findClip(s, f.clip.id).clip.audioType = type; });
  }

  render() {
    this.body.innerHTML = '';
    const sel = this.clips();
    if (!sel.length) { this.body.appendChild(h('div.empty', h('div', h('b', 'Select audio clips'), 'Tag clips as Dialogue, Music, SFX or Ambience to get controls suited to each type.'))); return; }
    const types = new Set(sel.map((f) => f.clip.audioType));
    const type = types.size === 1 ? [...types][0] : null;
    if (!type) {
      this.body.appendChild(h('div', { style: { padding: '12px', color: 'var(--muted)' } }, 'Edit the selection as:'));
      for (const [k, l] of TYPES) this.body.appendChild(h('button.btn', { style: { display: 'flex', width: 'calc(100% - 24px)', margin: '0 12px 8px', height: '36px', justifyContent: 'flex-start' }, on: { click: () => this.setType(k) } }, icon(k === 'music' ? 'audio' : k === 'dialogue' ? 'mic' : 'wave', 16), l));
      return;
    }
    const c = sel[0].clip;
    const label = TYPES.find((t) => t[0] === type);
    this.body.appendChild(h('div.toolbar', h('b', { style: { color: 'var(--white)' } }, label[1]), h('span', { style: { color: 'var(--dim)' } }, `${sel.length} clip(s)`), h('button.btn.small', { style: { marginLeft: 'auto' }, on: { click: () => this.setType(null) } }, 'Clear Audio Type')));
    const autoMatch = h('button.btn.small.primary', { on: { click: async () => { const m = await import('../../actions/editing.js'); const res = await m.normalizeClips(sel.map((f) => f.clip.id), 'lufs', label[2]); toast(`Matched ${res.size} clip(s) to ${label[2]} LUFS`); } } }, 'Auto-Match');
    this.body.appendChild(section('Loudness', h('div', h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, autoMatch, h('span', { style: { color: 'var(--dim)', fontSize: '11px' } }, `Target ${label[2]} LUFS`)))));
    const S = (lab, type2, param, def, min, max, step, defaults) => sliderRow(lab, this.param(c, type2, param, def), min, max, step, this.ensure(type2, defaults).bind(null, param), { def });
    if (type === 'dialogue') {
      this.body.appendChild(section('Repair', h('div',
        S('Reduce Noise', 'audio_denoise', 'amount', 0, 0, 100, 1),
        S('Reduce Rumble', 'highpass', 'freq', 20, 20, 250, 1),
        sliderRow('DeHum', this.param(c, 'dehum', 'harmonics', 0), 0, 8, 1, (v, fin) => this.ensure('dehum')('harmonics', v, fin)),
        S('DeEss', 'deesser', 'amount', 0, 0, 24, 0.5),
        S('Reduce Reverb', 'gate', 'floor', -96, -96, -6, 1, { threshold: -40 }))));
      this.body.appendChild(section('Clarity', h('div',
        S('Dynamics', 'compressor', 'ratio', 1, 1, 10, 0.1, { threshold: -20, makeup: 4 }),
        S('Presence', 'dialogue_clarity', 'presence', 0, 0, 100, 1),
        h('div.row', h('label', 'EQ preset'), h('select.field', { on: { change: (e) => this.eqPreset(e.target.value) } }, [['', 'None'], ['podcast', 'Podcast Voice'], ['broadcast', 'Broadcast'], ['telephone', 'Telephone'], ['warm', 'Warm'], ['bright', 'Bright and Airy'], ['muffle', 'Muffled (behind wall)']].map(([v, l]) => h('option', { value: v }, l)))))));
      this.body.appendChild(section('Creative', h('div', S('Reverb', 'reverb', 'mix', 0, 0, 100, 1, { room: 'room', decay: 1.2 }))));
    } else if (type === 'music') {
      this.duck = this.duck || { amount: -15, sensitivity: 6, fade: 0.8 };
      this.body.appendChild(section('Ducking', h('div',
        h('div', { style: { color: 'var(--dim)', fontSize: '11px', marginBottom: '6px' } }, 'Lower music under clips tagged as Dialogue'),
        sliderRow('Sensitivity', this.duck.sensitivity, 0, 10, 0.5, (v) => { this.duck.sensitivity = v; }),
        sliderRow('Reduce by (dB)', this.duck.amount, -40, 0, 0.5, (v) => { this.duck.amount = v; }),
        sliderRow('Fades (s)', this.duck.fade, 0.05, 3, 0.05, (v) => { this.duck.fade = v; }),
        h('button.btn.small.primary', { style: { marginTop: '6px' }, on: { click: () => import('../../actions/analysis.js').then((m) => m.autoDuck(this.duck)) } }, 'Generate Keyframes'))));
      this.body.appendChild(section('Creative', h('div', S('Stereo Width', 'stereo_expander', 'width', 100, 0, 300, 1))));
    } else if (type === 'sfx') {
      this.body.appendChild(section('Creative', h('div', S('Reverb', 'reverb', 'mix', 0, 0, 100, 1, { room: 'hall' }), S('Pan', 'panner', 'balance', 0, -100, 100, 1))));
    } else if (type === 'ambience') {
      this.body.appendChild(section('Creative', h('div', S('Reverb', 'reverb', 'mix', 0, 0, 100, 1, { room: 'hall', decay: 2.5 }), S('Stereo Width', 'stereo_expander', 'width', 100, 0, 300, 1))));
    }
    const vol = c.effects.find((e) => e.type === 'volume');
    this.body.appendChild(section('Clip Volume', h('div', sliderRow('Level (dB)', vol.params.level, -40, 15, 0.1, (v, fin) => { const s = this.seq; if (!this.snap) this.snap = JSON.stringify(s.tracks); for (const f of sel) findClip(s, f.clip.id).clip.effects.find((e) => e.type === 'volume').params.level = v; if (fin) { const after = JSON.stringify(s.tracks); s.tracks = JSON.parse(this.snap); this.snap = null; app.store.transact('Clip Volume', () => { s.tracks = JSON.parse(after); }); } }), h('label.check', h('input', { type: 'checkbox', checked: !c.enabled, on: { change: (e) => app.store.transact('Mute', () => { for (const f of sel) findClip(this.seq, f.clip.id).clip.enabled = !e.target.checked; }) } }), 'Mute'))));
  }

  eqPreset(name) {
    const presets = {
      podcast: { hpOn: true, hpFreq: 80, lsGain: -2, p1Freq: 300, p1Gain: -3, p1Q: 1, p2Freq: 3000, p2Gain: 3, p2Q: 0.8, hsGain: 2 },
      broadcast: { hpOn: true, hpFreq: 100, p1Freq: 200, p1Gain: 2, p2Freq: 2500, p2Gain: 3, hsFreq: 10000, hsGain: 3 },
      telephone: { hpOn: true, hpFreq: 400, lpOn: true, lpFreq: 3400, p2Freq: 1500, p2Gain: 6 },
      warm: { lsFreq: 180, lsGain: 3, hsGain: -2 },
      bright: { hsFreq: 8000, hsGain: 5, p3Freq: 5000, p3Gain: 2 },
      muffle: { lpOn: true, lpFreq: 900, lsGain: 3 },
    };
    const p = presets[name];
    const s = this.seq;
    app.store.transact('EQ Preset', () => {
      for (const f of this.clips()) {
        const live = findClip(s, f.clip.id).clip;
        live.effects = live.effects.filter((e) => e.type !== 'parametric_eq');
        if (p) live.effects.push(makeEffect('parametric_eq', p));
      }
    });
  }
  resize() {}
}

export function createTrackMixer(el) { return new TrackMixer(el); }
export function createClipMixer(el) { return new ClipMixer(el); }
export function createMeters(el) { return new MetersPanel(el); }
export function createEssentialSound(el) { return new EssentialSound(el); }
export { dbToGain, gainToDb };
