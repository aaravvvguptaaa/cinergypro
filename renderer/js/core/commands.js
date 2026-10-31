// Command registry, keyboard shortcut mapping and dispatch.
import { Emitter } from './util.js';

const IS_MAC = (window.native && window.native.platform === 'darwin') || /Mac/.test(navigator.platform);

class Commands extends Emitter {
  constructor() {
    super();
    this.map = new Map();         // id -> command
    this.bindings = new Map();    // combo -> [ids]
    this.custom = null;           // id -> [combos] overrides
    this.enabled = true;
  }

  register(id, cmd) {
    this.map.set(id, { id, label: id, category: 'General', keys: [], context: 'global', ...cmd });
  }
  registerMany(obj) { for (const [id, c] of Object.entries(obj)) this.register(id, c); this.rebuild(); }

  keysFor(id) {
    if (this.custom && this.custom[id]) return this.custom[id];
    const c = this.map.get(id);
    return c ? c.keys : [];
  }

  rebuild() {
    this.bindings.clear();
    for (const [id] of this.map) for (const k of this.keysFor(id)) {
      const norm = normalizeCombo(k);
      if (!this.bindings.has(norm)) this.bindings.set(norm, []);
      this.bindings.get(norm).push(id);
    }
    this.emit('bindings');
  }

  setCustom(custom) { this.custom = custom; this.rebuild(); }

  async run(id, arg) {
    const c = this.map.get(id);
    if (!c) { console.warn('Unknown command', id); return; }
    if (c.enabled && !c.enabled()) return;
    try { await c.run(arg); this.emit('ran', id); } catch (e) { console.error('Command failed', id, e); this.emit('error', { id, error: e }); }
  }

  // Returns true if handled
  handleKey(e, focusPanel) {
    if (!this.enabled) return false;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      if (!(e.metaKey || e.ctrlKey) || ['a', 'c', 'v', 'x', 'z'].includes(e.key.toLowerCase())) return false;
    }
    const combo = comboFromEvent(e);
    const ids = this.bindings.get(combo);
    if (!ids) return false;
    // Prefer a command whose context matches the focused panel, then global
    const pick = ids.find((id) => this.map.get(id).context === focusPanel) || ids.find((id) => this.map.get(id).context === 'global');
    if (!pick) return false;
    e.preventDefault();
    e.stopPropagation();
    this.run(pick, { event: e, repeat: e.repeat });
    return true;
  }

  conflicts() {
    const out = [];
    for (const [k, ids] of this.bindings) {
      const byCtx = {};
      for (const id of ids) { const c = this.map.get(id).context; (byCtx[c] = byCtx[c] || []).push(id); }
      for (const [ctx, arr] of Object.entries(byCtx)) if (arr.length > 1) out.push({ key: k, context: ctx, ids: arr });
    }
    return out;
  }

  list() { return [...this.map.values()]; }
}

export function comboFromEvent(e) {
  const parts = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (IS_MAC && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (e.code && e.code.startsWith('Key')) k = e.code.slice(3);
  else if (e.code && e.code.startsWith('Digit')) k = e.code.slice(5);
  else if (e.code && e.code.startsWith('Numpad')) k = 'Num' + e.code.slice(6);
  else if (e.code === 'Backquote') k = '`';
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'Equal') k = '=';
  else if (e.code === 'BracketLeft') k = '[';
  else if (e.code === 'BracketRight') k = ']';
  else if (e.code === 'Semicolon') k = ';';
  else if (e.code === 'Quote') k = "'";
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Period') k = '.';
  else if (e.code === 'Slash') k = '/';
  else if (e.code === 'Backslash') k = '\\';
  else if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

export function normalizeCombo(s) {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const mods = new Set(parts.map((m) => ({ cmd: 'Mod', command: 'Mod', mod: 'Mod', ctrl: IS_MAC ? 'Ctrl' : 'Mod', control: IS_MAC ? 'Ctrl' : 'Mod', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift' })[m.toLowerCase()] || m));
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m));
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...order, k].join('+');
}

export function displayCombo(s) {
  if (!s) return '';
  const n = normalizeCombo(s);
  if (!IS_MAC) return n.replace('Mod', 'Ctrl');
  return n.split('+').map((p) => ({ Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: 'Esc' })[p] || p).join('');
}

export function accelerator(s) {
  if (!s) return undefined;
  const n = normalizeCombo(s);
  return n.replace('Mod', 'CmdOrCtrl').replace('Ctrl+', 'Ctrl+').replace('ArrowLeft', 'Left').replace('ArrowRight', 'Right').replace('ArrowUp', 'Up').replace('ArrowDown', 'Down').replace(/\+`$/, '+`');
}

export const commands = new Commands();
export { IS_MAC };
