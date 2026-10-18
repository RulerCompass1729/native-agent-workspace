// A UI update must preserve live native sessions without using an older,
// unsafe terminal-based Claude send implementation in their retained service.
const legacyNotice = '后台仍在保留旧版会话；请用原生终端继续。结束会话并重新打开应用后，才可启用安全图形发送。';
function submissionState(snapshot, supported) {
  if (supported) return snapshot;
  return { ...snapshot, sessions: snapshot.sessions.map(s => s.provider === 'claude' ? { ...s, chatAvailable: false, submissionNotice: legacyNotice } : s) };
}
function assertSubmission(snapshot, ids) {
  if (!snapshot.capabilities?.includes('structuredClaudeSubmit') && snapshot.sessions.some(s => s.provider === 'claude' && ids.includes(s.id))) throw new Error(legacyNotice);
}
function assertAutomaticRun(snapshot) {
  if (!snapshot.capabilities?.includes('verifiedHandoffs')) throw new Error('旧版后台无法核实自动交接状态；原生会话已保留，请用原生终端或定向发送。结束会话并重新打开应用后可更新后台。');
}
module.exports = { submissionState, assertSubmission, assertAutomaticRun };
