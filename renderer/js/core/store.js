// Central application state, undo/redo history and change notifications.
import { Emitter, deepClone } from './util.js';
import { createProject } from './project.js';

class Store extends Emitter {
  constructor() {
    super();
    this.project = createProject();
    this.path = null;
    this.dirty = false;
    this.activeSeqId = null;
    this.sourceItemId = null;
    this.selection = { clips: new Set(), items: new Set(), transition: null, keyframes: [], captions: new Set(), markers: new Set(), track: null, editPoints: [] };
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 200;
    this._tx = null;
    this.focusPanel = 'timeline';
    this.clipboard = null;
  }

  get seq() { return this.activeSeqId ? this.project.items[this.activeSeqId] : null; }

  setProject(project, path = null) {
    this.project = project;
    this.path = path;
    this.dirty = false;
    this.undoStack = []; this.redoStack = [];
    this.selection.clips.clear(); this.selection.items.clear(); this.selection.transition = null;
    const seqs = Object.values(project.items).filter((i) => i.type === 'sequence');
    this.activeSeqId = project.activeSequence && project.items[project.activeSequence] ? project.activeSequence : (seqs[0] ? seqs[0].id : null);
    this.sourceItemId = null;
    this.emit('project');
    this.emit('history');
    this.emit('change', { scope: 'project' });
  }

  setActiveSequence(id) {
    if (this.activeSeqId === id) return;
    this.activeSeqId = id;
    this.project.activeSequence = id;
    this.selection.clips.clear(); this.selection.transition = null;
    this.emit('sequence', id);
    this.emit('selection');
  }

  // Snapshot a scope: 'project' | 'items' | item id
  _snap(scope) {
    if (scope === 'project') { const { items, ...rest } = this.project; return JSON.stringify({ rest, items }); }
    if (scope === 'items') return JSON.stringify(this.project.items);
    const it = this.project.items[scope];
    return it ? JSON.stringify(it) : 'null';
  }
  _restore(scope, json) {
    if (scope === 'project') { const { rest, items } = JSON.parse(json); Object.assign(this.project, rest); this.project.items = items; return; }
    if (scope === 'items') { this.project.items = JSON.parse(json); return; }
    const v = JSON.parse(json);
    if (v === null) delete this.project.items[scope]; else this.project.items[scope] = v;
  }

  /**
   * Run a mutation as one undoable step.
   * scopes: array of item ids / 'items' / 'project'. Defaults to the active sequence.
   * opts.coalesce: key; consecutive transactions with the same key within 1.2s merge.
   */
  transact(label, fn, scopes, opts = {}) {
    if (this._tx) { const r = fn(); return r; }
    scopes = scopes || (this.activeSeqId ? [this.activeSeqId] : ['items']);
    if (scopes.includes('items') || scopes.includes('project')) scopes = scopes.includes('project') ? ['project'] : ['items'];
    const before = scopes.map((s) => [s, this._snap(s)]);
    this._tx = { label };
    let result;
    try { result = fn(); } catch (e) {
      for (const [s, j] of before) this._restore(s, j);
      this._tx = null;
      this.emit('change', { scope: 'error' });
      throw e;
    }
    this._tx = null;
    const after = scopes.map((s) => [s, this._snap(s)]);
    if (before.every(([, j], i) => j === after[i][1])) { this.emit('change', { label, scopes, noop: true }); return result; }
    const now = performance.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (opts.coalesce && top && top.coalesce === opts.coalesce && now - top.time < 1200 && JSON.stringify(top.scopes) === JSON.stringify(scopes)) {
      top.after = after; top.time = now;
    } else {
      this.undoStack.push({ label, scopes, before, after, time: now, coalesce: opts.coalesce || null, id: Math.random().toString(36).slice(2) });
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    }
    this.redoStack = [];
    this.markDirty();
    this.emit('history');
    this.emit('change', { label, scopes });
    return result;
  }

  // Non-undoable change notification (playhead, view state)
  touch(what = 'view') { this.emit('change', { scope: what, transient: true }); }

  markDirty() { this.dirty = true; this.project.modified = Date.now(); this.emit('dirty', true); }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    for (const [s, j] of e.before) this._restore(s, j);
    this.redoStack.push(e);
    this._afterHistory();
    return e.label;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    for (const [s, j] of e.after) this._restore(s, j);
    this.undoStack.push(e);
    this._afterHistory();
    return e.label;
  }
  // Jump to a history index (History panel)
  goToHistory(index) {
    while (this.undoStack.length - 1 > index && this.undoStack.length) this.undo();
    while (this.undoStack.length - 1 < index && this.redoStack.length) this.redo();
  }
  clearHistory() { this.undoStack = []; this.redoStack = []; this.emit('history'); }

  _afterHistory() {
    if (this.activeSeqId && !this.project.items[this.activeSeqId]) this.activeSeqId = Object.values(this.project.items).find((i) => i.type === 'sequence')?.id || null;
    const seq = this.seq;
    if (seq) {
      const ids = new Set(); for (const k of ['video', 'audio']) for (const t of seq.tracks[k]) for (const c of t.clips) ids.add(c.id);
      for (const id of [...this.selection.clips]) if (!ids.has(id)) this.selection.clips.delete(id);
    }
    this.markDirty();
    this.emit('history');
    this.emit('change', { scope: 'history' });
    this.emit('selection');
  }

  selectClips(ids, mode = 'replace') {
    const s = this.selection.clips;
    if (mode === 'replace') { s.clear(); for (const id of ids) s.add(id); }
    else if (mode === 'add') for (const id of ids) s.add(id);
    else if (mode === 'toggle') for (const id of ids) s.has(id) ? s.delete(id) : s.add(id);
    else if (mode === 'remove') for (const id of ids) s.delete(id);
    this.selection.transition = null;
    this.emit('selection');
  }
  selectTransition(trackId, trId) { this.selection.clips.clear(); this.selection.transition = trId ? { trackId, id: trId } : null; this.emit('selection'); }
  selectItems(ids, mode = 'replace') {
    const s = this.selection.items;
    if (mode === 'replace') { s.clear(); for (const id of ids) s.add(id); }
    else if (mode === 'toggle') for (const id of ids) s.has(id) ? s.delete(id) : s.add(id);
    else for (const id of ids) s.add(id);
    this.emit('selection');
  }

  serialize() {
    const p = deepClone(this.project);
    p.activeSequence = this.activeSeqId;
    return JSON.stringify(p);
  }
}

export const store = new Store();
window.__store = store;
