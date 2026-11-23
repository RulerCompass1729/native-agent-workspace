/* Six phone views over the desktop projection. No polling, native terminal or sensitive approval bypass. */
(function (global) {
  'use strict';
  const ACTION_KEY = 'naw.mobile.workspace.v1';
  const { receiptContext, validReceiptContext, appendReceipt } = typeof module === 'object' && module.exports ? require('./client.js') : global.NAWMobile;
  const terminal = s => ['complete', 'not-sent'].includes(s);
  function receiptVisible(row, session, view) {
    if (!session || session.candidate || row.deviceId !== session.deviceId) return false;
    if (row.native) return session.sessions.some(s => s.id === row.sessionId && s.available !== false && s.actions?.includes('read') &&
      (!row.context || row.context.scope === 'session' && row.context.targetId === s.id && (!row.context.nativeId || row.context.nativeId === s.nativeId)));
    if (!session.workspace || !view) return false;
    if (!row.context) return true;
    if (row.context.scope === 'room') return view.rooms.some(r => r.id === row.context.targetId);
    return row.context.scope === 'record' && view.capabilities?.records === true && view.reminders?.records.some(r => r.record === row.context.targetId);
  }
  function createWorkspaceActions({ storage, request, newId, changed = () => {} }) {
    const state = { pending: [], drafts: [], busy: false, storageError: false };
    try {
      const raw = storage.getItem(ACTION_KEY);
      if (raw) {
        if (raw.length > 256 * 1024) throw Error('limit');
        const saved = JSON.parse(raw);
        const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
        if (saved.version !== 1 || !Array.isArray(saved.pending) || saved.pending.length > 64 || saved.pending.some(p => !p || !uuid(p.deviceId) || !uuid(p.requestId) || !['queueAdd', 'queueCancel', 'queueResolve', 'recordAcknowledge'].includes(p.action) || !['unconfirmed', 'complete', 'not-sent'].includes(p.status) || !validReceiptContext(p.context)) || new Set(saved.pending.map(p => p.requestId)).size !== saved.pending.length) throw Error('invalid');
        state.drafts = saved.drafts || [];
        if (!Array.isArray(state.drafts) || state.drafts.length > 16 || state.drafts.some(d => !d || !uuid(d.deviceId) ||
            !['roomId', 'itemId', 'questionId'].every(k => typeof d[k] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(d[k])) || typeof d.text !== 'string' || d.text.length > 6000)) throw Error('invalid');
        state.pending = saved.pending;
      }
    } catch { state.storageError = true; }
    function save() { try { const raw = JSON.stringify({ version: 1, pending: state.pending, drafts: state.drafts }); if (raw.length > 256 * 1024) throw Error('limit'); storage.setItem(ACTION_KEY, raw); } catch { state.storageError = true; throw Error('MOBILE_STORAGE_UNAVAILABLE'); } }
    function answerDraft(session, target, value) {
      if (!session || !['roomId', 'itemId', 'questionId'].every(k => typeof target[k] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(target[k]))) throw Error('MOBILE_DRAFT_INVALID');
      let draft = state.drafts.find(d => d.deviceId === session.deviceId && ['roomId', 'itemId', 'questionId'].every(k => d[k] === target[k]));
      if (value === undefined) return draft?.text || '';
      if (typeof value !== 'string' || value.length > 6000 || !value.isWellFormed() || !draft && state.drafts.length >= 16) throw Error('MOBILE_DRAFT_INVALID');
      if (!draft) { draft = { deviceId: session.deviceId, ...target, text: '' }; state.drafts.push(draft); }
      draft.text = value; save();
    }
    function clearAnswerDraft(session, target, original) {
      state.drafts = state.drafts.filter(d => d.deviceId !== session.deviceId || d.text !== original || ['roomId', 'itemId', 'questionId'].some(k => d[k] !== target[k]));
      save();
    }
    function record(row, result) {
      if (result.requestId !== row.requestId || !['complete', 'not-sent', 'unconfirmed'].includes(result.status) ||
          row.itemId && result.itemId && row.itemId !== result.itemId) throw Error('MOBILE_ACTION_UNCONFIRMED');
      row.status = result.status;
      if (typeof result.itemId === 'string') row.itemId = result.itemId;
      save();
    }
    async function act(session, fields, local = {}) {
      if (state.storageError || state.busy || !session || state.pending.some(p => p.deviceId === session.deviceId && !terminal(p.status))) throw Error('MOBILE_ACTION_UNCONFIRMED');
      const context = receiptContext({ target: local.target, text: local.text || fields.text || '',
        scope: fields.action === 'recordAcknowledge' ? 'record' : 'room', targetId: fields.record || fields.roomId || '' });
      const requestId = newId(), row = { deviceId: session.deviceId, requestId, status: 'unconfirmed', action: fields.action, context, createdAt: Date.now(),
        ...(typeof fields.roomId === 'string' ? { roomId: fields.roomId } : {}),
        ...(typeof fields.itemId === 'string' ? { itemId: fields.itemId } : {}),
        ...(fields.action === 'queueAdd' ? { text: fields.text } : {}),
        ...(fields.answerRequestId ? { answerRequestId: fields.answerRequestId, questionId: fields.questionId } : {}) };
      const original = state.pending, next = appendReceipt(original, row, 64, p => terminal(p.status));
      if (!next) throw Error('MOBILE_ACTION_UNCONFIRMED');
      state.pending = next;
      try { save(); } catch (error) { state.pending = original; throw error; }
      state.busy = true; changed();
      try { const result = await request('/mobile/workspace/action', { ...fields, requestId }, session.csrf); record(row, result); return result; }
      catch (error) {
        if (error?.code === 'MOBILE_PAIR_LIMIT') { row.status = 'not-sent'; save(); }
        throw error;
      }
      finally { state.busy = false; changed(); }
    }
    async function receipt(session, row) {
      if (!session || row.deviceId !== session.deviceId || state.busy) throw Error('MOBILE_RECEIPT_UNAVAILABLE');
      state.busy = true; changed();
      try { const result = await request('/mobile/workspace/action', { action: 'receipt', requestId: row.requestId }, session.csrf); record(row, result); return result; }
      finally { state.busy = false; changed(); }
    }
    function forget(row) { if (!terminal(row.status)) throw Error('MOBILE_ACTION_UNCONFIRMED'); state.pending = state.pending.filter(p => p !== row); save(); changed(); }
    return { state, act, receipt, forget, answerDraft, clearAnswerDraft };
  }
  const words = {
    zh: { home: '工作台', chat: '对话', space: '空间', queue: '队列', confirm: '确认操作', reminders: '提醒', sessions: '会话', members: '成员', connected: '已连接 NAW', synced: '上次同步', refresh: '刷新', manage: '管理', close: '关闭', send: '发送 ↑', message: '输入消息…', draft: '草稿仅在此浏览器保存', idle: '空闲', working: '进行中', needs: '等你', queued: '待派发', done: '已完成', cancelled: '已取消', all: '全部', add: '添加任务', task: '任务', assignee: '指定成员', any: '任意空闲成员', cancelTask: '取消任务', handled: '标为已处理', openSession: '打开会话', review: '查看确认卡', noScope: '本次配对未授权此范围，请在 Mac 重新选择。', noData: '当前没有记录', terminal: '原生终端', interrupt: '中断', takeover: '接管', mac: '此操作目前请回 Mac 完成。不会新建或替换原生会话。', pair: '配对手机', pairLabel: 'Mac 显示的配对口令', pairHelp: '仅显示 Mac 明确授权的会话和空间。', logout: '撤销此手机并退出', locked: '尚未配对或授权已失效', offline: '连接未确认；保留草稿，刷新核对。不会自动重发。', complete: '操作已完成', 'not-sent': '未执行，输入已保留', unconfirmed: '结果未确认，请查原回执，勿重复发送', receipt: '查询原回执', oldPair: '旧配对的回执，请回 Mac 核对', pending: '待你批准', approve: '批准本次', deny: '拒绝', scope: '范围', action: '操作', from: '来源', duration: '有效期', expired: '已过期 · 未执行', verifyMac: '手机敏感批准尚未启用，请在 Mac 验证本人并确认。', verifyDeadline: '由 Mac 核验', back: '回原会话', terminalOnly: '原生终端目前仅在 Mac 可用。', answer: '提交回答', question: '当前原生问题', ack: '知道了', export: '导出', sameBell: '和桌面小铃铛同一份提醒。', bellNote: '数量包含有效待确认和等你处理的提醒；敏感批准仍在 Mac 上完成。', operations: '操作记录', steward: '大管家记录', age: '块记录早于 30 天', size: '记录总量超过提醒线', unreadable: '记录暂时无法读取', unavailable: '记录源当前不可用', source: '同一份 NAW 状态', omit: '较早消息未显示，请回 Mac 查看完整历史或附件。', unchanged: '取消保留任务历史。', skip: '跳到内容', butler: '大管家', butlerNotSelected: '这次手机访问没选它', butlerNotSelectedHelp: '这次是在 Mac 上挑了部分会话给手机，大管家不在其中。要在手机上和它对话，请在 Mac 的手机访问里选上它。', butlerUnavailable: '暂时打不开', butlerUnavailableHelp: '大管家会话现在不能在手机上打开，例如正在交接给新会话。请稍后刷新，或在 Mac 上查看。', butlerNone: 'Mac 上还没有指定', butlerNoneHelp: '在 Mac 上把一个会话指定为大管家后，这里就能打开它、和它对话。', command: '原生命令请回 Mac 输入；草稿已保留。', storage: '此浏览器未能保存输入，发送已暂停。', newSession: '新建会话', newSpace: '新建空间', noNative: '请在 Mac 处理此原生问题。' },
    en: { home: 'Workspace', chat: 'Chat', space: 'Spaces', queue: 'Queue', confirm: 'Confirm action', reminders: 'Reminders', sessions: 'Sessions', members: 'Members', connected: 'Connected to NAW', synced: 'Last synced', refresh: 'Refresh', manage: 'Manage', close: 'Close', send: 'Send ↑', message: 'Write a message…', draft: 'Draft stays in this browser', idle: 'Idle', working: 'Working', needs: 'Needs you', queued: 'Queued', done: 'Done', cancelled: 'Cancelled', all: 'All', add: 'Add task', task: 'Task', assignee: 'Assign to', any: 'Any available member', cancelTask: 'Cancel task', handled: 'Mark handled', openSession: 'Open session', review: 'Review confirmation', noScope: 'This scope was not granted. Select it again on the Mac.', noData: 'No records to show', terminal: 'Native terminal', interrupt: 'Interrupt', takeover: 'Take over', mac: 'Please complete this action on the Mac for now. No native session is created or replaced.', pair: 'Pair this phone', pairLabel: 'Pairing code shown on your Mac', pairHelp: 'Only sessions and spaces explicitly granted on the Mac are shown.', logout: 'Revoke this phone and sign out', locked: 'Not paired or authorization expired', offline: 'Connection unconfirmed. Keep your draft and refresh to check. Nothing is resent automatically.', complete: 'Action completed', 'not-sent': 'Not executed; input retained', unconfirmed: 'Outcome unconfirmed. Query the original receipt; do not resend.', receipt: 'Query original receipt', oldPair: 'Receipt from an old pairing. Check on the Mac.', pending: 'Awaiting your approval', approve: 'Approve once', deny: 'Deny', scope: 'Scope', action: 'Action', from: 'From', duration: 'Expires', expired: 'Expired · Not executed', verifyMac: 'Sensitive approval on this phone is not enabled. Verify yourself and confirm on the Mac.', verifyDeadline: 'Verified by the Mac', back: 'Back to original session', terminalOnly: 'The native terminal is currently available on the Mac.', answer: 'Submit answer', question: 'Current native question', ack: 'Got it', export: 'Export', sameBell: 'The same reminders as the desktop bell.', bellNote: 'The count includes valid confirmations and reminders awaiting you. Sensitive approvals still use the Mac.', operations: 'Operation records', steward: 'Butler records', age: 'record blocks are over 30 days old', size: 'Record total exceeds the reminder line', unreadable: 'Record cannot currently be read', unavailable: 'Record source unavailable', source: 'The same NAW state', omit: 'Earlier messages are omitted. Open the Mac for full history or attachments.', unchanged: 'Cancelling keeps task history.', skip: 'Skip to content', butler: 'Butler', butlerNotSelected: 'Not chosen for this phone', butlerNotSelectedHelp: 'This phone was given a chosen set of sessions on the Mac, and the butler is not one of them. To talk to it here, choose it under Phone access on the Mac.', butlerUnavailable: 'Not available right now', butlerUnavailableHelp: 'The butler session cannot be opened on the phone right now, for example while it hands over to a new session. Refresh later or check on the Mac.', butlerNone: 'None chosen on the Mac', butlerNoneHelp: 'Choose a session as the butler on the Mac, then open it here to talk to it.', command: 'Use the Mac for native commands. Your draft is retained.', storage: 'This browser could not save the input. Sending is paused.', newSession: 'New session', newSpace: 'New space', noNative: 'Please handle this native question on the Mac.' },
  };
  Object.assign(words.zh, { submitted: '会话已收到', 'reply-written': '回答已写入', 'awaiting-native': '还没确认会话是否收到', prepared: '已准备，尚未提交', unknown: '状态未知', ended: '已结束', failed: '失败', removeReceipt: '移除已确认回执', invalidated: '已作废 · 未执行', replaced: '已有新的确认卡' });
  const SEND_BLOCKS = ['steerBusy', 'noQueue', 'queueBusy', 'question', 'answerPending', 'approval', 'interrupt', 'disconnected', 'readOnly', 'storage', 'notReady', 'ended'];
  Object.assign(words.zh, { queueSend: '等本轮结束后发送\u00a0↑', queueMidturn: '工具结束时送进本轮\u00a0↑', queueNote: '使用原生等待队列；保留当前工作，不强制中断。', queueMidturnNote: 'Claude 在本轮下一个工具结束时读到；本轮先结束就作为下一条发送。不中断当前工作。',
    ownPending: '上一条还没确认送到；确认前不能再发。草稿保留。', steer: '追加指令\u00a0↑', steerNote: '发送到当前原生回合；不会另开回合或强制中断。', 'blocked-steerBusy': '上一条输入等待确认，暂不能再次发送。草稿保留。', 'blocked-noQueue': '这个会话的原生连接不支持回复中排队，手机现在发不出去；在 Mac 上可以直接输入。草稿保留。',
    'blocked-queueBusy': '已有一条在排队，送到后才能再发。草稿保留。', 'blocked-question': '它在等原生问题的回答；先打开「当前原生问题」回答，再发消息。草稿保留。', 'blocked-questionMac': '它在等一个手机上不能回答的原生问题；请在 Mac 上回答。草稿保留。', 'blocked-answerPending': '回答已提交，正在等原生确认；确认后才能再发。草稿保留。', 'blocked-approval': '它在等审批，请先在 Mac 上处理。草稿保留。',
    'blocked-interrupt': '正在中断，或在等原生终端输入；请回 Mac 查看。草稿保留。', 'blocked-disconnected': '它和原生会话断开了；请回 Mac 查看。草稿保留。', 'blocked-readOnly': '这次手机访问只给了读取，不能发送。', 'blocked-storage': '这台 Mac 的 NAW 现在保存不了记录，手机发的消息无法登记；请回 Mac 处理。草稿保留。', 'blocked-notReady': '它现在收不了消息（正在启动、停止、出错或等待重新连接）；请回 Mac 查看。草稿保留。', 'blocked-ended': '这个会话已经结束，不能再发送。', queuedToast: '已排队，等待 Claude 接收；收到前不会重发。', ownUnconfirmed: '上一条结果未确认；点「查看这条消息的状态」核对，或回 Mac 查看。勿重复发送，草稿保留。',
    phoneOffline: '手机和 NAW 的连接未确认；联网后点刷新。草稿保留，不会自动重发。', reading: '正在读取此会话，尚不能发送。草稿保留。', messageReceipt: '查看这条消息的状态', messageUnconfirmed: '结果未确认；点「查看这条消息的状态」核对，勿重复发送。' });
  Object.assign(words.en, { queueSend: 'Send after this turn\u00a0↑', queueMidturn: 'Deliver at next tool step\u00a0↑', queueNote: 'Uses the native waiting queue. Current work continues without forced interruption.', queueMidturnNote: "Claude reads it when its next tool step in this turn finishes; if the turn ends first, it is sent as the next message. Current work is not interrupted.",
    ownPending: 'Your last message is not confirmed yet; you can send again once it is. Your draft is kept.', steer: 'Add instructions\u00a0↑', steerNote: 'Sends into the current native turn, without starting another turn or forcing interruption.', 'blocked-steerBusy': 'The previous input is awaiting confirmation. This input cannot send yet; your draft is kept.', 'blocked-noQueue': 'This native connection cannot queue a message during a reply, so the phone cannot send now; you can type on the Mac. Your draft is kept.',
    'blocked-queueBusy': 'A message is already queued; send again once it is delivered. Your draft is kept.', 'blocked-question': 'It is waiting for an answer to a native question; open Current native question and answer it first. Your draft is kept.', 'blocked-questionMac': 'It is waiting for a native question the phone cannot answer; answer it on the Mac. Your draft is kept.', 'blocked-answerPending': 'An answer was submitted and awaits native confirmation; you can send once it is confirmed. Your draft is kept.', 'blocked-approval': 'It is waiting for an approval; handle it on the Mac first. Your draft is kept.',
    'blocked-interrupt': 'It is interrupting or waiting for native terminal input; check on the Mac. Your draft is kept.', 'blocked-disconnected': 'It lost its native connection; check on the Mac. Your draft is kept.', 'blocked-readOnly': 'This phone was given read access only.', 'blocked-storage': 'NAW on this Mac cannot save records now, so a phone message cannot be recorded; handle it on the Mac. Your draft is kept.', 'blocked-notReady': 'It cannot take messages now (starting, stopping, in error or waiting to reconnect); check on the Mac. Your draft is kept.', 'blocked-ended': 'This session has ended; it cannot take messages.', queuedToast: 'Queued, waiting for Claude to receive it; nothing is resent before then.', ownUnconfirmed: 'The outcome of your last message is unconfirmed. Check this message\'s status or look on the Mac. Do not resend; your draft is kept.',
    phoneOffline: 'The phone\'s connection to NAW is unconfirmed. Refresh once online. Your draft is kept; nothing is resent automatically.', reading: 'Reading this session; you cannot send yet. Your draft is kept.', messageReceipt: 'Check this message\'s status', messageUnconfirmed: 'Outcome unconfirmed. Check this message\'s status; do not resend.' });
  Object.assign(words.en, { submitted: 'The session received it', 'reply-written': 'Answer written', 'awaiting-native': 'Not yet confirmed that the session received it', prepared: 'Prepared, not submitted', unknown: 'Unknown', ended: 'Ended', failed: 'Failed', removeReceipt: 'Remove confirmed receipt', invalidated: 'No longer valid · Not executed', replaced: 'Replaced by a new confirmation' });
  Object.assign(words.zh, { sendReceipt: '发送消息', answerReceipt: '回答原生问题', inspectInput: '查看原输入' });
  Object.assign(words.en, { sendReceipt: 'Send message', answerReceipt: 'Answer native question', inspectInput: 'View original input' });
  Object.assign(words.zh, { queueAnswer: '你的答复 · 给', answerAndHandle: '答复并标为已处理', handleOnly: '仅标为已处理（不附答复）',
    answerHelp: '确认原会话收到后才标为已处理；不会自动重发。', answerWaiting: '答复未确认，保留“等你”；不会自动重发。', answerCheck: '查看这条答复的状态', answerReceived: '答复已收到，等待处理回执。',
    answerBusy: '原会话正在运行；此处不会插入或打断。请稍后重试。', answerUnavailable: '原会话身份或发送权限未确认，请打开原会话核对。', handledDone: '已处理' });
  Object.assign(words.en, { queueAnswer: 'Your answer · To', answerAndHandle: 'Reply and mark handled', handleOnly: 'Mark handled without an answer',
    answerHelp: 'Marked handled only after the original session receives it. Nothing is resent automatically.', answerWaiting: 'Answer unconfirmed; still waiting for you. Nothing is resent automatically.', answerCheck: 'Check this answer’s status', answerReceived: 'Answer received; awaiting the handling receipt.',
    answerBusy: 'The original session is running. This action will not insert or interrupt; try again later.', answerUnavailable: 'The original session identity or send permission is unconfirmed. Check the original session.', handledDone: 'Handled' });
  Object.assign(words.zh, { registerKey: '登记敏感确认凭证', registrationCode: 'Mac 显示的六位登记码', registerHelp: '先在 Mac 发起登记；完成后核对两边公钥指纹，再在 Mac 确认和启用。', registrationReady: '请在 Mac 核对指纹并确认；手机批准仍未启用。', verifyPhone: '每张卡片都需系统验证本人；配对本身不能批准。', verifyFailed: '未完成或结果未确认；请查询回执或回 Mac 核对，不会重发。' });
  Object.assign(words.en, { registerKey: 'Register an approval passkey', registrationCode: 'Six-digit code shown on the Mac', registerHelp: 'Start registration on the Mac. Then compare public-key fingerprints and confirm and enable it on the Mac.', registrationReady: 'Compare the fingerprint and confirm on the Mac. Phone approvals remain disabled.', verifyPhone: 'Each card requires system user verification. Pairing alone cannot approve.', verifyFailed: 'Not completed or outcome unconfirmed. Check the receipt or Mac; nothing is resent.' });
  Object.assign(words.zh, { receiptTitle: '回执', receiptSend: '发给', receiptAnswer: '回答', receiptTime: '发起', receiptTimeUnknown: '时间未记录', receiptMissing: '原任务内容未保存，请回 Mac 核对', receiptHidden: '关联内容已不在本次授权范围内，请回 Mac 核对', receiptFull: '查看完整原输入', receiptExcerpt: '查看已保存片段', receiptHelp: '移除回执不会撤回消息或任务。', removeReceipt: '移除此条回执', unsentDraft: '未发送的草稿', taskAdded: '任务已添加', taskCancelled: '任务已取消', taskHandled: '任务已标为处理', reminderAcknowledged: '提醒已确认', receiptOperations: '操作记录', receiptSteward: '大管家记录', answerPending: '回答已写入；原生处理仍待确认', messageNotSent: '未发送，草稿保留' });
  Object.assign(words.en, { receiptTitle: 'Receipts', receiptSend: 'To', receiptAnswer: 'Answer to', receiptTime: 'started', receiptTimeUnknown: 'Time not saved', receiptMissing: 'Original task was not saved; check on the Mac', receiptHidden: 'Associated content is outside this grant; check on the Mac', receiptFull: 'View full original input', receiptExcerpt: 'View saved excerpt', receiptHelp: 'Removing a receipt keeps the message or task.', removeReceipt: 'Remove receipt', unsentDraft: 'Unsent draft', taskAdded: 'Task added', taskCancelled: 'Task cancelled', taskHandled: 'Task marked handled', reminderAcknowledged: 'Reminder acknowledged', receiptOperations: 'Operations record', receiptSteward: 'Butler record', answerPending: 'Answer written; native processing is still unconfirmed', messageNotSent: 'Not sent; draft kept' });
  // The desktop's own batch and timer words (ui-messages.js background.batch.* / background.timer.*).
  Object.assign(words.zh, { batchTitle: '{action} · {count} 项', confirmFirst: '逐项确认（1/{count}）', confirmNext: '确认下一项（{index}/{count}）',
    timerCountdown: '等你确认 · 剩余 {time}', timerCountdownName: '等你确认，剩余 {minutes} 分 {seconds} 秒，跳到这条消息', timerCountdownSecondsName: '等你确认，剩余 {seconds} 秒，跳到这条消息',
    timerMore: '+{count}', timerMoreName: '还有 {count} 个计时' });
  Object.assign(words.en, { batchTitle: '{action} · {count} items', confirmFirst: 'Confirm one by one (1/{count})', confirmNext: 'Confirm next ({index}/{count})',
    timerCountdown: 'Waiting for confirmation · {time} left', timerCountdownName: 'Waiting for confirmation, {minutes} min {seconds} s left. Jump to this message', timerCountdownSecondsName: 'Waiting for confirmation, {seconds} s left. Jump to this message',
    timerMore: '+{count}', timerMoreName: 'Other timers: {count}' });
  function mount() {
    const d = global.document, el = id => d.getElementById(id);
    let pairSecret=global.location.hash.startsWith('#pair=')?global.location.hash.slice(6):undefined;
    if (pairSecret !== undefined) global.history.replaceState(null, '', global.location.pathname + '#zh/home');
    let lang = global.location.hash.startsWith('#en/') ? 'en' : 'zh', view = null, locked = true, disconnected = false, busy = false, epoch = 0, route, client, lastReceived = 0, expiryTimer, composeKey = '', authorization = 0;
    const storage = { getItem: k => global.localStorage.getItem(k), setItem: (k, v) => global.localStorage.setItem(k, v) };
    let answeredQuestion = null, currentToast = null;
    const t = key => words[lang][key] || key;
    const f = (key, values) => t(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
    words.zh.loadingBody = '正在读取对话内容…'; words.en.loadingBody = 'Loading this conversation…';
    const node = (tag, value, cls) => { const n = d.createElement(tag); if (value !== undefined) n.textContent = value; if (cls) n.className = cls; return n; };
    const paths = { home: 'm3 10 9-7 9 7v10H3Z M9 20v-7h6v7', space: 'M3 4h8v7H3z M13 4h8v7h-8z M3 13h8v7H3z M13 13h8v7h-8z', queue: 'M4 4h16v16H4Z M8 8h8 M8 12h8 M8 16h5', bell: 'M6 9a6 6 0 0 1 12 0c0 7 3 7 3 8H3c0-1 3-1 3-8Z M10 21h4', back: 'm14 5-7 7 7 7', menu: 'M5 12h.01 M12 12h.01 M19 12h.01' };
    function icon(name) { const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg'), p = d.createElementNS(svg.namespaceURI, 'path'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); p.setAttribute('d', paths[name] || paths.menu); svg.append(p); return svg; }
    function button(label, fn, cls) { const b = node('button', label, cls); b.type = 'button'; if (fn) b.addEventListener('click', () => run(fn)); return b; }
    function link(label, dest, cls) { const a = node('a', label, cls); a.href = '#' + lang + '/' + dest; return a; }
    function dismissToast() {
      const restore = el('toast').contains(d.activeElement), previous = currentToast?.focus;
      currentToast = null;
      el('toast').hidden = true;
      if (restore) (previous?.isConnected ? previous : el('content')).focus();
    }
    function toast(key) {
      currentToast = { key, focus: d.activeElement };
      const close = node('button', '×', 'toast-close');
      close.type = 'button'; close.setAttribute('aria-label', lang === 'zh' ? '关闭提示' : 'Dismiss notification');
      close.addEventListener('click', dismissToast);
      el('toast').replaceChildren(node('span', t(key), 'toast-message'), close);
      el('toast').hidden = false;
    }
    function dialog(title, content) { el('dialog-title').textContent = title; el('dialog-body').replaceChildren(typeof content === 'string' ? node('p', content) : content); el('dialog-close').textContent = t('close'); if (!el('dialog').open) el('dialog').showModal(); }
    el('dialog-close').addEventListener('click', () => el('dialog').close());
    el('skip').addEventListener('click', event => { event.preventDefault(); el('content').focus(); });
    // Action readiness must not depend on a route read finishing.
    let started;
    async function run(fn) {
      try { await started; await fn(); }
      catch (error) {
        if (error?.code === 'MOBILE_PAIR_LIMIT') { toast('pairLimit'); return; }
        disconnected = true; paint(); toast('offline');
      }
    }
    async function api(url, value, csrf) {
      const generation = client?.state.authorization;
      const read = value === undefined ? new global.AbortController() : null;
      if (read) readingRequests.add(read);
      const timer = read ? global.setTimeout(() => read.abort(), 8000) : null;
      try {
        const response = await global.fetch(url, { method: value === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
          headers: { 'X-NAW-Mobile': '1', ...(value === undefined ? {} : { 'Content-Type': 'application/json', 'X-NAW-CSRF': csrf || '' }) }, ...(read ? { signal: read.signal } : { body: JSON.stringify(value) }) });
        const result = await response.json();
        if (generation !== client?.state.authorization) throw Error('MOBILE_AUTH_CHANGED');
        if (!response.ok) { if ([401, 403].includes(response.status)) { authorizationRejected = true; client.invalidate(); locked = true; view = null; paint(); } const code = result.error || 'MOBILE_DENIED'; throw Object.assign(Error(code), { code }); }
        disconnected = false;
        if (url === '/mobile/session') { locked = false; authorizationRejected = false; }
        return result;
      } finally { if (read) { readingRequests.delete(read); global.clearTimeout(timer); } }
    }
    words.zh.pairLimit = global.NAWMobile.PAIR_LIMIT.zh;
    words.en.pairLimit = global.NAWMobile.PAIR_LIMIT.en;
    const actions = createWorkspaceActions({ storage, request: api, newId: () => global.crypto.randomUUID(), changed: () => updateCompose() });
    const passkeys = global.NAWMobilePasskeys.create({ storage, request: api });
    Object.assign(words.zh,{finishPair:'完成手机配对',qrEnrollment:'这次二维码授权登记一把批准密钥。尚未激活，不能读取或执行操作。',verifyPair:'使用系统验证完成配对',finishVerified:'完成配对',verifyPairNote:'系统可能提示创建凭据及再次验证。每张敏感卡仍须单独验证。',basicPair:'先使用基础权限',basicPairNote:'敏感批准保持关闭。新手机完成后，旧手机才断开。',cancelPair:'取消本次配对',pairUnconfirmed:'验证取消或结果未确认。请刷新核对；可回 Mac 重新出码，或明确选择基础权限。不会自动启用敏感批准。'});
    Object.assign(words.en,{finishPair:'Complete phone pairing',qrEnrollment:'This QR code authorizes one approval key. Nothing can be read or executed until activation.',verifyPair:'Complete pairing with system verification',finishVerified:'Complete pairing',verifyPairNote:'The system may ask you to create a credential and verify again. Each sensitive card still requires its own verification.',basicPair:'Use basic access first',basicPairNote:'Sensitive approvals stay off. The old phone disconnects only after this phone completes pairing.',cancelPair:'Cancel this pairing',pairUnconfirmed:'Verification cancelled or unconfirmed. Refresh to check, get a new code on the Mac, or explicitly choose basic access. Sensitive approval is never enabled automatically.'});
    let pairingNotice=false,pairingBusy=false, recovery=null, authorizationRejected=false;
    const readingRequests = new Set();
    words.zh.autoReconnect='连接中断 · 正在自动重连。草稿保留，不会重发。';
    words.en.autoReconnect='Connection lost · Reconnecting automatically. Draft kept; nothing resent.';
    words.zh.offline = words.zh.phoneOffline = words.zh.autoReconnect;
    words.en.offline = words.en.phoneOffline = words.en.autoReconnect;
    // A pairing past its end cannot come back by reconnecting; a long outage points to the reason the Mac shows.
    words.zh.pairExpired='配对已到期。请在电脑上打开 设置 → 手机访问，点“连接手机”重新扫码。';
    words.en.pairExpired='The pairing has expired. On the Mac, open Settings → Phone access and select “Connect phone” to scan again.';
    words.zh.longOffline='还连不上电脑上的 NAW。电脑刚重启时，Tailscale 就绪后会自动接回；几分钟后还不行，请看电脑 设置 → 手机访问 里写的原因。草稿保留。';
    words.en.longOffline='Still cannot reach NAW on the Mac. After a restart it reconnects once Tailscale is ready; if not within a few minutes, see the reason under Settings → Phone access on the Mac. Draft kept.';
    let offlineSince = 0;
    const offlineWord = () => {
      const until = client?.state.session?.expiresAt;
      if (Number.isSafeInteger(until) && until <= Date.now()) return 'pairExpired';
      return offlineSince && Date.now() - offlineSince >= 180000 ? 'longOffline' : 'autoReconnect';
    };
    Object.assign(words.zh, { healthUnknown: '告警状态未核实', wakeStalled: '大管家未能叫醒', tokenAnomaly: '用量状态异常', sourceDisconnected: '本机服务已断开' });
    Object.assign(words.en, { healthUnknown: 'Alert status unverified', wakeStalled: 'Butler could not be awakened', tokenAnomaly: 'Usage status needs attention', sourceDisconnected: 'Local service disconnected' });
    words.zh.bellNote='数量来自桌面同一份提醒。敏感卡需逐张系统验证；未启用或不支持的操作请回 Mac。';
    words.en.bellNote='The count uses the same desktop reminders. Sensitive cards require individual system verification; use the Mac when not enabled or supported.';
    client = global.NAWMobile.createMobileClient({ request: api, storage, newId: () => global.crypto.randomUUID(), onChange: state => {
      if (authorization !== state.authorization) {
        authorization = state.authorization; view = null; busy = false; lastReceived = 0; composeKey = '';
        if (el('dialog').open) el('dialog').close();
        locked = !state.session; paint();
      } else updateCompose();
    } });
    const push = global.NAWMobilePush?.create({ request: api, session: () => client.state.session });
    Object.assign(words.zh, { pushTitle: '手机通知', pushEnable: '开启提醒', pushDisable: '关闭提醒', pushNote: '只发送提醒数量和几种固定告警（如本机服务断开、有事等你决定），不含名字或正文。通知可能延迟；打开后以当前记录为准。', pushHome: 'iPhone 请先从 Safari 添加到主屏幕，再从主屏幕打开。需要 iOS 16.4 或更新版本。', pushUnsupported: '当前浏览器未提供推送能力。iPhone 请添加到主屏幕后打开。', pushOff: '尚未开启', pushSubscribed: '已登记，尚未提交提醒', pushAccepted: '已交给推送服务，未确认手机送达', pushDelayed: '提交未确认，通知可能延迟；请刷新查看当前提醒', pushExpired: '订阅已失效，请重新开启', pushDenied: '通知权限未允许，请在系统设置中核对', pushUnknown: '设置结果未确认，请刷新核对；需要时在 Mac 撤销此手机' });
    Object.assign(words.en, { pushTitle: 'Phone notifications', pushEnable: 'Enable reminders', pushDisable: 'Disable reminders', pushNote: 'Only the reminder count and a few fixed alerts are sent (such as local service disconnected or a decision waiting for you), without names or content. Notifications may be delayed; open NAW for current records.', pushHome: 'On iPhone, add this page to the Home Screen in Safari, then open it there. Requires iOS 16.4 or later.', pushUnsupported: 'Push is unavailable in this browser. On iPhone, add NAW to the Home Screen and open it there.', pushOff: 'Not enabled', pushSubscribed: 'Registered; no reminder submitted yet', pushAccepted: 'Accepted by the push service; phone delivery unconfirmed', pushDelayed: 'Submission unconfirmed; notifications may be delayed. Refresh for current reminders.', pushExpired: 'Subscription expired; enable again', pushDenied: 'Notification permission was not granted. Check system settings.', pushUnknown: 'Setting unconfirmed. Refresh to check, or revoke this phone on the Mac.' });
    function avatar(s) { return node('span', (s.provider || 'N').slice(0, 1).toUpperCase(), 'avatar ' + (['claude', 'codex', 'deepseek'].includes(s.provider) ? s.provider : '')); }
    const providerName = name => ({ claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', dsh: 'DSH' })[name] || name || 'NAW';
    const stateText = s => t(({ idle: 'idle', working: 'working', starting: 'working', approval: 'needs', queued: 'queued', sent: 'working', waiting: 'needs', done: 'done', cancelled: 'cancelled' })[s] || s || 'idle');
    Object.assign(words.zh, { speechNames: '只看谁的对话', speechList: '对话内容', speechYou: '你', speechTo: '发给', speechDispatch: 'NAW 派活', speechUnknown: '未知会话', speechUnverified: '（未核实）', speechEmpty: '这个空间里还没有人说过话。', speechEmptyMember: '{name} 在这里还没有说过话，也没有收到消息。', speechExpand: '展开全文', speechCollapse: '收起' });
    Object.assign(words.en, { speechNames: 'Show messages of', speechList: 'Conversation messages', speechYou: 'You', speechTo: 'to', speechDispatch: 'NAW queue', speechUnknown: 'Unknown session', speechUnverified: ' (unverified)', speechEmpty: 'No one has said anything in this space yet.', speechEmptyMember: '{name} has not said or received anything here yet.', speechExpand: 'Show all', speechCollapse: 'Show less' });
    Object.assign(words.zh, { latestPosition: '最新消息', earlierPosition: '较早消息 · 最新在下方', messageQueued: '已排队，等待会话读取；请勿重复发送。', oldReceiptGroup: '上次配对的记录', oldReceiptHelp: '仅保存在此浏览器，不是新消息，不会重发。已收起且未删除；未确认的结果需回 Mac 核对。' });
    Object.assign(words.en, { latestPosition: 'Latest messages', earlierPosition: 'Earlier messages · latest below', messageQueued: 'Queued, waiting for the session to read it. Do not resend.', oldReceiptGroup: 'Previous pairing records', oldReceiptHelp: 'Stored only in this browser, not new messages; they will not be resent. Collapsed, not deleted. Check unresolved results on the Mac.' });
    function receipts(container, scope = {}) {
      const native = (client.state.pending || []).map(p => ({ ...p, native: true }));
      const rows = [...native, ...actions.state.pending].filter(row => {
        if (row.native) return scope.sessionId === row.sessionId && view?.sessions.some(s => s.id === row.sessionId);
        if (row.action === 'recordAcknowledge') return scope.records === true;
        const room = view?.rooms.find(r => r.id === row.roomId), task = room?.queue.find(i => i.id === row.itemId);
        return room && scope.roomId === row.roomId && (task || row.action === 'queueAdd' && !row.itemId && row.status !== 'complete');
      });
      if (!rows.length) return;
      const oldRows = rows.filter(row => row.deviceId !== client.state.session?.deviceId);
      const currentRows = rows.filter(row => !oldRows.includes(row));
      const list = node('ol', undefined, 'receipt-list');
      let oldList;
      if (oldRows.length) {
        const group = node('details', undefined, 'old-receipts');
        group.append(node('summary', t('oldReceiptGroup') + ' · ' + oldRows.length), node('p', t('oldReceiptHelp'), 'quiet'));
        oldList = node('ol', undefined, 'receipt-list'); group.append(oldList); container.append(group);
      } list.setAttribute('role', 'list');
      if (currentRows.length) container.append(node('h2', t('receiptTitle') + ' · ' + currentRows.length, 'receipt-heading'), list);
      for (const row of rows) {
        const visible = receiptVisible(row, client.state.session, view), context = visible ? row.context : null;
        const item = node('li', undefined, 'receipt context-receipt'), top = node('div', undefined, 'receipt-top');
        item.dataset.requestId = row.requestId;
        const target = context?.target || (visible && row.native ? client.state.session.sessions.find(s => s.id === row.sessionId)?.name || row.sessionId : '');
        const action = row.native ? t(row.action === 'answer' ? 'receiptAnswer' : 'receiptSend') : t(({ queueAdd: 'add', queueCancel: 'cancelTask', queueResolve: 'handled', recordAcknowledge: 'ack' })[row.action]);
        const task = !row.native && view.rooms.find(r => r.id === row.roomId)?.queue.find(i => i.id === row.itemId);
        const title = row.native ? action + (target ? ' · ' + target : '') : task ? (target ? target + ' · ' : '') + task.text + ' · ' + action : action + (target ? ' · ' + target : '');
        top.append(node('strong', visible ? title : t(row.deviceId !== client.state.session?.deviceId ? 'oldPair' : 'receiptHidden')));
        let time = t('receiptTimeUnknown');
        const atValue = context?.at ?? row.createdAt;
        if (visible && Number.isSafeInteger(atValue) && atValue >= 0 && atValue <= 8640000000000000) {
          const at = new Date(atValue), today = at.toDateString() === new Date().toDateString();
          time = (today ? at.toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }) : at.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en')) + ' ' + t('receiptTime');
          const stamp = node('time', time); stamp.dateTime = at.toISOString(); top.append(stamp);
        } else if (visible) top.append(node('span', time, 'quiet'));
        item.append(top);
        const original = visible ? row.native ? row.action === 'send' ? row.text : [row.question, row.answer].filter(v => typeof v === 'string' && v).join('\n') || context?.text || t('receiptMissing') : row.text || context?.text || t('receiptMissing') : '';
        const description = node('p', Array.from(original).slice(0, 85).join('') + (Array.from(original).length > 85 ? '…' : ''), 'receipt-original receipt-input');
        description.id = 'receipt-' + row.requestId;
        if (visible) item.append(description);
        if (Array.from(original).length > 85) {
          const full = node('details', undefined, 'receipt-full'); full.append(node('summary', t(context?.clipped ? 'receiptExcerpt' : 'receiptFull')), node('p', original)); item.append(full);
        }
        const bottom = node('div', undefined, 'receipt-bottom receipt-actions'), settled = ['complete', 'submitted', 'reply-written', 'not-sent'].includes(row.status);
        const outcome = row.native && row.queued === true && row.status === 'awaiting-native' ? 'messageQueued' : row.native ? ({ unconfirmed: 'messageUnconfirmed', 'reply-written': 'answerPending', 'not-sent': 'messageNotSent' })[row.status] || row.status
          : row.status === 'complete' ? ({ queueAdd: 'taskAdded', queueCancel: 'taskCancelled', queueResolve: 'taskHandled', recordAcknowledge: 'reminderAcknowledged' })[row.action] : row.status;
        if (visible) bottom.append(node('span', t(outcome), 'receipt-state receipt-status' + (settled ? '' : ' uncertain')));
        if (visible && original) bottom.append(button(t('inspectInput'), () => dialog(t('inspectInput'), original), 'receipt-inspect'));
        if (visible && !settled) {
          const query = button(t(row.native ? 'messageReceipt' : 'receipt'), async () => { if (row.native) await client.receipt(row.requestId); else await actions.receipt(client.state.session, row); await refresh(); }, 'receipt-control');
          query.setAttribute('aria-describedby', description.id); bottom.append(query);
        }
        if (visible && settled) {
          const remove = button(t('removeReceipt'), () => { if (row.native) client.forget(row.requestId); else actions.forget(row); paint(); }, 'receipt-control');
          remove.setAttribute('aria-label', [t('removeReceipt'), target, Array.from(original).slice(0, 85).join(''), visible ? time : '', row.requestId].filter(Boolean).join(' · ')); bottom.append(remove);
        }
        if (visible && rows.some(other => other !== row && other.deviceId === row.deviceId && other.context?.target === row.context?.target && (other.text || other.context?.text) === (row.text || row.context?.text) && Math.floor(other.context?.at / 60000) === Math.floor(row.context?.at / 60000))) {
          const suffix = row.requestId.slice(-8), short = rows.some(other => other !== row && other.requestId.endsWith(suffix)) ? row.requestId : '…' + suffix;
          item.append(node('p', short, 'quiet'));
        }
        item.append(bottom); (oldRows.includes(row) ? oldList : list).append(item);
      }
      container.append(node('p', t('receiptHelp'), 'receipt-help'));
    }
    function login() {
      const form = node('form', undefined, 'auth-form'); form.method = 'post'; form.action = '/mobile/pair';
      form.append(node('h1', t('locked')), node('p', t('pairHelp'), 'quiet'));
      const label = node('label', t('pairLabel')), input = node('input'); input.id = 'pair-code'; input.name = 'secret'; input.type = 'password'; input.required = true; input.minLength = input.maxLength = 43; input.autocomplete = 'one-time-code'; input.autocapitalize = 'none'; input.spellcheck = false; label.htmlFor = input.id;
      const submit = node('button', t('pair'), 'primary'); submit.type = 'submit';
      form.append(label, input, submit); form.addEventListener('submit', event => { event.preventDefault(); run(async () => { await client.start(input.value); if (client.state.session && !locked) { input.value = ''; await navigate(); } else toast('locked'); }); }); el('content').append(form);
    }
    function candidate() {
      const session=client.state.session,box=node('section',undefined,'auth-form');
      box.append(node('h1',t('finishPair')),node('p',t('qrEnrollment')));
      const runPair=async mode=>{
        if(pairingBusy)return;pairingBusy=true;pairingNotice=false;paint();
        try {
          if(mode==='verified' && !client.state.session.consent?.verified)await passkeys.registerCandidate(client.state.session);
          await api('/mobile/pair/activate',{mode},session.csrf);await client.start();await refresh();
        }catch{pairingNotice=true;}
        finally{pairingBusy=false;paint();recovery?.wake();}
      };
      const verify=button(t(session.consent?.verified?'finishVerified':'verifyPair'),()=>runPair('verified'),'primary');verify.id='complete-phone-pairing';verify.disabled=pairingBusy;
      const basic=button(t('basicPair'),()=>runPair('basic'));basic.id='basic-phone-pairing';basic.disabled=pairingBusy;
      const cancel=button(t('cancelPair'),async()=>{if(pairingBusy)return;await client.logout();locked=true;view=null;paint();});cancel.id='cancel-phone-pairing';cancel.disabled=pairingBusy;
      box.append(verify,node('p',t('verifyPairNote'),'quiet'),basic,node('p',t('basicPairNote'),'quiet'),cancel);
      if(pairingNotice)box.append(node('p',t('pairUnconfirmed'),'callout'));el('content').append(box);
    }
    function heading(key) { el('content').append(node('h1', t(key))); }
    function section(title, count) { const section = node('section', undefined, 'section'), h = node('div', undefined, 'section-title'), label = node('h2', title); if (count !== undefined) label.append(node('span', ' ' + count, 'quiet')); h.append(label); section.append(h); el('content').append(section); return section; }
    function roomList(container) {
      const box = node('div', undefined, 'box');
      for (const r of view.rooms) {
        const a = link('', 'space/' + encodeURIComponent(r.id), 'space-card'), h = node('div', undefined, 'space-card-top');
        h.append(node('strong', r.name), node('span', '›', 'chev'));
        const meta = node('div', undefined, 'space-meta'), avatars = node('span', undefined, 'avatars');
        avatars.setAttribute('aria-hidden', 'true');
        for (const s of r.members.slice(0, 3)) avatars.append(node('span', (s.provider || 'N').slice(0, 1).toUpperCase()));
        meta.append(avatars, node('span', [...new Set(r.members.map(s => providerName(s.provider)))].join(' / ') + (r.members.length ? ' · ' : '') + r.members.length + ' ' + t('members')));
        a.append(h, meta); box.append(a);
      }
      if (!view.rooms.length) box.append(node('p', t('noScope'), 'quiet')); container.append(box);
    }
    const stateTag = s => node('span', stateText(s.question ? 'approval' : s.state), 'tag ' + (s.state === 'working' && !s.question ? 'work' : 'neutral'));
    const butlerSession = () => view?.steward?.state === 'shared' ? view.sessions.find(s => s.id === view.steward.sessionId) : undefined;
    // The Mac's designated butler, as the projection names it. A view without the field (no workspace grant) shows no card.
    function butlerEntry() {
      if (!view.steward) return;
      const s = butlerSession(), body = node('div', undefined, 'row-main');
      body.append(node('strong', t('butler')));
      if (s) {
        const entry = link('', 'chat/' + encodeURIComponent(s.id), 'box row butler-entry');
        body.append(node('p', s.name));
        entry.append(avatar(s), body, stateTag(s));
        el('content').append(entry);
        return;
      }
      const reason = { notSelected: 'butlerNotSelected', none: 'butlerNone' }[view.steward.state] || 'butlerUnavailable';
      const entry = button('', () => dialog(t('butler'), t(reason + 'Help')), 'box row butler-entry');
      body.append(node('p', t(reason)));
      entry.append(avatar({}), body, node('span', '›', 'chev'));
      el('content').append(entry);
    }
    function home() {
      heading('home'); butlerEntry();
      const butler = butlerSession(), others = view.sessions.filter(s => s !== butler);
      const sessions = section(t('sessions'), others.length, 'newSession'), box = node('div', undefined, 'box');
      for (const s of others) { const a = link('', 'chat/' + encodeURIComponent(s.id), 'row'), main = node('div', undefined, 'row-main'); main.append(node('strong', s.name), node('p', providerName(s.provider))); a.append(avatar(s), main, stateTag(s)); box.append(a); }
      if (!others.length) box.append(node('p', t('noData'))); sessions.append(box); roomList(section(t('space'), view.rooms.length, 'newSpace'));
    }
    // owner: the session whose chat this is; its replies carry no name of their own.
    function thread(rows, container, owner) {
      for (const m of rows || []) {
        const card = m.kind === 'background-operation' ? view.confirmations.find(c => c.id === m.confirmationId) : null, members = card && batchOf(card);
        // A merged batch is one card, drawn on its newest member as on the desktop.
        if (members && members.at(-1) !== card) continue;
        // A user row with a name was written by NAW or another agent (NAW 派活, a space), as the Mac labels it.
        const human = m.role === 'human' || m.role === 'user' && !m.name, article = node('article', undefined, 'message' + (human ? ' human' : '')), body = node('div', undefined, 'message-body'), author = node('div', undefined, 'author');
        const s = (m.role === 'assistant' && owner) || view.sessions.find(s => s.name === m.name) || (m.role === 'assistant' ? { provider: 'codex' } : {});
        author.append(node('span', human ? (lang === 'zh' ? '你' : 'You') : m.name || s.name || 'NAW'));
        const at = typeof m.time === 'number' || typeof m.time === 'string' ? new Date(m.time) : null;
        if (at && Number.isFinite(at.getTime())) { const time = node('time', at.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })); time.dateTime = at.toISOString(); author.append(time); }
        else author.append(node('span', t('receiptTimeUnknown'), 'message-time-unknown'));
        const bubble = node('div', m.text || '', 'bubble');
        if (card) { article.dataset.confirmationId = card.id; bubble.replaceChildren(node('strong', members ? batchTitle(members) : card.title), link(t('review') + ' ›', members ? batchPath(members) : 'confirm/' + encodeURIComponent(card.id), 'text-link')); }
        if (m.attachments || m.textOmitted) bubble.append(node('p', t('omit'), 'small-note'));
        body.append(author, bubble); if (!human) article.append(avatar(s)); article.append(body); container.append(article);
      }
      if (!rows?.length) container.append(node('p', t('noData'), 'quiet'));
    }
    function tabs(items, container = el('content')) { const bar = node('div', undefined, 'tabs'); for (const [label, dest, active] of items) bar.append(link(label, dest, active ? 'selected' : '')); container.append(bar); }
    function latestMessage() { return el('content').querySelector('.thread > .message:last-child'); }
    function readingLatest() {
      const latest = latestMessage();
      return latest && Math.abs(latest.getBoundingClientRect().bottom - el('compose').getBoundingClientRect().top) < 80;
    }
    function scrollToLatest() {
      const latest = latestMessage();
      if (!latest) return;
      // Receipts follow the thread; the page bottom is not the newest message.
      global.scrollTo?.(0, global.scrollY + latest.getBoundingClientRect().bottom - el('compose').getBoundingClientRect().top + 16);
    }
    function chat() {
      const s = view.sessions.find(s => s.id === route.id); if (!s) { heading('chat'); el('content').append(node('p', t('noScope'))); return; }
      tabs([[t('chat'), 'chat/' + encodeURIComponent(s.id), true]]); const terminal = button(t('terminal'), () => dialog(t('terminal'), t('terminalOnly'))); el('content').querySelector('.tabs').append(terminal);
      // Both only say "use the Mac"; the phone holds read/send for the butler, so its page leaves them out.
      if (butlerSession()?.id !== s.id) {
        const controls = node('div', undefined, 'control-strip');
        controls.append(
          button(t('interrupt'), () => dialog(t('interrupt'), t('mac')), 'danger'),
          button(t('takeover'), () => dialog(t('takeover'), t('mac'))),
        ); el('content').append(controls);
      }
      const rows = node('div', undefined, 'thread'); thread(s.messages, rows, s); el('content').append(rows);
      if (s.earlierMessagesOmitted) el('content').append(node('p', t('omit'), 'small-note'));
      if (client.state.row?.question && client.state.selected === s.id) el('content').append(link(t('question') + ' ›', 'confirm/native/' + encodeURIComponent(s.id), 'link-row'));
      receipts(el('content'), { sessionId: s.id });
    }
    function space() {
      if (!route.id) { heading('space'); roomList(el('content')); return; }
      const r = view.rooms.find(r => r.id === route.id); if (!r) { heading('space'); el('content').append(node('p', t('noScope'))); return; }
      tabs([[t('chat'), 'space/' + r.id, true], [t('queue') + ' ' + r.queue.length, 'queue/' + r.id, false]]);
      const members = node('div', r.members.map(s => s.name).join(' / '), 'callout'); members.id = 'room-members'; el('content').append(members);
      const rows = node('div', undefined, 'thread');
      el('content').append(rows);
      if (Array.isArray(r.speech)) speech(r, rows); else thread(r.messages, rows);
      el('content').append(button('+ ' + t('add'), () => addTask(r), 'primary'));
      receipts(el('content'), { roomId: r.id });
    }
    // The Mac's 「对话」: only what was said, by everyone or by one participant (an older Mac sends the space record).
    const speechChosen = new Map(), speechOpen = new Set();
    function speech(r, rows) {
      const chosen = speechChosen.get(r.id) || '', people = [], seen = new Set(), butler = view.steward?.sessionId;
      const add = (id, name) => { if (id && !seen.has(id)) { seen.add(id); people.push({ id, name }); } };
      if (butler && r.speech.some(i => i.fromId === butler || i.to.some(x => x.id === butler))) add(butler, t('butler'));
      for (const s of r.members) add(s.id, s.name);
      for (const i of r.speech) { if (i.fromKind === 'agent' && !i.unverified) add(i.fromId, i.fromName); for (const x of i.to) add(x.id, x.name); }
      const names = node('div', undefined, 'tabs speech-names'); names.setAttribute('role', 'toolbar'); names.setAttribute('aria-label', t('speechNames'));
      for (const p of [{ id: '', name: t('all') }, ...people]) {
        const b = button(p.name, () => { speechChosen.set(r.id, p.id); paint(); global.scrollTo?.(0, d.documentElement.scrollHeight); el('content').querySelector(`[data-speech-member="${CSS.escape(p.id)}"]`)?.focus({ preventScroll: true }); });
        b.dataset.speechMember = p.id; b.setAttribute('aria-pressed', String(p.id === chosen)); if (p.id === chosen) b.className = 'selected'; names.append(b);
      }
      rows.before(names);
      rows.setAttribute('aria-label', t('speechList'));
      const shown = chosen ? r.speech.filter(i => i.fromId === chosen || i.to.some(x => x.id === chosen)) : r.speech;
      if (r.earlierSpeechOmitted) rows.append(node('p', t('omit'), 'small-note'));
      for (const i of shown) {
        const person = i.fromKind === 'person', article = node('article', undefined, 'message speech' + (person ? ' human' : '')), body = node('div', undefined, 'message-body'), author = node('div', undefined, 'author');
        const from = person ? t('speechYou') : i.fromKind === 'dispatch' ? t('speechDispatch') : (i.fromName || t('speechUnknown')) + (i.unverified ? t('speechUnverified') : '');
        article.dataset.speechId = i.id; author.append(node('span', from));
        const to = i.to.map(x => x.name || t('speechUnknown')).join('、');
        if (to) { const arrow = node('span', '→', 'speech-arrow'); arrow.setAttribute('aria-hidden', 'true'); author.append(arrow, node('span', t('speechTo'), 'visually-hidden'), node('span', to)); }
        const at = new Date(i.time);
        if (Number.isFinite(i.time) && i.time > 0) { const time = node('time', at.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })); time.dateTime = at.toISOString(); author.append(time); }
        else author.append(node('span', t('receiptTimeUnknown'), 'message-time-unknown'));
        const bubble = node('div', i.text, 'bubble'); if (i.textOmitted) bubble.append(node('p', t('omit'), 'small-note'));
        const s = view.sessions.find(s => s.id === i.fromId) || {};
        body.append(author, bubble);
        // Same threshold as the Mac (speech-stream.js folds); the open ones stay open across repaints.
        if (i.text.length > 600 || i.text.split('\n').length > 10) {
          const open = speechOpen.has(i.id), toggle = button(t(open ? 'speechCollapse' : 'speechExpand'), () => {
            const top = article.getBoundingClientRect().top;
            if (speechOpen.has(i.id)) speechOpen.delete(i.id); else speechOpen.add(i.id);
            paint();
            const again = el('content').querySelector(`[data-speech-id="${CSS.escape(i.id)}"]`);
            if (again) { global.scrollTo?.(0, global.scrollY + again.getBoundingClientRect().top - top); again.querySelector('.speech-toggle')?.focus({ preventScroll: true }); }
          }, 'speech-toggle');
          toggle.setAttribute('aria-expanded', String(open)); bubble.classList.toggle('folded', !open); body.append(toggle);
        } if (!person) article.append(avatar(s)); article.append(body); rows.append(article);
      }
      if (!shown.length) rows.append(node('p', chosen ? t('speechEmptyMember').replace('{name}', people.find(p => p.id === chosen)?.name || t('speechUnknown')) : t('speechEmpty'), 'quiet'));
    }
    function addTask(room) {
      const form = node('form'); form.method = 'post'; form.action = '/mobile/workspace/action';
      const input = node('textarea'); input.id = 'new-task-text'; input.name = 'text'; input.maxLength = 6000; input.required = true; const label = node('label', t('task')); label.htmlFor = input.id;
      const select = node('select'); select.id = 'new-task-assignee'; select.name = 'assignee'; const any = node('option', t('any')); any.value = ''; select.append(any);
      for (const s of room.members) { const option = node('option', s.name); option.value = s.id; select.append(option); }
      const assigned = node('label', t('assignee')); assigned.htmlFor = select.id;
      const send = node('button', t('add'), 'primary'); send.type = 'submit'; form.append(label, input, assigned, select, send);
      form.addEventListener('submit', event => { event.preventDefault(); run(async () => { const original = input.value; send.disabled = true; try { const result = await actions.act(client.state.session, { action: 'queueAdd', roomId: room.id, text: original, assignee: select.value || null }, { target: room.name, text: original }); toast(result.status); if (result.status === 'complete' && input.value === original) el('dialog').close(); await refresh(); } finally { send.disabled = false; } }); }); dialog(t('add'), form);
    }
    function queue() {
      const r = view.rooms.find(r => r.id === route.id) || view.rooms[0]; heading('queue');
      if (!r) { el('content').append(node('p', t('noScope'))); return; }
      el('content').append(node('h2', r.name)); const filters = node('div', undefined, 'tabs'), list = node('div');
      function show(filter) { list.replaceChildren(); for (const i of r.queue.filter(i => filter === 'all' || (filter === 'working' ? i.status === 'sent' : i.status === 'queued'))) {
        const card = node('article', undefined, 'queue-card'); card.dataset.itemId = i.id; const meta = node('div', undefined, 'queue-meta'); meta.append(node('span', i.answer ? t('handledDone') : stateText(i.status), 'tag ' + (i.status === 'sent' ? 'work' : 'neutral')), node('span', r.members.find(s => s.id === (i.sentTo || i.assignee))?.name || t('any'), 'small-author'));
        card.append(meta, node('h3', i.text), node('p', i.reply || i.reason || '', 'quiet')); const bottom = node('div', undefined, 'queue-bottom');
        if (i.question) card.append(node('p', i.question, 'queue-question'));
        if (i.answer) card.append(node('blockquote', i.answer.text, 'queue-answer-recorded'));
        if (i.status === 'waiting' && i.questionId) queueAnswer(r, i, card);
        if (view.sessions.some(s => s.id === (i.sentTo || i.assignee))) bottom.append(link(t('openSession'), 'chat/' + (i.sentTo || i.assignee)));
        if (i.status === 'queued' || i.status === 'waiting') bottom.append(button(t(i.status === 'queued' ? 'cancelTask' : i.questionId ? 'handleOnly' : 'handled'), async () => { const result = await actions.act(client.state.session, { action: i.status === 'queued' ? 'queueCancel' : 'queueResolve', roomId: r.id, itemId: i.id }, { target: r.name, text: i.text }); toast(result.status); await refresh(); }));
        card.append(bottom); list.append(card);
      } if (!list.childElementCount) list.append(node('p', t('noData'), 'quiet')); }
      for (const key of ['all', 'working', 'queued']) filters.append(button(t(key), () => show(key)));
      el('content').append(filters, list, button('+ ' + t('add'), () => addTask(r), 'primary'), node('p', t('unchanged'), 'small-note')); show('all'); receipts(el('content'), { roomId: r.id });
    }
    async function resolveQueueAnswer(row) {
      if (!row || row.deviceId !== client.state.session?.deviceId || row.status !== 'submitted' || !row.queueTarget) return;
      const room = view?.rooms.find(r => r.id === row.queueTarget.roomId), item = room?.queue.find(i => i.id === row.queueTarget.itemId);
      const result = await actions.act(client.state.session, { action: 'queueResolve', ...row.queueTarget, answerRequestId: row.requestId }, { target: room?.name, text: item?.text });
      if (result.status === 'complete') actions.clearAnswerDraft(client.state.session, row.queueTarget, row.text);
      toast(result.status); await refresh();
    }
    function queueAnswer(room, item, card) {
      const target = { roomId: room.id, itemId: item.id, questionId: item.questionId }, session = client.state.session;
      const previous = client.state.pending.findLast(p => p.deviceId === session.deviceId && p.sessionId === item.sentTo && p.queueTarget &&
        ['roomId', 'itemId', 'questionId'].every(k => p.queueTarget[k] === target[k]));
      const form = node('form', undefined, 'queue-answer'); form.method = 'post'; form.action = '/mobile/send';
      const input = node('textarea'); input.id = 'queue-answer-' + item.id; input.name = 'answer'; input.required = true; input.maxLength = 6000;
      input.value = actions.answerDraft(session, target) || previous?.text || '';
      const label = node('label', t('queueAnswer') + ' ' + (room.members.find(s => s.id === item.sentTo)?.name || '')); label.htmlFor = input.id;
      const note = node('p', !item.canAnswer ? t('answerUnavailable') : previous && previous.status !== 'not-sent' ? t(previous.status === 'submitted' ? 'answerReceived' : 'answerWaiting') : t('answerHelp'), 'small-note');
      note.id = input.id + '-note'; note.setAttribute('role', 'status'); input.setAttribute('aria-describedby', note.id);
      const submit = node('button', t('answerAndHandle'), 'primary'); submit.type = 'submit';
      submit.disabled = !item.canAnswer || disconnected || actions.state.storageError || Boolean(previous && previous.status !== 'not-sent');
      input.addEventListener('input', () => { try { actions.answerDraft(session, target, input.value); } catch { submit.disabled = true; note.textContent = t('storage'); } });
      form.addEventListener('submit', event => {
        event.preventDefault();
        run(async () => {
          const text = input.value, generation = client.state.authorization;
          submit.disabled = true;
          try {
            actions.answerDraft(session, target, text);
            if (actions.state.storageError || actions.state.busy || actions.state.pending.some(p => p.deviceId === session.deviceId && !terminal(p.status))) throw Error('MOBILE_ACTION_UNCONFIRMED');
            await client.select(item.sentTo);
            if (generation !== client.state.authorization || session.deviceId !== client.state.session?.deviceId || client.state.selected !== item.sentTo) return;
            if (!client.state.row?.canSend || client.state.row.sendMode === 'steer') { note.textContent = t('answerBusy'); return; }
            const row = await client.sendQueueAnswer(text, target);
            if (!row) { note.textContent = client.state.notice; return; }
            if (row.status === 'submitted') await resolveQueueAnswer(row);
            else { note.textContent = t(row.status === 'not-sent' ? 'not-sent' : 'answerWaiting'); await refresh(); }
          } finally { if (form.isConnected && (!previous || previous.status === 'not-sent')) submit.disabled = !item.canAnswer || disconnected || actions.state.storageError; }
        });
      });
      form.append(label, input, submit, note);
      if (previous && previous.status !== 'not-sent') form.append(button(t('answerCheck'), async () => {
        if (previous.status !== 'submitted') await client.receipt(previous.requestId);
        if (previous.status === 'submitted') await resolveQueueAnswer(previous); else { toast('answerWaiting'); await refresh(); }
      }));
      card.append(form);
    }
    function nativeQuestion() {
      heading('confirm'); const row = client.state.row;
      if (!row?.question || client.state.selected !== route.nativeId) {
        const written = answeredQuestion && answeredQuestion.authorization === client.state.authorization &&
          answeredQuestion.deviceId === client.state.session?.deviceId && answeredQuestion.sessionId === route.nativeId &&
          client.state.selected === route.nativeId && client.state.pending.includes(answeredQuestion.receipt) && answeredQuestion.receipt.status === 'reply-written';
        el('content').append(node('p', t(written ? 'reply-written' : 'noNative'), written ? 'native-answer-status' : undefined));
        if (written) receipts(el('content'), { sessionId: route.nativeId });
        return;
      }
      answeredQuestion = null;
      const form = node('form', undefined, 'card-detail native-question'), fields = []; form.method = 'post'; form.action = '/mobile/answer';
      for (const [index, q] of row.question.questions.entries()) { const fieldset = node('fieldset'), inputs = []; fieldset.append(node('legend', q.question));
        for (const option of q.options) { const label = node('label'), input = node('input'); input.type = q.multiSelect ? 'checkbox' : 'radio'; input.name = 'question-' + index; input.value = option.label; if (!q.multiSelect) input.required = true; label.append(input, node('span', option.label + (option.description ? ' · ' + option.description : ''))); inputs.push(input); fieldset.append(label); }
        fields.push({ q, inputs }); form.append(fieldset);
      }
      const submit = node('button', t('answer'), 'primary'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        run(async () => {
          submit.disabled = true;
          try {
            const generation = client.state.authorization, deviceId = client.state.session?.deviceId, sessionId = row.id;
            const previous = new Set(client.state.pending);
            const answers = Object.fromEntries(fields.map(({ q, inputs }) => [q.id || q.question, inputs.filter(i => i.checked).map(i => i.value)]));
            await client.answer(answers);
            const result = client.state.pending.find(p => !previous.has(p) && p.action === 'answer' && p.deviceId === deviceId && p.sessionId === sessionId);
            if (generation !== client.state.authorization || deviceId !== client.state.session?.deviceId || route.nativeId !== sessionId) return;
            if (result?.status === 'reply-written') answeredQuestion = { authorization: generation, deviceId, sessionId, receipt: result };
            toast(result?.status || 'unconfirmed');
            await refresh();
          } finally { submit.disabled = false; }
        });
      }); el('content').append(form); receipts(el('content'), { sessionId: route.nativeId });
    }
    const cardNow = () => view.syncedAt + (global.performance.now() - lastReceived);
    const cardExpired = card => card.disposition === 'expired' || card.state === 'confirmation-required' && card.expiresAt !== null && card.expiresAt <= cardNow();
    const clockTime = at => new Date(at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en');
    // A presentation deadline alone is not a backend receipt. F's explicit
    // expired disposition can say not-executed; a locally elapsed deadline
    // asks the person to check the Mac instead of inventing that outcome.
    function cardState(card, expired) {
      return card.afterStart && (card.disposition || card.state === 'cancelled') ? (lang === 'zh' ? '后续未执行；此前步骤的结果请回 Mac 核对' : 'Remaining work not executed; check earlier results on the Mac') : expired ? card.disposition === 'expired' ? t('expired') : lang === 'zh' ? '已过期 · 请回 Mac 核对' : 'Expired · Check on the Mac' : card.disposition === 'invalidated' ? t('invalidated') : card.state === 'confirmation-required' ? t('pending') : t(({ received: 'submitted', 'not-executed': 'not-sent' })[card.state] || card.state);
    }
    // The single card's facts; each row of a merged card opens to this same list.
    function cardFacts(card) {
      const facts = node('dl', undefined, 'facts');
      for (const [key, value] of [['scope', card.detail], ['from', card.actorName], ['duration', card.expiresAt ? clockTime(card.expiresAt) : t('verifyDeadline')]]) { const row = node('div'); row.append(node('dt', t(key)), node('dd', value)); facts.append(row); }
      return facts;
    }
    // Batches the person started confirming here, by member ids. A member that runs leaves the service's waiting
    // batch; this keeps the batch one card until the page reloads (the desktop keeps its own the same way).
    const startedBatches = new Map();
    function batchOf(card) {
      const ids = startedBatches.get(card.id) || (card.batch ? view.confirmations.filter(c => c.batch === card.batch).map(c => c.id) : null);
      const members = ids?.map(id => view.confirmations.find(c => c.id === id)).filter(Boolean);
      return members?.length > 1 ? members : null;
    }
    const batchPath = members => 'confirm/batch/' + members.map(c => encodeURIComponent(c.id)).join(',');
    const batchTitle = members => f('batchTitle', { action: members[0].batchTitles?.[lang] || members[0].titles?.[lang] || members[0].title, count: members.length });
    function scheduleExpiry(cards) {
      const next = cards.filter(c => !cardExpired(c) && c.expiresAt).map(c => c.expiresAt).sort((a, b) => a - b)[0];
      if (next) expiryTimer = global.setTimeout(paint, Math.max(1, Math.min(2147483647, next - cardNow())));
    }
    function confirmationList() {
      heading('confirm');
      const shown = new Set();
      for (const c of view.confirmations) {
        if (shown.has(c.id)) continue;
        const members = batchOf(c);
        for (const m of members || [c]) shown.add(m.id);
        el('content').append(members ? link(batchTitle(members), batchPath(members), 'link-row') : link(c.titles?.[lang] || c.title, 'confirm/' + encodeURIComponent(c.id), 'link-row'));
      }
      if (!view.confirmations.length) el('content').append(node('p', t('noData')));
    }
    const openRows = new Set();
    // One verification per card, as on its own page: each tap approves the next waiting member in order.
    function batchConfirmation() {
      const members = route.batch.map(id => view.confirmations.find(c => c.id === id)).filter(Boolean);
      if (!members.length) { confirmationList(); return; }
      const box = node('article', undefined, 'card-detail batch-detail'), waiting = members.filter(c => c.state === 'confirmation-required' && !cardExpired(c));
      const deadlines = new Set(waiting.map(c => c.expiresAt)), soonest = waiting.map(c => c.expiresAt).filter(Boolean).sort((a, b) => a - b)[0];
      box.dataset.confirmationId = members.at(-1).id;
      box.append(node('p', members[0].actorName, 'source'), node('h1', batchTitle(members)));
      if (waiting.length) box.append(node('p', t('pending') + (soonest ? ' · ' + t('duration') + ' ' + clockTime(soonest) : ''), 'quiet'));
      const rows = node('ol', undefined, 'batch-rows');
      for (const card of members) {
        const expired = cardExpired(card), li = node('li'), details = node('details'), summary = node('summary');
        li.dataset.confirmationId = card.id;
        details.open = openRows.has(card.id);
        details.addEventListener('toggle', () => { if (details.open) openRows.add(card.id); else openRows.delete(card.id); });
        summary.append(node('span', card.targetName || card.summary?.target || card.title, 'batch-target'), node('span', cardState(card, expired), expired ? 'batch-state sync-error' : 'batch-state'));
        if (deadlines.size > 1 && waiting.includes(card)) summary.append(node('span', t('duration') + ' ' + clockTime(card.expiresAt), 'batch-time'));
        details.append(summary, cardFacts(card), link(t('review') + ' ›', 'confirm/' + encodeURIComponent(card.id), 'text-link'));
        li.append(details);
        const receipt = passkeys.pending.find(p => p.id === card.id && p.status === 'unconfirmed');
        if (receipt) li.append(button(t('receipt'), async () => { try { const result = await passkeys.receipt(client.state.session, receipt); toast(result.status); } catch { toast('verifyFailed'); } await refresh(); }));
        rows.append(li);
      }
      box.append(rows);
      const next = waiting[0], index = members.indexOf(next) + 1, unconfirmed = passkeys.pending.some(p => p.status === 'unconfirmed' && members.some(c => c.id === p.id));
      const approve = button(index > 1 ? f('confirmNext', { index, count: members.length }) : f('confirmFirst', { count: members.length }), async () => {
        approve.disabled = true;
        const ids = members.map(c => c.id);
        for (const id of ids) startedBatches.set(id, ids);
        try { const result = await passkeys.decide(client.state.session, next, 'approve'); toast(result.status); }
        catch (error) { toast(error?.code === 'MOBILE_PAIR_LIMIT' ? 'pairLimit' : 'verifyFailed'); }
        await refresh();
      }, 'primary');
      approve.id = 'consent-batch';
      approve.disabled = !next?.canDecide || unconfirmed || passkeys.busy;
      // Nothing left to answer: the rows carry each card's own result.
      if (next) {
        const buttons = node('div', undefined, 'confirm-actions');
        buttons.append(approve);
        box.append(buttons, node('p', t(next.canDecide ? 'verifyPhone' : 'verifyMac'), 'auth-note'));
      }
      el('content').append(box, link(t('back') + ' ›', 'chat/' + encodeURIComponent(members[0].sessionId), 'link-row'));
      scheduleExpiry(waiting);
    }
    function confirmation() {
      if (route.nativeId) { nativeQuestion(); return; }
      if (route.batch) { batchConfirmation(); return; }
      const card = view.confirmations.find(c => c.id === route.id);
      if (!card) { confirmationList(); return; }
      const box = node('article', undefined, 'card-detail'), expired = cardExpired(card);
      box.dataset.confirmationId = card.id;
      box.append(node('p', card.actorName, 'source'), node('h1', card.titles?.[lang] || card.title), node('p', cardState(card, expired), expired ? 'sync-error' : 'quiet'));
      box.append(cardFacts(card));
      const pending = passkeys.pending.find(p => p.id === card.id && p.status === 'unconfirmed');
      const buttons = node('div', undefined, 'confirm-actions');
      for (const key of ['deny', 'approve']) {
        const b = button(t(key), async () => {
          for (const button of buttons.children) button.disabled = true;
          try { const result = await passkeys.decide(client.state.session, card, key); toast(result.status); }
          catch (error) { toast(error?.code === 'MOBILE_PAIR_LIMIT' ? 'pairLimit' : 'verifyFailed'); }
          await refresh();
        }, key === 'approve' ? 'primary' : '');
        b.id = 'consent-' + key; b.disabled = !card.canDecide || expired || Boolean(pending) || passkeys.busy; buttons.append(b);
      }
      box.append(buttons, node('p', t(card.canDecide ? 'verifyPhone' : 'verifyMac'), 'auth-note'));
      if (pending) box.append(button(t('receipt'), async () => { try { const result = await passkeys.receipt(client.state.session, pending); toast(result.status); } catch { toast('verifyFailed'); } await refresh(); }));
      el('content').append(box, link(t('back') + ' ›', 'chat/' + encodeURIComponent(card.sessionId), 'link-row'));
      if (!expired) scheduleExpiry([card]);
    }
    function registerPasskey() {
      const form = node('form', undefined, 'auth-form'), label = node('label', t('registrationCode')), input = node('input');
      input.id = 'registration-code'; input.required = true; input.inputMode = 'numeric'; input.pattern = '[0-9]{6}'; input.minLength = input.maxLength = 6; input.autocomplete = 'one-time-code'; label.htmlFor = input.id;
      const submit = node('button', t('registerKey'), 'primary'); submit.type = 'submit';
      form.append(node('p', t('registerHelp')), label, input, submit);
      form.addEventListener('submit', event => { event.preventDefault(); run(async () => {
        submit.disabled = true;
        try { const result = await passkeys.register(client.state.session, input.value); input.value = ''; form.replaceChildren(node('p', t('registrationReady')), node('code', result.fingerprint.match(/.{1,8}/g).join(' '))); }
        catch { toast('verifyFailed'); } finally { submit.disabled = false; }
      }); }); dialog(t('registerKey'), form);
    }
    function reminders() {
      heading('reminders'); if (!view.reminders) { el('content').append(node('p', t('noScope'))); return; }
      el('content').append(node('p', t('sameBell'), 'quiet'));
      if (push && view.capabilities?.push !== false) {
        const card = node('section', undefined, 'reminder-card'); card.id = 'push-card';
        const title = node('h2', t('pushTitle')); title.id = 'push-title'; card.setAttribute('aria-labelledby', title.id);
        const supported = push.supported(), state = push.state;
        const key = ({ off: 'pushOff', subscribed: 'pushSubscribed', accepted: 'pushAccepted', delayed: 'pushDelayed', expired: 'pushExpired', denied: 'pushDenied', unconfirmed: 'pushUnknown' })[state.state] || 'pushUnknown';
        const status = node('p', t(key)); status.id = 'push-status'; status.setAttribute('role', 'status');
        if (state.lastSubmittedAt) status.append(node('span', ' · ' + new Date(state.lastSubmittedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en')));
        card.append(title, node('p', t('pushNote'), 'quiet'), status, node('p', t('pushHome'), 'quiet'));
        if (supported || state.enabled) {
          const b = node('button', t(state.enabled ? 'pushDisable' : 'pushEnable'), 'primary'); b.type = 'button'; b.id = 'push-toggle';
          b.setAttribute('aria-disabled', String(state.busy));
          b.addEventListener('click', () => {
            if (push.state.busy) return;
            b.setAttribute('aria-disabled', 'true');
            // Bypass the ordinary async action wrapper so Safari receives the
            // permission request directly in this user's click task.
            const pending = push.state.enabled ? push.disable() : push.enable();
            pending.finally(() => { paint(); el('push-toggle')?.focus(); });
          }); card.append(b);
        } else card.append(node('p', t('pushUnsupported'), 'callout'));
        el('content').append(card);
      }
      for (const r of view.reminders.records) for (const i of r.items.filter(i => i.shown)) {
        const card = node('article', undefined, 'reminder-card'); card.dataset.record = r.record;
        card.append(node('div', t(r.record), 'record'), node('h3', (i.kind === 'age' ? i.blocks + ' ' : '') + t(i.kind)), node('p', r.blocks + ' · ' + Math.round(r.bytes / 1024 / 1024) + ' MiB', 'quiet'));
        const actionsBar = node('div', undefined, 'reminder-actions'); actionsBar.append(button(t('export'), () => dialog(t('export'), t('mac'))), button(t('ack'), async () => { const result = await actions.act(client.state.session, { action: 'recordAcknowledge', record: r.record, kind: i.kind, level: i.level }, { target: t(r.record === 'operations' ? 'receiptOperations' : 'receiptSteward'), text: t('ack') + ' · ' + t(i.kind) }); toast(result.status); await refresh(); })); card.append(actionsBar); el('content').append(card);
      }
      if (!view.reminders.count) el('content').append(node('p', t('noData'), 'quiet'));
    }
    // The fixed compose box grows with its note, the textarea and the safe area; the list keeps that much room below it.
    function readingPosition() {
      const label = el('reading-position');
      if (!label) return;
      const last = latestMessage();
      label.textContent = t(!last ? 'loadingBody' : last.getBoundingClientRect().bottom <= el('compose').getBoundingClientRect().top + 24 ? 'latestPosition' : 'earlierPosition');
    }
    function composeSpace() {
      const box = el('compose'), viewport = global.visualViewport;
      const editing = !box.hidden && (d.activeElement === el('message') || d.body.classList.contains('keyboard-compose')) && viewport?.scale === 1 && global.innerHeight - viewport.height > 100;
      d.body.classList.toggle('keyboard-compose', editing);
      const shortLandscape = global.innerWidth > global.innerHeight && global.innerHeight <= 450;
      d.body.classList.toggle('compact-compose', !box.hidden && (editing ? viewport.height < 200 : shortLandscape));
      d.documentElement.style.setProperty('--keyboard-inset', (editing ? Math.max(0, global.innerHeight - viewport.height - viewport.offsetTop) : 0) + 'px');
      d.documentElement.style.setProperty('--keyboard-top', (editing ? Math.max(0, viewport.offsetTop) : 0) + 'px');
      const nav = el('navigation').getBoundingClientRect().height, height = box.getBoundingClientRect().height;
      const bottom = (viewport?.offsetTop || 0) + (viewport?.height ?? global.innerHeight);
      d.documentElement.style.setProperty('--mobile-bottom', bottom + 'px');
      d.documentElement.style.setProperty('--mobile-header-height', el('top').getBoundingClientRect().height + 'px');
      d.documentElement.style.setProperty('--nav-height', nav + 'px');
      d.documentElement.style.setProperty('--compose-height', height + 'px');
      const space = box.hidden ? 0 : Math.max(0, global.innerHeight - box.getBoundingClientRect().top);
      d.documentElement.style.setProperty('--compose-space', Math.ceil(space) + 'px');
      readingPosition();
    }
    if (global.ResizeObserver) new global.ResizeObserver(composeSpace).observe(el('compose'));
    global.addEventListener('resize', composeSpace);
    global.addEventListener('scroll', readingPosition, { passive: true });
    global.visualViewport?.addEventListener('resize', composeSpace);
    global.visualViewport?.addEventListener('scroll', composeSpace);
    d.addEventListener('focusin', composeSpace);
    d.addEventListener('focusout', composeSpace);
    let timerClock = 0, timerShape = '';
    // This chat's confirmation deadlines beside its input box, from the view the page already holds; a batch is one.
    // A locally elapsed deadline is not a receipt (see cardState), so a timer leaves at zero instead of saying expired.
    function chatTimers() {
      if (route?.page !== 'chat' || !view) return [];
      const now = cardNow(), seen = new Set(), out = [];
      for (const card of view.confirmations) {
        if (seen.has(card.id) || card.sessionId !== route.id) continue;
        const members = batchOf(card) || [card];
        for (const m of members) seen.add(m.id);
        const waiting = members.filter(c => c.state === 'confirmation-required' && !c.disposition && Number.isSafeInteger(c.expiresAt) && c.expiresAt > now);
        if (!waiting.length) continue;
        out.push({ target: members.at(-1).id, path: members.length > 1 ? batchPath(members) : 'confirm/' + encodeURIComponent(card.id),
          title: members.length > 1 ? batchTitle(members) : card.titles?.[lang] || card.title, at: Math.min(...waiting.map(c => c.expiresAt)) });
      }
      return out.sort((a, b) => a.at - b.at);
    }
    function timerLabel(item) {
      const left = Math.max(0, Math.ceil((item.at - cardNow()) / 1000)), minutes = Math.floor(left / 60), seconds = left % 60;
      return { text: f('timerCountdown', { time: minutes + ':' + String(seconds).padStart(2, '0') }),
        name: minutes ? f('timerCountdownName', { minutes, seconds }) : f('timerCountdownSecondsName', { seconds }) };
    }
    function jumpTo(item) {
      const target = [...el('content').querySelectorAll('article[data-confirmation-id]')].find(a => a.dataset.confirmationId === item.target);
      if (!target) { global.location.hash = '#' + lang + '/' + item.path; return; }
      target.scrollIntoView({ block: 'center' });
      target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
      global.setTimeout(() => target.classList.remove('flash'), 1600);
    }
    // Rebuilt only when the timers change; the one-second tick rewrites the chip's text.
    function renderTimers() {
      const box = el('phone-timers'), items = box ? chatTimers() : [], shape = JSON.stringify(items.map(i => i.target));
      if (box && shape !== timerShape) {
        timerShape = shape; box.replaceChildren();
        if (items.length) {
          const main = node('button', undefined, 'phone-timer'); main.type = 'button'; main.addEventListener('click', () => jumpTo(items[0])); box.append(main);
          if (items.length > 1) {
            const more = node('button', f('timerMore', { count: items.length - 1 }), 'phone-timer-more'); more.type = 'button';
            more.setAttribute('aria-label', f('timerMoreName', { count: items.length - 1 }));
            more.addEventListener('click', () => {
              const list = node('div', undefined, 'phone-timer-list');
              for (const item of chatTimers().slice(1)) {
                const row = node('button', timerLabel(item).text + ' · ' + item.title); row.type = 'button';
                row.addEventListener('click', () => { el('dialog').close(); jumpTo(item); }); list.append(row);
              }
              dialog(f('timerMoreName', { count: items.length - 1 }), list);
            });
            box.append(more);
          }
        }
      }
      if (box) box.hidden = !items.length;
      if (items.length) {
        const label = timerLabel(items[0]), main = box.firstChild;
        if (main.textContent !== label.text) main.textContent = label.text;
        if (main.getAttribute('aria-label') !== label.name) main.setAttribute('aria-label', label.name);
      }
      if (items.length && !timerClock) timerClock = global.setInterval(renderTimers, 1000);
      if (!items.length && timerClock) { global.clearInterval(timerClock); timerClock = 0; }
    }
    function updateCompose() {
      if (!client) return;
      const active = !locked && route?.page === 'chat' && client.state.session?.sessions.some(s => s.id === route.id && s.available !== false) && view?.sessions.some(s => s.id === route.id); el('compose').hidden = !active; d.body.classList.toggle('with-compose', Boolean(active)); composeSpace();
      if (!active) { composeKey = ''; el('compose').replaceChildren(); renderTimers(); return; }
      if (composeKey !== route.id) {
        composeKey = route.id; el('compose').replaceChildren(); const inner = node('div', undefined, 'compose-inner'), label = node('label', t('unsentDraft'), 'quiet'), input = node('textarea'); input.id = 'message'; input.name = 'text'; input.maxLength = 16000; input.placeholder = t('message'); label.htmlFor = input.id;
        input.addEventListener('input', () => { try { client.setDraft(input.value); } catch { toast('storage'); } }); const tools = node('div', undefined, 'compose-tools'), send = node('button', t('send'), 'primary'); send.id = 'send-message'; send.type = 'submit';
        // Retain editing focus for a touch; Safari otherwise moves Send before click.
        let touchSend = false;
        send.addEventListener('touchstart', event => { touchSend = d.activeElement === input && event.touches.length === 1; if (touchSend) event.preventDefault(); }, { passive: false });
        send.addEventListener('touchend', event => {
          if (!touchSend) return; touchSend = false; event.preventDefault();
          const touch = event.changedTouches[0], rect = send.getBoundingClientRect();
          if (touch && touch.clientX >= rect.left && touch.clientX <= rect.right && touch.clientY >= rect.top && touch.clientY <= rect.bottom) send.click();
        }, { passive: false });
        send.addEventListener('touchcancel', () => { touchSend = false; });
        const note = node('span', t('draft'), 'small-note'); note.id = 'compose-note'; tools.append(note, send);
        const timers = node('div', undefined, 'phone-timers'); timers.id = 'phone-timers'; timers.hidden = true; timerShape = '';
        inner.append(timers, label, input, tools); el('compose').append(inner);
      }
      const input = el('message'), state = client.state; if (input.value !== state.draft) input.value = state.draft;
      // Mode and refusal reason come from mobile-session.cjs read(); the phone does not guess them.
      const row = state.row?.id === route.id ? state.row : null;
      const waiting = state.pending.some(p => p.deviceId === state.session?.deviceId && p.sessionId === state.selected && !['submitted', 'reply-written', 'not-sent'].includes(p.status));
      const mine = state.pending.filter(p => p.deviceId === state.session?.deviceId && p.sessionId === state.selected);
      const mode = row?.canSend ? row.sendMode : null, reason = row && !row.canSend && SEND_BLOCKS.includes(row.sendBlocked) ? row.sendBlocked : null;
      el('send-message').textContent = t(mode === 'queue' ? 'queueSend' : mode === 'queueMidturn' ? 'queueMidturn' : mode === 'steer' ? 'steer' : 'send');
      // Every reason the button is disabled has its own note, local ones first (B's review, C2).
      const note = disconnected ? 'phoneOffline' : state.storageError ? 'storage' : !row || state.selected !== route.id ? 'reading'
        : waiting ? (mine.some(p => p.queued === true && p.status === 'awaiting-native') ? 'messageQueued' : mine.some(p => p.status === 'unconfirmed') ? 'ownUnconfirmed' : 'ownPending')
        : mode === 'queue' ? 'queueNote' : mode === 'queueMidturn' ? 'queueMidturnNote' : mode === 'steer' ? 'steerNote'
        : reason === 'question' && !row.question ? 'blocked-questionMac' : reason ? 'blocked-' + reason
        : !row.canSend ? 'blocked-notReady' : 'draft';
      el('compose-note').textContent = t(note);
      el('send-message').disabled = disconnected || state.busy || state.storageError || !state.row?.canSend || state.selected !== route.id || !state.draft.trim() || waiting;
      renderTimers();
      composeSpace();
    }
    let acknowledgedMessages = 0;
    el('compose').addEventListener('submit', event => { event.preventDefault(); run(async () => { const text = client.state.draft; if (/^[!#/]/.test(text.normalize('NFKC').replace(/^[\s\p{Cc}\p{Default_Ignorable_Code_Point}]+/u, ''))) { toast('command'); return; } const sessionId = route.id, name = view.sessions.find(s => s.id === sessionId)?.name || sessionId;
      const generation = client.state.authorization, deviceId = client.state.session?.deviceId, scroll = global.scrollY;
      const before = new Set(client.state.pending.map(p => p.requestId)); await client.send();
      if (generation !== client.state.authorization || deviceId !== client.state.session?.deviceId) return;
      // The result of this click only, found by its own request id, not the last row or the current page.
      const mine = client.state.pending.find(p => p.deviceId === deviceId && p.sessionId === sessionId && !before.has(p.requestId)), status = mine?.status || 'unconfirmed', key = mine?.queued === true && status === 'awaiting-native' ? 'messageQueued' : status === 'unconfirmed' ? 'messageUnconfirmed' : status;
      if (status === 'submitted' && view?.sessions.some(s => s.id === sessionId) && route?.page === 'chat' && route.id === sessionId && client.state.selected === sessionId) {
        // Render only a confirmed receipt; the next workspace snapshot replaces this transient row.
        acknowledgedMessages++;
        const follow = global.scrollY === scroll;
        view = { ...view, sessions: view.sessions.map(s => s.id === sessionId ? { ...s, messages: [...(s.messages || []), {
          id: 'mobile-receipt:' + mine.requestId, role: 'user', text: mine.text, time: Date.now(), status: 'submitted',
        }] } : s) };
        paint();
        if (follow) scrollToLatest();
      }
      if (route?.page === 'chat' && route.id === sessionId) toast(key); else toast(name + ' · ' + t(key)); await refresh(); }); });
    function paint() {
      // A chat read to its end stays at its end when it repaints, so a message just sent or arrived is in view.
      const stick = route?.page === 'chat' && (readingLatest() || global.innerHeight + global.scrollY >= d.documentElement.scrollHeight - 80);
      // A space's conversation read to its end keeps growing downward, as on the Mac.
      const spaceSpeech = route?.page === 'space' && Boolean(route.id) && Boolean(el('content').querySelector('.speech-names')), spaceY = global.scrollY;
      const stickSpace = spaceSpeech && global.innerHeight + global.scrollY >= d.documentElement.scrollHeight - 80;
      global.clearTimeout(expiryTimer); el('content').replaceChildren(); el('top').replaceChildren(); el('connection').replaceChildren(); el('navigation').replaceChildren();
      d.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; d.title = (route ? t(route.page) : t('home')) + ' · NAW'; el('skip').textContent = t('skip'); el('dialog-close').textContent = t('close');
      if (!route || route.page === 'home') { const homeLink = link('', 'home', 'brand'); homeLink.append(node('span', 'N', 'mark'), node('span', 'NAW')); el('top').append(homeLink, node('span', '', 'grow')); }
      else { const back = link('', 'home', 'icon'); back.setAttribute('aria-label', t('home')); back.append(icon('back')); const title = node('div', route.page === 'chat' ? view?.sessions.find(s => s.id === route.id)?.name || t('chat') : route.page === 'space' ? view?.rooms.find(r => r.id === route.id)?.name || t('space') : t(route.page), 'top-title'); el('top').append(back, title); }
      if (route?.page === 'chat') {
        const session = view?.sessions.find(s => s.id === route.id), title = el('top').querySelector('.top-title');
        const spaces = view?.rooms.filter(r => session?.roomIds?.includes(r.id)).map(r => r.name) || [];
        title?.append(node('small', [butlerSession()?.id === route.id ? t('butler') : '', providerName(session?.provider), ...spaces].filter(Boolean).join(' · ')));
      }
      const pendingPair=client.state.session?.candidate===true;
      const bell = link('', 'reminders', 'icon bell'); bell.hidden=pendingPair;bell.setAttribute('aria-label', t('reminders') + ' · ' + (view?.reminders?.count || 0)); bell.append(icon('bell')); if (view?.reminders?.count) bell.append(node('span', view.reminders.count, 'count')); el('top').append(bell, button('···', () => { const menu = node('div', undefined, 'dialog-menu'); menu.append(button(t('refresh'), refresh));if(!pendingPair)menu.append(button(t('registerKey'), registerPasskey));menu.append(button(t(pendingPair?'cancelPair':'logout'), async () => { await client.logout(); locked = true; view = null; el('dialog').close(); paint(); })); dialog(t('manage'), menu); }, 'icon'));
      el('top').lastElementChild.setAttribute('aria-label', t('manage'));
      el('connection').classList.toggle('connection-warning', disconnected && !authorizationRejected);
      el('connection').classList.remove('health-attention');
      if (!disconnected) offlineSince = 0; else if (!offlineSince) offlineSince = Date.now();
      const status = node('span', disconnected && !authorizationRejected ? t(offlineWord()) : locked ? t('locked') : pendingPair?t('finishPair'):t('connected') + (view?.syncedAt ? ' · ' + new Date(view.syncedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }) : ''), 'sync-time'); status.id = 'sync-status'; status.setAttribute('role','status'); el('connection').append(status, button(t('refresh'), refresh)); const language = link(lang === 'zh' ? 'English' : '中文', (route?.page || 'home') + (route?.id ? '/' + encodeURIComponent(route.id) : '')); language.href = '#' + (lang === 'zh' ? 'en' : 'zh') + '/' + (route?.nativeId ? 'confirm/native/' + encodeURIComponent(route.nativeId) : (route?.page || 'home') + (route?.id ? '/' + encodeURIComponent(route.id) : '')); language.id = 'language-link'; el('connection').append(language);
      if (!pendingPair && view?.reminders) {
        const health = view.reminders.health, keys = { 'steward-wake-stalled': 'wakeStalled', 'token-anomaly': 'tokenAnomaly', 'service-disconnected': 'sourceDisconnected' };
        const alerts = Array.isArray(health?.alerts) ? [...new Set(health.alerts.map(a => keys[a?.code]).filter(Boolean))] : [];
        el('connection').classList.toggle('health-attention', alerts.length > 0);
        if (health?.available !== true || !Array.isArray(health.alerts) || health.alerts.some(a => !keys[a?.code])) alerts.push('healthUnknown');
        if (alerts.length) {
          const warning = link(alerts.map(t).join(' · '), 'reminders', 'health-warning');
          warning.id = 'health-warning'; warning.setAttribute('role', 'status'); el('connection').append(warning);
        }
      }
      el('navigation').hidden = locked || client.state.session?.candidate===true;
      if (locked || !client.state.session) { login(); updateCompose(); return; }
      if(client.state.session.candidate){candidate();updateCompose();return;}
      const nav = node('div', undefined, 'nav-inner'); for (const key of ['home', 'space', 'queue']) { const a = link('', key, route?.page === key ? 'active' : ''); a.append(icon(key), node('span', t(key))); if (route?.page === key) a.setAttribute('aria-current', 'page'); nav.append(a); } el('navigation').append(nav);
      if (!view) { el('content').append(node('p', t(busy || d.documentElement.dataset.loading === 'true' ? 'reading' : 'offline'))); updateCompose(); return; }
      const body = route?.page === 'chat' ? view.sessions.find(s => s.id === route.id)
        : route?.page === 'space' && route.id ? view.rooms.find(r => r.id === route.id) : null;
      if (body?.conversationLoaded === false && !body.messages?.length) {
        el('content').append(node('p', t(disconnected ? 'offline' : 'loadingBody'), 'quiet'));
        if (route.page === 'chat') receipts(el('content'), { sessionId: route.id });
      }
      else ({ home, chat, space, queue, confirm: confirmation, reminders }[route?.page] || home)();
      if (body?.conversationLoaded === false && body.messages?.length) el('content').append(node('p', t(disconnected ? 'offline' : 'loadingBody'), 'quiet'));
      if (route?.page === 'chat') { const position = node('span', '', 'reading-position'); position.id = 'reading-position'; el('connection').append(position); }
      updateCompose();
      if (stick) scrollToLatest();
      // Emptying the page above clamps the scroll to the top; scrolled up, the reading place stays put.
      if (stickSpace) global.scrollTo?.(0, d.documentElement.scrollHeight); else if (spaceSpeech) global.scrollTo?.(0, spaceY);
    }
    const routeKey = () => JSON.stringify([lang, route?.page, route?.id, route?.nativeId, route?.batch]);
    const workspacePath = () => '/mobile/workspace/' + (route?.page === 'chat' && route.id ? 'session/' + encodeURIComponent(route.id)
      : route?.page === 'space' && route.id ? 'room/' + encodeURIComponent(route.id) : 'summary');
    let refreshRead;
    function refresh({ automatic = false } = {}) {
      const key = routeKey(), acknowledged = acknowledgedMessages;
      if (refreshRead?.key === key && refreshRead.authorization === client.state.authorization && refreshRead.acknowledged === acknowledged) { paint(); return refreshRead.promise; }
      const read = { key, authorization: client.state.authorization, acknowledged }, ticket = ++epoch;
      refreshRead = read; busy = true;
      const offlineToast = currentToast?.key === 'offline' ? currentToast : null;
      read.promise = (async () => {
      let generation = client.state.authorization, deviceId;
      const current = () => ticket === epoch && key === routeKey();
      try { await client.start(undefined, { strict: true }); if (!current()) return;
        generation = client.state.authorization; deviceId = client.state.session?.deviceId;
        const selected = route?.page === 'chat' ? route.id : route?.nativeId;
        if (!locked && selected && client.state.selected !== selected && client.state.session?.sessions.some(s => s.id === selected && s.available !== false)) await client.select(selected);
        else if (!locked && client.state.session) await client.refresh(!automatic, { strict: true });
        if (!current() || generation !== client.state.authorization) return;
        if (locked || !client.state.session || client.state.session.candidate) { view = null; return; }
        paint();
        const next = client.state.session.workspace ? await api(workspacePath()) : { sessions: client.state.session.sessions.filter(s => s.available).map(s => ({ ...s,
          messages: client.state.row?.id === s.id ? client.state.row.messages.map(m => ({ ...m, role: 'assistant', name: s.name, attachments: m.unsupportedAttachments })) : [],
          earlierMessagesOmitted: client.state.row?.id === s.id ? client.state.row.earlierMessagesOmitted : 0 })), rooms: [], confirmations: [], reminders: null, syncedAt: Date.now() };
        if (!current() || generation !== client.state.authorization || deviceId !== client.state.session?.deviceId || acknowledged !== acknowledgedMessages) return;
        view = next; lastReceived = global.performance.now();
        if (push && next.reminders && next.capabilities?.push !== false) await push.read();
        if (current() && generation === client.state.authorization && offlineToast && currentToast === offlineToast) dismissToast();
      } catch { if (generation === client.state.authorization && current()) { disconnected = true; if (!automatic) toast('offline'); } }
      finally { if (current()) { busy = false; paint(); } if (refreshRead === read) refreshRead = null; }
      })();
      return read.promise;
    }
    let navigation = 0;
    async function navigate() {
      const ticket = ++navigation;
      let paired = false;
      d.documentElement.dataset.loading = 'true';
      try {
        // Opening a fresh pairing link in an already-open phone tab is also a
        // pairing gesture. Consume it before requests or storage, just as at boot.
        if (global.location.hash.startsWith('#pair=')) {
          const secret = global.location.hash.slice(6);
          global.history.replaceState(null, '', global.location.pathname + '#' + lang + '/home');
          paired = true;
          await client.start(secret);
        }
        if (ticket !== navigation) return;
        const parts = global.location.hash.slice(1).split('/'); lang = parts[0] === 'en' ? 'en' : 'zh';
        route = { page: ['home', 'chat', 'space', 'queue', 'confirm', 'reminders'].includes(parts[1]) ? parts[1] : 'home', id: parts[2] ? decodeURIComponent(parts[2]) : null, nativeId: parts[1] === 'confirm' && parts[2] === 'native' ? decodeURIComponent(parts[3] || '') : null,
          batch: parts[1] === 'confirm' && parts[2] === 'batch' && parts[3] ? parts[3].split(',').map(decodeURIComponent) : null };
        d.documentElement.dataset.page = route.page;
        d.documentElement.dataset.route = global.location.hash;
        if (view) {
          const unloaded = ({ messages, earlierMessagesOmitted, ...row }) => ({ ...row, conversationLoaded: false });
          view = { ...view, sessions: view.sessions.map(unloaded), rooms: view.rooms.map(unloaded) };
        }
        composeKey = ''; answeredQuestion = null; dismissToast(); paint();
        const id = route.page === 'chat' ? route.id : route.nativeId;
        if (id && client.state.session?.sessions.some(s => s.id === id)) await client.select(id, { read: false });
        if (ticket !== navigation) return;
        const reading = refresh();
        // A new grant must not keep the previous conversation visible while reading.
        if (!paired) await reading;
        if (ticket === navigation) paint();
        // A chat opens at its newest message, as on the Mac; later refreshes keep the reader's place.
        if (ticket === navigation && route.page === 'chat') scrollToLatest();
        if (ticket === navigation && route.page === 'space' && el('content').querySelector('.speech-names')) global.scrollTo?.(0, d.documentElement.scrollHeight);
      } catch {
        if (ticket === navigation) { disconnected = true; paint(); toast('offline'); }
      } finally { if (ticket === navigation) d.documentElement.dataset.loading = 'false'; }
    }
    const scheduleNavigate = () => navigate();
    // Navigation must not wait for an earlier route's network requests.
    global.addEventListener('hashchange', scheduleNavigate);
    started = (async () => { try { await client.start(pairSecret); } finally { pairSecret = undefined; } })();
    recovery = global.NAWMobile.createReadRecovery({ read: async () => {
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(d.activeElement?.tagName) && !el('compose').contains(d.activeElement);
      if (pairingBusy || client.state.busy || passkeys.busy || busy || el('dialog').open || editing) return true;
      await refresh({ automatic: true }); return !disconnected && !locked;
    }, active: () => !authorizationRejected && !client.state.session?.candidate,
    visible: () => d.visibilityState !== 'hidden', online: () => global.navigator.onLine !== false });
    const wake = () => recovery.wake(), offline = () => { disconnected = true; paint(); recovery.wake(); };
    const hide = () => { recovery.stop(); for (const read of readingRequests) read.abort(); };
    const show = () => recovery.start();
    d.addEventListener('visibilitychange', wake); global.addEventListener('online', wake); global.addEventListener('offline', offline);
    global.addEventListener('pagehide', hide); global.addEventListener('pageshow', show);
    client.ready = (async () => { await started; await scheduleNavigate(); })().finally(() => recovery.start()); paint();
    return { client, actions, refresh, navigate, dispose() { hide(); global.clearInterval(timerClock); d.removeEventListener('visibilitychange', wake);
      global.removeEventListener('online', wake); global.removeEventListener('offline', offline); global.removeEventListener('pagehide', hide); global.removeEventListener('pageshow', show); global.removeEventListener('hashchange', scheduleNavigate); } };
  }
  const exported = { createWorkspaceActions, ACTION_KEY, mount, receiptVisible };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else { global.NAWMobileWorkspace = exported; global.nawPhone = mount(); }
})(globalThis);
