/* Views consume session capabilities; they never own native processes. */
const api = window.workspace;
const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const button = (text, action, cls) => { const el = node('button', text, cls); el.type = 'button'; el.addEventListener('click', () => attempt(action)); return el; };
const states = { starting: '正在启动', idle: '就绪', working: '正在工作', approval: '等待确认', ended: '已结束', error: '需要检查' };
let state, owner, selected = '', mode = 'chat', preference = 'chat', folder = '', disconnected = false;
let toastTimer, lastMessages = '', lastRoomMessages = '', rendering = false;
const terminals = new Map();
const current = () => state?.sessions.find(s => s.id === selected);
const members = () => state?.sessions.filter(s => s.roomId === 'shared') || [];
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
async function attempt(action) { try { return await action(); } catch (error) { toast(error.message || '操作未完成。'); } }
function persistView() { return api.viewState({ selected, mode, preference }); }
function icon(provider) { return node('span', provider === 'claude' ? 'C' : 'C', `agent-icon ${provider}`); }
function select(id, requestedMode) {
  selected = id; const s = current();
  if (requestedMode) mode = requestedMode; else if (s) mode = s.owner === owner ? s.view : preference;
  $('message-input').value = s?.liveDraft || '';
  lastMessages = ''; lastRoomMessages = ''; render(); attempt(persistView);
}
function openCreate(provider = 'claude') {
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
  $('initial-view').value = preference; $('session-name').value = '';
  $('chosen-folder').textContent = folder; $('create-dialog').showModal();
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
    const s = current(); const inRoom = selected === 'room';
    document.title = `${s?.name || 'Native Workspace'} — Native Agent Workspace`;
    $('welcome').hidden = Boolean(s || inRoom); $('session-view').hidden = !s; $('room-view').hidden = !inRoom;
    $('title').textContent = s?.name || (inRoom ? '共同工作' : '你的工作空间');
    $('subtitle').textContent = s ? `${s.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${s.model} · ${s.roomId ? '协作中，也可单独操作' : '独立会话'}` : inRoom ? '你决定谁参与、分享什么、什么时候停。' : '从一个会话开始，需要时再邀请另一个。';
    const warning = disconnected ? '本地服务断开。草稿已保留，不会自动重发输入。' : state.storageWarning;
    $('alert').hidden = !warning; $('alert').textContent = warning || '';
    $('session-list').replaceChildren(...state.sessions.map(record => {
      const link = button('', () => select(record.id), `session-link${record.id === selected ? ' active' : ''}`);
      link.dataset.sessionId = record.id; link.draggable = true;
      link.addEventListener('dragstart', e => e.dataTransfer.setData('application/x-native-session', record.id));
      const label = node('span', record.name, 'label'); label.append(node('small', `${states[record.state]}${record.roomId ? ' · 协作中' : ''}`));
      link.append(icon(record.provider), label, node('span', undefined, `state-dot ${record.state}`)); return link;
    }));
    $('room-nav').classList.toggle('active', inRoom); $('member-count').textContent = members().length;
    $('header-actions').replaceChildren();
    if (s) {
      const own = s.owner === owner; const alive = !['ended', 'error'].includes(s.state);
      $('header-actions').append(button(s.roomId ? '脱出协作' : '加入协作', () => api.join(s.id, !s.roomId)), button('独立窗口', () => api.newWindow(s.id)), button('分享选中内容', () => { const text = mode === 'terminal' ? terminals.get(s.id)?.term.getSelection() : window.getSelection().toString(); text?.trim() ? share(text) : toast('先用鼠标选择需要分享的文字。'); }));
      $('session-status').textContent = `${states[s.state]}${s.activity ? ' · ' + s.activity : ''}${own ? '' : ' · 另一个窗口控制'}`;
      $('take-control').hidden = own || !alive;
      $('chat-tab').classList.toggle('active', mode === 'chat'); $('terminal-tab').classList.toggle('active', mode === 'terminal');
      $('messages').hidden = mode !== 'chat'; $('terminal-area').hidden = mode !== 'terminal'; $('composer-wrap').hidden = mode !== 'chat';
      $('message-input').disabled = !own || !alive || disconnected;
      $('send-button').disabled = !own || s.state !== 'idle' || Boolean(s.pendingTag) || disconnected || s.chatAvailable === false;
      $('interrupt').hidden = !own || !['working', 'approval'].includes(s.state);
      $('compose-hint').textContent = s.state === 'starting' ? '首次信任与登录请在原生终端完成' : s.chatAvailable === false ? '请先在原生终端完成第一条消息' : s.provider === 'claude' ? 'Enter 发送 · 实时工具过程在原生终端' : 'Enter 发送 · Shift Enter 换行';
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
      if (alive) $('advanced-content').append(button('结束这个原生会话…', () => api.stop(s.id), 'small'));
      for (const [id, entry] of terminals) entry.element.hidden = id !== s.id;
      if (mode === 'terminal' && alive) attempt(() => ensureTerminal(s.id));
    }
    if (inRoom) {
      const run = state.room.run;
      $('run-status').textContent = run ? `${{ running: '正在核查', paused: '已暂停', completed: '本轮交接结束' }[run.status]} · ${run.steps}/${run.maxSteps} 次回复${run.reason ? ' · ' + run.reason : ''}` : '选择材料和接收方，开始一次有边界的协作。';
      const signature = JSON.stringify(state.room.messages);
      if (signature !== lastRoomMessages) { messageList($('room-messages'), state.room.messages, true); lastRoomMessages = signature; }
      $('members').replaceChildren(...members().map(m => {
        const card = node('div', undefined, 'member-card'); const heading = node('div', undefined, 'member-name'); heading.append(icon(m.provider), node('strong', m.name));
        const actions = node('div', undefined, 'actions'); actions.append(button('单独操作', () => select(m.id)), button('脱出', () => api.join(m.id, false)));
        card.append(heading, node('p', states[m.state]), actions); return card;
      }));
      populateSelect($('recipient'), members());
      $('run-button').disabled = members().length !== 2 || run?.status === 'running';
      $('forward-button').disabled = !members().length; $('pause-button').disabled = run?.status !== 'running';
    }
  } finally { rendering = false; }
}
async function switchMode(next) {
  const s = current(); if (!s) return;
  await api.claim(s.id, next); mode = next; preference = next; await persistView(); render();
  if (next === 'terminal') { await ensureTerminal(s.id); terminals.get(s.id)?.term.focus(); }
  else $('message-input').focus();
}
async function ensureTerminal(id) {
  if (terminals.has(id)) { const existing = terminals.get(id); if (existing.ready) fitTerminal(id); return existing.pending; }
  const element = node('div', undefined, 'terminal-host'); element.dataset.terminalId = id; $('terminal-area').append(element);
  const term = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: false, theme: { background: '#20261f', foreground: '#eef2e8', cursor: '#e0edc9', selectionBackground: '#637a5988' } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(element);
  const entry = { element, term, fit, ready: false, sequence: 0, queued: [] }; terminals.set(id, entry);
  term.onData(data => {
    // The service's canonical terminal answers device queries, once.
    if (/^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\]/.test(data)) return;
    if (!entry.ready || disconnected) return;
    attempt(() => api.input(id, data));
  });
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) { attempt(() => api.copy(term.getSelection())); return false; }
    return true;
  });
  entry.pending = (async () => {
    try {
      const snapshot = await api.terminalSnapshot(id);
      term.resize(snapshot.cols || 100, snapshot.rows || 30);
      await new Promise(resolve => term.write(snapshot.buffer, resolve));
      entry.sequence = snapshot.sequence; entry.ready = true;
      for (const event of entry.queued) writeTerminal(entry, event);
      entry.queued = []; fitTerminal(id); if (selected === id && mode === 'terminal') term.focus();
    } catch (error) { terminals.delete(id); term.dispose(); element.remove(); throw error; }
  })();
  return entry.pending;
}
function fitTerminal(id) {
  const entry = terminals.get(id); const s = state.sessions.find(s => s.id === id);
  if (!entry?.ready || selected !== id || mode !== 'terminal' || s?.owner !== owner) return;
  requestAnimationFrame(() => { if (!entry.element.isConnected || entry.element.hidden || $('terminal-area').hidden) return; entry.fit.fit(); attempt(() => api.resize(id, entry.term.cols, entry.term.rows)); });
}
function writeTerminal(entry, event) { if (event.sequence > entry.sequence) { entry.term.write(event.data); entry.sequence = event.sequence; } }
const disposers = [
  api.onTerminal(event => { const entry = terminals.get(event.id); if (!entry) return; if (!entry.ready) entry.queued.push(event); else writeTerminal(entry, event); }),
  api.onState(next => { state = next; render(); }),
  api.onDisconnected(message => { disconnected = true; render(); toast(message); }),
  api.onNew(() => openCreate()),
];
const observer = new ResizeObserver(() => { if (selected) fitTerminal(selected); }); observer.observe($('terminal-area'));
$('new-session').onclick = () => openCreate(); $('start-claude').onclick = () => openCreate('claude'); $('start-codex').onclick = () => openCreate('codex');
$('cancel-create').onclick = () => $('create-dialog').close();
$('choose-folder').onclick = () => attempt(async () => { const value = await api.chooseFolder(); if (value) { folder = value; $('chosen-folder').textContent = folder; } });
$('create-form').onsubmit = event => { event.preventDefault(); attempt(async () => {
  $('confirm-create').disabled = true;
  try { const view = $('initial-view').value; preference = view; const id = await api.create({ provider: document.querySelector('input[name="provider"]:checked').value, cwd: folder, name: $('session-name').value, view }); state = await api.initial(); $('create-dialog').close(); select(id, view); }
  finally { $('confirm-create').disabled = false; }
}); };
$('room-nav').onclick = () => select('room');
$('room-nav').ondragover = event => { if (event.dataTransfer.types.includes('application/x-native-session')) { event.preventDefault(); $('room-nav').classList.add('drag-over'); } };
$('room-nav').ondragleave = () => $('room-nav').classList.remove('drag-over');
$('room-nav').ondrop = event => { event.preventDefault(); $('room-nav').classList.remove('drag-over'); const id = event.dataTransfer.getData('application/x-native-session'); if (state.sessions.some(s => s.id === id)) attempt(() => api.join(id, true)); };
$('chat-tab').onclick = () => attempt(() => switchMode('chat')); $('terminal-tab').onclick = () => attempt(() => switchMode('terminal'));
$('take-control').onclick = () => attempt(async () => { await api.claim(selected, mode); state = await api.initial(); render(); fitTerminal(selected); });
$('message-input').oninput = () => { const s = current(); if (s) { s.liveDraft = $('message-input').value; attempt(() => api.draft(s.id, s.liveDraft)); } };
$('message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$('send-button').disabled) $('composer').requestSubmit(); } };
$('composer').onsubmit = event => { event.preventDefault(); attempt(async () => { const id = selected, text = $('message-input').value; await api.send(id, text); if (selected === id && $('message-input').value === text) $('message-input').value = ''; }); };
$('interrupt').onclick = () => attempt(() => api.interrupt(selected));
$('room-composer').onsubmit = event => { event.preventDefault(); attempt(() => { const first = $('recipient').value; return api.run([first, ...members().filter(s => s.id !== first).map(s => s.id)], $('shared-input').value, 3); }); };
$('forward-button').onclick = () => attempt(() => api.forward($('recipient').value, $('shared-input').value));
$('pause-button').onclick = () => attempt(() => api.pause());
$('invite-button').onclick = () => { $('invite-list').replaceChildren(...state.sessions.filter(s => !s.roomId && s.state !== 'ended').map(s => button(`加入 ${s.name}`, async () => { await api.join(s.id, true); $('invite-dialog').close(); }))); if (!$('invite-list').children.length) $('invite-list').append(node('p', '先创建一个独立会话。')); $('invite-dialog').showModal(); };
$('close-invite').onclick = () => $('invite-dialog').close();
$('cancel-share').onclick = () => $('share-dialog').close();
$('confirm-share').onclick = () => attempt(async () => { await api.forward($('share-recipient').value, $('share-text').value); $('share-dialog').close(); toast('已定向发送。'); });
$('privacy-button').onclick = () => $('privacy-dialog').showModal(); $('close-privacy').onclick = () => $('privacy-dialog').close();
attempt(async () => { state = await api.initial(); owner = state.owner; folder = state.defaultWorkspace; preference = state.viewState.preference || 'chat'; mode = state.viewState.mode || preference; select(state.viewState.selected || '', mode); });
return () => { for (const dispose of disposers) dispose(); observer.disconnect(); clearTimeout(toastTimer); for (const entry of terminals.values()) entry.term.dispose(); };
