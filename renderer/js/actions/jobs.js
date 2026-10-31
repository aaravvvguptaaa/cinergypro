// Background job tracking shown in the status bar.
import { Emitter, uid } from '../core/util.js';

class Jobs extends Emitter {
  constructor() {
    super();
    this.list = new Map();
    window.native.on('job:progress', (m) => {
      const j = m.jobId && this.list.get(m.jobId);
      if (j) { j.progress = m.progress; if (m.stage) j.stage = m.stage; this.emit('change'); }
    });
  }
  start(label, kind = 'task') {
    const id = 'job_' + uid();
    const j = { id, label, kind, progress: 0, started: Date.now(), cancel: () => window.native.call('media:cancel', id) };
    this.list.set(id, j);
    this.emit('change');
    return j;
  }
  update(id, progress, label) { const j = this.list.get(id); if (j) { j.progress = progress; if (label) j.label = label; this.emit('change'); } }
  done(id) { this.list.delete(id); this.emit('change'); }
  async run(label, fn, kind) {
    const j = this.start(label, kind);
    try { return await fn(j); } finally { this.done(j.id); }
  }
}

export const jobs = new Jobs();
