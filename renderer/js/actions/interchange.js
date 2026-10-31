// Timeline interchange: OpenTimelineIO, CMX 3600 EDL, Final Cut Pro 7 XML (Premiere/Resolve), FCPXML.
import { app } from '../app-context.js';
import { allTracks, createSequence, createTrack, createClip, createMediaItem, createBin, seqDuration, itemDuration } from '../core/project.js';
import { basename, stem, uid, escapeHtml } from '../core/util.js';
import { framesToTC, tcToFrames, snapFps } from '../core/timecode.js';
import { toast, formDialog } from '../ui/widgets.js';

const fileUrl = (p) => 'file://' + encodeURI(p);
const fromUrl = (u) => decodeURI(String(u).replace(/^file:\/\/(localhost)?/, ''));
const xml = (s) => escapeHtml(s);

function clipItem(clip) { return app.store.project.items[clip.src.itemId] || null; }

// ---------- OpenTimelineIO ----------
export function toOTIO(seq) {
  const fps = seq.settings.fps;
  const rt = (v) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: fps, value: v });
  const tr = (start, dur) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start), duration: rt(dur) });
  const track = (t, kind) => {
    const children = []; let pos = 0;
    const clips = [...t.clips].sort((a, b) => a.start - b.start);
    for (const c of clips) {
      if (c.start > pos) children.push({ OTIO_SCHEMA: 'Gap.1', name: '', source_range: tr(0, c.start - pos), effects: [], markers: [], metadata: {} });
      const tin = t.transitions.find((x) => x.clipB === c.id && x.clipA);
      if (tin) children.push({ OTIO_SCHEMA: 'Transition.1', name: tin.type, transition_type: 'SMPTE_Dissolve', in_offset: rt(c.start - tin.start), out_offset: rt(tin.start + tin.dur - c.start), metadata: { cinergypro: { type: tin.type } } });
      const it = clipItem(c);
      const media = it && it.type === 'media' ? { OTIO_SCHEMA: 'ExternalReference.1', target_url: fileUrl(it.path), available_range: it.info.duration ? tr(0, Math.round(it.info.duration * fps)) : null, metadata: {} } : { OTIO_SCHEMA: 'MissingReference.1', metadata: {} };
      const effects = [];
      if (c.speed !== 1 || c.reverse) effects.push({ OTIO_SCHEMA: 'LinearTimeWarp.1', name: 'speed', effect_name: 'LinearTimeWarp', time_scalar: c.speed * (c.reverse ? -1 : 1), metadata: {} });
      if (c.frameHold != null) effects.push({ OTIO_SCHEMA: 'FreezeFrame.1', name: 'freeze', effect_name: 'FreezeFrame', time_scalar: 0, metadata: {} });
      children.push({ OTIO_SCHEMA: 'Clip.2', name: c.name, source_range: tr(Math.round(c.srcIn * fps), c.dur), media_references: { DEFAULT_MEDIA: media }, active_media_reference_key: 'DEFAULT_MEDIA', effects,
        markers: (c.markers || []).map((m) => ({ OTIO_SCHEMA: 'Marker.2', name: m.name, color: (m.color || 'green').toUpperCase(), marked_range: tr(Math.round(c.srcIn * fps) + m.frame, m.dur || 0), comment: m.comment || '', metadata: {} })),
        metadata: { cinergypro: { enabled: c.enabled, label: c.label, srcType: c.src.type } }, enabled: c.enabled });
      pos = c.start + c.dur;
    }
    return { OTIO_SCHEMA: 'Track.1', name: t.name, kind: kind === 'video' ? 'Video' : 'Audio', children, source_range: null, effects: [], markers: [], enabled: !(t.hidden || t.muted), metadata: {} };
  };
  return {
    OTIO_SCHEMA: 'Timeline.1', name: seq.name, global_start_time: rt(seq.settings.startTC || 0),
    tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: [...seq.tracks.video.map((t) => track(t, 'video')), ...seq.tracks.audio.map((t) => track(t, 'audio'))], source_range: null, effects: [], markers: seq.markers.map((m) => ({ OTIO_SCHEMA: 'Marker.2', name: m.name, color: (m.color || 'green').toUpperCase(), marked_range: tr(m.frame, m.dur || 0), comment: m.comment || '', metadata: {} })), metadata: {} },
    metadata: { cinergypro: { width: seq.settings.width, height: seq.settings.height } },
  };
}

