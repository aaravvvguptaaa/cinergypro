// Timecode formatting/parsing, including SMPTE drop-frame for 29.97 / 59.94.
export function isDropFrame(fps) { return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01; }
export function nominal(fps) { return Math.round(fps); }

export function framesToTC(frames, fps, opts = {}) {
  frames = Math.round(frames);
  const neg = frames < 0; if (neg) frames = -frames;
  const nf = nominal(fps) || 30;
  const df = opts.dropFrame !== false && isDropFrame(fps);
  let f = frames;
  if (df) {
    const dropPer = nf === 60 ? 4 : 2;
    const per10 = nf * 600 - dropPer * 9;
    const d = Math.floor(f / per10), m = f % per10;
    f += dropPer * 9 * d + (m > dropPer ? dropPer * Math.floor((m - dropPer) / (nf * 60 - dropPer)) : 0);
  }
  const ff = f % nf, s = Math.floor(f / nf) % 60, mi = Math.floor(f / (nf * 60)) % 60, hh = Math.floor(f / (nf * 3600));
  const p = (n) => String(n).padStart(2, '0');
  return (neg ? '-' : '') + `${p(hh)}:${p(mi)}:${p(s)}${df ? ';' : ':'}${p(ff)}`;
}

export function tcToFrames(tc, fps) {
  const nf = nominal(fps) || 30;
  const df = /;/.test(tc) || isDropFrame(fps);
  const parts = tc.split(/[:;.]/).map((x) => parseInt(x, 10) || 0);
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts.slice(-4);
  let frames = ((hh * 3600 + mm * 60 + ss) * nf) + ff;
  if (df && isDropFrame(fps)) {
    const dropPer = nf === 60 ? 4 : 2;
    const totalMin = hh * 60 + mm;
    frames -= dropPer * (totalMin - Math.floor(totalMin / 10));
  }
  return frames;
}

// Accepts "01:00:00:00", "1.12" (sec.frames), "+10" (relative), "-1:00", "245" (frames when short)
export function parseTimeInput(text, fps, current = 0) {
  const s = String(text).trim();
  if (!s) return null;
  const rel = s[0] === '+' || s[0] === '-' ? s[0] : null;
  const body = rel ? s.slice(1) : s;
  let frames;
  if (/[:;]/.test(body)) frames = tcToFrames(body, fps);
  else if (/^\d+$/.test(body)) {
    // Premiere-style: digits fill from the right as HHMMSSFF
    if (body.length <= 2) frames = parseInt(body, 10);
    else {
      const pad = body.padStart(8, '0');
      frames = tcToFrames(`${pad.slice(0, 2)}:${pad.slice(2, 4)}:${pad.slice(4, 6)}:${pad.slice(6, 8)}`, fps);
    }
  } else if (/^\d*\.\d+$/.test(body)) frames = Math.round(parseFloat(body) * fps);
  else return null;
  if (rel === '+') return current + frames;
  if (rel === '-') return current - frames;
  return frames;
}

export function secondsToClock(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatTime(frames, fps, mode = 'tc', startOffset = 0) {
  if (mode === 'frames') return String(Math.round(frames + startOffset));
  if (mode === 'seconds') return ((frames + startOffset) / fps).toFixed(3) + 's';
  if (mode === 'feet') { const f = Math.round(frames + startOffset); return `${Math.floor(f / 16)}+${String(f % 16).padStart(2, '0')}`; }
  return framesToTC(frames + startOffset, fps);
}

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];
export function snapFps(f) { let best = f, d = 1e9; for (const r of FRAME_RATES) { const dd = Math.abs(r - f); if (dd < d) { d = dd; best = r; } } return d < 0.05 ? best : Math.round(f * 1000) / 1000; }

// SRT/VTT time helpers
export function secToSrt(t, vtt = false) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000) % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${vtt ? '.' : ','}${p(ms, 3)}`;
}
export function srtToSec(s) {
  const m = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/.exec(s.trim());
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / Math.pow(10, m[4].length);
}
