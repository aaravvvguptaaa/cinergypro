// Export: presets, export dialog, render pipeline, batch queue, still frames, render previews.
import { app } from '../app-context.js';
import { seqDuration, allTracks, findClip } from '../core/project.js';
import { h, stem, dirname, basename, uid, deepClone, Emitter } from '../core/util.js';
import { modal, form, toast, progressDialog } from '../ui/widgets.js';
import { jobs } from './jobs.js';
import { framesToTC } from '../core/timecode.js';
import { AudioEngine } from '../engine/audio-engine.js';
import { hashStr } from '../engine/compositor.js';

export const PRESETS = [
  { id: 'h264_match', group: 'Recommended', name: 'H.264 - Match Source, High Bitrate', container: 'mp4', codec: 'h264', crf: 16, audioCodec: 'aac', audioBitrate: 320 },
  { id: 'h264_1080', group: 'Recommended', name: 'H.264 1080p', container: 'mp4', codec: 'h264', width: 1920, height: 1080, crf: 18, audioCodec: 'aac', audioBitrate: 320 },
  { id: 'h264_4k', group: 'Recommended', name: 'H.264 4K UHD', container: 'mp4', codec: 'h264', width: 3840, height: 2160, crf: 18, audioCodec: 'aac', audioBitrate: 320 },
  { id: 'hevc_4k', group: 'Recommended', name: 'HEVC 4K UHD', container: 'mp4', codec: 'hevc', width: 3840, height: 2160, crf: 22, audioCodec: 'aac', audioBitrate: 320 },
  { id: 'youtube_1080', group: 'Social', name: 'YouTube 1080p Full HD', container: 'mp4', codec: 'h264', width: 1920, height: 1080, bitrateMode: 'vbr', videoBitrate: 16, audioCodec: 'aac', audioBitrate: 384 },
  { id: 'youtube_4k', group: 'Social', name: 'YouTube 2160p 4K', container: 'mp4', codec: 'h264', width: 3840, height: 2160, bitrateMode: 'vbr', videoBitrate: 45, audioCodec: 'aac', audioBitrate: 384 },
  { id: 'vimeo_1080', group: 'Social', name: 'Vimeo 1080p', container: 'mp4', codec: 'h264', width: 1920, height: 1080, bitrateMode: 'vbr', videoBitrate: 20, audioCodec: 'aac', audioBitrate: 320 },
  { id: 'reels', group: 'Social', name: 'Instagram Reels / TikTok 9:16', container: 'mp4', codec: 'h264', width: 1080, height: 1920, bitrateMode: 'vbr', videoBitrate: 12, audioCodec: 'aac', audioBitrate: 256, maxFps: 30 },
  { id: 'insta_square', group: 'Social', name: 'Instagram Feed 1:1', container: 'mp4', codec: 'h264', width: 1080, height: 1080, bitrateMode: 'vbr', videoBitrate: 10, audioCodec: 'aac', audioBitrate: 256 },
  { id: 'x_1080', group: 'Social', name: 'X 1080p', container: 'mp4', codec: 'h264', width: 1920, height: 1080, bitrateMode: 'vbr', videoBitrate: 12, audioCodec: 'aac', audioBitrate: 256, maxFps: 60 },
  { id: 'linkedin', group: 'Social', name: 'LinkedIn 1080p', container: 'mp4', codec: 'h264', width: 1920, height: 1080, bitrateMode: 'vbr', videoBitrate: 10, audioCodec: 'aac', audioBitrate: 256 },
  { id: 'facebook', group: 'Social', name: 'Facebook 1080p', container: 'mp4', codec: 'h264', width: 1920, height: 1080, bitrateMode: 'vbr', videoBitrate: 12, audioCodec: 'aac', audioBitrate: 256 },
  { id: 'prores_422', group: 'Mastering', name: 'Apple ProRes 422', container: 'mov', codec: 'prores_422', audioCodec: 'pcm24' },
  { id: 'prores_hq', group: 'Mastering', name: 'Apple ProRes 422 HQ', container: 'mov', codec: 'prores_hq', audioCodec: 'pcm24' },
  { id: 'prores_4444', group: 'Mastering', name: 'Apple ProRes 4444 with Alpha', container: 'mov', codec: 'prores_4444', alpha: true, audioCodec: 'pcm24' },
  { id: 'prores_lt', group: 'Mastering', name: 'Apple ProRes 422 LT', container: 'mov', codec: 'prores_lt', audioCodec: 'pcm24' },
  { id: 'prores_proxy', group: 'Review', name: 'Apple ProRes 422 Proxy', container: 'mov', codec: 'prores_proxy', audioCodec: 'pcm16' },
  { id: 'dnxhr_hq', group: 'Mastering', name: 'DNxHR HQ (MXF OP1a)', container: 'mxf', codec: 'dnxhr_hq', audioCodec: 'pcm24' },
  { id: 'dnxhr_hqx', group: 'Mastering', name: 'DNxHR HQX 10-bit (MOV)', container: 'mov', codec: 'dnxhr_hqx', audioCodec: 'pcm24' },
  { id: 'dnxhr_sq', group: 'Broadcast', name: 'DNxHR SQ (MXF OP1a)', container: 'mxf', codec: 'dnxhr_sq', audioCodec: 'pcm24' },
  { id: 'hdr10', group: 'HDR', name: 'HEVC HDR10 (PQ) 10-bit', container: 'mov', codec: 'hevc', hdr: 'pq', crf: 18, audioCodec: 'aac', audioBitrate: 320 },
  { id: 'hlg', group: 'HDR', name: 'HEVC HLG 10-bit', container: 'mov', codec: 'hevc', hdr: 'hlg', crf: 18, audioCodec: 'aac', audioBitrate: 320 },
  { id: 'review_low', group: 'Review', name: 'Review Copy 720p (small file)', container: 'mp4', codec: 'h264', width: 1280, height: 720, crf: 26, preset: 'faster', audioCodec: 'aac', audioBitrate: 160, burnTimecode: true },
  { id: 'webm', group: 'Web', name: 'WebM VP9', container: 'webm', codec: 'vp9', crf: 30, audioCodec: 'opus', audioBitrate: 192 },
  { id: 'webm_alpha', group: 'Web', name: 'WebM VP9 with Alpha', container: 'webm', codec: 'vp9', crf: 30, alpha: true, audioCodec: 'opus', audioBitrate: 192 },
  { id: 'gif', group: 'Web', name: 'Animated GIF (480 px)', container: 'gif', codec: 'gif', width: 480, audioCodec: 'none', maxFps: 15 },
  { id: 'wav', group: 'Audio Only', name: 'WAV 48 kHz 24-bit', container: 'wav', audioOnly: true, audioCodec: 'pcm24' },
  { id: 'aiff', group: 'Audio Only', name: 'AIFF 48 kHz 24-bit', container: 'aiff', audioOnly: true, audioCodec: 'pcm24be' },
  { id: 'mp3', group: 'Audio Only', name: 'MP3 320 kbps', container: 'mp3', audioOnly: true, audioCodec: 'mp3', audioBitrate: 320 },
  { id: 'aac', group: 'Audio Only', name: 'AAC 256 kbps (M4A)', container: 'm4a', audioOnly: true, audioCodec: 'aac', audioBitrate: 256 },
  { id: 'flac', group: 'Audio Only', name: 'FLAC Lossless', container: 'flac', audioOnly: true, audioCodec: 'flac' },
  { id: 'png_seq', group: 'Image Sequence', name: 'PNG Sequence', container: 'png', codec: 'png', imageSequence: true, alpha: true, audioCodec: 'none' },
  { id: 'tiff_seq', group: 'Image Sequence', name: 'TIFF Sequence', container: 'tif', codec: 'tiff', imageSequence: true, audioCodec: 'none' },
  { id: 'jpeg_seq', group: 'Image Sequence', name: 'JPEG Sequence', container: 'jpg', codec: 'mjpeg', imageSequence: true, audioCodec: 'none' },
  { id: 'dpx_seq', group: 'Image Sequence', name: 'DPX Sequence (10-bit)', container: 'dpx', codec: 'dpx', imageSequence: true, audioCodec: 'none' },
];

