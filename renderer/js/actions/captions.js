// Captions and subtitles: tracks, editing, SRT/WebVTT/text import and export.
import { app } from '../app-context.js';
import { uid, basename, stem } from '../core/util.js';
import { secToSrt, srtToSec } from '../core/timecode.js';
import { toast, formDialog } from '../ui/widgets.js';

const DEFAULT_STYLE = { font: 'Inter', size: 44, color: '#ffffff', bg: '#000000', bgOpacity: 70, position: 'bottom', align: 'center', margin: 0.08, weight: 600, outline: 0, wordByWord: false };

export function createCaptionTrack(seq, name, format = 'subtitle') {
  const t = { id: uid('cap'), name: name || `Subtitles ${seq.captionTracks.length + 1}`, format, language: 'en', visible: true, style: { ...DEFAULT_STYLE }, captions: [] };
  seq.captionTracks.push(t);
  return t;
}

function tx(label, fn) { const s = app.store.seq; if (!s) return; return app.store.transact(label, () => fn(s), [s.id]); }

export function activeCaptionTrack(seq, create = true) {
  if (!seq.captionTracks.length && create) createCaptionTrack(seq);
  const id = app.panels.text && app.panels.text.trackId;
  return seq.captionTracks.find((t) => t.id === id) || seq.captionTracks[0];
}

export function addCaption(text = 'New caption', dur) {
  let cap;
  tx('Add Caption', (s) => {
    const t = activeCaptionTrack(s);
    const f = s.playhead; const d = dur || Math.round(s.settings.fps * 3);
    const next = t.captions.find((c) => c.start > f);
    const end = next ? Math.min(f + d, next.start) : f + d;
    const inside = t.captions.find((c) => f >= c.start && f < c.end);
    if (inside) { cap = inside; return; }
    cap = { id: uid('c'), start: f, end: Math.max(f + 1, end), text, speaker: '' };
    t.captions.push(cap); t.captions.sort((a, b) => a.start - b.start);
  });
  return cap;
}

export function updateCaption(trackId, capId, patch, coalesce = true) {
  tx('Edit Caption', (s) => { const t = s.captionTracks.find((x) => x.id === trackId); const c = t && t.captions.find((x) => x.id === capId); if (c) Object.assign(c, patch); });
}

export function deleteCaptions(trackId, ids) { tx('Delete Caption', (s) => { const t = s.captionTracks.find((x) => x.id === trackId); if (t) t.captions = t.captions.filter((c) => !ids.has(c.id)); }); }

export function splitCaption(trackId, capId) {
  tx('Split Caption', (s) => {
    const t = s.captionTracks.find((x) => x.id === trackId); const i = t.captions.findIndex((c) => c.id === capId); if (i < 0) return;
    const c = t.captions[i]; const words = c.text.split(/\s+/); const half = Math.ceil(words.length / 2);
    const mid = s.playhead > c.start && s.playhead < c.end ? s.playhead : Math.round((c.start + c.end) / 2);
    const b = { ...c, id: uid('c'), start: mid, text: words.slice(half).join(' ') };
    c.end = mid; c.text = words.slice(0, half).join(' ');
    t.captions.splice(i + 1, 0, b);
  });
}

export function mergeCaptions(trackId, ids) {
  tx('Merge Captions', (s) => {
    const t = s.captionTracks.find((x) => x.id === trackId); const sel = t.captions.filter((c) => ids.has(c.id)).sort((a, b) => a.start - b.start);
    if (sel.length < 2) return;
    sel[0].end = sel[sel.length - 1].end; sel[0].text = sel.map((c) => c.text).join(' ');
    t.captions = t.captions.filter((c) => c === sel[0] || !ids.has(c.id));
  });
}

export function parseSubtitles(text, fps) {
  const out = [];
  text = text.replace(/\r/g, '').replace(/^﻿/, '');
  const blocks = text.split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => /-->/.test(l));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->').map((s) => s.trim().split(' ')[0]);
    let txt = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]+\}/g, '');
    let speaker = '';
    const m = /^([A-Z][\w .'-]{0,30}):\s+/.exec(txt);
    if (m) { speaker = m[1]; }
    out.push({ id: uid('c'), start: Math.round(srtToSec(a) * fps), end: Math.round(srtToSec(z) * fps), text: txt, speaker });
  }
  return out;
}

