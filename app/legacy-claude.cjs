// Same-process, private reader for the inspected retained Claude host. Native
// hooks still own lifecycle, permissions and fleet. This cannot start a CLI.
const { Claude } = require('./adapters.cjs');
const { applyNativeBlock } = require('./native-blocks.cjs');
const { processMayBeAlive } = require('./platform.cjs');
const { readerPath, readReaderCache, writeReaderCache } = require('./reader-cache.cjs');

class LegacyClaude extends Claude {
  constructor(record, dataDir, currentRecord) {
    super({ ...record, messages: [] }, null, { attachOnly: true });
    this.retainedReader = true; this.currentRecord = currentRecord; this.reader = this;
    this.filename = readerPath(dataDir, record.nativeId);
    this.terminal = { get alive() { return processMayBeAlive(record.processIdentity); } };
    this.initialized = false; this.disposed = false;
    const saved = readReaderCache(this.filename, record);
    if (saved) {
      this.record.messages = saved.messages; this.nativeInputRequired = saved.nativeInputRequired === true; this.initialized = true;
      this.gap('观察连接已重新打开；接入前或超出缓存的临时内容，请在原生终端核对。');
    }
    this.on('nativeBlock', event => {
      // A late result from a tool started before this observer is not a new
      // tool invocation. Do not invent its turn or merge it with another tool.
      if (event.kind === 'tool' && !event.input && !this.record.messages.some(m => m.id === `native:${this.record.nativeId}:${event.id}`)) {
        this.gap('收到接入前工具的结果；该工具的起点未被观察，请在原生终端核对。'); return;
      }
      if (event.kind === 'input' && event.inputTag) {
        const pending = this.record.messages.find(m => m.id === event.inputTag && m.inputMode === 'queue' && m.nativeId === event.nativeId && m.text === event.text);
        if (pending) { pending.id = `native:${event.nativeId}:${event.id}`; pending.nativeBlock = true; }
      }
      if (applyNativeBlock(this.record, event, dataDir)) {
        this.emit('readerBlock', this.record.messages.find(m => m.id === `native:${event.nativeId}:${event.id}`));
        this.scheduleSave(); this.emit('change');
      }
    });
    this.on('inputRequired', () => { this.scheduleSave(); this.emit('change'); });
    this.on('usage', usage => { this.usage = usage; this.emit('change'); });
    this.on('model', model => { this.model = model; this.emit('change'); });
    this.on('capability', () => this.emit('change'));
    this.on('state', () => this.emit('change'));
    this.on('progress', update => { if (update.kind === 'gap') this.emit('change'); });
    this.on('contextEnd', () => { this.gap('原生上下文已结束或切换；此处保留原记录，请在原生终端继续。'); });
  }
  async bindRoot(message) {
    if (this.disposed || message.nativeBlocks !== true) throw Error('Reader unavailable');
    const latest = await this.currentRecord();
    if (this.disposed) throw Error('Reader closed');
    if (!latest || latest.nativeId !== this.record.nativeId || latest.pid !== this.record.pid) throw Error('Retained identity changed');
    // Do not freeze an old turn halfway through: its hook-only final reply
    // must remain visible before the new observer takes over at idle.
    if (!this.initialized && latest.state !== 'idle') throw Error('Waiting for native idle');
    const result = super.bindRoot(message);
    if (!this.initialized) {
      this.record.messages = structuredClone(latest.messages || []);
      this.markReader?.();
      this.initialized = true;
      this.gap('已接入原生实时内容；接入前未记录的临时过程仍需在原生终端查看。');
    }
    this.scheduleSave(); this.emit('change'); return result;
  }
  validRootBinding(message) { return !this.disposed && super.validRootBinding(message); }
  effectiveState(record) {
    if (record.approval) return record.state;
    if (!this.disposed && this.validRootBinding({ sessionId: record.nativeId, lease: this.rootLease }) && record.pid === this.record.pid &&
        ['idle', 'working', 'approval'].includes(record.state) && !record.nativeContextPending && this.submission.connected && this.liveTurn && Date.now() - this.observationSeenAt <= 5000) {
      return this.livePermissions?.size ? 'approval' : 'working';
    }
    if (!this.disposed && this.validRootBinding({ sessionId: record.nativeId, lease: this.rootLease }) &&
      record.pid === this.record.pid && ['idle', 'working'].includes(record.state) && !record.approval && !record.nativeContextPending &&
      this.submission.connected && (!this.liveTurn || Date.now() - this.observationSeenAt <= 5000) && this.rootTurn?.status) return this.rootTurn.status;
    return record.state;
  }
  clearRoot() { throw Error('Retained context migration is not supported'); }
  send() { throw Error('Use the retained submission channel'); }
  get queueAvailable() { return Boolean(!this.nativeInputRequired && !this.disposed && this.initialized && this.nativeQueue && this.rootLease && !this.rootEnding && this.submission.connected); }
  get sharedReplyAvailable() { return Boolean(this.queueAvailable && this.nativeSharedDisplay); }
  get pendingQueue() { return this.submission.pending?.waitForNativeTurn ? this.submission.pending.tag : null; }
  async queue(text, tag, guard) {
    if (!this.queueAvailable || this.submission.pending || !guard()) throw Error('原生等待输入暂不可用；草稿保留。');
    const row = { id: tag, role: 'user', kind: 'input', nativeId: this.record.nativeId, text, status: 'awaiting-native', inputMode: 'queue', time: Date.now() };
    this.record.messages.push(row); this.save(); this.emit('change');
    try {
      if (this.storageError) throw Error('等待输入未能保存；没有发送，草稿保留。');
      const pending = this.submission.request(text, tag, guard, true); this.emit('change');
      const receipt = await pending;
      if (row.status === 'awaiting-native') row.status = 'submitted';
      return receipt;
    } catch (error) {
      if (row.status === 'awaiting-native') row.status = 'unconfirmed';
      throw error;
    } finally { this.save(); this.emit('change'); }
  }
  interrupt() { throw Error('Native lifecycle belongs to the original host'); }
  stop() { throw Error('Native lifecycle belongs to the original host'); }
  gap(text) {
    this.rootTurn = null; this.liveTurn = null; this.livePermissions?.clear();
    for (const row of this.record.messages) if (['streaming', 'running', 'awaiting-native'].includes(row.status)) row.status = 'unconfirmed';
    const id = `retained-gap:${this.record.nativeId}`;
    let row = this.record.messages.find(m => m.id === id);
    if (!row) { row = { id, role: 'system', kind: 'gap', time: Date.now() }; this.record.messages.push(row); }
    row.text = text; row.incomplete = true; this.emit('readerBlock', row); this.scheduleSave(); this.emit('change');
  }
  scheduleSave() {
    if (this.disposed || this.saveTimer || !this.initialized) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 200);
  }
  save() {
    if (!this.initialized) return;
    try {
      writeReaderCache(this.filename, this.record, { nativeInputRequired: this.nativeInputRequired === true }); this.storageError = false;
    } catch {
      this.storageError = true;
      this.emit('change');
    }
  }
  close() {
    if (this.disposed) return;
    this.rootTurn = null; this.liveTurn = null; this.livePermissions?.clear(); this.disposed = true; clearTimeout(this.saveTimer); this.saveTimer = null;
    this.submission.close(); this.save();
  }
}
module.exports = { LegacyClaude, readerPath };
