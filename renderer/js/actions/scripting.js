// Scripting API (Script Console, script files) and the plugin system for GLSL effects,
// transitions and scripts.
import { app } from '../app-context.js';
import { allTracks, seqDuration, findClip } from '../core/project.js';
import { PLUGIN_EFFECTS, PLUGIN_TRANSITIONS } from '../core/effect-defs.js';
import { hexToRgb, basename } from '../core/util.js';
import { toast } from '../ui/widgets.js';

function seqWrap(seq) {
  if (!seq) return null;
  return {
    id: seq.id, name: seq.name, settings: { ...seq.settings },
    get playhead() { return seq.playhead; }, set playhead(f) { app.player.seek(f); },
    duration: () => seqDuration(seq),
    tracks: () => ({ video: seq.tracks.video.map((t) => ({ id: t.id, name: t.name, clips: t.clips.length })), audio: seq.tracks.audio.map((t) => ({ id: t.id, name: t.name, clips: t.clips.length })) }),
    clips: () => allTracks(seq).flatMap((t) => t.clips.map((c) => ({ id: c.id, name: c.name, kind: c.kind, track: t.name, start: c.start, end: c.start + c.dur, speed: c.speed, effects: c.effects.map((e) => e.type) }))),
    markers: () => seq.markers.map((m) => ({ ...m })),
    addMarker: (frame, name = '', comment = '', color = 'green') => app.store.transact('Script: Add Marker', () => { seq.markers.push({ id: 'mk_' + Math.random().toString(36).slice(2), frame, dur: 0, name, comment, color, type: 'comment' }); }, [seq.id]),
    select: (ids) => app.store.selectClips(ids),
    razor: async (frame, allTracksToo = true) => { const E = await import('../core/edit.js'); app.store.transact('Script: Razor', () => E.razorAt(seq, frame, allTracksToo ? allTracks(seq) : allTracks(seq).filter((t) => t.target)), [seq.id]); },
    insert: async (itemId, frame, mode = 'overwrite') => { const E = await import('../core/edit.js'); const it = app.store.project.items[itemId]; const { itemDuration } = await import('../core/project.js'); const d = itemDuration(app.store.project, it); app.store.transact('Script: Edit', () => E.editItemIntoSequence(app.store.project, seq, it, it.inPoint || 0, it.outPoint || (isFinite(d) ? d : 5), frame ?? seq.playhead, mode), [seq.id]); },
    applyEffect: async (clipId, type, params = {}) => { const m = await import('./editing.js'); m.applyEffect(type, [clipId], { params }); },
    setClip: (clipId, patch) => app.store.transact('Script: Edit Clip', () => { const f = findClip(seq, clipId); if (f) Object.assign(f.clip, patch); }, [seq.id]),
    export: async (out, presetId = 'h264_match') => { const m = await import('./export.js'); const p = m.PRESETS.find((x) => x.id === presetId) || m.PRESETS[0]; const v = { ...p, preset: p.id, out, range: 'all', audioCodec: p.audioCodec || 'aac', sampleRate: 48000, channels: 2, crf: p.crf ?? 18, bitrateMode: p.bitrateMode || 'crf', width: p.width || seq.settings.width, height: p.height || seq.settings.height, fps: 0, captions: 'none', title: seq.name }; return m.runExport(seq, v, { progress: { set() {}, close() {}, cancelled: false } }); },
  };
}

