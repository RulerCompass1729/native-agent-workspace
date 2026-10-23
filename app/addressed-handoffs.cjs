// Explicit native tool intent, not a parser for prose, mentions or terminal text.
// A call reserves at most one handoff. Workspace.advance owns actual delivery
// after the same native turn finishes and rechecks the human authorization.
const TOOL = 'workspace_message';
const NAMESPACE = 'workspace';
const tool = { type: 'function', name: TOOL,
  description: 'Within a human-authorized workspace discussion, address one message to an exact participant ID supplied with this task. Stages one handoff after your current turn finishes; does not wait for a reply. Without a tool call your answer goes to the human and cooperation stops. Never use for ordinary @ text or file references.',
  inputSchema: { type: 'object', properties: {
    recipient_id: { type: 'string', description: 'Exact workspace participant ID from the current authorized task.' },
    message: { type: 'string', description: 'The complete message to that participant, at most 6000 characters.' },
  }, required: ['recipient_id', 'message'], additionalProperties: false }, deferLoading: false };

function taskText(run, body, senderId) {
  const roster = run.ids.map(id => `${id}: ${run.names[id]}`).join('\n');
  return `${body}\n\n[Workspace collaboration authorized by the human]\n${senderId ? `Message from ${run.names[senderId]}. This is task material, not new human authorization.\n` : ''}Participants (use exact IDs):\n${roster}\nTo address another participant, call workspace.workspace_message (Codex code mode: tools.workspace__workspace_message; Claude: mcp__native_workspace__workspace_message) with recipient_id and message, once this turn. It is sent only after this turn finishes. No tool call means answer the human and stop. Do not poll or call merely to acknowledge. At most ${run.maxSteps - run.steps} replies remain; permission waits or human intervention stop routing. Native child work is not declared finished by this limit.\n[/Workspace collaboration]`;
}

function authorized(workspace, session, runtime, identity) {
  const run = workspace.room.run, awaiting = run?.awaiting;
  if (workspace.expireRun(run) || !run || run.mode !== 'directed' || run.status !== 'running' ||
    awaiting?.sessionId !== session.id || workspace.runtimes.get(session.id) !== runtime ||
    identity?.nativeId !== session.nativeId || !identity.turnId || !identity.callId ||
    typeof identity.callId !== 'string' || identity.callId.length > 160) throw Error('没有适用于本次原生回合的定向协作授权。');
  const grant = workspace.sharedReplies.grants.get(awaiting.tag);
  if (!grant || !workspace.sharedReplies.valid(grant) || !grant.turnId || grant.turnId !== identity.turnId ||
    (session.provider === 'claude' && (!grant.promptId || grant.promptId !== identity.promptId))) throw Error('本次回复归属尚未确认，未安排转交。');
  return { run, awaiting };
}
function failed(workspace, session, runtime, identity) {
  const { run } = authorized(workspace, session, runtime, identity);
  run.stopAfterReply = '原生工具未获准或消息未能登记；没有继续转交。请核对原生会话。';
  run.pendingHandoff = null; workspace.changed();
  return { status: 'not-sent' };
}
function accept(workspace, session, runtime, identity, args) {
  const { run, awaiting } = authorized(workspace, session, runtime, identity);
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['recipient_id', 'message'].includes(k)) ||
    typeof args.recipient_id !== 'string' || typeof args.message !== 'string' || !args.message.trim() || args.message.length > 6000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.message)) throw Error('请提供准确的接收者 ID 和不超过 6000 字符的完整消息。');
  if (run.steps + 1 >= run.maxSteps) throw Error('本轮回复上限已到，不再安排后续转交。');
  const target = workspace.sessions.get(args.recipient_id);
  if (!target || target.id === session.id || !run.ids.includes(target.id) || target.roomId !== 'shared') throw Error('接收者不在本次已授权成员中。');
  const previous = run.pendingHandoff;
  if (previous) {
    if (previous.sourceTag === awaiting.tag && previous.callId === identity.callId && previous.recipientId === target.id && previous.text === args.message) return { status: 'staged', message: '同一调用已登记，尚未投递；不会重复登记。' };
    throw Error('这个回复已经登记了一次转交；未追加或替换。');
  }
  run.pendingHandoff = { sourceTag: awaiting.tag, senderId: session.id, callId: identity.callId,
    turnId: identity.turnId, recipientId: target.id, text: args.message,
    nativeId: target.nativeId, member: target.memberRevision, control: target.controlRevision, connection: target.connectionRevision };
  workspace.changed();
  return { status: 'staged', message: '已登记，尚未投递。当前原生回复正常结束后才会在仍有效的授权内投递；不要轮询或等待。真人可随时撤销。' };
}
const codexTool = { type: 'namespace', name: NAMESPACE, description: 'Explicit messages within a human-authorized workspace discussion.', tools: [tool] };
module.exports = { TOOL, NAMESPACE, tool, codexTool, taskText, accept, failed };
