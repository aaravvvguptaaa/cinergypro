// Application preferences persisted to the user data folder.
import { Emitter, deepClone } from './util.js';

export const DEFAULT_PREFS = {
  general: { startup: 'home', showTooltips: true, language: 'en', recentProjects: [], timeDisplay: 'tc', confirmDeletes: true },
  appearance: { brightness: 0, interfaceScale: 1, accent: '#2f7cff', highContrast: false, reduceMotion: false },
  autosave: { enabled: true, interval: 5, maxVersions: 20, saveToCloud: false },
  timeline: {
    stillDuration: 5, videoTransitionDur: 24, audioTransitionDur: 12, defaultVideoTransition: 'cross_dissolve', defaultAudioTransition: 'constant_power',
    snapping: true, snapPlayhead: true, autoscroll: 'page', selectionFollowsPlayhead: false, showThumbnails: 'heads', showWaveforms: true, showClipNames: true,
    rippleTrimMode: 'shift', insertDefault: 'overwrite', autoCreateTracks: true, rectifiedWaveforms: true, showDuplicates: false, showThroughEdits: true, linkedSelection: true,
    scrollWheel: 'scroll', defaultScaleToFrame: 'none', playheadSnapOnEdit: true, keyframeInterp: 'linear',
  },
  playback: { preroll: 2, postroll: 2, stepFrames: 5, loop: false, resolution: 'full', pausedResolution: 'full', highQuality: false, audioScrub: true, maintainPitchShuttle: true, outputDevice: 'default', bufferMs: 40 },
  audio: { outputDevice: 'default', inputDevice: 'default', sampleRate: 48000, latencyHint: 'interactive', automationKeyframeThin: 1, defaultMix: 'stereo', meterType: 'dbfs', loudnessTarget: -23 },
  media: { importSubfolders: true, createBinsFromFolders: true, autoProxy: 'unsupported', proxyHeight: 720, proxyCodec: 'h264', imageSequenceFps: 24, defaultScale: 'none', generateWaveforms: true, xmpWrite: false, relinkSearchDepth: 6 },
  cache: { location: 'default', maxGB: 50, autoDeleteDays: 90 },
  color: { displayColorManagement: true, viewerGamma: 'mac', hdrGraphicsWhite: 203, scopesQuality: 'medium' },
  export: { lastDir: '', defaultPreset: 'h264_match', openAfterExport: false, notifyOnComplete: true, hardwareEncoding: true },
  graphics: { defaultFont: 'Inter', defaultSize: 96, textRenderer: 'standard' },
  labels: { video: 'iris', audio: 'forest', image: 'lavender', sequence: 'forest', bin: 'mango', adjustment: 'lavender', graphic: 'rose' },
  shortcuts: { preset: 'cinergy', custom: null },
  workspaces: { current: 'Editing', custom: {}, order: ['Assembly', 'Editing', 'Color', 'Effects', 'Audio', 'Captions', 'Graphics', 'Review', 'Learning'], modified: {} },
  memory: { reservedGB: 4, optimizeFor: 'performance' },
  scripting: { enablePlugins: true, enableScripts: true },
};

class Prefs extends Emitter {
  constructor() { super(); this.data = deepClone(DEFAULT_PREFS); this.path = null; }
  async load(userData) {
    this.path = userData + '/prefs.json';
    try {
      const s = await window.native.call('fs:read-text', this.path);
      this.data = merge(deepClone(DEFAULT_PREFS), JSON.parse(s));
    } catch { this.data = deepClone(DEFAULT_PREFS); }
    this.emit('change');
  }
  get(path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.data); }
  set(path, value) {
    const keys = path.split('.'); let o = this.data;
    for (const k of keys.slice(0, -1)) o = o[k] = o[k] || {};
    o[keys[keys.length - 1]] = value;
    this.save();
    this.emit('change', path);
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => { if (this.path) window.native.call('fs:write-text', this.path, JSON.stringify(this.data, null, 2)).catch(() => {}); }, 300);
  }
  reset(section) { if (section) this.data[section] = deepClone(DEFAULT_PREFS[section]); else this.data = deepClone(DEFAULT_PREFS); this.save(); this.emit('change'); }
}

function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export const prefs = new Prefs();
