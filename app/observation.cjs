const { randomUUID } = require('node:crypto');

// Volatile private evidence, never a source for task completion or handoff.
class TerminalJournal {
  constructor(cols, rows, { maxBytes = 2 * 1024 * 1024, maxEvents = 1200, maxCheckpointBytes = 4 * 1024 * 1024 } = {}) {
    this.epoch = randomUUID(); this.index = 0; this.events = []; this.bytes = 0;
    this.maxBytes = maxBytes; this.maxEvents = maxEvents; this.maxCheckpointBytes = maxCheckpointBytes;
    this.checkpoint = { index: 0, time: Date.now(), cols, rows, buffer: '' };
    this.truncated = false;
  }
  append(kind, data, cols, rows, serialize) {
    const event = { epoch: this.epoch, index: ++this.index, time: Date.now(), kind, cols, rows, data };
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (this.bytes + size > this.maxBytes || this.events.length >= this.maxEvents) {
      const buffer = serialize();
      this.checkpoint = Buffer.byteLength(JSON.stringify(buffer), 'utf8') <= this.maxCheckpointBytes
        ? { index: this.index, time: event.time, cols, rows, buffer } : null;
      this.events = []; this.bytes = 0; this.truncated = true;
      event.checkpointRequired = true;
    } else { this.events.push(event); this.bytes += size; }
    return event;
  }
  snapshot() {
    return { epoch: this.epoch, index: this.index, checkpoint: this.checkpoint, events: [...this.events], truncated: this.truncated,
      bytes: this.bytes, maxBytes: this.maxBytes, maxEvents: this.maxEvents,
      unavailable: this.checkpoint ? null : '原生画面超过观察缓存上限，请打开原生终端查看；未截取部分画面冒充完整画面。' };
  }
}

class ProgressJournal {
  constructor() { this.items = new Map(); this.revision = 0; this.truncated = false; }
  update(item) {
    const id = item.id || randomUUID();
    const previous = this.items.get(id);
    const next = { ...previous, id, time: previous?.time || Date.now(), updatedAt: Date.now() };
    for (const key of ['source', 'kind', 'status', 'turnId', 'title']) if (typeof item[key] === 'string') next[key] = item[key].slice(0, 300);
    if (typeof item.text === 'string') next.text = item.text.slice(-12000);
    if (typeof item.delta === 'string') next.text = ((previous?.text || '') + item.delta).slice(-12000);
    next.truncated = previous?.truncated || (typeof item.text === 'string' && item.text.length > 12000) || (typeof item.delta === 'string' && (previous?.text?.length || 0) + item.delta.length > 12000);
    this.items.set(id, next);
    let size = 0; const removed = [];
    for (const value of this.items.values()) size += Buffer.byteLength(JSON.stringify(value));
    while (this.items.size > 200 || size > 1024 * 1024) {
      const first = this.items.keys().next().value;
      size -= Buffer.byteLength(JSON.stringify(this.items.get(first)));
      this.items.delete(first); removed.push(first); this.truncated = true;
    }
    return { item: next, removed, revision: ++this.revision, truncated: this.truncated };
  }
  snapshot() { return { items: [...this.items.values()], revision: this.revision, truncated: this.truncated }; }
}
module.exports = { TerminalJournal, ProgressJournal };
