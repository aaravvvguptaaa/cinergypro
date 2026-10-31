// Effects panel: presets, Lumetri looks, audio effects/transitions, video effects/transitions.
import { app } from '../../app-context.js';
import { h, icon } from '../../core/util.js';
import { VIDEO_EFFECTS, AUDIO_EFFECTS, TRANSITIONS, AUDIO_TRANSITIONS, PLUGIN_EFFECTS, PLUGIN_TRANSITIONS } from '../../core/effect-defs.js';
import { BUILTIN_LOOKS } from '../../engine/lut.js';
import { contextMenu, toast } from '../widgets.js';
import * as A from '../../actions/editing.js';

const BUILTIN_PRESETS = [
  { id: 'p_fadein', name: 'Fade In (1s)', effects: [{ id: 'x', type: 'opacity', enabled: true, params: { opacity: 100, blendMode: 'normal' }, keyframes: { opacity: [{ t: 0, v: 0, interp: 'linear' }, { t: 24, v: 100, interp: 'linear' }] }, masks: [] }], dur: 24, anchor: 'in' },
  { id: 'p_fadeout', name: 'Fade Out (1s)', effects: [{ id: 'x', type: 'opacity', enabled: true, params: { opacity: 100, blendMode: 'normal' }, keyframes: { opacity: [{ t: 0, v: 100, interp: 'linear' }, { t: 24, v: 0, interp: 'linear' }] }, masks: [] }], dur: 24, anchor: 'out' },
  { id: 'p_pushin', name: 'Slow Push In (scale 100 to 115)', effects: [{ id: 'x', type: 'motion', enabled: true, params: { position: [0.5, 0.5], scale: 100, scaleWidth: 100, uniform: true, rotation: 0, anchor: [0.5, 0.5], antiFlicker: 0, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0, flipH: false, flipV: false }, keyframes: { scale: [{ t: 0, v: 100, interp: 'easeInOut' }, { t: 120, v: 115, interp: 'easeInOut' }] }, masks: [] }], dur: 120, scale: true },
  { id: 'p_kenburns', name: 'Ken Burns Pan', effects: [{ id: 'x', type: 'motion', enabled: true, params: { position: [0.5, 0.5], scale: 120, scaleWidth: 120, uniform: true, rotation: 0, anchor: [0.5, 0.5], antiFlicker: 0, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0, flipH: false, flipV: false }, keyframes: { position: [{ t: 0, v: [0.45, 0.5], interp: 'linear' }, { t: 120, v: [0.55, 0.48], interp: 'linear' }] }, masks: [] }], dur: 120, scale: true },
  { id: 'p_blurin', name: 'Blur In', effects: [{ id: 'x', type: 'gaussian_blur', enabled: true, params: { blurriness: 0, dimensions: 'both', repeatEdges: true }, keyframes: { blurriness: [{ t: 0, v: 60, interp: 'easeOut' }, { t: 18, v: 0, interp: 'linear' }] }, masks: [] }], dur: 18, anchor: 'in' },
  { id: 'p_pip_tr', name: 'Picture in Picture - Top Right', effects: [{ id: 'x', type: 'motion', enabled: true, params: { position: [0.78, 0.22], scale: 35, scaleWidth: 35, uniform: true, rotation: 0, anchor: [0.5, 0.5], antiFlicker: 0, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0, flipH: false, flipV: false }, keyframes: {}, masks: [] }], dur: 1 },
  { id: 'p_letterbox', name: 'Cinematic Letterbox 2.39:1', effects: [{ id: 'x', type: 'crop', enabled: true, params: { left: 0, top: 12.2, right: 0, bottom: 12.2, zoom: false, feather: 0 }, keyframes: {}, masks: [] }], dur: 1 },
  { id: 'p_greenscreen', name: 'Green Screen Key + Spill', effects: [{ id: 'x', type: 'ultra_key', enabled: true, params: null, keyframes: {}, masks: [] }], dur: 1 },
  { id: 'p_audiofadein', name: 'Audio Fade In (0.5s)', effects: [{ id: 'x', type: 'volume', enabled: true, params: { bypass: false, level: 0 }, keyframes: { level: [{ t: 0, v: -60, interp: 'linear' }, { t: 12, v: 0, interp: 'linear' }] }, masks: [] }], dur: 12, anchor: 'in' },
  { id: 'p_podcast', name: 'Podcast Voice', effects: [{ id: 'x', type: 'dialogue_clarity', enabled: true, params: { rumble: 60, presence: 40, leveling: 60, air: 25 }, keyframes: {}, masks: [] }, { id: 'y', type: 'limiter', enabled: true, params: { ceiling: -1, inputBoost: 3, release: 80 }, keyframes: {}, masks: [] }], dur: 1 },
];

