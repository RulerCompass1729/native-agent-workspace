/* Views consume session capabilities; they never own native processes. */
const api = window.workspace;
const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const button = (text, action, cls) => { const el = node('button', text, cls); el.type = 'button'; el.addEventListener('click', () => attempt(action)); return el; };
const states = { starting: '正在启动', idle: '就绪', working: '正在工作', approval: '等待确认', stopping: '等待原生退出确认', disconnected: '已断开 · 原生尚未释放', recoverable: '等待恢复', ended: '已结束', error: '需要检查' };
let state, owner, selected = '', mode = 'terminal', preference = 'terminal', folder = '', disconnected = false;
let roomSession = '', selectionRevision = 0;
let terminalDisplay = { fontSize: 14, palette: 'dark' };
const terminalThemes = {
  dark: { background: '#191b1e', foreground: '#e6e8eb', cursor: '#e6e8eb', selectionBackground: '#53677b88' },
  green: { background: '#20261f', foreground: '#eef2e8', cursor: '#e0edc9', selectionBackground: '#637a5988' },
};
let toastTimer, lastMessages = '', lastRoomMessages = '', rendering = false;
const terminals = new Map();
const activeSessionId = () => selected === 'room' ? roomSession : selected;
const current = () => state?.sessions.find(s => s.id === activeSessionId());
const members = () => state?.sessions.filter(s => s.roomId === 'shared') || [];
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
async function attempt(action) { try { return await action(); } catch (error) { toast(error.message || '操作未完成。'); } }
function persistView() { return api.viewState({ selected, mode, preference, roomSession, terminalDisplay, sharedDraft: $('shared-input').value }); }
function icon(provider) { return node('span', provider === 'claude' ? 'Cl' : 'Cx', `agent-icon ${provider}`); }
function select(id, requestedMode) {
  selectionRevision++;
  selected = id; const s = current();
  if (selected === 'room') mode = 'terminal'; else if (requestedMode) mode = requestedMode; else if (s) mode = s.owner === owner ? s.view : preference;
  $('message-input').value = s?.liveDraft || '';
  lastMessages = ''; lastRoomMessages = ''; render(); attempt(persistView);
  if (s && mode === 'terminal' && !['ended', 'stopping', 'disconnected', 'recoverable'].includes(s.state)) attempt(async () => { await ensureTerminal(s.id); focusTerminal(s.id); });
  if (selected === 'room' && s?.owner === owner && s.view !== 'terminal') attempt(() => api.claim(s.id, 'terminal'));
}
function selectRoom(id = '') { roomSession = id; select('room'); }
async function detach(id) {
  const nextMode = current()?.id === id ? mode : 'terminal';
  const revision = selectionRevision;
  await api.join(id, false);
  // Membership arrives through the state stream. Do not overwrite newer state
  // or pull a person back after they have already selected another view.
  if (roomSession === id) roomSession = '';
  if (revision !== selectionRevision) { await persistView(); return; }
  select(id, nextMode);
  const s = current(); if (s?.owner === owner && s.view !== nextMode) await api.claim(id, nextMode);
}
function focusTerminal(id = activeSessionId()) {
  if (id === activeSessionId() && mode === 'terminal' && !document.querySelector('dialog[open]')) terminals.get(id)?.term.focus();
}
function applyTerminalDisplay() {
  const theme = terminalThemes[terminalDisplay.palette];
  $('terminal-area').style.backgroundColor = theme.background;
  for (const entry of terminals.values()) { entry.term.options.fontSize = terminalDisplay.fontSize; entry.term.options.theme = { ...theme }; }
  fitTerminal(activeSessionId());
}
function pasteTerminal(text) {
  const s = current(), entry = terminals.get(activeSessionId());
  if (!s || s.owner !== owner || s.view !== 'terminal' || !entry?.ready || disconnected) throw new Error('请先连接并接管这个终端。');
  if (!text) return;
  if (text.length > 65500) throw new Error('粘贴内容过长，请分段粘贴。');
  if (/[\r\n]/.test(text) && !entry.term.modes.bracketedPasteMode) throw new Error('原生程序尚未启用多行粘贴保护，请先分行粘贴。');
  entry.term.paste(text); focusTerminal();
}
async function showTrust() {
  const snapshot = await api.initial();
  const content = $('trust-status'); content.replaceChildren();
  const section = (title, text) => { const item = node('section'); item.append(node('h3', title), node('p', text)); content.append(item); return item; };
  section('数据去向', '会话副本和草稿保存在本机。你发出的任务由所选原生服务处理；工具还可能访问其他网站。加入协作不会自动分享私人历史。');
  section('模型调用与费用', '外壳未启用自动标题、摘要或模型路由。一轮核查最多交接 3 次回复；原生工具和子 agent 的用量不受这个次数上限限制。');
  const dispatches = snapshot.diagnostics?.dispatches;
  section('本次后台运行的派发计数', `${Number.isSafeInteger(dispatches) ? dispatches + ' 次' : '未报告'}。只计通过应用发送与交接的消息，不含原生终端直接输入，也不代表总模型调用或费用；后台重启后重新计数。`);
  const usage = section('原生报告的用量', '以下是原生接口报告的累计 token；可能延迟或缺少子任务，不是账单。金额请在原生提供商账户核对。');
  for (const s of snapshot.sessions) {
    const total = s.usage?.total;
    const count = key => Number.isFinite(total?.[key]) ? total[key].toLocaleString() : '未报告';
    usage.append(node('p', `${s.name}：${total ? `输入 ${count('inputTokens')} · 缓存输入 ${count('cachedInputTokens')} · 输出 ${count('outputTokens')}` : '未报告；不能据此判断为零'}`));
  }
  if (!snapshot.sessions.length) usage.append(node('p', '尚无会话。'));
  section('后台与权限', `${snapshot.sessions.filter(s => !['ended', 'recoverable'].includes(s.state)).length} 个会话尚未确认结束。关闭窗口仍可能继续执行。原生进程、团队状态与权限请在终端核对；此处未测量 CPU、内存或完整网络出口。`);
  section('版本与核查', `应用 ${snapshot.appVersion || '未报告'} · 后台 ${snapshot.runtimeVersion || '未报告'}。可查看本机数据和公开实现。本地版本号不是签名验证；独立安全审计、完整流量与费用对账尚未完成。`);
  if (!$('privacy-dialog').open) $('privacy-dialog').showModal();
}
function openCreate(provider = 'claude') {
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
  $('initial-view').value = preference; $('session-name').value = '';
  $('chosen-folder').textContent = folder; createReadiness(); $('create-dialog').showModal();
}
function createReadiness() {
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const ready = state.preflight?.python && state.preflight?.[provider];
  $('confirm-create').disabled = !ready;
  $('create-readiness').textContent = ready ? '' : '还需要安装所选 agent 或 Python 3。点击“检查安装”查看入口。';
}
async function showSetup() {
  state.preflight = await api.preflight();
  const entries = [['claude', 'Claude Code', 'https://code.claude.com/docs/en/setup'], ['codex', 'Codex CLI', 'https://developers.openai.com/codex/cli/'], ['python', 'Python 3', 'https://www.python.org/downloads/macos/']];
  $('setup-status').replaceChildren(...entries.map(([key, label, url]) => {
    const row = node('p', `${label}：${state.preflight[key] ? '已找到' : '尚未找到'} `);
    row.append(button('官方安装说明', () => api.openExternal(url))); return row;
  }));
  $('version-info').textContent = `应用 ${state.appVersion || '开发版'} · 后台 ${state.runtimeVersion || '旧版（会话保留中）'}。安装或替换应用后可点“重新检查”。`;
  createReadiness(); if (!$('setup-dialog').open) $('setup-dialog').showModal();
}
function populateSelect(el, items) {
  const old = el.value;
  const signature = items.map(s => s.id + s.name).join('|');
  if (el.dataset.signature === signature) return;
  el.replaceChildren(...items.map(s => { const option = node('option', s.name); option.value = s.id; return option; }));
  el.dataset.signature = signature;
  if (items.some(s => s.id === old)) el.value = old;
}
function messageList(el, messages, room = false) {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  ui.clearMarkdown(el);
  el.replaceChildren();
  if (!messages.length) { el.append(node('p', room ? '选择需要一起完成的任务。这里只显示共享的内容。' : '从这里开始。你也可以随时使用同一个会话的原生终端。', 'message empty')); return; }
  for (const m of messages) {
    const item = node('article', undefined, `message ${m.role}`); item.dataset.messageId = m.id;
    const heading = node('div', undefined, 'message-heading');
    heading.append(node('strong', m.name || (m.role === 'user' ? '你' : current()?.provider === 'claude' ? 'Claude' : 'Codex')));
    if (['awaiting-native', 'unconfirmed', 'streaming'].includes(m.status)) heading.append(node('span', { 'awaiting-native': '等待原生确认', unconfirmed: '提交结果未确认', streaming: '正在回复' }[m.status]));
    const body = node('div', undefined, 'message-body'); item.append(heading, body);
    if (m.role === 'assistant') ui.markdown(body, m.text, m.status === 'streaming'); else body.textContent = m.text;
    const actions = node('div', undefined, 'message-actions');
    actions.append(button('复制', () => api.copy(m.text)), button('选择并分享', () => share(m.text)));
    item.append(actions); el.append(item);
  }
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function share(text) {
  if (!members().length) return toast('先把接收方加入共同工作，再分享选定内容。');
  $('share-text').value = text; populateSelect($('share-recipient'), members()); $('share-dialog').showModal();
}
function render() {
  if (!state || rendering) return;
  rendering = true;
  try {
    // A member may leave in another window. Keep its existing session in view.
    if (selected === 'room' && roomSession && !members().some(s => s.id === roomSession)) {
      selected = state.sessions.some(s => s.id === roomSession) ? roomSession : 'room';
      roomSession = ''; attempt(persistView);
    }
    const s = current(); const inRoom = selected === 'room';
    const slot = inRoom ? $('room-session') : $('solo-session');
    if ($('session-view').parentElement !== slot) slot.append($('session-view'));
    $('solo-session').hidden = inRoom || !s;
    $('room-session').hidden = !s;
    $('room-record-view').hidden = Boolean(s);
    $('room-scope').hidden = !s;
    $('chat-tab').parentElement.hidden = inRoom;
    document.title = `${s?.name || 'Native Workspace'} — Native Agent Workspace`;
    $('welcome').hidden = Boolean(s || inRoom); $('session-view').hidden = !s; $('room-view').hidden = !inRoom;
    $('title').textContent = inRoom ? '共同工作' : s?.name || '你的工作空间';
    $('subtitle').textContent = s ? `${s.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${s.model} · ${s.roomId ? '协作中，也可单独操作' : '独立会话'}` : inRoom ? '你决定谁参与、分享什么、什么时候停。' : '从一个会话开始，需要时再邀请另一个。';
    const warning = disconnected ? '本地服务断开。草稿已保留，不会自动重发输入。' : state.storageWarning;
    $('alert').hidden = !warning; $('alert').textContent = warning || '';
    $('reconnect-button').hidden = !disconnected;
    $('session-list').replaceChildren(...state.sessions.map(record => {
      const link = button('', () => select(record.id), `session-link${record.id === selected ? ' active' : ''}`);
      link.dataset.sessionId = record.id; link.draggable = true;
      const labelText = `${record.name} · ${record.provider === 'claude' ? 'Claude' : 'Codex'} · ${states[record.state]}`;
      link.setAttribute('aria-label', labelText); link.title = labelText;
      link.addEventListener('dragstart', e => e.dataTransfer.setData('application/x-native-session', record.id));
      const label = node('span', record.name, 'label'); label.append(node('small', `${states[record.state]}${record.roomId ? ' · 协作中' : ''}`));
      link.append(icon(record.provider), label, node('span', undefined, `state-dot ${record.state}`)); return link;
    }));
    $('room-nav').classList.toggle('active', inRoom); $('member-count').textContent = members().length;
    $('header-actions').replaceChildren();
    if (s) {
      const own = s.owner === owner; const alive = !['ended', 'error', 'stopping', 'disconnected', 'recoverable'].includes(s.state);
      $('header-actions').append(button(s.roomId ? '脱出协作' : '加入协作', () => s.roomId ? detach(s.id) : api.join(s.id, true)), button('独立窗口', () => api.newWindow(s.id)), button('分享选中内容', () => { const text = mode === 'terminal' ? terminals.get(s.id)?.term.getSelection() : window.getSelection().toString(); text?.trim() ? share(text) : toast('先用鼠标选择需要分享的文字。'); }));
      $('session-status').textContent = `${states[s.state]}${s.activity ? ' · ' + s.activity : ''}${!own && s.owner ? ' · 另一个窗口控制' : ''}`;
      $('take-control').hidden = own || !alive;
      $('chat-tab').classList.toggle('active', mode === 'chat'); $('terminal-tab').classList.toggle('active', mode === 'terminal');
      $('terminal-controls').hidden = mode !== 'terminal';
      $('terminal-paste').disabled = !own || s.view !== 'terminal' || !alive || disconnected;
      $('messages').hidden = mode !== 'chat'; $('terminal-area').hidden = mode !== 'terminal'; $('composer-wrap').hidden = mode !== 'chat';
      $('message-input').disabled = !own || !alive || disconnected;
      $('send-button').disabled = !own || s.state !== 'idle' || Boolean(s.pendingTag) || disconnected || s.chatAvailable === false;
      $('interrupt').hidden = !own || !['working', 'approval'].includes(s.state);
      $('compose-hint').textContent = s.state === 'starting' ? '首次信任与登录请在原生终端完成' : s.chatAvailable === false ? (s.submissionNotice || (s.provider === 'claude' ? '安全发送尚未连接；请在原生终端继续。草稿会保留。' : '请先在原生终端完成第一条消息')) : s.provider === 'claude' ? 'Enter 发送 · 实时工具过程在原生终端' : 'Enter 发送 · Shift Enter 换行';
      const signature = JSON.stringify(s.messages);
      if (signature !== lastMessages) { messageList($('messages'), s.messages); lastMessages = signature; }
      $('approval').hidden = s.state !== 'approval';
      $('approval').replaceChildren();
      if (s.state === 'approval') {
        $('approval').append(node('strong', '原生会话需要你确认'));
        if (s.approval) {
          const p = s.approval.params;
          $('approval').append(node('p', p.command || p.reason || s.approval.method));
          if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(s.approval.method)) {
            $('approval').append(button('允许这一次', () => api.approve(s.id, s.approval.requestId, 'accept')), button('拒绝', () => api.approve(s.id, s.approval.requestId, 'decline')));
          }
        }
        $('approval').append(button('在原生终端查看', () => switchMode('terminal')));
      }
      $('advanced-content').replaceChildren(node('div', `原生 ID：${s.nativeId || '正在建立'}\n运行进程：${s.pid || '未连接'}\n工作目录：${s.cwd}\n后台工作：${s.background ?? '原生未报告'} · 定时任务：${s.scheduled ?? '原生未报告'}`));
      if (s.usage) $('advanced-content').append(node('div', `原生报告用量：${JSON.stringify(s.usage.total || s.usage)}`));
      for (const event of s.fleet.slice(-8)) $('advanced-content').append(node('div', `${event.event} · ${event.name}`));
      if (!['ended', 'stopping', 'recoverable'].includes(s.state)) $('advanced-content').append(button(s.provider === 'codex' ? '断开本应用连接…' : '结束这个原生会话…', () => api.stop(s.id), 'small'));
      if (['ended', 'recoverable', 'error'].includes(s.state) && state.capabilities?.includes('resume')) {
        $('header-actions').prepend(button('继续原生会话', () => api.resume(s.id), 'primary'));
        $('advanced-content').append(button('移除本应用记录…', () => api.forget(s.id), 'small'));
      }
      for (const [id, entry] of terminals) { entry.element.hidden = id !== s.id; const record = state.sessions.find(record => record.id === id); entry.term.options.disableStdin = record?.owner !== owner || record?.view !== 'terminal' || disconnected; }
      if (mode === 'terminal' && (alive || (s.state === 'error' && s.terminalAvailable))) attempt(() => ensureTerminal(s.id));
    }
    if (inRoom) {
      const run = state.room.run;
      const people = members();
      const tabs = $('room-member-tabs');
      const tabSignature = JSON.stringify(people.map(m => [m.id, m.name]));
      if (tabs.dataset.signature !== tabSignature) {
        tabs.replaceChildren(...people.map(m => {
          const tab = button(m.name, () => selectRoom(m.id)); tab.dataset.roomSession = m.id; return tab;
        }));
        tabs.dataset.signature = tabSignature;
      }
      $('room-record').setAttribute('aria-pressed', String(!roomSession));
      for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.roomSession === roomSession));
      $('run-status').textContent = run ? `${{ running: '正在核查', paused: '已暂停', completed: '本轮交接结束' }[run.status]} · ${run.steps}/${run.maxSteps} 次回复${run.reason ? ' · ' + run.reason : ''}` : '选择材料和接收方，开始一次有边界的协作。';
      const next = state.sessions.find(m => m.id === run?.awaiting?.sessionId);
      if (run?.status === 'running' && next) $('run-status').textContent += ` · 等待 ${next.name}`;
      const signature = JSON.stringify(state.room.messages);
      if (signature !== lastRoomMessages) { messageList($('room-messages'), state.room.messages, true); lastRoomMessages = signature; }
      $('members').replaceChildren(...members().map(m => {
        const card = node('div', undefined, 'member-card'); const heading = node('div', undefined, 'member-name'); heading.append(icon(m.provider), node('strong', m.name));
        const actions = node('div', undefined, 'actions'); actions.append(button('查看终端', () => { $('members-dialog').close(); selectRoom(m.id); }), button('脱出', async () => { await detach(m.id); $('members-dialog').close(); }));
        card.append(heading, node('p', states[m.state]), actions); return card;
      }));
      populateSelect($('recipient'), members());
      const safeHandoffs = state.capabilities?.includes('verifiedHandoffs');
      $('run-button').disabled = members().length !== 2 || run?.status === 'running' || !safeHandoffs;
      $('run-help').textContent = safeHandoffs ? '最多 3 次回复、10 分钟。原生后台或团队状态未报告时，保留回复并暂停；可确认后定向发送。原生子 agent 的用量另计。' : '旧版后台仍在保留原生会话，自动核查暂不可用；请用原生终端或定向发送。结束会话并重开应用后可更新后台。';
      $('forward-button').disabled = !members().length; $('pause-button').disabled = run?.status !== 'running';
    }
  } finally { rendering = false; }
}
async function switchMode(next) {
  const s = current(); if (!s) return;
  await api.claim(s.id, next);
  // The change stream is batched. Fetch the acknowledged control state before
  // exposing the input, or the first key after switching can be discarded.
  state = await api.initial(); mode = next; preference = next; await persistView(); render();
  if (next === 'terminal') { await ensureTerminal(s.id); focusTerminal(s.id); }
  else $('message-input').focus();
}
async function ensureTerminal(id) {
  const generation = state.sessions.find(s => s.id === id)?.connectionRevision || 0;
  const old = terminals.get(id);
  if (old && old.generation !== generation) { old.term.dispose(); old.element.remove(); terminals.delete(id); }
  if (terminals.has(id)) { const existing = terminals.get(id); if (existing.ready) fitTerminal(id); return existing.pending; }
  const element = node('div', undefined, 'terminal-host'); element.dataset.terminalId = id; $('terminal-area').append(element);
  const theme = terminalThemes[terminalDisplay.palette];
  $('terminal-area').style.backgroundColor = theme.background;
  const term = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: terminalDisplay.fontSize, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionClickForcesSelection: true, disableStdin: state.sessions.find(s => s.id === id)?.owner !== owner || state.sessions.find(s => s.id === id)?.view !== 'terminal' || disconnected, theme: { ...theme } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(element);
  const entry = { element, term, fit, generation, ready: false, sequence: 0, queued: [] }; terminals.set(id, entry);
  element.addEventListener('paste', event => { event.preventDefault(); event.stopPropagation(); attempt(() => { if (activeSessionId() === id) pasteTerminal(event.clipboardData?.getData('text/plain') || ''); }); }, true);
  term.onData(data => {
    // The service's canonical terminal answers device queries, once. Focus
    // reports belong to this observing view, not to the native input stream:
    // changing tabs or windows must not impersonate a human intervention.
    if (/^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\[[IO]$/.test(data) || /^\x1b\]/.test(data)) return;
    if (!entry.ready || disconnected || activeSessionId() !== id || mode !== 'terminal') return;
    attempt(() => api.input(id, data));
  });
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) { attempt(() => api.copy(term.getSelection())); return false; }
    return true;
  });
  entry.pending = (async () => {
    try {
      const snapshot = await api.terminalSnapshot(id);
      if (terminals.get(id) !== entry) return;
      term.resize(snapshot.cols || 100, snapshot.rows || 30);
      await new Promise(resolve => term.write(snapshot.buffer, resolve));
      entry.sequence = snapshot.sequence; entry.ready = true;
      for (const event of entry.queued) writeTerminal(entry, event);
      entry.queued = []; fitTerminal(id); focusTerminal(id);
    } catch (error) { if (terminals.get(id) === entry) { terminals.delete(id); term.dispose(); element.remove(); throw error; } }
  })();
  return entry.pending;
}
function fitTerminal(id) {
  const entry = terminals.get(id); const s = state.sessions.find(s => s.id === id);
  if (!entry?.ready || activeSessionId() !== id || mode !== 'terminal' || s?.owner !== owner) return;
  requestAnimationFrame(() => { if (activeSessionId() !== id || mode !== 'terminal' || !entry.element.isConnected || !entry.element.checkVisibility() || state.sessions.find(s => s.id === id)?.owner !== owner) return; entry.fit.fit(); attempt(() => api.resize(id, entry.term.cols, entry.term.rows)); });
}
function writeTerminal(entry, event) { if (event.sequence > entry.sequence) { entry.term.write(event.data); entry.sequence = event.sequence; } }
const disposers = [
  api.onTerminal(event => { const entry = terminals.get(event.id); if (!entry) return; if (!entry.ready) entry.queued.push(event); else writeTerminal(entry, event); }),
  api.onState(next => { state = { ...state, ...next }; render(); }),
  api.onDisconnected(message => { disconnected = true; render(); toast(message); }),
  api.onNew(() => openCreate()),
];
const observer = new ResizeObserver(() => { if (activeSessionId()) fitTerminal(activeSessionId()); }); observer.observe($('terminal-area'));
$('new-session').onclick = () => openCreate(); $('start-claude').onclick = () => openCreate('claude'); $('start-codex').onclick = () => openCreate('codex');
$('cancel-create').onclick = () => $('create-dialog').close();
$('choose-folder').onclick = () => attempt(async () => { const value = await api.chooseFolder(); if (value) { folder = value; $('chosen-folder').textContent = folder; } });
$('create-form').onsubmit = event => { event.preventDefault(); attempt(async () => {
  $('confirm-create').disabled = true;
  try { const view = $('initial-view').value; preference = view; const id = await api.create({ provider: document.querySelector('input[name="provider"]:checked').value, cwd: folder, name: $('session-name').value, view }); state = await api.initial(); $('create-dialog').close(); select(id, view); }
  finally { $('confirm-create').disabled = false; }
}); };
$('room-nav').onclick = () => select('room');
$('room-record').onclick = () => selectRoom();
$('manage-members').onclick = () => $('members-dialog').showModal();
$('close-members').onclick = () => { $('members-dialog').close(); focusTerminal(); };
$('room-nav').ondragover = event => { if (event.dataTransfer.types.includes('application/x-native-session')) { event.preventDefault(); $('room-nav').classList.add('drag-over'); } };
$('room-nav').ondragleave = () => $('room-nav').classList.remove('drag-over');
$('room-nav').ondrop = event => { event.preventDefault(); $('room-nav').classList.remove('drag-over'); const id = event.dataTransfer.getData('application/x-native-session'); if (state.sessions.some(s => s.id === id)) attempt(() => api.join(id, true)); };
$('chat-tab').onclick = () => attempt(() => switchMode('chat')); $('terminal-tab').onclick = () => attempt(() => switchMode('terminal'));
$('take-control').onclick = () => attempt(async () => { await api.claim(activeSessionId(), mode); state = await api.initial(); render(); fitTerminal(activeSessionId()); focusTerminal(); });
$('terminal-copy').onclick = () => attempt(async () => { const text = terminals.get(activeSessionId())?.term.getSelection(); if (!text) return toast('先选择文字；原生程序占用鼠标时，按住 ⌥ Option 拖选，再点复制。'); await api.copy(text); focusTerminal(); });
$('terminal-paste').onclick = () => attempt(async () => { const id = activeSessionId(); const text = await api.pasteText(); if (activeSessionId() === id && mode === 'terminal') pasteTerminal(text); });
$('terminal-display').onclick = () => { $('terminal-font-size').value = terminalDisplay.fontSize; $('terminal-palette').value = terminalDisplay.palette; $('terminal-display-dialog').showModal(); };
const saveTerminalDisplay = () => attempt(async () => {
  const fontSize = Number($('terminal-font-size').value);
  if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) throw new Error('字号请设为 10–24。');
  terminalDisplay = { fontSize, palette: $('terminal-palette').value }; applyTerminalDisplay(); await persistView();
});
$('terminal-font-size').onchange = $('terminal-palette').onchange = saveTerminalDisplay;
$('reset-terminal-display').onclick = () => { $('terminal-font-size').value = 14; $('terminal-palette').value = 'dark'; saveTerminalDisplay(); };
$('close-terminal-display').onclick = () => { $('terminal-display-dialog').close(); focusTerminal(); };
$('message-input').oninput = () => { const s = current(); if (s) { s.liveDraft = $('message-input').value; attempt(() => api.draft(s.id, s.liveDraft)); } };
$('message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$('send-button').disabled) $('composer').requestSubmit(); } };
$('composer').onsubmit = event => { event.preventDefault(); attempt(async () => { const id = activeSessionId(), text = $('message-input').value; await api.send(id, text); if (activeSessionId() === id && $('message-input').value === text) $('message-input').value = ''; }); };
$('interrupt').onclick = () => attempt(() => api.interrupt(activeSessionId()));
$('shared-input').oninput = () => attempt(persistView);
$('room-composer').onsubmit = event => { event.preventDefault(); attempt(() => { const first = $('recipient').value; return api.run([first, ...members().filter(s => s.id !== first).map(s => s.id)], $('shared-input').value, 3); }); };
$('forward-button').onclick = () => attempt(() => api.forward($('recipient').value, $('shared-input').value));
$('pause-button').onclick = () => attempt(() => api.pause());
$('invite-button').onclick = () => { $('members-dialog').close(); $('invite-list').replaceChildren(...state.sessions.filter(s => !s.roomId && s.state !== 'ended').map(s => button(`加入 ${s.name}`, async () => { await api.join(s.id, true); $('invite-dialog').close(); }))); if (!$('invite-list').children.length) $('invite-list').append(node('p', '先创建一个独立会话。')); $('invite-dialog').showModal(); };
$('close-invite').onclick = () => $('invite-dialog').close();
$('cancel-share').onclick = () => $('share-dialog').close();
$('confirm-share').onclick = () => attempt(async () => { await api.forward($('share-recipient').value, $('share-text').value); $('share-dialog').close(); toast('已定向发送。'); });
$('privacy-button').onclick = $('refresh-trust').onclick = () => attempt(showTrust); $('quit-service').onclick = () => attempt(() => api.quitService());
$('privacy-source').onclick = () => attempt(() => api.openExternal('https://github.com/RulerCompass1729/native-agent-workspace/blob/main/docs/privacy.md'));
$('data-directory').onclick = () => attempt(() => api.dataDirectory());
$('clear-shared-history').onclick = () => attempt(() => { if (!state.capabilities?.includes('clearSharedHistory')) throw new Error('后台仍在保留旧版会话；结束它们并重开应用后可使用此功能。'); return api.clearSharedHistory(); });
$('close-privacy').onclick = () => { $('privacy-dialog').close(); focusTerminal(); };
$('reconnect-button').onclick = () => attempt(async () => { $('reconnect-button').disabled = true; try { await api.reconnect(); } finally { $('reconnect-button').disabled = false; } });
$('setup-button').onclick = $('create-setup').onclick = $('refresh-setup').onclick = () => attempt(showSetup);
$('close-setup').onclick = () => $('setup-dialog').close();
for (const input of document.querySelectorAll('input[name="provider"]')) input.onchange = createReadiness;
attempt(async () => {
  state = await api.initial(); owner = state.owner; folder = state.defaultWorkspace; preference = state.viewState.preference || 'terminal'; mode = state.viewState.mode || preference;
  roomSession = typeof state.viewState.roomSession === 'string' ? state.viewState.roomSession : '';
  const display = state.viewState.terminalDisplay;
  if (display && Number.isInteger(display.fontSize) && display.fontSize >= 10 && display.fontSize <= 24 && terminalThemes[display.palette]) terminalDisplay = display;
  $('shared-input').value = typeof state.viewState.sharedDraft === 'string' ? state.viewState.sharedDraft : '';
  const draft = state.viewState.draft, saved = state.sessions.find(s => s.id === draft?.id);
  if (saved && (!saved.owner || saved.owner === owner)) { saved.liveDraft = draft.text; await api.draft(saved.id, draft.text); }
  select(state.viewState.selected || '', mode); await api.uiReady();
});
return () => { for (const dispose of disposers) dispose(); observer.disconnect(); clearTimeout(toastTimer); for (const entry of terminals.values()) entry.term.dispose(); };
