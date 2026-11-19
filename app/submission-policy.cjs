const { uiError, uiNotice } = require('./ui-errors.cjs');
// Capability checks apply to the session's retained service, not the new UI.
const legacyNotice = '这个旧版会话的原生身份和历史已保留。可用“接通原会话输入”连接；尚不支持的连接可在原生终端继续。';
const capabilitiesFor = (snapshot, id) => snapshot.sessions?.find(s => s.id === id)?.serviceCapabilities || snapshot.capabilities || [];
const canSubmit = (snapshot, s) => s.legacySubmit === true || capabilitiesFor(snapshot, s.id).includes(s.provider === 'claude' ? 'structuredClaudeSubmit' : 'nativeInputIsolation');
const canShare = (snapshot, s) => s.legacyShare === true || (capabilitiesFor(snapshot, s.id).includes('nativeInputIsolation') && (s.provider !== 'claude' || capabilitiesFor(snapshot, s.id).includes('claudePromptIdentity')));
function submissionState(snapshot) {
  return { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s,
    ...(!canSubmit(snapshot, s) ? { chatAvailable: false, submissionNotice: legacyNotice, submissionNoticeUiMessage: uiError('error.policy.legacyNotice').uiMessage } : {}),
    shareAvailable: canSubmit(snapshot, s) && canShare(snapshot, s),
    sharingNotice: s.legacyShare === true && !s.legacySharedReply ? '回复在成员视图查看；再次分享由你选择，不会自动转发私人回复。' : canShare(snapshot, s) ? null : legacyNotice,
    sharingNoticeUiMessage: s.legacyShare === true && !s.legacySharedReply ? uiNotice('notice.policy.sharingLocal').uiMessage : canShare(snapshot, s) ? null : uiError('error.policy.legacyNotice').uiMessage,
  })) };
}
function rotationEpoch(session) {
  const episode = session?.rotationEpisode;
  return episode && episode.nativeId === session.nativeId ? episode.epoch : null;
}
function rotationBlocked(session) {
  return rotationEpoch(session) !== null && !['not-sent', 'complete', 'released'].includes(session.rotationEpisode.state);
}
function queuePurposeValid(session, input, itemId, nativeId, claim) {
  if (rotationBlocked(session) || !input || input.role !== 'user' || nativeId && nativeId !== session.nativeId) return false;
  if (claim?.claimed === true) return (claim.claimEpoch ?? null) === rotationEpoch(session) &&
    !input.dispatchPurpose?.kind?.startsWith('rotation-') && !input.dispatchItem?.startsWith('rotation:');
  if (input.origin !== 'naw-dispatch' || input.dispatchItem !== itemId) return false;
  const purpose = input.dispatchPurpose;
  // Existing queue records already name their item; only the pre-epoch scope can use them.
  if (!purpose) return rotationEpoch(session) === null;
  return purpose.kind === 'queue' && purpose.itemId === itemId && purpose.nativeId === session.nativeId &&
    purpose.epoch === rotationEpoch(session);
}
function assertSubmission(snapshot, ids) {
  if (snapshot.sessions.some(s => ids.includes(s.id) && !canSubmit(snapshot, s))) throw uiError('error.policy.legacyNotice');
}
function assertSharing(snapshot, ids) {
  assertSubmission(snapshot, ids);
  if (ids.some(id => { const s = snapshot.sessions.find(s => s.id === id); return !s || !canShare(snapshot, s); })) throw uiError('error.policy.legacyNotice');
}
function assertAutomaticRun(snapshot, mode = 'strict', ids) {
  if (!['strict', 'replies', 'directed'].includes(mode)) throw uiError("error.policy.unknownAuthorization");
  const cap = mode === 'directed' ? 'agentAddressedHandoffs' : mode === 'replies' ? 'boundedReplyHandoffs' : 'verifiedHandoffs';
  const supported = ids ? ids.every(id => {
    const caps = capabilitiesFor(snapshot, id);
    return snapshot.sessions.some(s => s.id === id && (mode !== 'directed' || s.addressedSendAvailable === true)) && caps.includes(cap) && caps.includes('nativeInputIsolation') &&
      (ids.length <= 2 || caps.includes('multiSessionHandoffs'));
  }) : snapshot.capabilities?.includes(cap);
  if (!supported) throw (snapshot.handoffNotice ? Object.assign(new Error(snapshot.handoffNotice), snapshot.handoffNoticeUiMessage ? { uiMessage: snapshot.handoffNoticeUiMessage } : {}) : uiError('error.policy.handoffUnsupported'));
}
function assertNativeCreation(snapshot, id) {
  if (!capabilitiesFor(snapshot, id).includes('nativePermissionDefaults')) throw uiError("error.policy.legacyGuiResumeUnsupported");
}
module.exports = { submissionState, assertSubmission, assertSharing, assertAutomaticRun, assertNativeCreation, capabilitiesFor, rotationEpoch, rotationBlocked, queuePurposeValid };