// ---------- CMX 3600 EDL ----------
export function toEDL(seq, trackIndex = 0) {
  const fps = seq.settings.fps;
  const df = Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
  const lines = [`TITLE: ${seq.name.slice(0, 70)}`, `FCM: ${df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  let n = 1;
  const v = seq.tracks.video[trackIndex];
  const audios = seq.tracks.audio.slice(0, 2);
  const pad = (s, l) => String(s).padEnd(l).slice(0, l);
  const tc = (f) => framesToTC(f + (seq.settings.startTC || 0), fps);
  const stc = (sec) => framesToTC(Math.round(sec * fps), fps);
  const events = [];
  if (v) for (const c of v.clips) events.push({ c, ch: 'V', t: v });
  audios.forEach((t, i) => { for (const c of t.clips) if (!c.linkId || !v || !v.clips.some((x) => x.linkId === c.linkId && x.start === c.start && x.dur === c.dur)) events.push({ c, ch: 'A' + (i > 0 ? i + 1 : ''), t }); else { const ev = events.find((e) => e.c.linkId === c.linkId && e.ch.startsWith('V')); if (ev && !ev.ch.includes('A')) ev.ch = i > 0 ? 'AA/V' : 'B'; } });
  events.sort((a, b) => a.c.start - b.c.start);
  for (const { c, ch, t } of events) {
    const it = clipItem(c);
    const reel = it && it.type === 'media' ? (it.metadata.reel || stem(it.path)).replace(/[^\w]/g, '').slice(0, 8).toUpperCase() || 'AX' : (it && it.type === 'synthetic' ? 'BL' : 'AX');
    const tr = t.transitions.find((x) => x.clipB === c.id && x.clipA);
    const sIn = stc(c.srcIn), sOut = stc(c.srcIn + c.dur / fps * c.speed);
    const num = String(n++).padStart(3, '0');
    if (tr && tr.type.includes('dissolve')) {
      const prev = t.clips.find((x) => x.id === tr.clipA);
      lines.push(`${num}  ${pad(reel, 8)} ${pad(ch, 5)} C        ${stc(prev.srcIn + (c.start - prev.start) / fps * prev.speed)} ${stc(prev.srcIn + (c.start - prev.start) / fps * prev.speed)} ${tc(c.start)} ${tc(c.start)}`);
      lines.push(`${num}  ${pad(reel, 8)} ${pad(ch, 5)} D    ${String(tr.dur).padStart(3, '0')} ${sIn} ${sOut} ${tc(c.start)} ${tc(c.start + c.dur)}`);
    } else lines.push(`${num}  ${pad(reel, 8)} ${pad(ch, 5)} C        ${sIn} ${sOut} ${tc(c.start)} ${tc(c.start + c.dur)}`);
    if (c.speed !== 1) lines.push(`M2   ${pad(reel, 8)}       ${(fps * c.speed * (c.reverse ? -1 : 1)).toFixed(1).padStart(5)}                ${sIn}`);
    lines.push(`* FROM CLIP NAME: ${c.name}`);
    if (it && it.type === 'media') lines.push(`* SOURCE FILE: ${it.path}`);
    lines.push('');
  }
  for (const m of seq.markers) lines.push(`* LOC: ${tc(m.frame)} ${(m.color || 'GREEN').toUpperCase()} ${m.name || m.comment || 'Marker'}`);
  return lines.join('\n') + '\n';
}

// ---------- Final Cut Pro 7 XML (xmeml v5) ----------
export function toXMEML(seq) {
  const fps = seq.settings.fps;
  const tb = Math.round(fps), ntsc = Math.abs(fps - Math.round(fps)) > 0.001 ? 'TRUE' : 'FALSE';
  const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>`;
  const files = new Map();
  const fileEl = (it) => {
    if (files.has(it.id)) return `<file id="file-${it.id}"/>`;
    files.set(it.id, true);
    const dur = Math.round((it.info.duration || 0) * fps);
    return `<file id="file-${it.id}"><name>${xml(it.name)}</name><pathurl>${xml(fileUrl(it.path))}</pathurl>${rate}<duration>${dur}</duration><timecode>${rate}<string>${it.info.timecode || '00:00:00:00'}</string><displayformat>NDF</displayformat></timecode><media>${it.info.hasVideo ? `<video><samplecharacteristics>${rate}<width>${it.info.width}</width><height>${it.info.height}</height></samplecharacteristics></video>` : ''}${it.info.hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${it.info.sampleRate}</samplerate></samplecharacteristics><channelcount>${it.info.channels}</channelcount></audio>` : ''}</media></file>`;
  };
  const clipEl = (c, kind, tIndex) => {
    const it = clipItem(c);
    const inF = Math.round(c.srcIn * fps), outF = inF + Math.round(c.dur * c.speed);
    const mo = c.effects.find((e) => e.type === 'motion'), op = c.effects.find((e) => e.type === 'opacity');
    let filters = '';
    if (kind === 'video' && mo && (mo.params.scale !== 100 || mo.params.rotation || mo.params.position[0] !== 0.5 || mo.params.position[1] !== 0.5)) filters += `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>scale</parameterid><name>Scale</name><value>${mo.params.scale}</value></parameter><parameter><parameterid>rotation</parameterid><name>Rotation</name><value>${mo.params.rotation}</value></parameter><parameter><parameterid>center</parameterid><name>Center</name><value><horiz>${(mo.params.position[0] - 0.5) * 2}</horiz><vert>${(mo.params.position[1] - 0.5) * 2}</vert></value></parameter></effect></filter>`;
    if (kind === 'video' && op && op.params.opacity !== 100) filters += `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>opacity</parameterid><name>opacity</name><value>${op.params.opacity}</value></parameter></effect></filter>`;
    if (c.speed !== 1) filters += `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>speed</parameterid><name>speed</name><value>${c.speed * 100 * (c.reverse ? -1 : 1)}</value></parameter></effect></filter>`;
    if (kind === 'audio') { const vol = c.effects.find((e) => e.type === 'volume'); if (vol && (vol.params.level || c.gain)) filters += `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${Math.pow(10, ((vol.params.level || 0) + (c.gain || 0)) / 20).toFixed(4)}</value></parameter></effect></filter>`; }
    const links = c.linkId ? allTracks(seq).flatMap((t) => t.clips.filter((x) => x.linkId === c.linkId).map((x) => `<link><linkclipref>clip-${x.id}</linkclipref><mediatype>${x.kind}</mediatype><trackindex>${seq.tracks[x.kind].indexOf(t) + 1}</trackindex><clipindex>${t.clips.indexOf(x) + 1}</clipindex></link>`)).join('') : '';
    const markers = (c.markers || []).map((m) => `<marker><name>${xml(m.name)}</name><comment>${xml(m.comment || '')}</comment><in>${inF + m.frame}</in><out>-1</out></marker>`).join('');
    return `<clipitem id="clip-${c.id}"><name>${xml(c.name)}</name><enabled>${c.enabled ? 'TRUE' : 'FALSE'}</enabled><duration>${it && it.info ? Math.round((it.info.duration || 0) * fps) : c.dur}</duration>${rate}<start>${c.start}</start><end>${c.start + c.dur}</end><in>${inF}</in><out>${outF}</out>${it && it.type === 'media' ? fileEl(it) : ''}${kind === 'audio' ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${(c.src.stream || 0) + 1}</trackindex></sourcetrack>` : ''}${filters}${links}${markers}</clipitem>`;
  };
  const transEl = (tr) => `<transitionitem>${rate}<start>${tr.start}</start><end>${tr.start + tr.dur}</end><alignment>${tr.align === 'start' ? 'start-black' : tr.align === 'end' ? 'end-black' : 'center'}</alignment><effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype></effect></transitionitem>`;
  const trackEl = (t, kind, i) => `<track><enabled>${(kind === 'video' ? !t.hidden : !t.muted) ? 'TRUE' : 'FALSE'}</enabled><locked>${t.locked ? 'TRUE' : 'FALSE'}</locked>${t.clips.map((c) => clipEl(c, kind, i)).join('')}${t.transitions.filter((x) => x.clipA && x.clipB).map(transEl).join('')}</track>`;
  const markers = seq.markers.map((m) => `<marker><name>${xml(m.name)}</name><comment>${xml(m.comment || '')}</comment><in>${m.frame}</in><out>${m.dur ? m.frame + m.dur : -1}</out></marker>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="seq-${seq.id}"><name>${xml(seq.name)}</name><duration>${seqDuration(seq)}</duration>${rate}<timecode>${rate}<string>${framesToTC(seq.settings.startTC || 0, fps)}</string><frame>${seq.settings.startTC || 0}</frame><displayformat>NDF</displayformat></timecode><media><video><format><samplecharacteristics>${rate}<width>${seq.settings.width}</width><height>${seq.settings.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>${seq.tracks.video.map((t, i) => trackEl(t, 'video', i)).join('')}</video><audio><numOutputChannels>2</numOutputChannels>${seq.tracks.audio.map((t, i) => trackEl(t, 'audio', i)).join('')}</audio></media>${markers}</sequence></xmeml>\n`;
}

// ---------- FCPXML 1.10 ----------
export function toFCPXML(seq) {
  const fps = seq.settings.fps;
  const fr = fps === 29.97 ? '1001/30000s' : fps === 23.976 ? '1001/24000s' : fps === 59.94 ? '1001/60000s' : `1/${Math.round(fps)}s`;
  const frameDur = fps === 29.97 ? [1001, 30000] : fps === 23.976 ? [1001, 24000] : fps === 59.94 ? [1001, 60000] : [1, Math.round(fps)];
  const t = (frames) => `${frames * frameDur[0]}/${frameDur[1]}s`;
  const assets = new Map();
  for (const tr of allTracks(seq)) for (const c of tr.clips) { const it = clipItem(c); if (it && it.type === 'media' && !assets.has(it.id)) assets.set(it.id, it); }
  const res = [`<format id="r0" name="FFVideoFormat${seq.settings.height}p${Math.round(fps)}" frameDuration="${fr}" width="${seq.settings.width}" height="${seq.settings.height}"/>`];
  let rid = 1; const ridOf = new Map();
  for (const it of assets.values()) {
    const id = 'r' + rid++; ridOf.set(it.id, id);
    res.push(`<asset id="${id}" name="${xml(it.name)}" start="0s" duration="${t(Math.round((it.info.duration || 10) * fps))}" hasVideo="${it.info.hasVideo ? 1 : 0}" hasAudio="${it.info.hasAudio ? 1 : 0}" format="r0"${it.info.hasAudio ? ` audioSources="1" audioChannels="${it.info.channels}" audioRate="${it.info.sampleRate}"` : ''}><media-rep kind="original-media" src="${xml(fileUrl(it.path))}"/></asset>`);
  }
  const primary = seq.tracks.video[0];
  const total = seqDuration(seq);
  const clipXml = (c, lane) => { const it = clipItem(c); if (!it || !ridOf.has(it.id)) return ''; return `<asset-clip ref="${ridOf.get(it.id)}"${lane ? ` lane="${lane}"` : ''} offset="${t(c.start)}" name="${xml(c.name)}" start="${t(Math.round(c.srcIn * fps))}" duration="${t(c.dur)}" format="r0" tcFormat="NDF"${c.enabled ? '' : ' enabled="0"'}>${c.speed !== 1 ? `<timeMap><timept time="0s" value="0s" interp="linear"/><timept time="${t(c.dur)}" value="${t(Math.round(c.dur * c.speed))}" interp="linear"/></timeMap>` : ''}</asset-clip>`; };
  // spine: primary storyline with gaps; other tracks become connected clips on lanes
  let spine = ''; let pos = 0;
  const connected = [];
  seq.tracks.video.slice(1).forEach((tr, i) => tr.clips.forEach((c) => connected.push({ c, lane: i + 1 })));
  seq.tracks.audio.forEach((tr, i) => tr.clips.forEach((c) => { if (!(c.linkId && primary && primary.clips.some((v) => v.linkId === c.linkId))) connected.push({ c, lane: -(i + 1) }); }));
  const items = primary ? [...primary.clips].sort((a, b) => a.start - b.start) : [];
  for (const c of items) {
    if (c.start > pos) { const gapInner = connected.filter((x) => x.c.start >= pos && x.c.start < c.start).map((x) => clipXml({ ...x.c, start: x.c.start - pos + 0 }, x.lane)).join(''); spine += `<gap name="Gap" offset="${t(pos)}" duration="${t(c.start - pos)}" start="0s">${gapInner.replace(/offset="[^"]+"/g, (m) => m)}</gap>`; }
    const inner = connected.filter((x) => x.c.start >= c.start && x.c.start < c.start + c.dur).map((x) => clipXml({ ...x.c, start: Math.round(x.c.srcIn * 0) + (x.c.start - c.start) + Math.round(c.srcIn * fps) }, x.lane)).join('');
    const base = clipXml(c, 0);
    spine += base.replace('</asset-clip>', inner + '</asset-clip>');
    pos = c.start + c.dur;
  }
  if (!items.length) spine = `<gap name="Gap" offset="0s" duration="${t(total)}" start="0s">${connected.map((x) => clipXml(x.c, x.lane)).join('')}</gap>`;
  const markers = seq.markers.map((m) => `<marker start="${t(m.frame)}" duration="${t(1)}" value="${xml(m.name || 'Marker')}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>${res.join('')}</resources><library><event name="CinergyPro Export"><project name="${xml(seq.name)}"><sequence format="r0" duration="${t(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${spine}</spine>${markers}</sequence></project></event></library></fcpxml>\n`;
}

export async function exportTimeline(fmt) {
  const seq = app.store.seq; if (!seq) return toast('Open a sequence first', 'warn');
  const ext = { otio: 'otio', edl: 'edl', xml: 'xml', fcpxml: 'fcpxml' }[fmt];
  const path = await window.native.call('dialog:save', { title: 'Export ' + fmt.toUpperCase(), defaultPath: `${app.prefs.get('export.lastDir') || app.info.desktop}/${seq.name}.${ext}` });
  if (!path) return;
  let text;
  if (fmt === 'otio') text = JSON.stringify(toOTIO(seq), null, 2);
  else if (fmt === 'edl') text = toEDL(seq);
  else if (fmt === 'xml') text = toXMEML(seq);
  else text = toFCPXML(seq);
  await window.native.call('fs:write-text', path, text);
  toast(`Exported ${basename(path)}`);
}

// ---------- Import ----------
async function itemForPath(path, cache, bin) {
  if (cache.has(path)) return cache.get(path);
  let it = Object.values(app.store.project.items).find((i) => i.type === 'media' && i.path === path);
  if (!it) {
    let info;
    try { info = await window.native.call('media:probe', path); if (info.fps) info.fps = snapFps(info.fps); }
    catch { info = { name: basename(path), kind: 'video', duration: 3600, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 24 }; }
    it = createMediaItem(path, info, bin);
    if (!(await window.native.call('fs:exists', path))) it.offline = true;
    cache.set(path, it);
    it.__new = true;
  }
  cache.set(path, it);
  return it;
}

export async function importTimeline(path) {
  const text = await window.native.call('fs:read-text', path);
  const bin = createBin('Imported: ' + stem(path));
  const cache = new Map();
  let seq;
  try {
    if (/\.otio$/i.test(path)) seq = await fromOTIO(JSON.parse(text), cache, bin.id);
    else if (/\.edl$/i.test(path)) seq = await fromEDL(text, stem(path), cache, bin.id);
    else if (/\.(xml)$/i.test(path)) seq = await fromXMEML(text, cache, bin.id);
    else if (/\.fcpxml$/i.test(path)) seq = await fromFCPXML(text, cache, bin.id);
  } catch (e) { toast('Import failed: ' + e.message, 'error', 6000); return; }
  if (!seq) return;
  seq.parent = bin.id;
  app.store.transact('Import Timeline', () => {
    app.store.project.items[bin.id] = bin;
    for (const it of cache.values()) if (it.__new) { delete it.__new; app.store.project.items[it.id] = it; }
    app.store.project.items[seq.id] = seq;
  }, ['items']);
  app.store.setActiveSequence(seq.id);
  const offline = [...cache.values()].filter((i) => i.offline).length;
  toast(`Imported ${seq.name}${offline ? `, ${offline} file(s) offline` : ''}`);
}

async function fromOTIO(tl, cache, bin) {
  const stack = tl.tracks;
  const first = (stack.children || []).find((t) => (t.children || []).some((c) => c.source_range));
  const rate = first ? (first.children.find((c) => c.source_range).source_range.duration.rate) : 24;
  const seq = createSequence(tl.name || 'OTIO Timeline', { fps: rate, width: (tl.metadata && tl.metadata.cinergypro && tl.metadata.cinergypro.width) || 1920, height: (tl.metadata && tl.metadata.cinergypro && tl.metadata.cinergypro.height) || 1080 }, bin);
  seq.tracks.video = []; seq.tracks.audio = [];
  for (const t of stack.children || []) {
    const kind = t.kind === 'Audio' ? 'audio' : 'video';
    const track = createTrack(kind, seq.tracks[kind].length, { name: t.name });
    let pos = 0;
    for (const c of t.children || []) {
      const sr = c.source_range; const r = sr ? sr.duration.rate || rate : rate;
      const dur = sr ? Math.round(sr.duration.value * rate / r) : 0;
      if (c.OTIO_SCHEMA.startsWith('Gap')) { pos += dur; continue; }
      if (c.OTIO_SCHEMA.startsWith('Transition')) continue;
      if (!c.OTIO_SCHEMA.startsWith('Clip')) continue;
      const ref = c.media_references ? c.media_references[c.active_media_reference_key || 'DEFAULT_MEDIA'] : c.media_reference;
      const url = ref && ref.target_url;
      let clip;
      if (url) {
        const it = await itemForPath(fromUrl(url), cache, bin);
        clip = createClip(kind, { type: 'media', itemId: it.id, stream: 0 }, pos, dur, sr ? sr.start_time.value / r : 0, { name: c.name || it.name, label: it.label });
      } else clip = createClip(kind, { type: 'synthetic', itemId: null }, pos, dur, 0, { name: c.name || 'Missing' });
      const warp = (c.effects || []).find((e) => /TimeWarp/.test(e.OTIO_SCHEMA));
      if (warp) { clip.speed = Math.abs(warp.time_scalar) || 1; clip.reverse = warp.time_scalar < 0; }
      if (c.enabled === false) clip.enabled = false;
      for (const m of c.markers || []) clip.markers.push({ id: uid('mk'), frame: Math.round(m.marked_range.start_time.value - (sr ? sr.start_time.value : 0)), dur: Math.round(m.marked_range.duration.value), name: m.name || '', comment: m.comment || '', color: (m.color || 'green').toLowerCase(), type: 'comment' });
      track.clips.push(clip);
      pos += dur;
    }
    seq.tracks[kind].push(track);
  }
  for (const k of ['video', 'audio']) if (!seq.tracks[k].length) seq.tracks[k].push(createTrack(k, 0));
  for (const m of stack.markers || []) seq.markers.push({ id: uid('mk'), frame: Math.round(m.marked_range.start_time.value), dur: Math.round(m.marked_range.duration.value), name: m.name || '', comment: m.comment || '', color: (m.color || 'green').toLowerCase(), type: 'comment' });
  return seq;
}

async function fromEDL(text, name, cache, bin) {
  const fcm = /FCM:\s*DROP/i.test(text);
  const r = await formDialog('Import EDL', [{ key: 'fps', label: 'Frame rate', type: 'select', options: [[23.976, '23.976'], [24, '24'], [25, '25'], [29.97, '29.97'], [30, '30'], [50, '50'], [59.94, '59.94'], [60, '60']] }, { key: 'folder', label: 'Media folder', type: 'folder', note: 'Files are matched by clip name or reel name' }], { fps: fcm ? 29.97 : 24, folder: '' });
  if (!r) return null;
  const fps = r.fps;
  const seq = createSequence(name, { fps }, bin);
  const ev = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{3,})\s+(\S+)\s+(\S+)\s+(C|D|W\d+)\s*(\d+)?\s+(\d\d:\d\d:\d\d[:;]\d\d)\s+(\d\d:\d\d:\d\d[:;]\d\d)\s+(\d\d:\d\d:\d\d[:;]\d\d)\s+(\d\d:\d\d:\d\d[:;]\d\d)/.exec(line.trim());
    if (m) { cur = { reel: m[2], ch: m[3], type: m[4], tdur: +(m[5] || 0), sIn: tcToFrames(m[6], fps), sOut: tcToFrames(m[7], fps), rIn: tcToFrames(m[8], fps), rOut: tcToFrames(m[9], fps) }; ev.push(cur); continue; }
    const cn = /FROM CLIP NAME:\s*(.+)$/.exec(line); if (cn && cur) cur.name = cn[1].trim();
    const sf = /SOURCE FILE:\s*(.+)$/.exec(line); if (sf && cur) cur.file = sf[1].trim();
  }
  const startOffset = ev.length ? Math.min(...ev.map((e) => e.rIn)) : 0;
  const recStart = startOffset >= fps * 3600 ? Math.floor(startOffset / (fps * 3600)) * fps * 3600 : 0;
  seq.settings.startTC = recStart;
  for (const e of ev) {
    if (e.rOut <= e.rIn) continue;
    let path = e.file;
    if (!path && r.folder) path = await window.native.call('fs:find-file', (e.name || e.reel), [r.folder], 4).catch(() => null);
    if (!path) path = (r.folder || '/Offline') + '/' + (e.name || e.reel);
    const it = await itemForPath(path, cache, bin);
    const start = e.rIn - recStart, dur = e.rOut - e.rIn;
    const linkId = uid('lnk');
    if (/V|B/.test(e.ch)) seq.tracks.video[0].clips.push(createClip('video', { type: 'media', itemId: it.id }, start, dur, e.sIn / fps, { name: e.name || it.name, linkId }));
    if (/A|B/.test(e.ch)) seq.tracks.audio[/A2/.test(e.ch) ? 1 : 0].clips.push(createClip('audio', { type: 'media', itemId: it.id, stream: 0 }, start, dur, e.sIn / fps, { name: e.name || it.name, linkId }));
  }
  for (const t of allTracks(seq)) t.clips.sort((a, b) => a.start - b.start);
  return seq;
}

async function fromXMEML(text, cache, bin) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const s = doc.querySelector('sequence');
  if (!s) throw new Error('No sequence found in XML');
  const q = (el, sel) => el.querySelector(sel);
  const tb = +(q(s, ':scope > rate > timebase') || {}).textContent || 24;
  const ntsc = ((q(s, ':scope > rate > ntsc') || {}).textContent || '').toUpperCase() === 'TRUE';
  const fps = ntsc ? +(tb * 1000 / 1001).toFixed(3) : tb;
  const w = +((q(s, 'format width') || {}).textContent || 1920), hh = +((q(s, 'format height') || {}).textContent || 1080);
  const seq = createSequence((q(s, ':scope > name') || {}).textContent || 'XML Sequence', { fps: snapFps(fps), width: w, height: hh }, bin);
  seq.tracks.video = []; seq.tracks.audio = [];
  const fileMap = new Map();
  for (const f of doc.querySelectorAll('file[id]')) { const pu = q(f, 'pathurl'); if (pu) fileMap.set(f.getAttribute('id'), fromUrl(pu.textContent)); }
  for (const kind of ['video', 'audio']) {
    const tracks = s.querySelectorAll(`media > ${kind} > track`);
    let ti = 0;
    for (const t of tracks) {
      const track = createTrack(kind, ti++);
      for (const ci of t.querySelectorAll(':scope > clipitem')) {
        const start = +q(ci, ':scope > start').textContent, end = +q(ci, ':scope > end').textContent;
        const inF = +q(ci, ':scope > in').textContent;
        if (start < 0 || end <= start) continue;
        const fe = q(ci, ':scope > file');
        const fid = fe && fe.getAttribute('id');
        const path = fid ? fileMap.get(fid) : null;
        if (!path) continue;
        const it = await itemForPath(path, cache, bin);
        const c = createClip(kind, { type: 'media', itemId: it.id, stream: 0 }, start, end - start, inF / fps, { name: (q(ci, ':scope > name') || {}).textContent || it.name });
        const sp = [...ci.querySelectorAll('filter effect')].find((e) => /timeremap/i.test((q(e, 'effectid') || {}).textContent || ''));
        if (sp) { const v = +((q(sp, 'parameter value') || {}).textContent || 100); c.speed = Math.abs(v) / 100 || 1; c.reverse = v < 0; }
        if (((q(ci, ':scope > enabled') || {}).textContent || 'TRUE').toUpperCase() === 'FALSE') c.enabled = false;
        track.clips.push(c);
      }
      seq.tracks[kind].push(track);
    }
    if (!seq.tracks[kind].length) seq.tracks[kind].push(createTrack(kind, 0));
  }
  // relink A/V pairs that share source and timing
  for (const v of seq.tracks.video) for (const c of v.clips) for (const a of seq.tracks.audio) for (const d of a.clips) if (d.src.itemId === c.src.itemId && d.start === c.start && d.dur === c.dur) { const l = c.linkId || uid('lnk'); c.linkId = l; d.linkId = l; }
  for (const m of s.querySelectorAll(':scope > marker')) seq.markers.push({ id: uid('mk'), frame: +q(m, 'in').textContent, dur: 0, name: (q(m, 'name') || {}).textContent || '', comment: (q(m, 'comment') || {}).textContent || '', color: 'green', type: 'comment' });
  return seq;
}