const CODECS_FOR = {
  mp4: [['h264', 'H.264'], ['hevc', 'HEVC (H.265)']], mov: [['h264', 'H.264'], ['hevc', 'HEVC (H.265)'], ['prores_proxy', 'ProRes 422 Proxy'], ['prores_lt', 'ProRes 422 LT'], ['prores_422', 'ProRes 422'], ['prores_hq', 'ProRes 422 HQ'], ['prores_4444', 'ProRes 4444'], ['prores_4444xq', 'ProRes 4444 XQ'], ['dnxhr_lb', 'DNxHR LB'], ['dnxhr_sq', 'DNxHR SQ'], ['dnxhr_hq', 'DNxHR HQ'], ['dnxhr_hqx', 'DNxHR HQX'], ['dnxhr_444', 'DNxHR 444'], ['png', 'PNG (lossless)']],
  mxf: [['dnxhr_lb', 'DNxHR LB'], ['dnxhr_sq', 'DNxHR SQ'], ['dnxhr_hq', 'DNxHR HQ'], ['dnxhr_hqx', 'DNxHR HQX']], webm: [['vp9', 'VP9']], gif: [['gif', 'GIF']], mkv: [['h264', 'H.264'], ['hevc', 'HEVC'], ['vp9', 'VP9']],
  png: [['png', 'PNG']], tif: [['tiff', 'TIFF']], jpg: [['mjpeg', 'JPEG']], dpx: [['dpx', 'DPX']],
};
const AUDIO_FOR = { mp4: [['aac', 'AAC'], ['none', 'No audio']], mov: [['aac', 'AAC'], ['pcm16', 'PCM 16-bit'], ['pcm24', 'PCM 24-bit'], ['none', 'No audio']], mxf: [['pcm24', 'PCM 24-bit'], ['pcm16', 'PCM 16-bit']], webm: [['opus', 'Opus'], ['none', 'No audio']], mkv: [['aac', 'AAC'], ['flac', 'FLAC'], ['opus', 'Opus']],
  wav: [['pcm16', 'PCM 16-bit'], ['pcm24', 'PCM 24-bit'], ['pcm32f', '32-bit float']], aiff: [['pcm24be', 'PCM 24-bit'], ['pcm16', 'PCM 16-bit']], mp3: [['mp3', 'MP3']], m4a: [['aac', 'AAC']], flac: [['flac', 'FLAC']] };

