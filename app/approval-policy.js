// Shared display/decision boundary. Native permissions remain authoritative.
(function (target) {
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
  if (typeof module !== 'undefined' && module.exports) module.exports = { nativeApprovalPolicy };
  else target.nativeWorkspaceApproval = { nativeApprovalPolicy };
})(typeof window === 'undefined' ? globalThis : window);