export const scriptingAPI = {
  build(log) {
    const api = {
      version: app.info ? app.info.version : '1.0',
      log,
      project: () => ({ name: app.store.project.name, path: app.store.path, items: () => Object.values(app.store.project.items).map((i) => ({ id: i.id, type: i.type, name: i.name, path: i.path, parent: i.parent })), save: () => import('./project-io.js').then((m) => m.saveProject()) }),
      importMedia: async (paths) => (await import('./media.js')).importPaths(Array.isArray(paths) ? paths : [paths]),
      sequence: (id) => seqWrap(id ? app.store.project.items[id] : app.store.seq),
      sequences: () => Object.values(app.store.project.items).filter((i) => i.type === 'sequence').map((s) => ({ id: s.id, name: s.name })),
      openSequence: (id) => app.store.setActiveSequence(id),
      newSequence: async (opts = {}) => (await import('./editing.js')).createSequenceFrom({ name: 'Scripted Sequence', width: 1920, height: 1080, fps: 24, pixelAspect: 1, fieldOrder: 'progressive', colorSpace: 'rec709', sampleRate: 48000, audioChannels: 'stereo', videoTracks: 3, audioTracks: 3, ...opts }).id,
      run: (cmd, arg) => app.commands.run(cmd, arg),
      commands: () => app.commands.list().map((c) => ({ id: c.id, label: c.label, keys: app.commands.keysFor(c.id) })),
      undo: () => app.store.undo(), redo: () => app.store.redo(),
      play: () => app.player.play(1), stop: () => app.player.pause(),
      fs: { read: (p) => window.native.call('fs:read-text', p), write: (p, s) => window.native.call('fs:write-text', p, s), list: (p) => window.native.call('fs:list', p) },
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    return api;
  },
  async run(code, log = console.log) {
    const cinergy = this.build(log);
    const fn = new Function('cinergy', 'log', `return (async () => { ${/\breturn\b/.test(code) ? code : 'return (' + code.replace(/;\s*$/, '') + ')'} })()`);
    try { return await fn(cinergy, log); }
    catch (e) {
      if (e instanceof SyntaxError) { const fn2 = new Function('cinergy', 'log', `return (async () => { ${code} })()`); return fn2(cinergy, log); }
      throw e;
    }
  },
};

// ---------------- Plugins ----------------
// <Plugins>/<name>/manifest.json:
// { "name": "...", "effects": [{ "id", "name", "category", "shader": "x.glsl", "params": [{name,label,type,default,min,max}] }],
//   "transitions": [{ "id", "name", "category", "shader": "t.glsl" }], "scripts": [{ "name", "file" }] }
export const plugins = { loaded: [], scripts: [] };

function uniformsFor(params, p) {
  const out = {};
  for (const d of params) {
    const u = 'u' + d.name[0].toUpperCase() + d.name.slice(1);
    const v = p[d.name];
    if (d.type === 'color') out[u] = hexToRgb(v).slice(0, 3);
    else if (d.type === 'point') out[u] = [v[0], 1 - v[1]];
    else if (d.type === 'bool') out[u] = v ? 1 : 0;
    else if (d.type === 'angle') out[u] = v * Math.PI / 180;
    else out[u] = +v;
  }
  return out;
}

export async function loadPlugins() {
  if (app.prefs.get('scripting.enablePlugins') === false) return;
  const dir = app.info.pluginsDir;
  let folders = [];
  try { folders = (await window.native.call('fs:list', dir)).filter((f) => f.dir); } catch { return; }
  for (const f of folders) {
    try {
      const man = JSON.parse(await window.native.call('fs:read-text', `${f.path}/manifest.json`));
      for (const e of man.effects || []) {
        const src = await window.native.call('fs:read-text', `${f.path}/${e.shader}`);
        const key = 'plugin_' + (man.id || basename(f.path)) + '_' + e.id;
        const params = (e.params || []).map((p) => ({ step: 0.1, ...p }));
        PLUGIN_EFFECTS[key] = {
          name: e.name, category: e.category || ('Plugins: ' + (man.name || basename(f.path))), masks: true, params, plugin: true,
          impl: (ctx, inp, p) => { const o = ctx.acquire(inp.w, inp.h); ctx.pass(key, src.includes('uniform sampler2D uTex') ? src : 'uniform sampler2D uTex;\n' + src, o, { uTex: inp }, uniformsFor(params, p)); return o; },
        };
        app.effectDefs[key] = PLUGIN_EFFECTS[key];
      }
      for (const t of man.transitions || []) {
        const src = await window.native.call('fs:read-text', `${f.path}/${t.shader}`);
        const key = 'plugin_' + (man.id || basename(f.path)) + '_' + t.id;
        PLUGIN_TRANSITIONS[key] = { name: t.name, category: t.category || 'Plugins', params: t.params || [], src };
      }
      for (const s of man.scripts || []) plugins.scripts.push({ name: s.name, path: `${f.path}/${s.file}`, plugin: man.name });
      plugins.loaded.push({ name: man.name || basename(f.path), path: f.path, version: man.version || '' });
    } catch (e) { console.warn('Plugin failed to load', f.path, e); toast(`Plugin "${basename(f.path)}" failed to load: ${e.message}`, 'warn', 6000); }
  }
  app.compositor.onPluginFrag = (type) => (PLUGIN_TRANSITIONS[type] ? PLUGIN_TRANSITIONS[type].src : null);
  // user scripts folder
  try {
    const sdir = `${app.info.userData}/Scripts`;
    await window.native.call('fs:mkdir', sdir);
    for (const s of (await window.native.call('fs:list', sdir)).filter((x) => x.name.endsWith('.js'))) plugins.scripts.push({ name: s.name.replace(/\.js$/, ''), path: s.path });
  } catch {}
  if (app.panels.effects) app.panels.effects.render();
}

export async function installSamplePlugin() {
  const dir = `${app.info.pluginsDir}/sample-effects`;
  await window.native.call('fs:write-text', `${dir}/manifest.json`, JSON.stringify({
    id: 'sample', name: 'Sample Effects', version: '1.0',
    effects: [{ id: 'duotone', name: 'Duotone', category: 'Plugins: Sample', shader: 'duotone.glsl', params: [{ name: 'dark', label: 'Shadows', type: 'color', default: '#1b1464' }, { name: 'light', label: 'Highlights', type: 'color', default: '#ffb347' }, { name: 'mix', label: 'Amount', type: 'number', default: 100, min: 0, max: 100 }] }],
    transitions: [{ id: 'swirl', name: 'Swirl', shader: 'swirl.glsl' }],
    scripts: [{ name: 'Add marker every 10 seconds', file: 'markers.js' }],
  }, null, 2));
  await window.native.call('fs:write-text', `${dir}/duotone.glsl`, `uniform sampler2D uTex; uniform vec3 uDark; uniform vec3 uLight; uniform float uMix;
void main(){ vec4 s = unpm(texture(uTex, vUv)); float l = luma(s.rgb); vec3 d = mix(uDark, uLight, l); fragColor = pm(vec4(mix(s.rgb, d, uMix/100.0), s.a)); }`);
  await window.native.call('fs:write-text', `${dir}/swirl.glsl`, `void main(){ vec2 d = vUv - 0.5; float r = length(d); float a = (1.0 - smoothstep(0.0, 0.7, r)) * sin(uP * 3.14159) * 6.0; d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d; vec2 uv = d + 0.5; fragColor = mix(texture(uA, uv), texture(uB, uv), smoothstep(0.3, 0.7, uP)); }`);
  await window.native.call('fs:write-text', `${dir}/markers.js`, `const s = cinergy.sequence(); const step = Math.round(s.settings.fps * 10);\nfor (let f = 0; f < s.duration(); f += step) s.addMarker(f, 'Beat ' + (f / step + 1));\nlog('Added markers');`);
  toast('Sample plugin installed. Restart CinergyPro to load it.');
}
