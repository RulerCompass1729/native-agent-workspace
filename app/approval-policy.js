// Shared display/decision boundary. Native permissions remain authoritative.
(function (target) {
  function nativeApprovalPolicy(approval) {
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
      && p.environmentId == null;
    const decisions = [];
    if (ordinary && nativeDecisions.includes('accept')) decisions.push('accept');
    // Refusal is safe even when a specialized permission cannot be fully
    // represented here. Never turn a policy/session option into an "accept".
    if ((commandRequest || fileRequest) && nativeDecisions.includes('decline')) decisions.push('decline');
    return { command, cwd, reason, decisions,
      nativeRequired: !ordinary,
      notice: !ordinary ? '这项请求的权限范围需要在原生终端核对。' : '',
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { nativeApprovalPolicy };
  else target.nativeWorkspaceApproval = { nativeApprovalPolicy };
})(typeof window === 'undefined' ? globalThis : window);
