// Like the reading/search modules, this shares the workspace renderer scope.
// Reuse the existing DSH menu and native clipboard/edit paths.
let contentMenu;
const contentMenuOrigin = () => ({ revision: selectionRevision, id: activeSessionId(), nativeId: current()?.nativeId });
const contentMenuCurrent = target => target.revision === selectionRevision && target.id === activeSessionId() && target.nativeId === current()?.nativeId;
const contentMenuChanged = () => new Error('内容或会话已变化，请重新打开菜单。');
function terminalMenuTarget(id = activeSessionId()) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id);
  return { ...contentMenuOrigin(), id, entry, nativeId: record?.nativeId, owner: record?.owner, text: entry?.term.getSelection() || '' };
}
function terminalMenuCurrent(target, writable = false) {
  const record = current();
  return Boolean(contentMenuCurrent(target) && target.entry?.ready && terminals.get(target.id) === target.entry &&
    currentTerminalDisplay(target.entry, record) && (!writable || record?.owner === target.owner && target.owner === owner && terminalCanInput(target.id)));
}
async function copyTerminalContext(target = terminalMenuTarget()) {
  if (!terminalMenuCurrent(target)) throw contentMenuChanged();
  if (!target.text) return toast('先选择文字；原生程序占用鼠标时，按住 ⌥ Option 拖选，再点复制。');
  await api.copy(target.text);
  if (terminalMenuCurrent(target)) focusTerminal(target.id);
}
async function pasteTerminalContext(target = terminalMenuTarget()) {
  if (!terminalMenuCurrent(target, true)) throw new Error('请先连接并接管这个终端。');
  const content = await api.pasteNativeContent(target.id, target.nativeId);
  if (!terminalMenuCurrent(target, true)) throw contentMenuChanged();
  if (content.images) await pasteImages([], content.images); else pasteTerminal(content.text);
}
function showContentMenu(element, point, keyboard = false, event) {
  if (element instanceof Element && element.closest('[data-member-menu]')) return false;
  if (!(element instanceof Element) || !element.closest('.naw') || element.closest('[data-session-row], #room-nav') && !element.closest('#rename-editor')) return false;
  const origin = contentMenuOrigin(), opener = document.activeElement;
  const terminal = element.closest('[data-terminal-id]');
  let field, fieldState, actions = [], restore = () => { if (contentMenuCurrent(origin) && opener?.isConnected) opener.focus({ preventScroll: true }); };
  if (terminal) {
    const target = terminalMenuTarget(terminal.dataset.terminalId);
    if (!terminalMenuCurrent(target)) return false;
    // A native mouse-mode right click belongs to the program. The existing
    // force-selection modifier (Option on macOS) opens the application menu.
    const forced = navigator.platform.includes('Mac') ? event?.altKey : event?.shiftKey;
    if (!keyboard && target.entry.term.modes.mouseTrackingMode !== 'none' && !target.entry.term.options.disableStdin && !forced) return true;
    actions = [
      { id: 'copy', label: '复制', disabled: !target.text, run: () => copyTerminalContext(target) },
      { id: 'paste', label: '粘贴', disabled: !terminalMenuCurrent(target, true), run: () => pasteTerminalContext(target) },
    ];
    restore = () => { if (terminalMenuCurrent(target)) target.entry.term.focus(); };
  } else {
    field = element.closest('input, textarea');
    if (field && !field.disabled && typeof field.selectionStart === 'number') {
      const draftRevision = () => field.id === 'message-input' ? draftRevisions.get(origin.id) : field.id === 'shared-input' ? roomDraftRevision : field.id === 'rename-name' ? renameRevision : undefined;
      fieldState = { value: field.value, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection, revision: draftRevision() };
      const selectedText = fieldState.value.slice(fieldState.start, fieldState.end);
      const validField = () => contentMenuCurrent(origin) && field.isConnected && !field.disabled && field.value === fieldState.value && draftRevision() === fieldState.revision;
      const editable = () => validField() && !field.readOnly && document.activeElement === field && field.selectionStart === fieldState.start && field.selectionEnd === fieldState.end;
      restore = () => {
        if (!validField()) return;
        field.focus({ preventScroll: true }); field.setSelectionRange(fieldState.start, fieldState.end, fieldState.direction);
      };
      const edit = text => {
        if (!editable()) throw contentMenuChanged();
        const maximum = field.id === 'message-input' ? 16000 : field.maxLength;
        if (maximum >= 0 && field.value.length - (fieldState.end - fieldState.start) + text.length > maximum) throw new Error(`超过 ${maximum} 个字符；原内容保留，没有截断粘贴。`);
        // This is the same Chromium edit mechanism used by chooseMention.
        // A direct value assignment would discard the person's undo history.
        if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) throw new Error('未能编辑原输入框，内容保留。');
      };
      actions = [
        { id: 'cut', label: '剪切', disabled: field.readOnly || !selectedText, run: async () => {
          if (!editable()) throw contentMenuChanged();
          await api.copy(selectedText); edit('');
        } },
        { id: 'copy', label: '复制', disabled: !selectedText, run: () => { if (!validField()) throw contentMenuChanged(); return api.copy(selectedText); } },
        { id: 'paste', label: '粘贴', disabled: field.readOnly, run: async () => {
          if (!editable()) throw contentMenuChanged();
          const text = await api.pasteText();
          if (!text) return toast('剪贴板里没有文字。');
          edit(text);
        } },
        { id: 'all', label: '全选', disabled: !field.value, run: () => { if (!validField()) throw contentMenuChanged(); field.focus({ preventScroll: true }); field.select(); } },
      ];
    } else {
      const text = window.getSelection()?.toString();
      if (text) actions.push({ id: 'copy', label: '复制', run: () => { if (!contentMenuCurrent(origin)) throw contentMenuChanged(); return api.copy(text); } });
    }
    const link = element.closest('a[href]');
    if (link) {
      const href = link.href;
      actions.push({ id: 'link', label: '复制链接', run: () => { if (!contentMenuCurrent(origin)) throw contentMenuChanged(); return api.copy(href); } });
    }
  }
  if (!actions.length) return false;
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  const close = ui.menu({
    contextElement: element,
    items: actions.map(({ run, ...item }) => item),
    getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : element.getBoundingClientRect(),
    onClose: () => { if (contentMenu?.close === close) contentMenu = null; restore(); },
    onSelect: action => { const item = actions.find(item => item.id === action); if (item && !item.disabled) attempt(item.run); },
  });
  contentMenu = { close };
  return true;
}
function bindContentMenus() {
  const context = event => {
    if (event.defaultPrevented) return;
    if (showContentMenu(event.target, { x: event.clientX, y: event.clientY }, false, event)) event.preventDefault();
  };
  // Capture before xterm's target listener can encode Shift+F10 as native input.
  const key = event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
    let target = event.target;
    if (!(target instanceof Element) || !target.closest('.naw')) {
      const selection = window.getSelection(), anchor = selection && !selection.isCollapsed && selection.anchorNode;
      target = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    }
    if (showContentMenu(target, undefined, true, event)) { event.preventDefault(); event.stopPropagation(); }
  };
  document.addEventListener('contextmenu', context);
  document.addEventListener('keydown', key, true);
  return () => { document.removeEventListener('contextmenu', context); document.removeEventListener('keydown', key, true); contentMenu?.close(); };
}