export async function importCaptions(path) {
  if (!path) {
    const r = await window.native.call('dialog:open', { title: 'Import Captions', filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'txt'] }] });
    if (!r) return; path = r[0];
  }
  const s = app.store.seq; if (!s) return toast('Open a sequence first', 'warn');
  const text = await window.native.call('fs:read-text', path);
  let caps;
  if (/\.txt$/i.test(path)) {
    const d = Math.round(s.settings.fps * 3);
    caps = text.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l, i) => ({ id: uid('c'), start: s.playhead + i * d, end: s.playhead + (i + 1) * d, text: l, speaker: '' }));
  } else caps = parseSubtitles(text, s.settings.fps);
  if (!caps.length) return toast('No captions found in that file', 'warn');
  tx('Import Captions', (q) => { const t = createCaptionTrack(q, stem(path)); t.captions = caps; });
  app.dock.openPanel('text');
  toast(`Imported ${caps.length} captions`);
}

export function exportCaptionsText(seq, fmt = 'srt', offsetFrames = 0, trackId = null) {
  const t = trackId ? seq.captionTracks.find((x) => x.id === trackId) : seq.captionTracks.find((x) => x.visible) || seq.captionTracks[0];
  if (!t) return '';
  const fps = seq.settings.fps;
  const caps = t.captions.filter((c) => c.end > offsetFrames).map((c) => ({ ...c, start: Math.max(0, c.start - offsetFrames), end: c.end - offsetFrames }));
  if (fmt === 'vtt') return 'WEBVTT\n\n' + caps.map((c, i) => `${i + 1}\n${secToSrt(c.start / fps, true)} --> ${secToSrt(c.end / fps, true)}${t.style.position === 'top' ? ' line:10%' : ''}\n${c.speaker ? `<v ${c.speaker}>` : ''}${c.text}\n`).join('\n');
  if (fmt === 'txt') return caps.map((c) => (c.speaker ? c.speaker + ': ' : '') + c.text).join('\n');
  return caps.map((c, i) => `${i + 1}\n${secToSrt(c.start / fps)} --> ${secToSrt(c.end / fps)}\n${c.text}\n`).join('\n');
}

export async function exportCaptionsDialog() {
  const s = app.store.seq; if (!s || !s.captionTracks.length) return toast('This sequence has no captions', 'warn');
  const r = await formDialog('Export Captions', [{ key: 'track', label: 'Caption track', type: 'select', string: true, options: s.captionTracks.map((t) => [t.id, t.name]) }, { key: 'fmt', label: 'Format', type: 'select', string: true, options: [['srt', 'SubRip (.srt)'], ['vtt', 'WebVTT (.vtt)'], ['txt', 'Plain text (.txt)']] }], { track: s.captionTracks[0].id, fmt: 'srt' });
  if (!r) return;
  const path = await window.native.call('dialog:save', { defaultPath: `${app.info.desktop}/${s.name}.${r.fmt}` });
  if (!path) return;
  await window.native.call('fs:write-text', path, exportCaptionsText(s, r.fmt, 0, r.track));
  toast('Captions exported');
}

// Split long captions so each segment fits within maxChars / maxLines
export function resegment(trackId, maxChars = 42, maxLines = 2) {
  tx('Resegment Captions', (s) => {
    const t = s.captionTracks.find((x) => x.id === trackId); if (!t) return;
    const out = [];
    for (const c of t.captions) {
      const words = c.text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
      const chunks = []; let line = '', lines = [];
      for (const w of words) {
        if ((line + ' ' + w).trim().length > maxChars) { lines.push(line.trim()); line = w; if (lines.length === maxLines) { chunks.push(lines.join('\n')); lines = []; } }
        else line = (line + ' ' + w).trim();
      }
      if (line) lines.push(line);
      if (lines.length) chunks.push(lines.join('\n'));
      const total = c.end - c.start; const per = total / Math.max(1, chunks.length);
      chunks.forEach((txt, i) => out.push({ ...c, id: i ? uid('c') : c.id, start: Math.round(c.start + i * per), end: Math.round(c.start + (i + 1) * per), text: txt }));
    }
    t.captions = out;
  });
}

export function findReplace(trackId, find, replace) {
  let n = 0;
  tx('Replace in Captions', (s) => { const t = s.captionTracks.find((x) => x.id === trackId); for (const c of t.captions) { const before = c.text; c.text = c.text.split(find).join(replace); if (before !== c.text) n++; } });
  return n;
}

export { DEFAULT_STYLE, basename };
