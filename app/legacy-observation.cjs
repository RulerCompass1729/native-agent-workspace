const { TerminalJournal } = require('./observation.cjs');

// Only this inspected protocol/provider pair has a snapshot that cannot create
// or attach a terminal. In particular, do not generalize to legacy Codex.
function supportsLegacyObservation(state, record) {
  return state.runtimeVersion === '0.1.0-alpha.2' && record?.provider === 'claude'
    && record.terminalAvailable === true && !state.capabilities?.includes('observe');
}

class LegacyObservation {
  constructor(read, publish) {
    this.read = read; this.publish = publish; this.journal = new TerminalJournal(100, 30);
    this.watching = false; this.disposed = false; this.revision = 0; this.last = null;
  }
  changed() {
    if (!this.watching || this.disposed) return;
    this.dirty = true;
    if (!this.timer && !this.pending) this.timer = setTimeout(() => {
      this.timer = null;
      this.capture().catch(() => { if (!this.disposed && this.watching) this.publish({ observationError: true }); });
    }, 40);
  }
  async capture() {
    if (this.pending) return this.pending;
    const revision = this.revision;
    this.dirty = false;
    this.pending = (async () => {
      const frame = await this.read();
      if (this.disposed || revision !== this.revision || !this.watching) return;
      this.capturedRevision = revision;
      if (typeof frame?.buffer !== 'string' || !Number.isSafeInteger(frame.sequence)
        || !Number.isInteger(frame.cols) || frame.cols < 20 || frame.cols > 400
        || !Number.isInteger(frame.rows) || frame.rows < 5 || frame.rows > 200) throw Error('旧连接没有提供有效的原生画面。');
      // A complete checkpoint provides its own dimensions. Never interpret
      // unlabelled old output bytes using guessed resize ordering.
      const fingerprint = [frame.sequence, frame.cols, frame.rows];
      if (this.last && fingerprint.every((value, i) => value === this.last[i])) return;
      this.last = fingerprint;
      const event = this.journal.append('snapshot', '\x1bc' + frame.buffer, frame.cols, frame.rows, () => frame.buffer);
      this.publish(event);
    })().finally(() => {
      this.pending = null;
      if (this.dirty && !this.disposed && this.watching) this.changed();
    });
    return this.pending;
  }
  async observe() {
    if (this.disposed) throw Error('观察连接已关闭。');
    this.watching = true;
    await this.capture();
    if (this.capturedRevision !== this.revision && this.watching && !this.disposed) await this.capture();
    if (this.disposed || !this.watching) throw Error('观察视图已关闭。');
    return { terminal: { ...this.journal.snapshot(), legacySnapshots: true }, progress: { items: [], revision: 0, truncated: false } };
  }
  release() { this.watching = false; this.revision++; clearTimeout(this.timer); this.timer = null; }
  dispose() { this.release(); this.disposed = true; }
}
module.exports = { LegacyObservation, supportsLegacyObservation };
