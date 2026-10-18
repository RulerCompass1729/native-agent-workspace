// A UI update must preserve live native sessions without using an older,
// unsafe terminal-based Claude send implementation in their retained service.
const legacyNotice = '这个旧版会话保留在原后台，请用原生终端继续。新建会话可使用新版功能；旧会话不会自动迁移或重发。';
const capabilitiesFor = (snapshot, id) => snapshot.sessions?.find(s => s.id === id)?.serviceCapabilities || snapshot.capabilities || [];
function submissionState(snapshot, supported) {
  if (supported && snapshot.sessions.every(s => !s.serviceCapabilities || s.serviceCapabilities.includes('structuredClaudeSubmit') || s.provider !== 'claude')) return snapshot;
  return { ...snapshot, sessions: snapshot.sessions.map(s => s.provider === 'claude' && !(s.serviceCapabilities ? s.serviceCapabilities.includes('structuredClaudeSubmit') : supported) ? { ...s, chatAvailable: false, submissionNotice: legacyNotice } : s) };
}
function assertSubmission(snapshot, ids) {
  if (snapshot.sessions.some(s => s.provider === 'claude' && ids.includes(s.id) && !capabilitiesFor(snapshot, s.id).includes('structuredClaudeSubmit'))) throw new Error(legacyNotice);
}
function assertAutomaticRun(snapshot) {
  if (!snapshot.capabilities?.includes('verifiedHandoffs')) throw new Error(snapshot.handoffNotice || '旧版后台无法核实自动交接状态；原生会话已保留，请用原生终端或定向发送。');
}
function assertNativeCreation(snapshot, id) {
  if (!capabilitiesFor(snapshot, id).includes('nativePermissionDefaults')) throw new Error('这个旧版会话尚不能在图形界面恢复，请在原生终端继续。新建会话会使用新版后台，旧会话不会自动迁移。');
}
module.exports = { submissionState, assertSubmission, assertAutomaticRun, assertNativeCreation, capabilitiesFor };