export class EffectsPanel {
  constructor(el) {
    this.el = el;
    this.open = new Set(['Video Effects']);
    this.q = '';
    app.panels.effects = this;
    this.search = h('input.field', { placeholder: 'Search effects and transitions', on: { input: (e) => { this.q = e.target.value.toLowerCase(); this.render(); }, keydown: (e) => e.stopPropagation() } });
    this.body = h('div.scroll.tree');
    el.append(h('div.toolbar', h('div.search', icon('search', 14), this.search)), this.body);
    app.store.on('project', () => this.render());
    this.render();
  }

  folders() {
    const cats = (map) => { const out = {}; for (const [k, d] of Object.entries(map)) { if (d.intrinsic) continue; (out[d.category] = out[d.category] || []).push([k, d.name]); } return out; };
    const userPresets = [...(app.prefs.get('effects.userPresets') || []), ...(app.store.project.libraries.effectPresets || [])];
    return [
      { name: 'Presets', kind: 'preset', groups: { 'Built-in': BUILTIN_PRESETS.map((p) => [p.id, p.name, p]), ...(userPresets.length ? { 'My Presets': userPresets.map((p) => [p.id, p.name, p]) } : {}) } },
      { name: 'Lumetri Presets', kind: 'look', groups: { 'Creative Looks': Object.entries(BUILTIN_LOOKS).map(([k, l]) => [k, l.name]) } },
      { name: 'Audio Effects', kind: 'effect', groups: cats(AUDIO_EFFECTS) },
      { name: 'Audio Transitions', kind: 'transition', groups: cats(AUDIO_TRANSITIONS) },
      { name: 'Video Effects', kind: 'effect', groups: { ...cats(VIDEO_EFFECTS), ...cats(PLUGIN_EFFECTS) } },
      { name: 'Video Transitions', kind: 'transition', groups: { ...cats(TRANSITIONS), ...cats(PLUGIN_TRANSITIONS) } },
    ];
  }

  render() {
    this.body.innerHTML = '';
    const q = this.q;
    for (const f of this.folders()) {
      const entries = Object.entries(f.groups).map(([g, items]) => [g, items.filter(([, n]) => !q || n.toLowerCase().includes(q) || g.toLowerCase().includes(q))]).filter(([, items]) => items.length);
      if (q && !entries.length) continue;
      const openF = q || this.open.has(f.name);
      this.body.appendChild(this.folderRow(f.name, 0, openF));
      if (!openF) continue;
      for (const [g, items] of entries) {
        const key = f.name + '/' + g; const openG = q || this.open.has(key);
        this.body.appendChild(this.folderRow(g, 1, openG, key));
        if (!openG) continue;
        for (const [id, name, preset] of items) this.body.appendChild(this.itemRow(f.kind, id, name, preset));
      }
    }
  }

  folderRow(name, depth, open, key = name) {
    const n = h('div.node.folder', { style: { paddingLeft: 6 + depth * 14 + 'px' } }, h('span.tw', icon(open ? 'chev-down' : 'chev-right', 11)), h('span', { style: { color: '#f2b33d', display: 'flex' } }, icon('folder', 13)), name);
    n.addEventListener('click', () => { if (this.open.has(key)) this.open.delete(key); else this.open.add(key); this.render(); });
    return n;
  }

