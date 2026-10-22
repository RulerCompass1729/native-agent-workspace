// Same-process, private reader for the inspected retained Claude host. Native
// hooks still own lifecycle, permissions and fleet. This cannot start a CLI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Claude } = require('./adapters.cjs');
const { applyNativeBlock } = require('./native-blocks.cjs');
const { processMayBeAlive } = require('./platform.cjs');
const readerPath = (dataDir, nativeId) => path.join(dataDir, `legacy-reader-${crypto.createHash('sha256').update(nativeId).digest('hex')}.json`);

class LegacyClaude extends Claude {
  constructor(record, dataDir, currentRecord) {
    super({ ...record, messages: [] }, null, { attachOnly: true });
    this.retainedReader = true; this.currentRecord = currentRecord; this.reader = this;
    this.filename = readerPath(dataDir, record.nativeId);
    this.terminal = { get alive() { return processMayBeAlive(record.processIdentity); } };
    this.initialized = false; this.disposed = false;
    try {
      const stat = fs.lstatSync(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 64 * 1024 * 1024) throw Error('Unsafe reader cache');
      const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (saved.nativeId !== record.nativeId || JSON.stringify(saved.processIdentity) !== JSON.stringify(record.processIdentity) || !Array.isArray(saved.messages)) throw Error('Reader identity changed');
      this.record.messages = saved.messages; this.initialized = true;
      this.gap('观察连接已重新打开；离线期间的临时内容无法补回，请在原生终端核对。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.on('nativeBlock', event => {
      // A late result from a tool started before this observer is not a new
      // tool invocation. Do not invent its turn or merge it with another tool.
      if (event.kind === 'tool' && !event.input && !this.record.messages.some(m => m.id === `native:${this.record.nativeId}:${event.id}`)) {
        this.gap('收到接入前工具的结果；该工具的起点未被观察，请在原生终端核对。'); return;
      }
      if (applyNativeBlock(this.record, event)) { this.scheduleSave(); this.emit('change'); }
    });
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
  clearRoot() { throw Error('Retained context migration is not supported'); }
  send() { throw Error('Use the retained submission channel'); }
  queue() { throw Error('Use the retained submission channel'); }
  interrupt() { throw Error('Native lifecycle belongs to the original host'); }
  stop() { throw Error('Native lifecycle belongs to the original host'); }
  gap(text) {
    for (const row of this.record.messages) if (['streaming', 'running'].includes(row.status)) row.status = 'unconfirmed';
    const id = `retained-gap:${this.record.nativeId}`;
    let row = this.record.messages.find(m => m.id === id);
    if (!row) { row = { id, role: 'system', kind: 'gap', time: Date.now() }; this.record.messages.push(row); }
    row.text = text; row.incomplete = true; this.scheduleSave(); this.emit('change');
  }
  scheduleSave() {
    if (this.disposed || this.saveTimer || !this.initialized) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 200);
  }
  save() {
    if (!this.initialized) return;
    const temporary = this.filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ nativeId: this.record.nativeId, processIdentity: this.record.processIdentity,
        messages: this.record.messages.filter(row => !row.volatile) }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filename); this.storageError = false;
    } catch {
      this.storageError = true;
      this.emit('change');
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  close() {
    this.disposed = true; clearTimeout(this.saveTimer); this.saveTimer = null;
    this.submission.close(); this.save();
  }
}
module.exports = { LegacyClaude, readerPath };
