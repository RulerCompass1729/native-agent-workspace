const { randomUUID } = require('node:crypto');
const { trimVolatileRows } = require('./native-blocks.cjs');

// A room displays only the turn bound to its explicit send. Display is not
// model delivery; only Workspace.advance may hand off an accepted final reply.
class SharedReplies {
  constructor(workspace) { this.workspace = workspace; this.grants = new Map(); }
  authorize(s, runtime, tag, source, run) {
    this.grants.set(tag, { tag, sessionId: s.id, runtime, nativeId: s.nativeId,
      member: s.memberRevision, control: s.controlRevision, connection: s.connectionRevision,
      failedTurnId: !run && s.state === 'error' ? runtime.failedTurnInputId : null,
      recoveryLease: runtime.rootLease,
      sourceId: source.id, requiredInputTag: source.inputMode === 'steer' ? tag : '', run, rows: new Map(), closed: false });
    for (const [key, grant] of this.grants) if (this.grants.size > 64 && grant.closed) this.grants.delete(key);
  }
  valid(g) {
    const w = this.workspace, s = w.sessions.get(g.sessionId);
    const explicitRecovery = this.recovering(g);
    return !g.closed && s && w.runtimes.get(s.id) === g.runtime && s.nativeId === g.nativeId &&
      s.roomId === 'shared' && s.memberRevision === g.member && s.controlRevision === g.control && s.connectionRevision === g.connection &&
      !['ended', 'recoverable', 'disconnected', 'approval'].includes(s.state) && (s.state !== 'error' || explicitRecovery) && !s.approval && !g.runtime.transportDisconnected && !g.runtime.backendExitConfirmed &&
      (!g.run || (w.room.run === g.run && g.run.status === 'running' && Date.now() < g.run.deadline));
  }
  recovering(g) {
    const r = g.runtime;
    const acceptedTurn = g.turnId || g.receipt?.turnId || (r.pending?.tag === g.tag && r.pending.accepted ? r.pending.turnId : null);
    // Only this new human send may cross the lag between ordered native B
    // start/acceptance and the settings hook changing A's old error state.
    // Neither an old grant nor an automatic run inherits that permission.
    return Boolean(g.failedTurnId && !g.run && g.recoveryLease === r.rootLease &&
      !r.nativeInputRequired && !r.rootEnding && !r.disposed && r.submission?.connected !== false &&
      (r.failedTurnInputMatches?.(g.failedTurnId) ||
        (r.submission?.pending?.tag === g.tag && r.submission.pending.authorized) ||
        (acceptedTurn && r.rootTurn?.id === acceptedTurn &&
          (r.rootTurn.status === 'working' || (r.rootTurn.status === null && r.rootTurn.completed === true)))));
  }
  close(tag, reason = '后续内容留在原会话') {
    const g = this.grants.get(tag); if (!g || g.closed) return;
    g.closed = true;
    const rows = [...g.rows.values()];
    // A permission can arrive between completed items, with nothing currently
    // streaming. Keep the completed status but explain why no continuation follows.
    if (rows.length && !rows.some(row => row.finalReply)) rows.at(-1).sharingStopped ||= reason;
    for (const row of g.rows.values()) if (!row.finalReply && ['streaming', 'running'].includes(row.status)) {
      row.sharingStopped = reason;
      row.status = 'unconfirmed';
    }
  }
  refresh() {
    for (const g of this.grants.values()) if (!g.closed && !this.valid(g)) this.close(g.tag);
  }
  bind(s, tag, identity) {
    const g = this.grants.get(tag);
    if (!g || !this.valid(g) || !identity || identity.nativeId !== g.nativeId || typeof identity.turnId !== 'string' || !identity.turnId) return;
    if (g.requiredInputTag && identity.inputTag !== g.requiredInputTag) return;
    if (s.provider === 'claude' && (typeof identity.promptId !== 'string' || !identity.promptId)) return;
    if (g.turnId && (g.turnId !== identity.turnId || g.promptId !== identity.promptId)) { this.close(tag); return; }
    g.turnId = identity.turnId; g.promptId = identity.promptId;
    // Native events may precede the send ACK. Exact identity, never proximity
    // or matching text, allows their existing private rows to enter the room.
    for (const row of s.messages) if (row.turnId === g.turnId) this.record(s, row, g);
  }
  record(s, message, only) {
    if (message?.kind === 'gap') {
      for (const g of this.grants.values()) if (g.sessionId === s.id && !g.closed) {
        for (const row of g.rows.values()) row.incomplete = true;
        this.close(g.tag, '部分内容未同步，请在原会话核对');
      }
      return;
    }
    if (!message?.turnId || message.nativeId !== s.nativeId) return;
    for (const g of only ? [only] : this.grants.values()) {
      if (g.sessionId !== s.id || g.nativeId !== message.nativeId || !g.turnId || g.turnId !== message.turnId) continue;
      if (!this.valid(g)) { this.close(g.tag); this.boundary(g, message); continue; }
      if (g.requiredInputTag && message.inputTag !== g.requiredInputTag) continue;
      if (!['assistant', 'tool'].includes(message.role) && message.kind !== 'turn') continue;
      if (s.provider === 'claude' && message.role === 'assistant' && message.promptId !== g.promptId) continue;
      let row = g.rows.get(message.id);
      if (!row) {
        row = { id: randomUUID(), sessionId: s.id, name: s.name, role: message.role, time: Date.now(),
          replyTo: g.sourceId, sourceTag: g.tag, nativeMessageId: message.id, nativeId: g.nativeId,
          turnId: g.turnId, ...(g.run ? { runId: g.run.id } : {}), sharedStream: true, deliveryTracked: true };
        g.rows.set(message.id, row); this.workspace.room.messages.push(row);
      }
      for (const field of ['text', 'input', 'title', 'status', 'incomplete', 'volatile', 'displayTurnId']) row[field] = message[field];
      row.nativeStatus = message.status;
      this.boundary(g, message);
    }
    const room = this.workspace.room;
    room.messages = trimVolatileRows(room.messages, 'shared-native-cache-gap');
    const retained = new Set(room.messages.map(m => m.id));
    for (const g of this.grants.values()) for (const [id, row] of g.rows) if (!retained.has(row.id)) g.rows.delete(id);
  }
  boundary(g, message) {
    if (message.kind !== 'turn') return;
    for (const row of g.rows.values()) if (row.role === 'assistant' && row.nativeStatus === 'streaming') {
      row.status = message.status === 'interrupted' ? 'interrupted' : 'unconfirmed';
      row.nativeStatus = row.status;
    }
  }
  hasCompletedPlan(s, tag) {
    const g = this.grants.get(tag);
    if (!g || g.sessionId !== s.id || !g.turnId || !this.valid(g)) return false;
    return s.messages.some(message => message.kind === 'plan' && message.status === 'complete' && !message.incomplete &&
      message.nativeId === g.nativeId && message.turnId === g.turnId &&
      (!g.requiredInputTag || message.inputTag === g.requiredInputTag) &&
      g.rows.get(message.id)?.status === 'complete' && !g.rows.get(message.id).incomplete);
  }
  final(s, info, run) {
    const g = this.grants.get(info.tag);
    if (!g || !this.valid(g)) { this.close(info.tag); return null; }
    // The adapter supplies the final native item identity. Never deduplicate
    // equal text from two different messages, agents, or turns.
    let row = info.messageId && g?.rows.get(info.messageId);
    if (g.requiredInputTag && (!g.turnId || info.inputTag !== g.requiredInputTag || !row || row.role !== 'assistant')) { this.close(info.tag); return null; }
    if (!row || row.role !== 'assistant') {
      row = { id: randomUUID(), role: 'assistant', sessionId: s.id, name: s.name, time: Date.now(),
        ...(g ? { replyTo: g.sourceId, sourceTag: g.tag } : {}), ...(run ? { runId: run.id } : {}), deliveryTracked: true };
      this.workspace.room.messages.push(row);
    }
    row.text = info.text; row.status = 'complete'; row.finalReply = true;
    this.close(info.tag, '本次回复已结束');
    return row;
  }
}
module.exports = { SharedReplies };