  itemRow(kind, id, name, preset) {
    const isAudio = !!AUDIO_EFFECTS[id] || !!AUDIO_TRANSITIONS[id];
    const isDefault = id === app.prefs.get('timeline.defaultVideoTransition') || id === app.prefs.get('timeline.defaultAudioTransition');
    const ic = kind === 'transition' ? 'roll' : kind === 'preset' ? 'stopwatch' : kind === 'look' ? 'palette' : isAudio ? 'wave' : 'fx';
    const n = h('div.node', { style: { paddingLeft: '40px' }, draggable: true }, h('span', { style: { color: 'var(--muted)', display: 'flex' } }, icon(ic, 13)), h('span', { style: { textDecoration: isDefault ? 'underline' : 'none', textDecorationColor: 'var(--blue)' } }, name), kind === 'effect' && !isAudio ? h('span.badge', 'GPU') : null);
    n.addEventListener('dragstart', (e) => {
      if (kind === 'transition') e.dataTransfer.setData('application/x-cinergy-transition', id);
      else if (kind === 'preset') e.dataTransfer.setData('application/x-cinergy-preset', JSON.stringify(this.resolvePreset(preset)));
      else if (kind === 'look') e.dataTransfer.setData('application/x-cinergy-preset', JSON.stringify({ id, name, effects: [{ id: 'l', type: 'lumetri', enabled: true, params: { ...this.lumetriDefaults(), look: id }, keyframes: {}, masks: [] }] }));
      else e.dataTransfer.setData('application/x-cinergy-effect', id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    n.addEventListener('dblclick', () => this.apply(kind, id, preset));
    n.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [
      { label: 'Apply to Selected Clips', action: () => this.apply(kind, id, preset) },
      kind === 'transition' ? { label: 'Set Selected as Default Transition', action: () => { app.prefs.set(isAudio ? 'timeline.defaultAudioTransition' : 'timeline.defaultVideoTransition', id); this.render(); toast(`${name} is now the default ${isAudio ? 'audio' : 'video'} transition`); } } : null,
      kind === 'preset' && String(id).startsWith('pre') ? { label: 'Delete Preset', action: () => { app.prefs.set('effects.userPresets', (app.prefs.get('effects.userPresets') || []).filter((p) => p.id !== id)); app.store.project.libraries.effectPresets = app.store.project.libraries.effectPresets.filter((p) => p.id !== id); this.render(); } } : null,
    ]); });
    return n;
  }

  lumetriDefaults() { const p = {}; for (const d of VIDEO_EFFECTS.lumetri.params) p[d.name] = JSON.parse(JSON.stringify(d.default)); return p; }

  resolvePreset(p) {
    const out = JSON.parse(JSON.stringify(p));
    for (const e of out.effects) if (!e.params) { const d = (VIDEO_EFFECTS[e.type] || AUDIO_EFFECTS[e.type]); e.params = {}; for (const q of d.params) e.params[q.name] = JSON.parse(JSON.stringify(q.default)); }
    // presets were authored at 24 fps; scale to the sequence rate
    const fps = app.store.seq ? app.store.seq.settings.fps : 24;
    const k = fps / 24;
    if (!String(p.id).startsWith('pre')) { for (const e of out.effects) for (const keys of Object.values(e.keyframes || {})) for (const kf of keys) kf.t = Math.round(kf.t * k); out.dur = Math.round((out.dur || 1) * k); }
    return out;
  }

  apply(kind, id, preset) {
    if (kind === 'transition') { const audio = !!AUDIO_TRANSITIONS[id]; const key = audio ? 'timeline.defaultAudioTransition' : 'timeline.defaultVideoTransition'; const prev = app.prefs.get(key); app.prefs.data.timeline[audio ? 'defaultAudioTransition' : 'defaultVideoTransition'] = id; A.applyDefaultTransition(audio ? 'audio' : 'video'); app.prefs.data.timeline[audio ? 'defaultAudioTransition' : 'defaultVideoTransition'] = prev; return; }
    if (kind === 'preset') return A.applyPreset(this.resolvePreset(preset));
    if (kind === 'look') return A.applyPreset({ id, effects: [{ id: 'l', type: 'lumetri', enabled: true, params: { ...this.lumetriDefaults(), look: id }, keyframes: {}, masks: [] }] });
    A.applyEffect(id);
  }

  resize() {}
}

export function createEffectsPanel(el) { return new EffectsPanel(el); }
export { BUILTIN_PRESETS };
