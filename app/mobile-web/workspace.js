/* Six phone views over the desktop projection. No polling, native terminal or sensitive approval bypass. */
(function (global) {
  'use strict';
  const ACTION_KEY = 'naw.mobile.workspace.v1';
  const terminal = s => ['complete', 'not-sent'].includes(s);
  function createWorkspaceActions({ storage, request, newId, changed = () => {} }) {
    const state = { pending: [], busy: false, storageError: false };
    try {
      const raw = storage.getItem(ACTION_KEY);
      if (raw) {
        if (raw.length > 256 * 1024) throw Error('limit');
        const saved = JSON.parse(raw);
        const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
        if (saved.version !== 1 || !Array.isArray(saved.pending) || saved.pending.length > 64 || saved.pending.some(p => !p || !uuid(p.deviceId) || !uuid(p.requestId) || !['queueAdd', 'queueCancel', 'queueResolve', 'recordAcknowledge'].includes(p.action) || !['unconfirmed', 'complete', 'not-sent'].includes(p.status)) || new Set(saved.pending.map(p => p.requestId)).size !== saved.pending.length) throw Error('invalid');
        state.pending = saved.pending;
      }
    } catch { state.storageError = true; }
    function save() { try { storage.setItem(ACTION_KEY, JSON.stringify({ version: 1, pending: state.pending })); } catch { state.storageError = true; throw Error('MOBILE_STORAGE_UNAVAILABLE'); } }
    async function act(session, fields) {
      if (state.storageError || state.busy || !session || state.pending.some(p => p.deviceId === session.deviceId && !terminal(p.status)) || state.pending.length >= 64) throw Error('MOBILE_ACTION_UNCONFIRMED');
      const requestId = newId(), row = { deviceId: session.deviceId, requestId, status: 'unconfirmed', action: fields.action };
      state.pending.push(row); save(); state.busy = true; changed();
      try { const result = await request('/mobile/workspace/action', { ...fields, requestId }, session.csrf); if (result.requestId !== requestId || !['complete', 'not-sent', 'unconfirmed'].includes(result.status)) throw Error('MOBILE_ACTION_UNCONFIRMED'); Object.assign(row, { status: result.status, itemId: result.itemId }); save(); return result; }
      finally { state.busy = false; changed(); }
    }
    async function receipt(session, row) {
      if (!session || row.deviceId !== session.deviceId || state.busy) throw Error('MOBILE_RECEIPT_UNAVAILABLE');
      state.busy = true; changed();
      try { const result = await request('/mobile/workspace/action', { action: 'receipt', requestId: row.requestId }, session.csrf); if (result.requestId !== row.requestId || !['complete', 'not-sent', 'unconfirmed'].includes(result.status)) throw Error('MOBILE_ACTION_UNCONFIRMED'); Object.assign(row, { status: result.status, itemId: result.itemId }); save(); return result; }
      finally { state.busy = false; changed(); }
    }
    function forget(row) { if (!terminal(row.status)) throw Error('MOBILE_ACTION_UNCONFIRMED'); state.pending = state.pending.filter(p => p !== row); save(); changed(); }
    return { state, act, receipt, forget };
  }
  const words = {
    zh: { home: '工作台', chat: '对话', space: '空间', queue: '队列', confirm: '确认操作', reminders: '提醒', sessions: '会话', members: '成员', connected: '已连接 NAW', synced: '上次同步', refresh: '刷新', manage: '管理', close: '关闭', send: '发送 ↑', message: '输入消息…', draft: '草稿仅在此浏览器保存', idle: '空闲', working: '进行中', needs: '等你', queued: '待派发', done: '已完成', cancelled: '已取消', all: '全部', add: '添加任务', task: '任务', assignee: '指定成员', any: '任意空闲成员', cancelTask: '取消任务', handled: '标为已处理', openSession: '打开会话', review: '查看确认卡', noScope: '本次配对未授权此范围，请在 Mac 重新选择。', noData: '当前没有记录', terminal: '原生终端', interrupt: '中断', takeover: '接管', mac: '此操作目前请回 Mac 完成。不会新建或替换原生会话。', pair: '配对手机', pairLabel: 'Mac 显示的配对口令', pairHelp: '仅显示 Mac 明确授权的会话和空间。', logout: '撤销此手机并退出', locked: '尚未配对或授权已失效', offline: '连接未确认；保留草稿，刷新核对。不会自动重发。', complete: '操作已完成', 'not-sent': '未执行，输入已保留', unconfirmed: '结果未确认，请查原回执，勿重复发送', receipt: '查询原回执', oldPair: '旧配对的回执，请回 Mac 核对', pending: '待你批准', approve: '批准本次', deny: '拒绝', scope: '范围', action: '操作', from: '来源', duration: '有效期', expired: '已过期 · 未执行', verifyMac: '手机敏感批准尚未启用，请在 Mac 验证本人并确认。', verifyDeadline: '由 Mac 核验', back: '回原会话', terminalOnly: '原生终端目前仅在 Mac 可用。', answer: '提交回答', question: '当前原生问题', ack: '知道了', export: '导出', sameBell: '和桌面小铃铛同一份提醒。', bellNote: '数量包含有效待确认和等你处理的提醒；敏感批准仍在 Mac 上完成。', operations: '操作记录', steward: '大管家记录', age: '块记录早于 30 天', size: '记录总量超过提醒线', unreadable: '记录暂时无法读取', unavailable: '记录源当前不可用', source: '同一份 NAW 状态', omit: '较早消息未显示，请回 Mac 查看完整历史或附件。', unchanged: '取消保留任务历史。', skip: '跳到内容', butler: '大管家', butlerNote: '未在本次配对授权内', command: '原生命令请回 Mac 输入；草稿已保留。', storage: '此浏览器未能保存输入，发送已暂停。', newSession: '新建会话', newSpace: '新建空间', noNative: '请在 Mac 处理此原生问题。' },
    en: { home: 'Workspace', chat: 'Chat', space: 'Spaces', queue: 'Queue', confirm: 'Confirm action', reminders: 'Reminders', sessions: 'Sessions', members: 'Members', connected: 'Connected to NAW', synced: 'Last synced', refresh: 'Refresh', manage: 'Manage', close: 'Close', send: 'Send ↑', message: 'Write a message…', draft: 'Draft stays in this browser', idle: 'Idle', working: 'Working', needs: 'Needs you', queued: 'Queued', done: 'Done', cancelled: 'Cancelled', all: 'All', add: 'Add task', task: 'Task', assignee: 'Assign to', any: 'Any available member', cancelTask: 'Cancel task', handled: 'Mark handled', openSession: 'Open session', review: 'Review confirmation', noScope: 'This scope was not granted. Select it again on the Mac.', noData: 'No records to show', terminal: 'Native terminal', interrupt: 'Interrupt', takeover: 'Take over', mac: 'Please complete this action on the Mac for now. No native session is created or replaced.', pair: 'Pair this phone', pairLabel: 'Pairing code shown on your Mac', pairHelp: 'Only sessions and spaces explicitly granted on the Mac are shown.', logout: 'Revoke this phone and sign out', locked: 'Not paired or authorization expired', offline: 'Connection unconfirmed. Keep your draft and refresh to check. Nothing is resent automatically.', complete: 'Action completed', 'not-sent': 'Not executed; input retained', unconfirmed: 'Outcome unconfirmed. Query the original receipt; do not resend.', receipt: 'Query original receipt', oldPair: 'Receipt from an old pairing. Check on the Mac.', pending: 'Awaiting your approval', approve: 'Approve once', deny: 'Deny', scope: 'Scope', action: 'Action', from: 'From', duration: 'Expires', expired: 'Expired · Not executed', verifyMac: 'Sensitive approval on this phone is not enabled. Verify yourself and confirm on the Mac.', verifyDeadline: 'Verified by the Mac', back: 'Back to original session', terminalOnly: 'The native terminal is currently available on the Mac.', answer: 'Submit answer', question: 'Current native question', ack: 'Got it', export: 'Export', sameBell: 'The same reminders as the desktop bell.', bellNote: 'The count includes valid confirmations and reminders awaiting you. Sensitive approvals still use the Mac.', operations: 'Operation records', steward: 'Butler records', age: 'record blocks are over 30 days old', size: 'Record total exceeds the reminder line', unreadable: 'Record cannot currently be read', unavailable: 'Record source unavailable', source: 'The same NAW state', omit: 'Earlier messages are omitted. Open the Mac for full history or attachments.', unchanged: 'Cancelling keeps task history.', skip: 'Skip to content', butler: 'Butler', butlerNote: 'Not granted in this pairing', command: 'Use the Mac for native commands. Your draft is retained.', storage: 'This browser could not save the input. Sending is paused.', newSession: 'New session', newSpace: 'New space', noNative: 'Please handle this native question on the Mac.' },
  };
  Object.assign(words.zh, { submitted: '已提交给原生会话', 'reply-written': '回答已写入', 'awaiting-native': '等待原生接收确认', prepared: '已准备，尚未提交', unknown: '状态未知', ended: '已结束', failed: '失败', removeReceipt: '移除已确认回执', invalidated: '已作废 · 未执行', replaced: '已有新的确认卡' });
  Object.assign(words.en, { submitted: 'Submitted to the native session', 'reply-written': 'Answer written', 'awaiting-native': 'Awaiting native acceptance', prepared: 'Prepared, not submitted', unknown: 'Unknown', ended: 'Ended', failed: 'Failed', removeReceipt: 'Remove confirmed receipt', invalidated: 'No longer valid · Not executed', replaced: 'Replaced by a new confirmation' });
  Object.assign(words.zh, { registerKey: '登记敏感确认凭证', registrationCode: 'Mac 显示的六位登记码', registerHelp: '先在 Mac 发起登记；完成后核对两边公钥指纹，再在 Mac 确认和启用。', registrationReady: '请在 Mac 核对指纹并确认；手机批准仍未启用。', verifyPhone: '每张卡片都需系统验证本人；配对本身不能批准。', verifyFailed: '未完成或结果未确认；请查询回执或回 Mac 核对，不会重发。' });
  Object.assign(words.en, { registerKey: 'Register an approval passkey', registrationCode: 'Six-digit code shown on the Mac', registerHelp: 'Start registration on the Mac. Then compare public-key fingerprints and confirm and enable it on the Mac.', registrationReady: 'Compare the fingerprint and confirm on the Mac. Phone approvals remain disabled.', verifyPhone: 'Each card requires system user verification. Pairing alone cannot approve.', verifyFailed: 'Not completed or outcome unconfirmed. Check the receipt or Mac; nothing is resent.' });
  function mount() {
    const d = global.document, el = id => d.getElementById(id);
    let pairSecret=global.location.hash.startsWith('#pair=')?global.location.hash.slice(6):undefined;
    if (pairSecret !== undefined) global.history.replaceState(null, '', global.location.pathname + '#zh/home');
    let lang = global.location.hash.startsWith('#en/') ? 'en' : 'zh', view = null, locked = true, disconnected = false, busy = false, epoch = 0, route, client, lastReceived = 0, expiryTimer, composeKey = '';
    const storage = { getItem: k => global.localStorage.getItem(k), setItem: (k, v) => global.localStorage.setItem(k, v) };
    const t = key => words[lang][key] || key;
    const node = (tag, value, cls) => { const n = d.createElement(tag); if (value !== undefined) n.textContent = value; if (cls) n.className = cls; return n; };
    const paths = { home: 'm3 10 9-7 9 7v10H3Z M9 20v-7h6v7', space: 'M3 4h8v7H3z M13 4h8v7h-8z M3 13h8v7H3z M13 13h8v7h-8z', queue: 'M4 4h16v16H4Z M8 8h8 M8 12h8 M8 16h5', bell: 'M6 9a6 6 0 0 1 12 0c0 7 3 7 3 8H3c0-1 3-1 3-8Z M10 21h4', back: 'm14 5-7 7 7 7', menu: 'M5 12h.01 M12 12h.01 M19 12h.01' };
    function icon(name) { const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg'), p = d.createElementNS(svg.namespaceURI, 'path'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); p.setAttribute('d', paths[name] || paths.menu); svg.append(p); return svg; }
    function button(label, fn, cls) { const b = node('button', label, cls); b.type = 'button'; if (fn) b.addEventListener('click', () => run(fn)); return b; }
    function link(label, dest, cls) { const a = node('a', label, cls); a.href = '#' + lang + '/' + dest; return a; }
    function toast(key) { el('toast').textContent = words[lang][key] || key; el('toast').hidden = false; }
    function dialog(title, content) { el('dialog-title').textContent = title; el('dialog-body').replaceChildren(typeof content === 'string' ? node('p', content) : content); el('dialog-close').textContent = t('close'); if (!el('dialog').open) el('dialog').showModal(); }
    el('dialog-close').addEventListener('click', () => el('dialog').close());
    el('skip').addEventListener('click', event => { event.preventDefault(); el('content').focus(); });
    async function run(fn) { try { await client.ready; await fn(); } catch { disconnected = true; paint(); toast('offline'); } }
    async function api(url, value, csrf) {
      const response = await global.fetch(url, { method: value === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'X-NAW-Mobile': '1', ...(value === undefined ? {} : { 'Content-Type': 'application/json', 'X-NAW-CSRF': csrf || '' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      const result = await response.json();
      if (!response.ok) { if ([401, 403].includes(response.status)) { locked = true; view = null; paint(); } throw Error(result.error || 'MOBILE_DENIED'); }
      disconnected = false;
      if (url === '/mobile/session') locked = false;
      return result;
    }
    const actions = createWorkspaceActions({ storage, request: api, newId: () => global.crypto.randomUUID(), changed: () => updateCompose() });
    const passkeys = global.NAWMobilePasskeys.create({ storage, request: api });
    Object.assign(words.zh,{finishPair:'完成手机配对',qrEnrollment:'这次二维码授权登记一把批准密钥。尚未激活，不能读取或执行操作。',verifyPair:'使用系统验证完成配对',finishVerified:'完成配对',verifyPairNote:'系统可能提示创建凭据及再次验证。每张敏感卡仍须单独验证。',basicPair:'先使用基础权限',basicPairNote:'敏感批准保持关闭。新手机完成后，旧手机才断开。',cancelPair:'取消本次配对',pairUnconfirmed:'验证取消或结果未确认。请刷新核对；可回 Mac 重新出码，或明确选择基础权限。不会自动启用敏感批准。'});
    Object.assign(words.en,{finishPair:'Complete phone pairing',qrEnrollment:'This QR code authorizes one approval key. Nothing can be read or executed until activation.',verifyPair:'Complete pairing with system verification',finishVerified:'Complete pairing',verifyPairNote:'The system may ask you to create a credential and verify again. Each sensitive card still requires its own verification.',basicPair:'Use basic access first',basicPairNote:'Sensitive approvals stay off. The old phone disconnects only after this phone completes pairing.',cancelPair:'Cancel this pairing',pairUnconfirmed:'Verification cancelled or unconfirmed. Refresh to check, get a new code on the Mac, or explicitly choose basic access. Sensitive approval is never enabled automatically.'});
    let pairingNotice=false,pairingBusy=false;
    words.zh.bellNote='数量来自桌面同一份提醒。敏感卡需逐张系统验证；未启用或不支持的操作请回 Mac。';
    words.en.bellNote='The count uses the same desktop reminders. Sensitive cards require individual system verification; use the Mac when not enabled or supported.';
    client = global.NAWMobile.createMobileClient({ request: api, storage, newId: () => global.crypto.randomUUID(), onChange: () => updateCompose() });
    const push = global.NAWMobilePush?.create({ request: api, session: () => client.state.session });
    Object.assign(words.zh, { pushTitle: '手机通知', pushEnable: '开启提醒', pushDisable: '关闭提醒', pushNote: '只发送提醒数量，不含名字或正文。通知可能延迟；打开后以当前记录为准。', pushHome: 'iPhone 请先从 Safari 添加到主屏幕，再从主屏幕打开。需要 iOS 16.4 或更新版本。', pushUnsupported: '当前浏览器未提供推送能力。iPhone 请添加到主屏幕后打开。', pushOff: '尚未开启', pushSubscribed: '已登记，尚未提交提醒', pushAccepted: '已交给推送服务，未确认手机送达', pushDelayed: '提交未确认，通知可能延迟；请刷新查看当前提醒', pushExpired: '订阅已失效，请重新开启', pushDenied: '通知权限未允许，请在系统设置中核对', pushUnknown: '设置结果未确认，请刷新核对；需要时在 Mac 撤销此手机' });
    Object.assign(words.en, { pushTitle: 'Phone notifications', pushEnable: 'Enable reminders', pushDisable: 'Disable reminders', pushNote: 'Only the reminder count is sent, without names or content. Notifications may be delayed; open NAW for current records.', pushHome: 'On iPhone, add this page to the Home Screen in Safari, then open it there. Requires iOS 16.4 or later.', pushUnsupported: 'Push is unavailable in this browser. On iPhone, add NAW to the Home Screen and open it there.', pushOff: 'Not enabled', pushSubscribed: 'Registered; no reminder submitted yet', pushAccepted: 'Accepted by the push service; phone delivery unconfirmed', pushDelayed: 'Submission unconfirmed; notifications may be delayed. Refresh for current reminders.', pushExpired: 'Subscription expired; enable again', pushDenied: 'Notification permission was not granted. Check system settings.', pushUnknown: 'Setting unconfirmed. Refresh to check, or revoke this phone on the Mac.' });
    function avatar(s) { return node('span', (s.provider || 'N').slice(0, 1).toUpperCase(), 'avatar ' + (['claude', 'codex', 'deepseek'].includes(s.provider) ? s.provider : '')); }
    const providerName = name => ({ claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' })[name] || name || 'NAW';
    const stateText = s => t(({ idle: 'idle', working: 'working', starting: 'working', approval: 'needs', queued: 'queued', sent: 'working', waiting: 'needs', done: 'done', cancelled: 'cancelled' })[s] || s || 'idle');
    function receipts(container) {
      const native = (client.state.pending || []).map(p => ({ ...p, native: true }));
      for (const row of [...native, ...actions.state.pending]) {
        const item = node('div', undefined, 'receipt'); item.append(node('p', row.deviceId !== client.state.session?.deviceId ? t('oldPair') : t(row.status)));
        if (row.deviceId === client.state.session?.deviceId && !['complete', 'submitted', 'reply-written', 'not-sent'].includes(row.status)) item.append(button(t('receipt'), async () => { if (row.native) await client.receipt(row.requestId); else await actions.receipt(client.state.session, row); await refresh(); }));
        if (['complete', 'submitted', 'reply-written', 'not-sent'].includes(row.status)) item.append(button(t('removeReceipt'), () => { if (row.native) client.forget(row.requestId); else actions.forget(row); paint(); }));
        container.append(item);
      }
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
        finally{pairingBusy=false;paint();}
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
    function home() {
      heading('home'); const butler = button('', () => dialog(t('butler'), t('noScope')), 'box row butler-entry'), body = node('div', undefined, 'row-main');
      body.append(node('strong', t('butler')), node('p', t('butlerNote'))); butler.append(avatar({}), body, node('span', '›', 'chev')); el('content').append(butler);
      const sessions = section(t('sessions'), view.sessions.length, 'newSession'), box = node('div', undefined, 'box');
      for (const s of view.sessions) { const a = link('', 'chat/' + encodeURIComponent(s.id), 'row'), main = node('div', undefined, 'row-main'); main.append(node('strong', s.name), node('p', providerName(s.provider))); a.append(avatar(s), main, node('span', stateText(s.question ? 'approval' : s.state), 'tag ' + (s.state === 'working' && !s.question ? 'work' : 'neutral'))); box.append(a); }
      if (!view.sessions.length) box.append(node('p', t('noData'))); sessions.append(box); roomList(section(t('space'), view.rooms.length, 'newSpace'));
    }
    function thread(rows, container) {
      for (const m of rows || []) {
        const human = ['human', 'user'].includes(m.role), article = node('article', undefined, 'message' + (human ? ' human' : '')), body = node('div', undefined, 'message-body'), author = node('div', undefined, 'author');
        const s = view.sessions.find(s => s.name === m.name) || { provider: 'codex' };
        author.append(node('span', human ? (lang === 'zh' ? '你' : 'You') : m.name || s.name || 'NAW'));
        if (m.time) { const time = node('time', new Date(m.time).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' })); time.dateTime = new Date(m.time).toISOString(); author.append(time); }
        const bubble = node('div', m.text || '', 'bubble');
        if (m.kind === 'background-operation') { const card = view.confirmations.find(c => c.id === m.confirmationId); if (card) { bubble.replaceChildren(node('strong', card.title), link(t('review') + ' ›', 'confirm/' + encodeURIComponent(card.id), 'text-link')); } }
        if (m.attachments || m.textOmitted) bubble.append(node('p', t('omit'), 'small-note'));
        body.append(author, bubble); if (!human) article.append(avatar(s)); article.append(body); container.append(article);
      }
      if (!rows?.length) container.append(node('p', t('noData'), 'quiet'));
    }
    function tabs(items, container = el('content')) { const bar = node('div', undefined, 'tabs'); for (const [label, dest, active] of items) bar.append(link(label, dest, active ? 'selected' : '')); container.append(bar); }
    function chat() {
      const s = view.sessions.find(s => s.id === route.id); if (!s) { heading('chat'); el('content').append(node('p', t('noScope'))); return; }
      tabs([[t('chat'), 'chat/' + encodeURIComponent(s.id), true]]); const terminal = button(t('terminal'), () => dialog(t('terminal'), t('terminalOnly'))); el('content').querySelector('.tabs').append(terminal);
      const controls = node('div', undefined, 'control-strip');
      controls.append(
        button(t('interrupt'), () => dialog(t('interrupt'), t('mac')), 'danger'),
        button(t('takeover'), () => dialog(t('takeover'), t('mac'))),
      ); el('content').append(controls);
      const rows = node('div', undefined, 'thread'); thread(s.messages, rows); el('content').append(rows);
      if (s.earlierMessagesOmitted) el('content').append(node('p', t('omit'), 'small-note'));
      if (client.state.row?.question && client.state.selected === s.id) el('content').append(link(t('question') + ' ›', 'confirm/native/' + encodeURIComponent(s.id), 'link-row'));
      receipts(el('content'));
    }
    function space() {
      if (!route.id) { heading('space'); roomList(el('content')); return; }
      const r = view.rooms.find(r => r.id === route.id); if (!r) { heading('space'); el('content').append(node('p', t('noScope'))); return; }
      tabs([[t('chat'), 'space/' + r.id, true], [t('queue') + ' ' + r.queue.length, 'queue/' + r.id, false]]);
      const members = node('div', r.members.map(s => s.name).join(' / '), 'callout'); members.id = 'room-members'; el('content').append(members);
      const rows = node('div', undefined, 'thread'); thread(r.messages, rows); el('content').append(rows);
      el('content').append(button('+ ' + t('add'), () => addTask(r), 'primary'));
    }
    function addTask(room) {
      const form = node('form'); form.method = 'post'; form.action = '/mobile/workspace/action';
      const input = node('textarea'); input.id = 'new-task-text'; input.name = 'text'; input.maxLength = 6000; input.required = true; const label = node('label', t('task')); label.htmlFor = input.id;
      const select = node('select'); select.id = 'new-task-assignee'; select.name = 'assignee'; const any = node('option', t('any')); any.value = ''; select.append(any);
      for (const s of room.members) { const option = node('option', s.name); option.value = s.id; select.append(option); }
      const assigned = node('label', t('assignee')); assigned.htmlFor = select.id;
      const send = node('button', t('add'), 'primary'); send.type = 'submit'; form.append(label, input, assigned, select, send);
      form.addEventListener('submit', event => { event.preventDefault(); run(async () => { const original = input.value; send.disabled = true; try { const result = await actions.act(client.state.session, { action: 'queueAdd', roomId: room.id, text: original, assignee: select.value || null }); toast(result.status); if (result.status === 'complete' && input.value === original) el('dialog').close(); await refresh(); } finally { send.disabled = false; } }); }); dialog(t('add'), form);
    }
    function queue() {
      const r = view.rooms.find(r => r.id === route.id) || view.rooms[0]; heading('queue');
      if (!r) { el('content').append(node('p', t('noScope'))); return; }
      el('content').append(node('h2', r.name)); const filters = node('div', undefined, 'tabs'), list = node('div');
      function show(filter) { list.replaceChildren(); for (const i of r.queue.filter(i => filter === 'all' || (filter === 'working' ? i.status === 'sent' : i.status === 'queued'))) {
        const card = node('article', undefined, 'queue-card'); card.dataset.itemId = i.id; const meta = node('div', undefined, 'queue-meta'); meta.append(node('span', stateText(i.status), 'tag ' + (i.status === 'sent' ? 'work' : 'neutral')), node('span', r.members.find(s => s.id === (i.sentTo || i.assignee))?.name || t('any'), 'small-author'));
        card.append(meta, node('h3', i.text), node('p', i.reply || i.reason || '', 'quiet')); const bottom = node('div', undefined, 'queue-bottom');
        if (view.sessions.some(s => s.id === (i.sentTo || i.assignee))) bottom.append(link(t('openSession'), 'chat/' + (i.sentTo || i.assignee)));
        if (i.status === 'queued' || i.status === 'waiting') bottom.append(button(t(i.status === 'queued' ? 'cancelTask' : 'handled'), async () => { const result = await actions.act(client.state.session, { action: i.status === 'queued' ? 'queueCancel' : 'queueResolve', roomId: r.id, itemId: i.id }); toast(result.status); await refresh(); }));
        card.append(bottom); list.append(card);
      } if (!list.childElementCount) list.append(node('p', t('noData'), 'quiet')); }
      for (const key of ['all', 'working', 'queued']) filters.append(button(t(key), () => show(key)));
      el('content').append(filters, list, button('+ ' + t('add'), () => addTask(r), 'primary'), node('p', t('unchanged'), 'small-note')); show('all'); receipts(el('content'));
    }
    function nativeQuestion() {
      heading('confirm'); const row = client.state.row;
      if (!row?.question || client.state.selected !== route.nativeId) { el('content').append(node('p', t('noNative'))); return; }
      const form = node('form', undefined, 'card-detail native-question'), fields = []; form.method = 'post'; form.action = '/mobile/answer';
      for (const [index, q] of row.question.questions.entries()) { const fieldset = node('fieldset'), inputs = []; fieldset.append(node('legend', q.question));
        for (const option of q.options) { const label = node('label'), input = node('input'); input.type = q.multiSelect ? 'checkbox' : 'radio'; input.name = 'question-' + index; input.value = option.label; if (!q.multiSelect) input.required = true; label.append(input, node('span', option.label + (option.description ? ' · ' + option.description : ''))); inputs.push(input); fieldset.append(label); }
        fields.push({ q, inputs }); form.append(fieldset);
      }
      const submit = node('button', t('answer'), 'primary'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', event => { event.preventDefault(); run(async () => { submit.disabled = true; try { const answers = Object.fromEntries(fields.map(({ q, inputs }) => [q.id || q.question, inputs.filter(i => i.checked).map(i => i.value)])); await client.answer(answers); const result = client.state.pending.at(-1); toast(result?.status || 'unconfirmed'); await refresh(); } finally { submit.disabled = false; } }); }); el('content').append(form); receipts(el('content'));
    }
    function confirmation() {
      if (route.nativeId) { nativeQuestion(); return; }
      const card = view.confirmations.find(c => c.id === route.id);
      if (!card) { heading('confirm'); for (const c of view.confirmations) el('content').append(link(c.titles?.[lang] || c.title, 'confirm/' + encodeURIComponent(c.id), 'link-row')); if (!view.confirmations.length) el('content').append(node('p', t('noData'))); return; }
      const box = node('article', undefined, 'card-detail'), expired = card.disposition === 'expired' || card.state === 'confirmation-required' && card.expiresAt !== null && card.expiresAt <= view.syncedAt + (global.performance.now() - lastReceived);
      box.dataset.confirmationId = card.id;
      // A presentation deadline alone is not a backend receipt. F's explicit
      // expired disposition can say not-executed; a locally elapsed deadline
      // asks the person to check the Mac instead of inventing that outcome.
      const stateLabel = card.afterStart && (card.disposition || card.state === 'cancelled') ? (lang === 'zh' ? '后续未执行；此前步骤的结果请回 Mac 核对' : 'Remaining work not executed; check earlier results on the Mac') : expired ? card.disposition === 'expired' ? t('expired') : lang === 'zh' ? '已过期 · 请回 Mac 核对' : 'Expired · Check on the Mac' : card.disposition === 'invalidated' ? t('invalidated') : card.state === 'confirmation-required' ? t('pending') : t(({ received: 'submitted', 'not-executed': 'not-sent' })[card.state] || card.state);
      box.append(node('p', card.actorName, 'source'), node('h1', card.titles?.[lang] || card.title), node('p', stateLabel, expired ? 'sync-error' : 'quiet'));
      const facts = node('dl', undefined, 'facts'); for (const [key, value] of [['scope', card.detail], ['from', card.actorName], ['duration', card.expiresAt ? new Date(card.expiresAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en') : t('verifyDeadline')]]) { const row = node('div'); row.append(node('dt', t(key)), node('dd', value)); facts.append(row); } box.append(facts);
      const pending = passkeys.pending.find(p => p.id === card.id && p.status === 'unconfirmed');
      const buttons = node('div', undefined, 'confirm-actions');
      for (const key of ['deny', 'approve']) {
        const b = button(t(key), async () => {
          for (const button of buttons.children) button.disabled = true;
          try { const result = await passkeys.decide(client.state.session, card, key); toast(result.status); }
          catch { toast('verifyFailed'); }
          await refresh();
        }, key === 'approve' ? 'primary' : '');
        b.id = 'consent-' + key; b.disabled = !card.canDecide || expired || Boolean(pending) || passkeys.busy; buttons.append(b);
      }
      box.append(buttons, node('p', t(card.canDecide ? 'verifyPhone' : 'verifyMac'), 'auth-note'));
      if (pending) box.append(button(t('receipt'), async () => { try { const result = await passkeys.receipt(client.state.session, pending); toast(result.status); } catch { toast('verifyFailed'); } await refresh(); }));
      el('content').append(box, link(t('back') + ' ›', 'chat/' + encodeURIComponent(card.sessionId), 'link-row'));
      if (!expired && card.expiresAt) expiryTimer = global.setTimeout(paint, Math.max(1, Math.min(2147483647, card.expiresAt - view.syncedAt - (global.performance.now() - lastReceived))));
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
        const actionsBar = node('div', undefined, 'reminder-actions'); actionsBar.append(button(t('export'), () => dialog(t('export'), t('mac'))), button(t('ack'), async () => { const result = await actions.act(client.state.session, { action: 'recordAcknowledge', record: r.record, kind: i.kind, level: i.level }); toast(result.status); await refresh(); })); card.append(actionsBar); el('content').append(card);
      }
      if (!view.reminders.count) el('content').append(node('p', t('noData'), 'quiet'));
    }
    function updateCompose() {
      if (!client) return;
      const active = !locked && route?.page === 'chat' && view?.sessions.some(s => s.id === route.id); el('compose').hidden = !active; d.body.classList.toggle('with-compose', Boolean(active));
      if (!active) { composeKey = ''; return; }
      if (composeKey !== route.id) {
        composeKey = route.id; el('compose').replaceChildren(); const inner = node('div', undefined, 'compose-inner'), label = node('label', t('chat'), 'quiet'), input = node('textarea'); input.id = 'message'; input.name = 'text'; input.maxLength = 16000; input.placeholder = t('message'); label.htmlFor = input.id;
        input.addEventListener('input', () => { try { client.setDraft(input.value); } catch { toast('storage'); } }); const tools = node('div', undefined, 'compose-tools'), send = node('button', t('send'), 'primary'); send.id = 'send-message'; send.type = 'submit'; tools.append(node('span', t('draft'), 'small-note'), send); inner.append(label, input, tools); el('compose').append(inner);
      }
      const input = el('message'), state = client.state; if (input.value !== state.draft) input.value = state.draft;
      el('send-message').disabled = disconnected || state.busy || state.storageError || !state.row?.canSend || state.selected !== route.id || !state.draft.trim() || state.pending.some(p => p.deviceId === state.session?.deviceId && p.sessionId === state.selected && !['submitted', 'reply-written', 'not-sent'].includes(p.status));
    }
    el('compose').addEventListener('submit', event => { event.preventDefault(); run(async () => { const text = client.state.draft; if (/^[!#/]/.test(text.normalize('NFKC').replace(/^[\s\p{Cc}\p{Default_Ignorable_Code_Point}]+/u, ''))) { toast('command'); return; } await client.send(); toast(client.state.pending.at(-1)?.status || 'unconfirmed'); await refresh(); }); });
    function paint() {
      global.clearTimeout(expiryTimer); el('content').replaceChildren(); el('top').replaceChildren(); el('connection').replaceChildren(); el('navigation').replaceChildren();
      d.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; d.title = (route ? t(route.page) : t('home')) + ' · NAW'; el('skip').textContent = t('skip'); el('dialog-close').textContent = t('close');
      if (!route || route.page === 'home') { const homeLink = link('', 'home', 'brand'); homeLink.append(node('span', 'N', 'mark'), node('span', 'NAW')); el('top').append(homeLink, node('span', '', 'grow')); }
      else { const back = link('', 'home', 'icon'); back.setAttribute('aria-label', t('home')); back.append(icon('back')); const title = node('div', route.page === 'chat' ? view?.sessions.find(s => s.id === route.id)?.name || t('chat') : route.page === 'space' ? view?.rooms.find(r => r.id === route.id)?.name || t('space') : t(route.page), 'top-title'); el('top').append(back, title); }
      const pendingPair=client.state.session?.candidate===true;
      const bell = link('', 'reminders', 'icon bell'); bell.hidden=pendingPair;bell.setAttribute('aria-label', t('reminders') + ' · ' + (view?.reminders?.count || 0)); bell.append(icon('bell')); if (view?.reminders?.count) bell.append(node('span', view.reminders.count, 'count')); el('top').append(bell, button('···', () => { const menu = node('div', undefined, 'dialog-menu'); menu.append(button(t('refresh'), refresh));if(!pendingPair)menu.append(button(t('registerKey'), registerPasskey));menu.append(button(t(pendingPair?'cancelPair':'logout'), async () => { await client.logout(); locked = true; view = null; el('dialog').close(); paint(); })); dialog(t('manage'), menu); }, 'icon'));
      el('top').lastElementChild.setAttribute('aria-label', t('manage'));
      const status = node('span', locked ? t('locked') : disconnected ? t('offline') : pendingPair?t('finishPair'):t('connected') + (view?.syncedAt ? ' · ' + new Date(view.syncedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }) : ''), 'sync-time'); status.id = 'sync-status'; el('connection').append(status, button(t('refresh'), refresh)); const language = link(lang === 'zh' ? 'English' : '中文', (route?.page || 'home') + (route?.id ? '/' + encodeURIComponent(route.id) : '')); language.href = '#' + (lang === 'zh' ? 'en' : 'zh') + '/' + (route?.nativeId ? 'confirm/native/' + encodeURIComponent(route.nativeId) : (route?.page || 'home') + (route?.id ? '/' + encodeURIComponent(route.id) : '')); language.id = 'language-link'; el('connection').append(language);
      el('navigation').hidden = locked || client.state.session?.candidate===true;
      if (locked || !client.state.session) { login(); updateCompose(); return; }
      if(client.state.session.candidate){candidate();updateCompose();return;}
      const nav = node('div', undefined, 'nav-inner'); for (const key of ['home', 'space', 'queue']) { const a = link('', key, route?.page === key ? 'active' : ''); a.append(icon(key), node('span', t(key))); if (route?.page === key) a.setAttribute('aria-current', 'page'); nav.append(a); } el('navigation').append(nav);
      if (!view) { el('content').append(node('p', t('offline'))); updateCompose(); return; }
      ({ home, chat, space, queue, confirm: confirmation, reminders }[route?.page] || home)(); updateCompose();
    }
    async function refresh() {
      if (busy) return; busy = true; const ticket = ++epoch;
      try { await client.start(); if (!locked && client.state.session) await client.refresh(); if (locked || !client.state.session) { view = null; return; }
        if(client.state.session.candidate){view=null;return;}
        const next = client.state.session.workspace ? await api('/mobile/workspace') : { sessions: client.state.session.sessions.filter(s => s.available).map(s => ({ ...s,
          messages: client.state.row?.id === s.id ? client.state.row.messages.map(m => ({ ...m, role: 'assistant', name: s.name, attachments: m.unsupportedAttachments })) : [],
          earlierMessagesOmitted: client.state.row?.id === s.id ? client.state.row.earlierMessagesOmitted : 0 })), rooms: [], confirmations: [], reminders: null, syncedAt: Date.now() };
        if (ticket !== epoch) return; view = next; lastReceived = global.performance.now();
        if (push && next.reminders && next.capabilities?.push !== false) await push.read();
      } catch { disconnected = true; toast('offline'); } finally { if (ticket === epoch) { busy = false; paint(); } }
    }
    async function navigate() {
      d.documentElement.dataset.loading = 'true';
      // Opening a fresh pairing link in an already-open phone tab is also a
      // pairing gesture. Consume it before requests or storage, just as at boot.
      if (global.location.hash.startsWith('#pair=')) {
        const secret = global.location.hash.slice(6);
        global.history.replaceState(null, '', global.location.pathname + '#' + lang + '/home');
        await client.start(secret);
      }
      const parts = global.location.hash.slice(1).split('/'); lang = parts[0] === 'en' ? 'en' : 'zh';
      route = { page: ['home', 'chat', 'space', 'queue', 'confirm', 'reminders'].includes(parts[1]) ? parts[1] : 'home', id: parts[2] ? decodeURIComponent(parts[2]) : null, nativeId: parts[1] === 'confirm' && parts[2] === 'native' ? decodeURIComponent(parts[3] || '') : null };
      d.documentElement.dataset.page = route.page;
      d.documentElement.dataset.route = global.location.hash;
      composeKey = ''; el('toast').hidden = true; paint();
      const id = route.page === 'chat' ? route.id : route.nativeId;
      if (id && client.state.session?.sessions.some(s => s.id === id)) await client.select(id);
      await refresh(); paint(); d.documentElement.dataset.loading = 'false';
    }
    let navigation = Promise.resolve();
    const scheduleNavigate = () => (navigation = navigation.then(navigate, navigate));
    global.addEventListener('hashchange', () => run(scheduleNavigate));
    client.ready = (async () => {try{await client.start(pairSecret);}finally{pairSecret=undefined;}await scheduleNavigate(); })(); paint();
    return { client, actions, refresh, navigate };
  }
  const exported = { createWorkspaceActions, ACTION_KEY, mount };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else { global.NAWMobileWorkspace = exported; global.nawPhone = mount(); }
})(globalThis);
