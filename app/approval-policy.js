// Shared display/decision boundary. Native permissions remain authoritative.
(function (target) {
  // In-memory native requests only. The source connection and typed native ID
  // identify a request; GUI IDs are separate, disposable decision credentials.
  class ApprovalQueue {
    constructor(makeId) { this.makeId = makeId; this.entries = []; this.overflowSources = new Set(); }
    get current() { return this.entries.at(-1); }
    get overflow() { return this.overflowSources.size > 0; }
    add(approval, rpc, runtime) {
      const index = this.entries.findIndex(r => r.rpc === rpc && r.nativeRequestId === approval.requestId);
      const previous = this.entries[index];
      const content = JSON.stringify(approval);
      if (previous?.content === content) return previous;
      if (index < 0 && this.entries.length >= 200) { this.overflowSources.add(rpc); return null; }
      const requestId = this.makeId();
      const entry = { runtime, rpc, requestId, nativeRequestId: approval.requestId, content, approval: { ...approval, requestId } };
      if (index < 0) this.entries.push(entry); else this.entries[index] = entry;
      return entry;
    }
    get(requestId) { return this.entries.find(r => r.requestId === requestId); }
    resolve(nativeRequestId, rpc) { this.entries = this.entries.filter(r => r.rpc !== rpc || r.nativeRequestId !== nativeRequestId); }
    removeSource(rpc) { this.entries = this.entries.filter(r => r.rpc !== rpc); this.overflowSources.delete(rpc); }
    snapshot() { return { approval: this.current?.approval || (this.overflow ? { method: 'native/requestOverflow', params: {} } : null), approvals: this.entries.map(r => r.approval), approvalOverflow: this.overflow }; }
  }
  function nativeQuestions(approval) {
    if (approval?.method !== 'item/tool/requestUserInput') return null;
    const questions = approval.params?.questions;
    if (!Array.isArray(questions) || !questions.length || questions.length > 20) return null;
    const ids = new Set();
    for (const q of questions) {
      if (!q || !['id', 'header', 'question'].every(k => typeof q[k] === 'string' && q[k].length <= 16000) || !q.id || ids.has(q.id)) return null;
      ids.add(q.id);
      if (q.options != null && (!Array.isArray(q.options) || q.options.length > 100 || !q.options.every(o => o && typeof o.label === 'string' && o.label.length <= 16000 && typeof o.description === 'string' && o.description.length <= 16000))) return null;
    }
    return questions;
  }
  function nativeApprovalPolicy(approval, { localDecisions = true } = {}) {
    const p = approval?.params && typeof approval.params === 'object' ? approval.params : {};
    const text = value => typeof value === 'string' ? value : '';
    const command = text(p.command), cwd = text(p.cwd), reason = text(p.reason);
    const commandRequest = approval?.method === 'item/commandExecution/requestApproval';
    const fileRequest = approval?.method === 'item/fileChange/requestApproval';
    const nativeDecisions = !Object.hasOwn(p, 'availableDecisions') ? ['accept', 'decline']
      : Array.isArray(p.availableDecisions) ? p.availableDecisions : [];
    const ordinary = commandRequest && command.trim() && cwd.trim()
      && p.networkApprovalContext == null && p.additionalPermissions == null
      && (!Object.hasOwn(p, 'kind') || p.kind === 'command')
      && (p.environmentId == null || (localDecisions && p.environmentId === 'local'));
    const decisions = [];
    if (ordinary && nativeDecisions.includes('accept')) decisions.push('accept');
    // Refusal is safe even when a specialized permission cannot be fully
    // represented here. Never turn a policy/session option into an "accept".
    if ((commandRequest || fileRequest) && nativeDecisions.includes('decline')) decisions.push('decline');
    // Native cancel interrupts this turn; it is not a refusal that continues it.
    if (localDecisions && (commandRequest || fileRequest) && nativeDecisions.includes('cancel')) decisions.push('cancel');
    return { command, cwd, reason, decisions, questions: nativeQuestions(approval),
      nativeRequired: !ordinary,
      notice: !ordinary ? '这项请求的权限范围需要在原生终端核对。' : '',
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { nativeApprovalPolicy, ApprovalQueue };
  else target.nativeWorkspaceApproval = { nativeApprovalPolicy };
})(typeof window === 'undefined' ? globalThis : window);