async function fromFCPXML(text, cache, bin) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const fmt = doc.querySelector('format');
  const parseT = (s) => { if (!s) return 0; const m = /^(\d+)(?:\/(\d+))?s$/.exec(s); return m ? +m[1] / (+m[2] || 1) : 0; };
  const fd = parseT(fmt ? fmt.getAttribute('frameDuration') : '1/24s') || 1 / 24;
  const fps = snapFps(1 / fd);
  const seq = createSequence((doc.querySelector('project') || {}).getAttribute?.('name') || 'FCPXML', { fps, width: +(fmt && fmt.getAttribute('width')) || 1920, height: +(fmt && fmt.getAttribute('height')) || 1080 }, bin);
  const assets = new Map();
  for (const a of doc.querySelectorAll('asset')) { const rep = a.querySelector('media-rep'); assets.set(a.getAttribute('id'), fromUrl(rep ? rep.getAttribute('src') : a.getAttribute('src'))); }
  const place = async (el, parentOffset, parentStart) => {
    const ref = el.getAttribute('ref'); const path = assets.get(ref); if (!path) return;
    const lane = +(el.getAttribute('lane') || 0);
    const off = parseT(el.getAttribute('offset')), st = parseT(el.getAttribute('start')), dur = parseT(el.getAttribute('duration'));
    const abs = parentOffset + (off - parentStart);
    const it = await itemForPath(path, cache, bin);
    const kind = lane < 0 || (it.info && !it.info.hasVideo) ? 'audio' : 'video';
    const ti = lane < 0 ? -lane - 1 : lane;
    while (seq.tracks[kind].length <= ti) seq.tracks[kind].push(createTrack(kind, seq.tracks[kind].length));
    const linkId = uid('lnk');
    seq.tracks[kind][ti].clips.push(createClip(kind, { type: 'media', itemId: it.id, stream: 0 }, Math.round(abs * fps), Math.max(1, Math.round(dur * fps)), st, { name: el.getAttribute('name') || it.name, linkId: kind === 'video' && it.info.hasAudio && lane === 0 ? linkId : null }));
    if (kind === 'video' && lane === 0 && it.info.hasAudio) seq.tracks.audio[0].clips.push(createClip('audio', { type: 'media', itemId: it.id, stream: 0 }, Math.round(abs * fps), Math.max(1, Math.round(dur * fps)), st, { name: el.getAttribute('name') || it.name, linkId }));
    for (const child of el.querySelectorAll(':scope > asset-clip, :scope > clip')) await place(child, abs, st);
  };
  const spine = doc.querySelector('spine');
  if (spine) for (const el of spine.children) {
    if (el.tagName === 'gap') { const off = parseT(el.getAttribute('offset')); for (const c of el.querySelectorAll(':scope > asset-clip')) await place(c, off, parseT(el.getAttribute('start'))); }
    else if (el.tagName === 'asset-clip' || el.tagName === 'clip') await place(el, 0, 0);
  }
  for (const t of allTracks(seq)) t.clips.sort((a, b) => a.start - b.start);
  return seq;
}

export { itemDuration };