export const queue = new (class extends Emitter { constructor() { super(); this.items = []; this.running = false; } add(j) { this.items.push({ ...j, id: uid('q'), status: 'queued', progress: 0 }); this.emit('change'); } })();

function userPresets() { return app.prefs.get('export.userPresets') || []; }

export async function exportDialog(opts = {}) {
  const seqs = opts.seqIds ? opts.seqIds.map((id) => app.store.project.items[id]) : [app.store.seq];
  const seq = seqs[0];
  if (!seq) return toast('Open a sequence to export', 'warn');
  const lastId = app.prefs.get('export.defaultPreset') || 'h264_match';
  const all = [...PRESETS, ...userPresets()];
  const base = all.find((p) => p.id === lastId) || PRESETS[0];
  const vals = defaultsFrom(base, seq);
  vals.range = seq.inPoint != null && seq.outPoint != null ? 'inout' : 'all';
  const dir = app.prefs.get('export.lastDir') || app.info.movies || app.info.documents;
  vals.out = `${dir}/${seq.name}.${base.container}`;
  const preview = h('canvas', { width: 320, height: 180, style: { width: '100%', borderRadius: '6px', background: '#000', display: 'block' } });
  const summary = h('div', { style: { color: 'var(--muted)', fontSize: '11px', lineHeight: 1.6, marginTop: '8px', fontFamily: 'var(--mono)' } });
  let f;
  const spec = [
    { type: 'group', label: 'Preset' },
    { key: 'preset', label: 'Preset', type: 'select', string: true, options: all.map((p) => [p.id, `${p.group}: ${p.name}`]), onChange: (v, values) => { const p = all.find((x) => x.id === v); Object.assign(values, defaultsFrom(p, seq)); values.out = values.out.replace(/\.[^.\/]+$/, '') + (p.imageSequence ? '_#####.' : '.') + p.container; rebuild(); } },
    { type: 'group', label: 'Output' },
    { key: 'out', label: 'File', type: 'savefile' },
    { key: 'range', label: 'Range', type: 'select', string: true, options: [['all', 'Entire Sequence'], ['inout', 'Sequence In/Out'], ['custom', 'Custom']] },
    { key: 'customIn', label: 'Start', show: (v) => v.range === 'custom' }, { key: 'customOut', label: 'End', show: (v) => v.range === 'custom' },
    { type: 'group', label: 'Video', show: (v) => !v.audioOnly },
    { key: 'container', label: 'Format', type: 'select', string: true, options: Object.keys(CODECS_FOR).map((k) => [k, k.toUpperCase()]).concat([['wav', 'WAV'], ['aiff', 'AIFF'], ['mp3', 'MP3'], ['m4a', 'M4A'], ['flac', 'FLAC']]), onChange: (v, values) => { values.audioOnly = ['wav', 'aiff', 'mp3', 'm4a', 'flac'].includes(v); values.imageSequence = ['png', 'tif', 'jpg', 'dpx'].includes(v); if (CODECS_FOR[v]) values.codec = CODECS_FOR[v][0][0]; if (AUDIO_FOR[v]) values.audioCodec = AUDIO_FOR[v][0][0]; values.out = values.out.replace(/(_#####)?\.[^.\/]+$/, '') + (values.imageSequence ? '_#####.' : '.') + v; rebuild(); } },
    { key: 'codec', label: 'Codec', type: 'select', string: true, options: (v) => CODECS_FOR[v.container] || [['h264', 'H.264']], show: (v) => !v.audioOnly },
    { key: 'width', label: 'Width', type: 'number', show: (v) => !v.audioOnly }, { key: 'height', label: 'Height', type: 'number', show: (v) => !v.audioOnly },
    { key: 'fps', label: 'Frame rate', type: 'select', options: [[0, 'Match sequence'], [23.976, '23.976'], [24, '24'], [25, '25'], [29.97, '29.97'], [30, '30'], [50, '50'], [59.94, '59.94'], [60, '60'], [15, '15'], [12, '12']], show: (v) => !v.audioOnly },
    { key: 'bitrateMode', label: 'Bitrate encoding', type: 'select', string: true, options: [['crf', 'Constant quality'], ['vbr', 'VBR'], ['cbr', 'CBR']], show: (v) => ['h264', 'hevc', 'vp9'].includes(v.codec) && !v.audioOnly },
    { key: 'crf', label: 'Quality (CRF)', type: 'range', min: 10, max: 40, step: 1, note: 'Lower is higher quality', show: (v) => v.bitrateMode === 'crf' && ['h264', 'hevc', 'vp9'].includes(v.codec) && !v.audioOnly },
    { key: 'videoBitrate', label: 'Target bitrate (Mb/s)', type: 'number', min: 0.5, max: 800, step: 0.5, show: (v) => v.bitrateMode !== 'crf' && ['h264', 'hevc', 'vp9'].includes(v.codec) && !v.audioOnly },
    { key: 'profile', label: 'Profile', type: 'select', string: true, options: [['', 'Auto'], ['baseline', 'Baseline'], ['main', 'Main'], ['high', 'High']], show: (v) => v.codec === 'h264' && !v.audioOnly && !v.hw },
    { key: 'level', label: 'Level', type: 'select', string: true, options: [['', 'Auto'], ['4.0', '4.0'], ['4.1', '4.1'], ['4.2', '4.2'], ['5.1', '5.1'], ['5.2', '5.2']], show: (v) => v.codec === 'h264' && !v.audioOnly && !v.hw },
    { key: 'gop', label: 'Keyframe distance', type: 'number', min: 0, max: 600, note: 'Frames between keyframes; 0 = encoder default', show: (v) => ['h264', 'hevc', 'vp9'].includes(v.codec) && !v.audioOnly },
    { key: 'hdr', label: 'HDR', type: 'select', string: true, options: [['', 'SDR (Rec. 709)'], ['pq', 'HDR10 (PQ)'], ['hlg', 'HLG']], show: (v) => v.codec === 'hevc' || v.codec.startsWith('prores') },
    { key: 'alpha', label: 'Alpha channel', type: 'check', text: 'Render alpha channel', show: (v) => ['prores_4444', 'prores_4444xq', 'png', 'vp9', 'tiff'].includes(v.codec) },
    { key: 'hw', label: 'Encoding', type: 'check', text: 'Hardware encoding (VideoToolbox)', show: (v) => ['h264', 'hevc'].includes(v.codec) && app.info.platform === 'darwin' },
    { type: 'group', label: 'Audio' },
    { key: 'audioCodec', label: 'Audio format', type: 'select', string: true, options: (v) => AUDIO_FOR[v.container] || [['aac', 'AAC'], ['none', 'No audio']] },
    { key: 'sampleRate', label: 'Sample rate', type: 'select', options: [[48000, '48000 Hz'], [44100, '44100 Hz'], [96000, '96000 Hz']] },
    { key: 'channels', label: 'Channels', type: 'select', options: [[2, 'Stereo'], [1, 'Mono']] },
    { key: 'audioBitrate', label: 'Bitrate (kbps)', type: 'select', options: [[128, '128'], [160, '160'], [192, '192'], [256, '256'], [320, '320'], [384, '384']], show: (v) => ['aac', 'mp3', 'opus'].includes(v.audioCodec) },
    { key: 'normalize', label: 'Loudness', type: 'select', string: true, options: [['', 'No normalization'], ['-14', 'Normalize to -14 LUFS (streaming)'], ['-16', 'Normalize to -16 LUFS (podcast)'], ['-23', 'Normalize to -23 LUFS (EBU R128)'], ['-24', 'Normalize to -24 LKFS (ATSC A/85)']] },
    { type: 'group', label: 'Captions and overlays' },
    { key: 'captions', label: 'Captions', type: 'select', string: true, options: [['none', 'None'], ['burn', 'Burn captions into video'], ['srt', 'Create sidecar SRT file'], ['vtt', 'Create sidecar WebVTT file']] },
    { key: 'burnTimecode', label: 'Timecode', type: 'check', text: 'Burn in timecode', show: (v) => !v.audioOnly },
    { type: 'group', label: 'Metadata' },
    { key: 'title', label: 'Title' }, { key: 'artist', label: 'Author' }, { key: 'copyright', label: 'Copyright' }, { key: 'comment', label: 'Description' },
    { type: 'group', label: 'After export' },
    { key: 'openAfter', label: '', type: 'check', text: 'Reveal file when finished' },
    { key: 'importAfter', label: '', type: 'check', text: 'Import into project' },
  ];
  const holder = h('div');
  const rebuild = () => { f = form(spec, vals); holder.innerHTML = ''; holder.appendChild(f.el); Object.assign(vals, f.values); f.values = vals; updateSummary(); };
  const updateSummary = () => {
    const [a, b] = rangeOf(seq, vals);
    const secs = (b - a) / seq.settings.fps;
    const br = vals.audioOnly ? (vals.audioBitrate || 1411) / 1000 : (vals.bitrateMode !== 'crf' && vals.videoBitrate ? vals.videoBitrate : estimateBitrate(vals));
    summary.innerHTML = '';
    summary.append(h('div', `Source: ${seq.name}, ${seq.settings.width}x${seq.settings.height}, ${seq.settings.fps} fps`), h('div', `Output: ${vals.audioOnly ? 'audio only' : (vals.width || seq.settings.width) + 'x' + (vals.height || seq.settings.height)}, ${vals.codec || vals.audioCodec}`), h('div', `Duration: ${framesToTC(b - a, seq.settings.fps)}`), h('div', `Estimated size: ${br ? Math.round(br * secs / 8) + ' MB' : 'varies'}`));
  };
  rebuild();
  // poster frame
  app.player.renderExact(seq, Math.min(seq.playhead, Math.max(0, seqDuration(seq) - 1)), { scale: 320 / seq.settings.width }).then(({ bytes, w, h: hh }) => {
    const c = preview.getContext('2d'); preview.width = w; preview.height = hh;
    const img = c.createImageData(w, hh);
    for (let y = 0; y < hh; y++) img.data.set(bytes.subarray((hh - 1 - y) * w * 4, (hh - y) * w * 4), y * w * 4);
    c.putImageData(img, 0, 0);
  }).catch(() => {});
  const body = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 300px', gap: '20px', width: '920px' } }, h('div', { style: { maxHeight: '64vh', overflow: 'auto', paddingRight: '6px' } }, holder), h('div', preview, summary,
    h('div', { style: { marginTop: '14px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button.btn.small', { on: { click: async () => { const { promptDialog } = await import('../ui/widgets.js'); const name = await promptDialog('Save Export Preset', 'My Preset'); if (!name) return; const p = { ...deepClone(vals), id: 'user_' + uid(), group: 'User', name }; delete p.out; app.prefs.set('export.userPresets', [...userPresets(), p]); toast('Preset saved'); } } }, 'Save preset'),
      h('button.btn.small', { on: { click: () => { app.prefs.set('export.userPresets', userPresets().filter((p) => p.id !== vals.preset)); toast('Preset removed'); } } }, 'Delete preset'))));
  const r = await modal({ title: seqs.length > 1 ? `Export ${seqs.length} Sequences` : 'Export', body, width: 980, buttons: [{ label: 'Cancel', value: null }, { label: 'Add to Queue', value: 'queue' }, { label: 'Export', primary: true, value: 'now' }] });
  if (!r) return;
  app.prefs.set('export.defaultPreset', vals.preset);
  app.prefs.set('export.lastDir', dirname(vals.out));
  for (const s of seqs) {
    const out = seqs.length > 1 ? `${dirname(vals.out)}/${s.name}.${vals.container}` : vals.out;
    const job = { seqId: s.id, settings: { ...vals, out }, name: s.name };
    if (r === 'queue') queue.add(job);
  }
  if (r === 'queue') { app.dock.openPanel('exportQueue'); toast('Added to the export queue'); return; }
  for (const s of seqs) await runExport(s, { ...vals, out: seqs.length > 1 ? `${dirname(vals.out)}/${s.name}.${vals.container}` : vals.out });
}

function estimateBitrate(v) {
  const px = (v.width || 1920) * (v.height || 1080);
  const k = { h264: 0.12, hevc: 0.07, vp9: 0.08, prores_422: 1.6, prores_hq: 2.4, prores_4444: 3.6, prores_lt: 1.1, prores_proxy: 0.5, dnxhr_hq: 2.2, dnxhr_sq: 1.4, dnxhr_lb: 0.5, dnxhr_hqx: 2.2, gif: 0.3 }[v.codec] || 0.15;
  const crfK = v.crf != null ? Math.pow(2, (18 - v.crf) / 6) : 1;
  return px * 30 * k * crfK / 1e6 * (['h264', 'hevc', 'vp9'].includes(v.codec) ? 0.6 : 1);
}

function defaultsFrom(p, seq) {
  return {
    preset: p.id, container: p.container, codec: p.codec || 'h264', audioOnly: !!p.audioOnly, imageSequence: !!p.imageSequence,
    width: p.width || seq.settings.width, height: p.height ? p.height : (p.width ? Math.round(p.width * seq.settings.height / seq.settings.width / 2) * 2 : seq.settings.height),
    fps: p.maxFps && seq.settings.fps > p.maxFps ? p.maxFps : 0, bitrateMode: p.bitrateMode || 'crf', crf: p.crf != null ? p.crf : 18, videoBitrate: p.videoBitrate || 16, profile: p.profile || '', level: p.level || '', gop: p.gop || 0,
    hdr: p.hdr || '', alpha: !!p.alpha, hw: !!app.prefs.get('export.hardwareEncoding') && app.info.platform === 'darwin' && ['h264', 'hevc'].includes(p.codec) && !p.hdr, preset_speed: p.preset,
    audioCodec: p.audioCodec || 'aac', sampleRate: 48000, channels: 2, audioBitrate: p.audioBitrate || 320, normalize: '', captions: 'none', burnTimecode: !!p.burnTimecode,
    title: seq.name, artist: '', copyright: '', comment: '', openAfter: app.prefs.get('export.openAfterExport'), importAfter: false,
  };
}

function rangeOf(seq, v) {
  const end = seqDuration(seq);
  if (v.range === 'inout' && seq.inPoint != null && seq.outPoint != null) return [seq.inPoint, seq.outPoint + 1];
  if (v.range === 'custom') {
    const parse = (s) => { const p = String(s || '').split(/[:;]/).map(Number); while (p.length < 4) p.unshift(0); return ((p[0] * 3600 + p[1] * 60 + p[2]) * Math.round(seq.settings.fps)) + p[3]; };
    const a = parse(v.customIn), b = parse(v.customOut);
    if (b > a) return [a, b + 1];
  }
  return [0, Math.max(1, end)];
}

// Single untouched clip with matching settings can be stream-copied.
function smartRenderSource(seq, v, a, b) {
  if (v.burnTimecode || v.captions === 'burn' || v.normalize || v.imageSequence || v.audioOnly) return null;
  const vids = seq.tracks.video.flatMap((t) => t.clips.filter((c) => c.start < b && c.start + c.dur > a));
  const auds = seq.tracks.audio.flatMap((t) => t.clips.filter((c) => c.start < b && c.start + c.dur > a));
  if (vids.length !== 1 || auds.length > 1 || seq.tracks.video.some((t) => t.transitions.length)) return null;
  const c = vids[0];
  if (auds[0] && auds[0].src.itemId !== c.src.itemId) return null;
  if (c.speed !== 1 || c.reverse || c.timeRemap || c.frameHold != null || c.start > a || c.start + c.dur < b) return null;
  const mo = c.effects.find((e) => e.type === 'motion'), op = c.effects.find((e) => e.type === 'opacity');
  const untouched = c.effects.every((e) => ['motion', 'opacity', 'timeremap'].includes(e.type)) && mo.params.scale === 100 && mo.params.position[0] === 0.5 && mo.params.position[1] === 0.5 && mo.params.rotation === 0 && op.params.opacity === 100 && !Object.values(mo.keyframes).some((k) => k.length) && !Object.values(op.keyframes).some((k) => k.length);
  if (!untouched) return null;
  const item = app.store.project.items[c.src.itemId];
  if (!item || item.type !== 'media') return null;
  const codecMatch = { h264: 'h264', hevc: 'hevc' }[v.codec] === item.info.codec || (v.codec.startsWith('prores') && item.info.codec === 'prores');
  if (!codecMatch || item.info.width !== +v.width || item.info.height !== +v.height || (v.fps && Math.abs(v.fps - item.info.fps) > 0.01)) return null;
  return { source: item.path, start: c.srcIn + (a - c.start) / seq.settings.fps, duration: (b - a) / seq.settings.fps };
}

export async function runExport(seq, v, ui = {}) {
  const fps = v.fps || seq.settings.fps;
  const [a, b] = rangeOf(seq, v);
  const prog = ui.progress || progressDialog(`Exporting ${seq.name}`);
  const job = jobs.start(`Exporting ${seq.name}`, 'export');
  const t0 = performance.now();
  const meta = { title: v.title, artist: v.artist, copyright: v.copyright, comment: v.comment, encoder: 'CinergyPro' };
  let session = null;
  const tmpWav = `${app.info.cacheDir}/export_${uid()}.wav`;
  // optional timecode burn-in via a temporary adjustment effect on the whole sequence
  const restore = [];
  try {
    const smart = smartRenderSource(seq, v, a, b);
    if (smart) {
      prog.set(0.1, 'Smart rendering (no re-encode)');
      await window.native.call('export:smart', { ...smart, out: v.out, metadata: meta });
      prog.set(1, 'Done');
      await finish();
      return v.out;
    }
    // audio
    let audioPath = null;
    if (v.audioCodec !== 'none' && seq.tracks.audio.some((t) => t.clips.length)) {
      prog.set(0.01, 'Mixing audio');
      let buf = await app.audio.renderOffline(seq, a, b, { sampleRate: v.sampleRate, channels: v.channels });
      if (v.normalize) {
        const m = AudioEngine.measure(buf);
        const gain = Math.pow(10, (parseFloat(v.normalize) - m.integrated) / 20);
        const peakAfter = Math.pow(10, m.peak / 20) * gain;
        const g = peakAfter > 0.97 ? gain * 0.97 / peakAfter : gain;
        for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
      }
      await window.native.call('fs:write-binary', tmpWav, AudioEngine.toWav(buf, 32));
      audioPath = tmpWav;
    }
    if (v.audioOnly) {
      if (!audioPath) throw new Error('This sequence has no audio');
      prog.set(0.5, 'Encoding audio');
      await window.native.call('export:start', { audioOnly: true, audioWav: audioPath, out: v.out, audioCodec: v.audioCodec, sampleRate: v.sampleRate, channels: v.channels, audioBitrate: v.audioBitrate, metadata: meta, duration: (b - a) / seq.settings.fps });
      await finish();
      return v.out;
    }
    if (v.burnTimecode) {
      const { makeEffect } = await import('../core/effect-defs.js');
      // overlay on the topmost track as an adjustment-like burn via every top clip: simplest is a temporary caption-like hook
      app.compositor.__burnTC = makeEffect('timecode_burnin', { size: 4, position: [0.5, 0.93] });
    }
    const W = seq.settings.width, H = seq.settings.height;
    const outW = Math.round((+v.width || W) / 2) * 2, outH = Math.round((+v.height || H) / 2) * 2;
    // render at output size when downscaling to save work
    const scale = Math.min(1, Math.max(outW / W, outH / H));
    const rw = Math.round(W * scale), rh = Math.round(H * scale);
    let out = v.out;
    if (v.imageSequence) out = v.out.replace(/#+/, (m) => `%0${m.length}d`).replace(/(\.[^.]+)$/, (e) => (/%0\d+d/.test(v.out.replace(/#+/, '%05d')) ? e : e));
    if (v.imageSequence && !/%0\d+d/.test(out)) out = out.replace(/(\.[^.]+)$/, '_%05d$1');
    const res = await window.native.call('export:start', {
      out, width: rw, height: rh, outWidth: outW, outHeight: outH, fps, codec: v.codec, crf: v.crf, bitrateMode: v.bitrateMode, videoBitrate: v.videoBitrate, profile: v.profile, level: v.level, gop: v.gop || 0,
      hdr: v.hdr || null, alpha: v.alpha, hw: v.hw, preset: v.preset_speed, audioWav: audioPath, audioCodec: audioPath ? v.audioCodec : 'none', sampleRate: v.sampleRate, channels: v.channels, audioBitrate: v.audioBitrate,
      metadata: meta, imageSequence: v.imageSequence, timecode: framesToTC(a + (seq.settings.startTC || 0), seq.settings.fps), pixelAspect: seq.settings.pixelAspect, fieldOrder: seq.settings.fieldOrder,
    });
    session = res.id;
    const totalOut = Math.max(1, Math.round((b - a) / seq.settings.fps * fps));
    for (let i = 0; i < totalOut; i++) {
      if (prog.cancelled || (ui.isCancelled && ui.isCancelled())) throw new Error('Export cancelled');
      const f = a + Math.floor(i * seq.settings.fps / fps);
      const { bytes } = await app.player.renderExact(seq, f, { scale, captions: v.captions === 'burn', alpha: v.alpha });
      await window.native.call('export:frame', session, bytes.buffer);
      if (i % 3 === 0 || i === totalOut - 1) {
        const p = (i + 1) / totalOut;
        const el = (performance.now() - t0) / 1000;
        const eta = el / p - el;
        prog.set(p, `Frame ${i + 1} of ${totalOut}  -  ${Math.round((i + 1) / el)} fps  -  ${Math.ceil(eta)}s remaining`);
        jobs.update(job.id, p);
        if (ui.onProgress) ui.onProgress(p);
      }
    }
    prog.set(1, 'Finishing file');
    await window.native.call('export:finish', session);
    session = null;
    if (v.captions === 'srt' || v.captions === 'vtt') {
      const { exportCaptionsText } = await import('./captions.js');
      const txt = exportCaptionsText(seq, v.captions, a);
      await window.native.call('fs:write-text', v.out.replace(/\.[^.]+$/, '.' + v.captions), txt);
    }
    await finish();
    return v.out;
  } catch (e) {
    if (session) window.native.call('export:abort', session).catch(() => {});
    jobs.done(job.id);
    prog.close();
    app.compositor.__burnTC = null;
    if (/cancel/i.test(e.message)) toast('Export cancelled', 'warn'); else toast('Export failed: ' + e.message, 'error', 8000);
    throw e;
  } finally {
    window.native.call('fs:remove', tmpWav).catch(() => {});
    for (const fn of restore) fn();
  }
  async function finish() {
    app.compositor.__burnTC = null;
    jobs.done(job.id);
    prog.close();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    toast(`Exported ${basename(v.out)} in ${secs}s`);
    if (v.openAfter) window.native.call('shell:reveal', v.out.replace(/_?#+|%0\dd/, '00000'));
    if (v.importAfter && !v.imageSequence) { const { importPaths } = await import('./media.js'); importPaths([v.out], { allowDuplicates: true }); }
  }
}

export async function runQueue() {
  if (queue.running) return;
  queue.running = true; queue.emit('change');
  for (const item of queue.items) {
    if (item.status !== 'queued') continue;
    const seq = app.store.project.items[item.seqId];
    if (!seq) { item.status = 'error'; item.error = 'Sequence missing'; continue; }
    item.status = 'encoding'; queue.emit('change');
    try {
      const silent = { set: () => {}, close: () => {}, get cancelled() { return item.cancel; } };
      await runExport(seq, item.settings, { progress: silent, onProgress: (p) => { item.progress = p; queue.emit('change'); }, isCancelled: () => item.cancel });
      item.status = 'done'; item.progress = 1;
    } catch (e) { item.status = item.cancel ? 'cancelled' : 'error'; item.error = e.message; }
    queue.emit('change');
  }
  queue.running = false; queue.emit('change');
}

export async function exportFrame() {
  const seq = app.store.seq; if (!seq) return;
  const def = `${app.prefs.get('export.lastDir') || app.info.desktop}/${seq.name}_${framesToTC(seq.playhead, seq.settings.fps).replace(/[:;]/g, '-')}.png`;
  const path = await window.native.call('dialog:save', { title: 'Export Frame', defaultPath: def, filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg'] }, { name: 'TIFF', extensions: ['tif'] }, { name: 'DPX', extensions: ['dpx'] }] });
  if (!path) return;
  const { bytes, w, h: hh } = await app.player.renderExact(seq, seq.playhead, { scale: 1, captions: true });
  await window.native.call('export:still', path, bytes.buffer, w, hh, (path.split('.').pop() || 'png').toLowerCase().replace('tif', 'tiff'));
  toast('Frame exported');
  return path;
}

export async function exportAudioStems() {
  const seq = app.store.seq; if (!seq) return;
  const dir = await window.native.call('dialog:open', { title: 'Choose a folder for audio stems', directory: true });
  if (!dir) return;
  const [a, b] = [seq.inPoint != null ? seq.inPoint : 0, seq.outPoint != null ? seq.outPoint + 1 : seqDuration(seq)];
  for (const t of seq.tracks.audio) {
    if (!t.clips.length) continue;
    const saved = seq.tracks.audio.map((x) => [x, x.solo]);
    for (const x of seq.tracks.audio) x.solo = x === t;
    const buf = await app.audio.renderOffline(seq, a, b);
    for (const [x, s] of saved) x.solo = s;
    await window.native.call('fs:write-binary', `${dir[0]}/${seq.name} - ${t.name}.wav`, AudioEngine.toWav(buf, 32));
  }
  toast('Stems exported');
}

// ---------- Render previews ----------
const hashCache = new Map();
app.__hashCache = hashCache;
export function seqVideoHash(seq) {
  let hsh = hashCache.get(seq.id);
  if (!hsh) { hsh = hashStr(JSON.stringify([seq.settings, seq.tracks.video, seq.captionTracks])); hashCache.set(seq.id, hsh); }
  return hsh;
}

export async function renderPreviews(seq = app.store.seq, all = false) {
  if (!seq) return;
  const a = !all && seq.inPoint != null ? seq.inPoint : 0;
  const b = !all && seq.outPoint != null ? seq.outPoint + 1 : seqDuration(seq);
  if (b <= a) return;
  const out = `${app.info.cacheDir}/previews/${seq.id}_${a}_${b}_${uid()}.mp4`;
  const v = { container: 'mp4', codec: 'h264', crf: 14, bitrateMode: 'crf', gop: 1, width: seq.settings.width, height: seq.settings.height, fps: 0, audioCodec: 'none', range: 'custom', out, preset_speed: 'ultrafast', title: seq.name };
  const tc = (f) => framesToTC(f, seq.settings.fps, { dropFrame: false });
  v.customIn = tc(a); v.customOut = tc(b - 1);
  const hash = seqVideoHash(seq);
  await runExport(seq, v, {});
  seq.renderedRanges = (seq.renderedRanges || []).filter((r) => r.b <= a || r.a >= b);
  seq.renderedRanges.push({ a, b, path: out, hash });
  app.store.markDirty();
  app.store.touch('render');
}

export function deletePreviews(seq = app.store.seq) {
  if (!seq) return;
  for (const r of seq.renderedRanges || []) window.native.call('fs:remove', r.path).catch(() => {});
  seq.renderedRanges = [];
  app.store.touch('render');
}

export function previewLookup(seq, frame) {
  if (!seq.renderedRanges || !seq.renderedRanges.length) return null;
  const r = seq.renderedRanges.find((x) => frame >= x.a && frame < x.b);
  if (!r || r.hash !== seqVideoHash(seq)) return null;
  return { path: r.path, t: (frame - r.a) / seq.settings.fps };
}
