// Capability checks apply to the session's retained service, not the new UI.
const legacyNotice = '这个旧版会话仍在原连接上，可用原生终端继续。原生工作结束后，从会话菜单选择“更新原会话连接”启用新版功能；保留原身份和历史，不重发旧任务。';
const capabilitiesFor = (snapshot, id) => snapshot.sessions?.find(s => s.id === id)?.serviceCapabilities || snapshot.capabilities || [];
const canSubmit = (snapshot, s) => capabilitiesFor(snapshot, s.id).includes(s.provider === 'claude' ? 'structuredClaudeSubmit' : 'nativeInputIsolation');
function submissionState(snapshot) {
  return { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s,
    ...(!canSubmit(snapshot, s) ? { chatAvailable: false, submissionNotice: legacyNotice } : {}),
    shareAvailable: canSubmit(snapshot, s) && capabilitiesFor(snapshot, s.id).includes('nativeInputIsolation'),
    sharingNotice: capabilitiesFor(snapshot, s.id).includes('nativeInputIsolation') ? null : legacyNotice,
  })) };
}
function assertSubmission(snapshot, ids) {
  if (snapshot.sessions.some(s => ids.includes(s.id) && !canSubmit(snapshot, s))) throw new Error(legacyNotice);
}
function assertSharing(snapshot, ids) {
  assertSubmission(snapshot, ids);
  if (ids.some(id => !capabilitiesFor(snapshot, id).includes('nativeInputIsolation'))) throw new Error(legacyNotice);
}
function assertAutomaticRun(snapshot, mode = 'strict') {
  if (!['strict', 'replies'].includes(mode)) throw new Error('未知协作授权。');
  if (!snapshot.capabilities?.includes(mode === 'replies' ? 'boundedReplyHandoffs' : 'verifiedHandoffs')) throw new Error(snapshot.handoffNotice || '旧版后台无法核实自动交接状态；原生会话已保留，请用原生终端或定向发送。');
}
function assertNativeCreation(snapshot, id) {
  if (!capabilitiesFor(snapshot, id).includes('nativePermissionDefaults')) throw new Error('这个旧版会话尚不能在图形界面恢复，请在原生终端继续。新建会话会使用新版后台，旧会话不会自动迁移。');
}
module.exports = { submissionState, assertSubmission, assertSharing, assertAutomaticRun, assertNativeCreation, capabilitiesFor };
