// Existing-session readers with injected input hosts. This module has no native
// input, launch or sharing API; the workspace supplies the same Solo bindings.
(function (target, factory) {
  const fleet = typeof module !== 'undefined' && module.exports ? require('./fleet-observation.js') : target.nativeWorkspaceFleet;
  const api = factory(target, fleet);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else target.nativeWorkspaceCollaboration = api;
})(typeof window === 'undefined' ? globalThis : window, function (target, fleet) {
  const labels = { starting: '正在启动', idle: '会话就绪', working: '正在工作', approval: '等待确认', stopping: '等待退出确认', disconnected: '已断开', recoverable: '等待恢复', ended: '已结束', background: '已转到后台', error: '需要检查' };
  function statusFacts(record, connected = true, now = Date.now()) {
    const live = connected && !record.transportDisconnected && !record.backendUnavailable;
    const observations = [record.nativeActivity, record.nativeApproval, record.sharedActivity].filter(value => value &&
      record.nativeId && value.nativeId === record.nativeId && (!record.activeTurnId || !value.turnId || value.turnId === record.activeTurnId) &&
      Number.isFinite(value.observedAt) && value.observedAt <= now);
    const latest = observations.sort((a, b) => b.observedAt - a.observedAt)[0];
    const age = latest ? Math.max(0, Math.floor((now - latest.observedAt) / 1000)) : null;
    const stale = !live || latest?.stale === true || age !== null && age > 5;
    const time = age === null ? '更新时间未报告' : age < 5 ? '刚更新' : age < 60 ? `${age} 秒前更新` : `${Math.floor(age / 60)} 分钟前更新`;
    const children = fleet.observedFleet(record, live);
    let child = '子任务：未报告';
    if (children.children.length) {
      child = children.running || children.unknown
        ? `子任务：${children.running ? `${children.running} 项进行中` : ''}${children.running && children.unknown ? ' · ' : ''}${children.unknown ? `${children.unknown} 项状态未知` : ''}（部分观察）`
        : `子任务：已观察到的 ${children.children.length} 项已结束（部分观察）`;
    }
    const base = Object.hasOwn(labels, record.state) ? labels[record.state] : '状态未报告';
    const question = record.approval?.method === 'item/tool/requestUserInput';
    const state = !live ? '连接状态待核对' : record.nativeContextPending ? '原生上下文待核对' : record.claudeQuestion || question && record.approval.params?.isBlocking !== false
      ? '等待回答' : question ? `${base} · 有待回答问题` : base;
    const pending = record.nativeApproval?.requests?.length || record.approvals?.length || 0;
    const compactChild = children.children.length ? [children.running && `${children.running} 进行中`, children.unknown && `${children.unknown} 未知`, !children.running && !children.unknown && `${children.children.length} 已结束`, '部分观察'].filter(Boolean).join(' · ') : '';
    return { state: pending > 1 ? `${state} · ${pending} 项待处理` : state, child, freshness: `${stale ? '最后观察 · ' : ''}${time}`, stale,
      compactChild, freshnessReported: age !== null || stale };
  }
  function excerpt(record, messages = record.messages || [], limit = 220) {
    const source = messages.findLast(message => message.role === 'assistant' && typeof message.id === 'string' && message.id &&
      typeof message.text === 'string' && message.text.trim());
    if (!source) return null;
    // Slice code points, never split a surrogate pair or rewrite native text.
    limit = Math.max(1, Math.min(1000, Number.isSafeInteger(limit) ? limit : 220));
    let text = '', count = 0, truncated = false;
    for (const point of source.text) { if (count++ === limit) { truncated = true; break; } text += point; }
    return { sessionId: record.id, messageId: source.id, nativeId: typeof source.nativeId === 'string' && source.nativeId ? source.nativeId : null,
      turnId: source.turnId, text, truncated, incomplete: Boolean(source.incomplete),
      time: Number.isFinite(source.time) && Math.abs(source.time) <= 8640000000000000 ? source.time : null,
      previousContext: Boolean(source.nativeId && source.nativeId !== record.nativeId) };
  }
  function adjustedWidths(weights, index, delta, total, minimum = 180) {
    const next = weights.slice(), sum = weights.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(delta) || !(total > 0) || index < 0 || index + 1 >= next.length || next.some(n => !Number.isFinite(n) || n <= 0)) return next;
    const pair = weights[index] + weights[index + 1], floor = Math.min(minimum / total * sum, pair / 2);
    next[index] = Math.max(floor, Math.min(pair - floor, weights[index] + delta / total * sum));
    next[index + 1] = pair - next[index]; return next;
  }
  function create(options) {
    const doc = options.host.ownerDocument, host = options.host;
    const el = (tag, text, cls) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const setText = (n, text) => { if (n.textContent !== text) n.textContent = text; };
    const button = (text, action, cls) => { const n = el('button', text, cls); n.type = 'button'; n.addEventListener('click', action); return n; };
    const panes = new Map(); let records = [], connected = true, contentVisible = true, brief = false, layout = 'grid', focused = '', weights = new Map(), originSelection, briefSelection, dragging;
    const orderType = 'application/x-native-room-member-order';
    const canOrder = () => Boolean(options.onMove && connected && contentVisible && !focused);
    const orderStatus = el('span', undefined, 'collaboration-order-status'); orderStatus.setAttribute('role', 'status');
    const clearOrderMarkers = () => {
      for (const pane of panes.values()) for (const marker of [pane.header, pane.unit]) {
        marker.classList.remove('member-order-before', 'member-order-after'); delete marker.dataset.orderHint;
      }
    };
    host.addEventListener('dragend', clearOrderMarkers);
    host.addEventListener('keydown', event => { if (event.key === 'Escape') clearOrderMarkers(); });
    async function moveMember(id, target, after) {
      if (!canOrder() || id === target) return;
      options.beforeInputLayout?.(); options.beforeLayout?.();
      try {
        await options.onMove(id, target, after);
        // Announce the rendered broadcast, never a predicted native operation.
        requestAnimationFrame(() => {
          const index = records.findIndex(s => s.id === id);
          if (index >= 0) orderStatus.textContent = `${options.label(records[index])} 已移到第 ${index + 1} 位，共 ${records.length} 位成员`;
        });
      } catch (error) { orderStatus.textContent = error.message || '顺序未更改。'; options.onOrderError?.(error); }
    }
    const toolbar = el('div', undefined, 'collaboration-toolbar');
    const back = button('← 返回共同工作', () => focus(''), 'collaboration-back'); back.hidden = true;
    const simplify = button('简化信息', () => {
      options.beforeInputLayout?.(); options.beforeLayout?.(); brief = !brief; render(); options.onLayout?.();
      if (!brief) { restoreSelection(briefSelection); briefSelection = null; }
    }); simplify.setAttribute('aria-pressed', 'false');
    simplify.addEventListener('pointerdown', () => { if (!brief) briefSelection = selectedRange(); });
    const grid = button('网格', () => setLayout('grid')), list = button('列表', () => setLayout('list'));
    const layouts = el('div', undefined, 'collaboration-layout-controls'); layouts.setAttribute('role', 'group'); layouts.setAttribute('aria-label', '成员阅读布局'); layouts.append(grid, list);
    toolbar.append(back, layouts, simplify);
    const headers = el('div', undefined, 'collaboration-statuses'); headers.setAttribute('aria-label', '全体协作成员状态');
    const readers = el('div', undefined, 'collaboration-readers');
    const empty = el('p', '邀请已有会话加入，一起查看各自的工作。', 'quiet collaboration-empty');
    host.classList.add('collaboration-overview'); host.append(toolbar, headers, readers, empty, orderStatus);
    function key(id) { return `collaboration:${options.roomId || 'shared'}:${id}`; }
    function selectedRange() {
      const selection = doc.getSelection();
      return selection && !selection.isCollapsed && readers.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    }
    function rememberSelection() { originSelection = selectedRange(); }
    function restoreSelection(range) {
      if (range?.startContainer.isConnected && range.endContainer.isConnected) {
        const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    function focus(id) {
      if (id === focused) return;
      if (id && !records.some(s => s.id === id)) return;
      options.beforeInputLayout?.(); options.beforeLayout?.();
      if (id && !focused && !originSelection) rememberSelection();
      const previous = focused; focused = id; render();
      options.onFocus?.(id, previous, id ? key(id) : key(previous));
      if (!id) {
        const previousPane = panes.get(previous); previousPane?.name.focus({ preventScroll: true });
        restoreSelection(originSelection);
        originSelection = null;
      }
      options.onLayout?.();
    }
    function setLayout(value) { options.beforeInputLayout?.(); options.beforeLayout?.(); layout = value; render(); options.onLayout?.(); }
    function refreshStatus() {
      for (const record of records) {
        const pane = panes.get(record.id); if (!pane) continue;
        const facts = statusFacts(record, connected);
        setText(pane.status, facts.state); setText(pane.child, facts.child); setText(pane.freshness, facts.freshness);
        setText(pane.compactChild, facts.compactChild);
        pane.compactChild.title = facts.child;
        pane.freshness.classList.toggle('compact-status-hidden', !facts.freshnessReported);
        pane.header.dataset.state = record.state || 'unknown'; pane.header.dataset.stale = String(facts.stale);
      }
    }
    function setWidths() {
      const columns = records.map(record => `${weights.get(record.id) || 1}fr`).join(' ') || '1fr';
      host.style.setProperty('--collaboration-columns', columns);
      for (let i = 0; i < records.length; i++) {
        const pane = panes.get(records[i].id); pane.grip.hidden = i === records.length - 1 || layout === 'list' || Boolean(focused);
        pane.grip.setAttribute('aria-valuenow', String(Math.round((weights.get(records[i].id) || 1) * 100)));
      }
    }
    function resize(index, delta, total) {
      const values = records.map(r => weights.get(r.id) || 1), next = adjustedWidths(values, index, delta, total);
      records.forEach((r, i) => weights.set(r.id, next[i])); setWidths();
    }
    function makePane(record) {
      const header = el('section', undefined, 'collaboration-member-status'); header.dataset.memberId = record.id;
      const name = button('', () => focus(record.id), 'collaboration-member-name');
      const nameText = el('span', undefined, 'collaboration-name-text'), nameSuffix = el('span', undefined, 'collaboration-name-suffix'); name.append(nameText, nameSuffix);
      const revealName = reveal => {
        if (name.classList.contains('is-revealed') === reveal) return;
        options.beforeLayout?.(); name.classList.toggle('is-revealed', reveal); options.onLayout?.();
      };
      name.addEventListener('focus', () => { if (host.closest('.compact-room-surface') && name.matches(':focus-visible') && nameText.scrollWidth > nameText.clientWidth) revealName(true); });
      name.addEventListener('blur', () => revealName(false));
      // Reuse the application's existing member-drag contract on the handle,
      // leaving the conversation itself available for ordinary text selection.
      options.decorateHeader?.(name, record);
      name.addEventListener('dragstart', event => { if (canOrder()) event.dataTransfer.setData(orderType, record.id); });
      name.addEventListener('keydown', event => {
        if (!canOrder() || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const index = records.findIndex(s => s.id === record.id), next = records[index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (next) moveMember(record.id, next.id, event.key === 'ArrowDown');
      });
      const acceptsOrder = event => canOrder() && event.dataTransfer.types.includes(orderType);
      const after = event => {
        const horizontal = layout === 'grid' && [...panes.values()].some(p => p.header !== header && Math.abs(p.header.getBoundingClientRect().top - header.getBoundingClientRect().top) < 2);
        header.dataset.orderAxis = horizontal ? 'x' : 'y';
        const box = header.getBoundingClientRect();
        return horizontal ? event.clientX >= box.left + box.width / 2 : event.clientY >= box.top + box.height / 2;
      };
      header.addEventListener('dragover', event => {
        if (!acceptsOrder(event)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        clearOrderMarkers(); const below = after(event), marker = layout === 'list' ? panes.get(record.id).unit : header;
        marker.dataset.orderAxis = header.dataset.orderAxis;
        marker.classList.add(below ? 'member-order-after' : 'member-order-before');
        marker.dataset.orderHint = below ? '移到此成员之后' : '移到此成员之前';
      });
      header.addEventListener('dragleave', event => { if (!header.contains(event.relatedTarget)) clearOrderMarkers(); });
      header.addEventListener('drop', event => {
        if (!acceptsOrder(event)) return;
        event.preventDefault(); event.stopPropagation(); const id = event.dataTransfer.getData(orderType), below = after(event); clearOrderMarkers();
        if (records.some(s => s.id === id)) moveMember(id, record.id, below);
      });
      name.addEventListener('pointerdown', () => { if (!focused) rememberSelection(); });
      const heading = el('div', undefined, 'collaboration-member-heading');
      // Keep every original message action in the normal tab order, while
      // offering a short keyboard route past a member's long conversation.
      const next = button('', () => {
        const index = records.findIndex(s => s.id === record.id);
        if (!focused && index >= 0) {
          const target = panes.get(records[index + 1]?.id);
          target?.name.focus(); target?.header.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }, 'collaboration-member-next');
      const more = button('⋯', () => options.onMemberMenu?.(record.id, more), 'collaboration-member-more');
      more.dataset.memberMenu = record.id;
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.addEventListener('pointerdown', event => { if (more.getAttribute('aria-expanded') === 'true') event.stopPropagation(); });
      const memberMenuTarget = event => {
        const control = event.target.closest('button, a, input, textarea, select, [contenteditable], [role="button"], [role="link"]');
        return !control || control === name || control === more;
      };
      const showMemberMenu = event => {
        if (event.defaultPrevented || more.disabled || more.hidden || !memberMenuTarget(event)) return;
        event.preventDefault(); event.stopPropagation(); options.onMemberMenu?.(record.id, more);
      };
      header.addEventListener('contextmenu', showMemberMenu);
      header.addEventListener('pointerdown', event => {
        // Keep the original same-anchor toggle when a menu is already open.
        if ((event.button === 2 || event.button === 0 && event.ctrlKey) && more.getAttribute('aria-expanded') === 'true' && memberMenuTarget(event)) event.stopPropagation();
      });
      header.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return;
        showMemberMenu(event);
      });
      heading.append(name, more, next);
      const status = el('span', undefined, 'collaboration-member-state'); status.setAttribute('role', 'status');
      const child = el('span', undefined, 'collaboration-member-child compact-status-hidden'), freshness = el('span', undefined, 'collaboration-member-freshness');
      const compactChild = el('span', undefined, 'collaboration-member-child-compact'); compactChild.setAttribute('aria-hidden', 'true');
      header.append(heading, status, child, compactChild, freshness);
      const reader = el('section', undefined, 'collaboration-member-reader'); reader.dataset.memberId = record.id;
      const messages = el('div', undefined, 'messages collaboration-messages'); messages.setAttribute('aria-label', `${record.name} 的原会话`);
      let pane;
      const short = el('div', undefined, 'collaboration-brief'), briefLabel = el('strong', '原文摘录'), quote = el('blockquote'), truncation = el('span', '…', 'collaboration-truncation'), source = button('', () => {
        const snippet = pane.snippet;
        if (!snippet) return;
        options.beforeLayout?.(); brief = false; render(); options.onSource?.(messages, key(record.id), snippet); options.onLayout?.();
      }, 'collaboration-source');
      truncation.setAttribute('aria-label', '摘录未显示全部内容');
      const notice = el('span', undefined, 'quiet'); short.append(briefLabel, quote, truncation, source, notice);
      const grip = el('div', undefined, 'collaboration-resize'); grip.tabIndex = 0; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-label', `调整 ${record.name} 的阅读列宽`); grip.setAttribute('aria-valuemin', '1'); grip.setAttribute('aria-valuemax', '1000');
      grip.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); options.beforeLayout?.(); resize(records.findIndex(r => r.id === record.id), event.key === 'ArrowLeft' ? -30 : 30, readers.clientWidth); options.onLayout?.();
      });
      grip.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); options.beforeLayout?.();
        dragging = { pointerId: event.pointerId, x: event.clientX, index: records.findIndex(r => r.id === record.id) }; grip.setPointerCapture(event.pointerId);
      });
      grip.addEventListener('pointermove', event => {
        if (!dragging || dragging.pointerId !== event.pointerId) return;
        resize(dragging.index, event.clientX - dragging.x, readers.clientWidth); dragging.x = event.clientX;
      });
      const finish = () => { if (dragging) { dragging = null; options.onLayout?.(); } };
      grip.addEventListener('pointerup', finish); grip.addEventListener('pointercancel', finish); grip.addEventListener('lostpointercapture', finish);
      const input = el('div', undefined, 'collaboration-member-input'); input.hidden = true;
      const nativeFooter = el('div', undefined, 'column-native-footer'); nativeFooter.hidden = true;
      reader.append(messages, short, input, nativeFooter, grip);
      const unit = el('div', undefined, 'collaboration-member-unit'); unit.dataset.memberId = record.id; unit.append(reader);
      return pane = { header, name, nameText, nameSuffix, more, next, status, child, compactChild, freshness, unit, reader, messages, input, nativeFooter, heading, short, quote, truncation, source, notice, grip };
    }
    function render() {
      const reordered = [...readers.children].map(n => n.dataset.memberId).join('\n') !== records.map(r => r.id).join('\n');
      const active = reordered && doc.activeElement, selection = reordered && doc.getSelection();
      const selected = selection && !selection.isCollapsed && readers.contains(selection.anchorNode) && readers.contains(selection.focusNode)
        ? { anchor: selection.anchorNode, start: selection.anchorOffset, focus: selection.focusNode, end: selection.focusOffset } : null;
      const scrolls = reordered ? [...panes.values()].map(p => [p.messages, p.messages.scrollTop, p.messages.scrollLeft, p.short, p.short.scrollTop]) : [];
      const anchor = reordered && host.dataset.listUnits === 'true' && [...readers.children].find(n => n.getBoundingClientRect().bottom > readers.getBoundingClientRect().top);
      const anchorOffset = anchor && anchor.getBoundingClientRect().top - readers.getBoundingClientRect().top;
      host.dataset.layout = layout; host.dataset.focused = String(Boolean(focused)); host.dataset.brief = String(brief); host.dataset.content = String(contentVisible);
      simplify.setAttribute('aria-pressed', String(brief)); grid.setAttribute('aria-pressed', String(layout === 'grid')); list.setAttribute('aria-pressed', String(layout === 'list'));
      back.hidden = !focused; simplify.hidden = Boolean(focused) || !contentVisible; layouts.hidden = Boolean(focused) || !contentVisible; readers.hidden = Boolean(focused) || !contentVisible; empty.hidden = records.length > 0 || !contentVisible;
      const columnInput = layout === 'grid' && !focused && !brief && contentVisible && records.length <= 4;
      const listUnits = layout === 'list' && !focused && contentVisible;
      host.dataset.listUnits = String(listUnits); headers.hidden = listUnits;
      const retained = new Set(records.map(r => r.id));
      for (const [id, pane] of panes) if (!retained.has(id)) {
        options.disposeInput?.(id); options.disposeMessages?.(pane.messages); pane.header.remove(); pane.unit.remove(); panes.delete(id); weights.delete(id);
      }
      records.forEach((record, i) => {
        let pane = panes.get(record.id); if (!pane) { pane = makePane(record); panes.set(record.id, pane); }
        const label = options.label(record), suffix = label.startsWith(record.name) ? label.slice(record.name.length) : '';
        setText(pane.nameText, suffix ? record.name : label); setText(pane.nameSuffix, suffix); pane.name.title = label;
        pane.name.setAttribute('aria-label', `放大 ${label} 的会话`); pane.name.setAttribute('aria-pressed', String(focused === record.id));
        if (options.onMove) {
          pane.name.setAttribute('aria-description', `第 ${i + 1} 位，共 ${records.length} 位成员。${canOrder() ? '拖动卡片头排序，或按 Option 加上下方向键；也可在成员菜单中上移或下移。' : ''}`);
          if (canOrder()) pane.name.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
          else pane.name.removeAttribute('aria-keyshortcuts');
        }
        pane.more.hidden = !options.onMemberMenu;
        pane.more.disabled = !connected;
        pane.more.setAttribute('aria-label', `管理 ${label}`);
        pane.input.hidden = !columnInput;
        const nativeVisible = options.renderInput?.(pane.input, record, columnInput) || false;
        pane.reader.classList.toggle('has-column-input', columnInput);
        pane.nativeFooter.hidden = !nativeVisible;
        const nextParent = nativeVisible ? pane.nativeFooter : pane.heading;
        if (pane.next.parentElement !== nextParent) nextParent.append(pane.next);
        pane.next.hidden = (!listUnits && !nativeVisible) || i === records.length - 1;
        setText(pane.next, `跳到下一成员：${records[i + 1] ? options.label(records[i + 1]) : ''}`);
        pane.header.classList.toggle('is-focused', focused === record.id);
        pane.messages.hidden = brief; pane.short.hidden = !brief;
        pane.messages.setAttribute('aria-label', `${label} 的原会话`);
        pane.grip.setAttribute('aria-label', `调整 ${label} 的阅读列宽`);
        // Stable nodes preserve text selection, process expansion and anchors.
        if (listUnits) {
          if (pane.header.parentElement !== pane.unit) pane.unit.insertBefore(pane.header, pane.reader);
        } else if (headers.children[i] !== pane.header) headers.insertBefore(pane.header, headers.children[i] || null);
        if (readers.children[i] !== pane.unit) readers.insertBefore(pane.unit, readers.children[i] || null);
        if (!focused && !brief && contentVisible) options.renderMessages(pane.messages, record, options.messages(record), key(record.id));
        if (brief) {
          const snippet = excerpt(record, options.messages(record));
          pane.snippet = snippet;
          setText(pane.quote, snippet ? snippet.text : '原会话尚未报告可摘录的消息。');
          pane.truncation.hidden = !snippet?.truncated;
          pane.source.hidden = !snippet;
          if (snippet) {
            const time = snippet.time === null ? '记录时间未报告' : `本机记录 ${new Date(snippet.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            setText(pane.source, `${record.name} · ${time} · 查看原文 ›`);
            setText(pane.notice, [snippet.incomplete && '内容未完整同步', !snippet.nativeId && '原生上下文未报告', snippet.previousContext && '此前原生上下文'].filter(Boolean).join(' · '));
          } else setText(pane.notice, '');
        }
      });
      setWidths(); refreshStatus();
      for (const [messages, top, left, short, briefTop] of scrolls) { messages.scrollTop = top; messages.scrollLeft = left; short.scrollTop = briefTop; }
      if (anchor?.isConnected && host.dataset.listUnits === 'true') readers.scrollTop += anchor.getBoundingClientRect().top - readers.getBoundingClientRect().top - anchorOffset;
      if (active?.isConnected && doc.activeElement === doc.body && host.contains(active)) active.focus({ preventScroll: true });
      if (selected?.anchor.isConnected && selected.focus.isConnected) selection.setBaseAndExtent(selected.anchor, selected.start, selected.focus, selected.end);
    }
    return {
      update(people, isConnected = true, showContent = true, focusId = focused) {
        if (!isConnected || records.map(r => r.id).join('\n') !== people.map(r => r.id).join('\n')) { options.beforeInputLayout?.(); dragging = null; clearOrderMarkers(); }
        records = people; connected = isConnected; contentVisible = showContent;
        if (!focusId || records.some(r => r.id === focusId)) { if (focusId !== focused) originSelection = null; focused = focusId; }
        if (focused && !records.some(r => r.id === focused)) { const previous = focused; focused = ''; options.onFocus?.('', previous, key(previous)); }
        render();
      },
      focus, key, toolbar, refresh: refreshStatus, get focused() { return focused; },
      dispose() { toolbar.remove(); for (const [id, pane] of panes) { options.disposeInput?.(id); options.disposeMessages?.(pane.messages); } panes.clear(); host.replaceChildren(); },
    };
  }
  return { create, statusFacts, excerpt, adjustedWidths };
});
