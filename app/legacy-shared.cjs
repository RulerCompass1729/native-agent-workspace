// Retained hosts use the same room-message projection as current services.
// Only a new explicit send can grant display; persisted rows never grant work.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { SharedReplies } = require('./shared-replies.cjs');

class LegacyShared extends SharedReplies {
  constructor(dataDir, changed) {
    super({ sessions: new Map(), runtimes: new Map(), room: { messages: [] } });
    this.filename = path.join(dataDir, 'legacy-shared.json'); this.changed = changed;
    try {
      const stat = fs.lstatSync(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 64 * 1024 * 1024) throw Error('Unsafe shared cache');
      const rows = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (!Array.isArray(rows)) throw Error('Invalid shared cache');
      this.workspace.room.messages = rows.map(row => ['streaming', 'running'].includes(row.status)
        ? { ...row, status: 'unconfirmed', sharingStopped: '观察连接已关闭；后续内容留在原会话' } : row);
    } catch (error) { if (error.code !== 'ENOENT') this.storageError = true; }
  }
  authorize(record, runtime, tag, source, authority) {
    if (this.storageError || !runtime.sharedReplyAvailable || typeof authority !== 'function') return false;
    const s = { ...record, messages: runtime.record.messages };
    this.workspace.sessions.set(s.id, s); this.workspace.runtimes.set(s.id, runtime);
    super.authorize(s, runtime, tag, source);
    Object.assign(this.grants.get(tag), { authority, lease: runtime.rootLease });
    return true;
  }
  valid(g) {
    try {
      const r = g.runtime, nativeValid = r.record.provider === 'codex'
        ? r.sharedReplyAvailable && !r.approval && ['idle', 'working'].includes(r.state)
        : !r.disposed && !r.rootEnding && r.nativeSharedDisplay && r.rootLease === g.lease;
      return !this.storageError && nativeValid && g.authority() && super.valid(g);
    }
    catch { return false; }
  }
  close(tag, reason) { super.close(tag, reason); this.scheduleSave(); }
  revoke(id, reason) { for (const g of this.grants.values()) if (g.sessionId === id) this.close(g.tag, reason); }
  receipt(tag, identity) {
    const g = this.grants.get(tag); if (!g || g.closed) return;
    if (!identity?.turnId || !identity?.promptId) { this.close(tag, '回复归属未确认'); return; }
    g.receipt = { ...identity, nativeId: g.nativeId }; this.bindAccepted(g);
  }
  bindAccepted(g) {
    if (!g.acceptedInput || !g.receipt) return;
    if (!this.valid(g)) { this.close(g.tag); return; }
    const s = this.workspace.sessions.get(g.sessionId); s.messages = g.runtime.record.messages;
    super.bind(s, g.tag, g.receipt); this.scheduleSave();
  }
  bindNative(runtime, identity) {
    const g = this.grants.get(identity?.tag);
    if (!g || g.runtime !== runtime || runtime.record.provider !== 'codex' || !this.valid(g)) return;
    const s = this.workspace.sessions.get(g.sessionId); s.messages = runtime.record.messages;
    super.bind(s, g.tag, identity); this.scheduleSave();
  }
  completeNative(runtime, info) {
    const g = this.grants.get(info?.tag), row = g?.rows.get(info?.messageId);
    // Completion only finalizes an already attributed native block. No raw fallback.
    if (g?.runtime === runtime && this.valid(g) && row?.role === 'assistant' && row.turnId === g.turnId) {
      super.final(this.workspace.sessions.get(g.sessionId), { ...info, text: row.text }); this.scheduleSave();
    } else if (g) this.close(g.tag, '原生回复归属未确认');
  }
  observed(runtime, message) {
    const s = this.workspace.sessions.get(runtime.record.id);
    if (!s || this.workspace.runtimes.get(s.id) !== runtime) return;
    s.messages = runtime.record.messages;
    if (message.kind === 'input') {
      for (const g of this.grants.values()) if (g.sessionId === s.id && !g.closed) {
        if (message.inputTag !== g.tag) this.close(g.tag, '原生已接收其他输入；后续内容留在原会话');
        else { g.acceptedInput = true; this.bindAccepted(g); }
      }
    } else this.record(s, message);
    this.scheduleSave();
  }
  record(s, message, only) {
    super.record(s, message, only);
    if (s.provider === 'claude' && message?.kind === 'turn') for (const g of only ? [only] : this.grants.values()) {
      if (g.sessionId !== s.id || g.turnId !== message.turnId || g.closed) continue;
      const proof = g.runtime.displayProofs?.get(g.turnId);
      // No raw Stop fallback, and no final row synthesized without display proof.
      if (this.valid(g) && message.status === 'complete' && proof?.ended && !proof.incomplete &&
        proof.promptId === g.promptId && typeof proof.safeText === 'string' && g.rows.get(proof.messageId)?.role === 'assistant') {
        super.final(s, { tag: g.tag, messageId: proof.messageId, text: proof.safeText });
      } else this.close(g.tag, '原生本轮已结束；未确认内容留在原会话');
    }
  }
  snapshot() { this.refresh(); return this.workspace.room.messages; }
  clear(ids) {
    const selected = new Set(ids);
    for (const g of this.grants.values()) if (selected.has(g.sourceId) || [...g.rows.values()].some(row => selected.has(row.id))) this.close(g.tag);
    const previous = this.workspace.room.messages;
    this.workspace.room.messages = previous.filter(row => !selected.has(row.id) && !selected.has(row.sourceTag));
    try { this.save(); } catch (error) { this.workspace.room.messages = previous; throw error; }
  }
  scheduleSave() {
    if (this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { this.save(); } catch { this.storageError = true; this.refresh(); }
      this.changed();
    }, 150);
  }
  save() {
    if (this.storageError) throw Error('本地共享回复记录无法保存；后续内容留在原会话。');
    const temporary = this.filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.workspace.room.messages.filter(row => !row.volatile)), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filename);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  dispose() {
    this.disposed = true;
    for (const g of this.grants.values()) this.close(g.tag);
    clearTimeout(this.saveTimer); this.saveTimer = null;
    try { this.save(); } catch { this.storageError = true; }
  }
}
module.exports = { LegacyShared };
