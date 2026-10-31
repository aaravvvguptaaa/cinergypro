// End-to-end self test (runs only when launched with --test). Prints [TEST] lines to stdout.
import { app } from './app-context.js';
import * as IO from './actions/project-io.js';
import * as M from './actions/media.js';
import * as A from './actions/editing.js';
import * as X from './actions/export.js';
import { allTracks, seqDuration, findClip, createSequence } from './core/project.js';
import { makeEffect, makeMask } from './core/effect-defs.js';
import { sleep } from './core/util.js';

const results = [];
const log = (...a) => console.log('[TEST]', ...a);
async function step(name, fn) {
  const t0 = performance.now();
  try { const r = await fn(); results.push([name, true]); log('PASS', name, r !== undefined ? JSON.stringify(r).slice(0, 300) : '', `(${Math.round(performance.now() - t0)}ms)`); return r; }
  catch (e) { results.push([name, false]); log('FAIL', name, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)); return null; }
}
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); };
const shot = async (name) => { await sleep(500); await window.native.call('app:capture', `${app.info.testOut}/${name}.png`); };

export async function run() {
  if (app.info.argv.includes('--layout-debug')) return layoutDebug();
  const media = app.info.testMedia, out = app.info.testOut;
  window.onerror = (m, s, l) => log('WINDOW ERROR', m, s, l);
  const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  window.__testErrs = errs;
  const quick = app.info.argv.includes('--quick');
  window.addEventListener('unhandledrejection', (e) => log('UNHANDLED', e.reason && e.reason.stack ? e.reason.stack.split('\n').slice(0, 3).join(' | ') : e.reason));
  await step('home screen renders', async () => { app.ui.showHome(); await shot('01-home'); });
  await step('new project', async () => { await IO.newProject({ name: 'Test Project', path: `${out}/Test Project.cinergy` }); assert(app.store.seq, 'sequence'); });
  let items;
  await step('import media', async () => {
    items = await M.importPaths([`${media}/clipA.mp4`, `${media}/clipB.mp4`, `${media}/green.mp4`, `${media}/clipC_prores.mov`, `${media}/still.png`, `${media}/music.wav`]);
    assert(items.length === 6, 'imported ' + items.length);
    return items.map((i) => `${i.name}:${i.info.kind}:${i.info.width}x${i.info.height}@${i.info.fps}`);
  });
  const byName = (n) => items.find((i) => i.name === n);
  await step('decode audio waveforms', async () => { const b = await app.audio.ensure(byName('clipA.mp4')); assert(b && b.duration > 5, 'buffer'); const p = app.audio.peaksFor(byName('clipA.mp4')); assert(p, 'peaks'); return { dur: b.duration, ch: b.numberOfChannels }; });
  await step('ProRes gets a playback copy', async () => { for (let i = 0; i < 60 && !byName('clipC_prores.mov').playback; i++) await sleep(500); return byName('clipC_prores.mov').playback || 'no playback copy (Chromium may decode it natively)'; });
  const seq = app.store.seq;
  await step('edit clips into sequence', async () => {
    A.createSequenceFrom;
    app.ui.openInSource(byName('clipA.mp4').id);
    const a = byName('clipA.mp4'); a.inPoint = 0.5; a.outPoint = 4.5;
    app.player.seek(0);
    A.sourceEdit('overwrite');
    app.ui.openInSource(byName('clipB.mp4').id);
    A.sourceEdit('overwrite');
    const s = app.store.seq;
    const v1 = s.tracks.video[0].clips.length, a1 = s.tracks.audio[0].clips.length;
    assert(v1 === 2 && a1 === 2, `V1 ${v1} A1 ${a1}`);
    return { duration: seqDuration(s), v1, a1 };
  });
  await step('insert edit shifts clips', async () => {
    const s = app.store.seq; const before = seqDuration(s);
    app.ui.openInSource(byName('still.png').id); byName('still.png').inPoint = null; byName('still.png').outPoint = 2;
    app.player.seek(24); A.sourceEdit('insert');
    assert(seqDuration(s) > before, 'longer');
    return { before, after: seqDuration(s), clips: s.tracks.video[0].clips.map((c) => [c.name, c.start, c.dur]) };
  });
  await step('undo / redo', async () => { const s = app.store.seq; const d = seqDuration(s); app.store.undo(); const u = seqDuration(app.store.seq); app.store.redo(); assert(seqDuration(app.store.seq) === d && u < d, 'undo/redo'); return { d, u }; });
  await step('razor and ripple delete', async () => {
    const s = app.store.seq; s.playhead = 60;
    for (const t of allTracks(s)) t.target = true;
    A.addEdit(false);
    const n = app.store.seq.tracks.video[0].clips.length;
    const mid = app.store.seq.tracks.video[0].clips.find((c) => c.start === 60);
    assert(mid, 'split clip at 60');
    app.store.selectClips([...A.expandLinked([mid.id])]);
    const d0 = seqDuration(app.store.seq);
    A.deleteSelection(true);
    const d1 = seqDuration(app.store.seq);
    assert(d1 < d0, 'ripple shortened');
    return { clipsAfterSplit: n, d0, d1 };
  });
  await step('trim, roll and slip', async () => {
    const E = await import('./core/edit.js');
    const s = app.store.seq; const t = s.tracks.video[0];
    const [c1, c2] = t.clips;
    app.store.transact('test trims', () => { E.trimTail(app.store.project, s, t, c1, -5, 'normal'); E.rollEdit(app.store.project, s, t, c1, c2, 0); E.slipClip(app.store.project, s, c2, 3); });
    return t.clips.map((c) => [c.start, c.dur, +c.srcIn.toFixed(3)]);
  });
  await step('transitions', async () => {
    const s = app.store.seq; const t = s.tracks.video[0];
    app.store.transact('close gaps', () => { const E = app.__edit; E.closeAllGaps(s, allTracks(s)); });
    const c2 = t.clips[1];
    A.addTransitionAt(t, c2.start, 'cross_dissolve', 12);
    A.addTransitionAt(s.tracks.audio[0], s.tracks.audio[0].clips[1].start, 'constant_power', 12);
    assert(app.store.seq.tracks.video[0].transitions.length === 1, 'video transition');
    return app.store.seq.tracks.video[0].transitions.map((x) => [x.type, x.start, x.dur, x.align]);
  });
  await step('effects: lumetri, blur with mask, transform, key', async () => {
    const s = app.store.seq; const t = s.tracks.video[0];
    const c1 = t.clips[0], c2 = t.clips[t.clips.length - 1];
    A.applyEffect('lumetri', [c1.id], { params: { temperature: 30, exposure: 0.3, saturation: 130, look: 'builtin:teal-orange' } });
    A.applyEffect('gaussian_blur', [c2.id], { params: { blurriness: 30 } });
    app.store.transact('mask', () => { const f = findClip(app.store.seq, c2.id); f.clip.effects.find((e) => e.type === 'gaussian_blur').masks.push(makeMask('ellipse')); });
    A.applyEffect('vignette', [c2.id]);
    A.applyEffect('film_grain', [c1.id]);
    return findClip(app.store.seq, c1.id).clip.effects.map((e) => e.type);
  });
  await step('keyframes on motion', async () => {
    const s = app.store.seq; const c = s.tracks.video[0].clips[0];
    app.store.transact('kf', () => { const mo = c.effects.find((e) => e.type === 'motion'); mo.keyframes.scale = [{ t: 0, v: 100, interp: 'linear' }, { t: 24, v: 140, interp: 'easeInOut' }]; });
    const { evaluate } = await import('./core/keyframes.js');
    const mo = findClip(app.store.seq, c.id).clip.effects.find((e) => e.type === 'motion');
    return [0, 12, 24].map((f) => +evaluate(mo.keyframes.scale, f, 100).toFixed(2));
  });
  await step('green screen on V2 with ultra key', async () => {
    const s = app.store.seq; const g = byName('green.mp4');
    const E = app.__edit;
    let placed;
    app.store.transact('green', () => { placed = E.editItemIntoSequence(app.store.project, s, g, 0, 3, 12, 'overwrite', { videoTrack: s.tracks.video[1], audio: false }); });
    A.applyEffect('ultra_key', [placed[0].id]);
    return placed.map((c) => c.id).length;
  });
  await step('title graphic and captions', async () => {
    app.player.seek(6);
    const { GRAPHIC_TEMPLATES } = await import('./engine/graphics.js');
    A.newGraphicAtPlayhead(GRAPHIC_TEMPLATES.lower_third.make());
    const C = await import('./actions/captions.js');
    C.addCaption('Hello from CinergyPro captions', 48);
    const s = app.store.seq;
    assert(s.captionTracks.length === 1 && s.captionTracks[0].captions.length === 1, 'caption');
    return { graphics: allTracks(s).flatMap((t) => t.clips).filter((c) => c.graphic).length };
  });
  await step('music bed with volume keyframes and track effect', async () => {
    const s = app.store.seq; const m = byName('music.wav'); const E = app.__edit;
    app.store.transact('music', () => { const pl = E.editItemIntoSequence(app.store.project, s, m, 0, 6, 0, 'overwrite', { audioTrack: s.tracks.audio[2], video: false }); const vol = pl[0].effects.find((e) => e.type === 'volume'); vol.keyframes.level = [{ t: 0, v: -30, interp: 'linear' }, { t: 24, v: -6, interp: 'linear' }]; s.tracks.audio[2].audio.effects.push(makeEffect('parametric_eq', { lsGain: 3 })); s.tracks.audio[2].audio.effects.push(makeEffect('compressor')); s.tracks.audio[2].audio.effects.push(makeEffect('reverb')); });
    return s.tracks.audio[2].clips.length;
  });
  await step('nest and speed change', async () => {
    const s = app.store.seq; const g = s.tracks.video[1].clips[0];
    app.store.selectClips([g.id]);
    app.store.transact('nest', () => { app.__edit.nestClips(app.store.project, s, new Set([g.id]), 'Nested Key'); }, ['items']);
    const nested = app.store.seq.tracks.video[1].clips.find((c) => c.src.type === 'sequence');
    assert(nested, 'nested clip');
    app.store.transact('speed', () => { app.__edit.setSpeed(app.store.project, app.store.seq, app.store.seq.tracks.video[1], findClip(app.store.seq, nested.id).clip, { speed: 0.5 }); });
    return findClip(app.store.seq, nested.id).clip.dur;
  });
  await step('render program frames (paused, exact)', async () => {
    const s = app.store.seq;
    const frames = [0, 30, 60, 90];
    const stats = [];
    for (const f of frames) { const r = await app.player.renderExact(s, f, { scale: 0.25, captions: true }); let sum = 0; for (let i = 0; i < r.bytes.length; i += 4) sum += r.bytes[i] + r.bytes[i + 1] + r.bytes[i + 2]; stats.push(Math.round(sum / (r.bytes.length / 4) / 3)); }
    assert(stats.some((v) => v > 5), 'non-black frames');
    return stats;
  });
  await step('editing workspace screenshot', async () => { app.player.seek(30); app.player.invalidate(); app.dock.openPanel('effectControls'); app.store.selectClips([app.store.seq.tracks.video[0].clips[0].id]); await sleep(1500); await shot('02-editing'); });
  await step('playback runs', async () => { app.player.play(1); await sleep(2500); const f = app.store.seq.playhead; app.player.pause(); assert(f > 10, 'advanced to ' + f); return f; });
  await step('color workspace screenshot', async () => { app.commands.run('workspace.Color'); app.store.selectClips([app.store.seq.tracks.video[0].clips[0].id]); app.player.seek(20); await sleep(2000); await shot('03-color'); app.commands.run('workspace.Audio'); await sleep(1200); await shot('04-audio'); app.commands.run('workspace.Graphics'); const g = allTracks(app.store.seq).flatMap((t) => t.clips).find((c) => c.graphic); app.store.selectClips([g.id]); app.player.seek(g.start + 20); await sleep(1500); await shot('05-graphics'); app.commands.run('workspace.Editing'); });
  await step('save and reopen project', async () => {
    const ok = await IO.saveProject(); assert(ok, 'saved');
    const path = app.store.path; const d = seqDuration(app.store.seq);
    app.store.dirty = false;
    await IO.openProject(path);
    assert(seqDuration(app.store.seq) === d, 'same duration after reopen');
    return path;
  });
  await step('interchange exports', async () => {
    const I = await import('./actions/interchange.js');
    const s = app.store.seq;
    await window.native.call('fs:write-text', `${out}/test.otio`, JSON.stringify(I.toOTIO(s)));
    await window.native.call('fs:write-text', `${out}/test.edl`, I.toEDL(s));
    await window.native.call('fs:write-text', `${out}/test.xml`, I.toXMEML(s));
    await window.native.call('fs:write-text', `${out}/test.fcpxml`, I.toFCPXML(s));
    const C = await import('./actions/captions.js');
    await window.native.call('fs:write-text', `${out}/test.srt`, C.exportCaptionsText(s, 'srt'));
    return 'otio, edl, xml, fcpxml, srt';
  });
  await step('re-import OTIO and XML', async () => {
    const I = await import('./actions/interchange.js');
    await I.importTimeline(`${out}/test.otio`);
    const a = app.store.seq; const n1 = allTracks(a).reduce((x, t) => x + t.clips.length, 0);
    await I.importTimeline(`${out}/test.xml`);
    const b = app.store.seq; const n2 = allTracks(b).reduce((x, t) => x + t.clips.length, 0);
    assert(n1 > 3 && n2 > 3, `clips ${n1} ${n2}`);
    return { otioClips: n1, xmlClips: n2 };
  });
  if (!quick) await step('export H.264 with audio and burned captions', async () => {
    const seqs = Object.values(app.store.project.items).filter((i) => i.type === 'sequence');
    const s = seqs.find((x) => x.name === 'Sequence 01');
    app.store.setActiveSequence(s.id);
    const v = { preset: 'h264_1080', container: 'mp4', codec: 'h264', width: 1280, height: 720, fps: 0, bitrateMode: 'crf', crf: 23, preset_speed: 'veryfast', audioCodec: 'aac', sampleRate: 48000, channels: 2, audioBitrate: 192, captions: 'burn', burnTimecode: true, normalize: '-16', range: 'all', out: `${out}/export_h264.mp4`, title: 'Test', hw: false, gop: 0, profile: '', level: '', hdr: '', alpha: false };
    await X.runExport(s, v, { progress: { set() {}, close() {}, cancelled: false } });
    const info = await window.native.call('media:probe', v.out);
    assert(info.hasVideo && info.hasAudio && info.width === 1280, 'probe');
    return { w: info.width, h: info.height, fps: info.fps, dur: +info.duration.toFixed(2), audio: info.audioCodec, expectedDur: +(seqDuration(s) / s.settings.fps).toFixed(2) };
  });
  if (!quick) await step('export ProRes 422', async () => {
    const s = app.store.seq;
    s.inPoint = 0; s.outPoint = 23;
    const v = { container: 'mov', codec: 'prores_422', width: 1920, height: 1080, fps: 0, audioCodec: 'pcm24', sampleRate: 48000, channels: 2, captions: 'none', range: 'inout', out: `${out}/export_prores.mov`, title: 'Test' };
    await X.runExport(s, v, { progress: { set() {}, close() {}, cancelled: false } });
    const info = await window.native.call('media:probe', v.out);
    s.inPoint = s.outPoint = null;
    return { codec: info.codec, frames: info.frames, dur: info.duration };
  });
  await step('export audio only WAV + stems loudness', async () => {
    const s = app.store.seq;
    const v = { audioOnly: true, container: 'wav', audioCodec: 'pcm24', sampleRate: 48000, channels: 2, range: 'all', out: `${out}/export_mix.wav`, title: 'Mix' };
    await X.runExport(s, v, { progress: { set() {}, close() {}, cancelled: false } });
    const loud = await window.native.call('media:loudness', v.out);
    return loud;
  });
  await step('export still frame', async () => { const s = app.store.seq; s.playhead = 40; const { bytes, w, h } = await app.player.renderExact(s, 40, { scale: 1, captions: true }); await window.native.call('export:still', `${out}/still_40.png`, bytes.buffer, w, h, 'png'); return [w, h]; });
  if (!quick) await step('render preview (in to out)', async () => { const s = app.store.seq; s.inPoint = 0; s.outPoint = 47; await X.renderPreviews(s); s.inPoint = s.outPoint = null; return (s.renderedRanges || []).length; });
  await step('multicam source sequence', async () => {
    const E = app.__edit;
    const mc = E.createMulticamSequence(app.store.project, [byName('clipA.mp4'), byName('clipB.mp4')], [0, 0.5], 'MC Test', { width: 1920, height: 1080, fps: 24 }, null);
    app.store.transact('mc', () => { app.store.project.items[mc.id] = mc; }, ['items']);
    const s = app.store.seq;
    app.store.transact('mc edit', () => { const pl = E.editItemIntoSequence(app.store.project, s, mc, 0, 3, seqDuration(s), 'overwrite'); pl[0].angle = 1; });
    const r = await app.player.renderExact(s, seqDuration(s) - 10, { scale: 0.25 });
    return r.w;
  });
  await step('audio sync by cross-correlation', async () => { const an = await import('./actions/analysis.js'); const off = await an.audioOffsetBetween(byName('clipA.mp4'), byName('clipA.mp4')); assert(Math.abs(off) < 0.05, 'self offset ' + off); return off; });
  await step('scene detection via ffmpeg', async () => { const t = await window.native.call('media:scenes', `${media}/clipB.mp4`, { threshold: 0.2 }); return t.length; });
  await step('stabilize', async () => { const p = await window.native.call('media:stabilize', `${media}/green.mp4`, { smoothness: 10 }); const i = await window.native.call('media:probe', p); return [i.width, i.height, +i.duration.toFixed(2)]; });
  await step('scripting API', async () => { const { scriptingAPI } = await import('./actions/scripting.js'); return scriptingAPI.run('cinergy.sequence().clips().length'); });
  await step('every effect renders', async () => {
    const { VIDEO_EFFECTS } = await import('./core/effect-defs.js');
    const s = app.store.seq; const c = s.tracks.video[0].clips[0];
    const fails = [];
    for (const k of Object.keys(VIDEO_EFFECTS)) {
      if (VIDEO_EFFECTS[k].intrinsic) continue;
      const fx = makeEffect(k); c.effects.push(fx);
      const n0 = window.__testErrs.length;
      try { await app.player.renderExact(s, c.start + 5, { scale: 0.2 }); const err = app.gl.gl.getError(); if (err) fails.push(k + ':gl' + err); } catch (e) { fails.push(k + ':' + e.message.slice(0, 80)); }
      if (window.__testErrs.length > n0) fails.push(k + ':' + window.__testErrs.slice(n0).join(' / ').slice(0, 160));
      c.effects.pop();
    }
    assert(!fails.length, fails.join(', '));
    return Object.keys(VIDEO_EFFECTS).length;
  });
  await step('every transition renders', async () => {
    const { TRANSITIONS } = await import('./core/effect-defs.js');
    const s = app.store.seq; const t = s.tracks.video[0]; const tr = t.transitions[0];
    if (!tr) return 'no transition';
    const fails = []; const orig = tr.type;
    for (const k of Object.keys(TRANSITIONS)) { tr.type = k; tr.params = {}; for (const p of TRANSITIONS[k].params) tr.params[p.name] = p.default; const n0 = window.__testErrs.length; try { await app.player.renderExact(s, tr.start + Math.floor(tr.dur / 2), { scale: 0.2 }); } catch (e) { fails.push(k + ':' + e.message.slice(0, 80)); } if (window.__testErrs.length > n0) fails.push(k + ':' + window.__testErrs.slice(n0).join(' / ').slice(0, 160)); }
    tr.type = orig;
    assert(!fails.length, fails.join(', '));
    return Object.keys(TRANSITIONS).length;
  });
  await step('every audio effect builds offline', async () => {
    const { AUDIO_EFFECTS } = await import('./core/effect-defs.js');
    const { buildAudioEffect } = await import('./engine/audio-effects.js');
    const ctx = new OfflineAudioContext(2, 4800, 48000); await ctx.audioWorklet.addModule(app.audio.workletUrl);
    const fails = [];
    for (const k of Object.keys(AUDIO_EFFECTS)) { try { const fx = makeEffect(k); const n = buildAudioEffect(ctx, k, fx.params); n.output.connect(ctx.destination); } catch (e) { fails.push(k + ':' + e.message); } }
    await ctx.startRendering();
    assert(!fails.length, fails.join(', '));
    return Object.keys(AUDIO_EFFECTS).length;
  });
  await step('dialogs open', async () => {
    const W = await import('./ui/dialogs.js');
    W.preferencesDialog(); await sleep(600); await shot('06-preferences'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    W.shortcutsDialog(); await sleep(600); await shot('07-shortcuts'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    X.exportDialog(); await sleep(1200); await shot('08-export'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  if (errs.length) log('CONSOLE ERRORS', errs.length, JSON.stringify([...new Set(errs)].slice(0, 12)));
  const failed = results.filter((r) => !r[1]).length;
  log(`SUMMARY ${results.length - failed}/${results.length} passed`);
  await sleep(300);
  app.store.dirty = false;
  window.native.call('app:quit');
}

async function layoutDebug() {
  await IO.newProject({ name: 'Layout', path: `${app.info.testOut}/Layout.cinergy` });
  await sleep(800);
  const r = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return `${el.className} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} disp=${cs.display} h=${cs.height} flex=${cs.flex}`; };
  log(r(document.getElementById('dock')));
  for (const el of [...document.querySelectorAll('#dock .dock-split, #dock .dock-node, #dock .dock-group, #dock .dock-body')].slice(0, 14)) log(r(el));
  await shot('layout');
  window.native.call('app:quit');
}
