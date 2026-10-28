// A reading surface for existing sessions. It has no native input, launch or
// sharing API; deliberate input stays in the existing session workspace.
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
    return { state: pending > 1 ? `${state} · ${pending} 项待处理` : state, child, freshness: `${stale ? '最后观察 · ' : ''}${time}`, stale };
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
    const toolbar = el('div', undefined, 'collaboration-toolbar');
    const back = button('← 返回共同工作', () => focus(''), 'collaboration-back'); back.hidden = true;
    const simplify = button('简化信息', () => {
      options.beforeLayout?.(); brief = !brief; render(); options.onLayout?.();
      if (!brief) { restoreSelection(briefSelection); briefSelection = null; }
    }); simplify.setAttribute('aria-pressed', 'false');
    simplify.addEventListener('pointerdown', () => { if (!brief) briefSelection = selectedRange(); });
    const grid = button('网格', () => setLayout('grid')), list = button('列表', () => setLayout('list'));
    const layouts = el('div', undefined, 'collaboration-layout-controls'); layouts.setAttribute('role', 'group'); layouts.setAttribute('aria-label', '成员阅读布局'); layouts.append(grid, list);
    toolbar.append(back, layouts, simplify);
    const headers = el('div', undefined, 'collaboration-statuses'); headers.setAttribute('aria-label', '全体协作成员状态');
    const readers = el('div', undefined, 'collaboration-readers');
    const empty = el('p', '邀请已有会话加入，一起查看各自的工作。', 'quiet collaboration-empty');
    host.classList.add('collaboration-overview'); host.append(toolbar, headers, readers, empty);
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
      options.beforeLayout?.();
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
    function setLayout(value) { options.beforeLayout?.(); layout = value; render(); options.onLayout?.(); }
    function refreshStatus() {
      for (const record of records) {
        const pane = panes.get(record.id); if (!pane) continue;
        const facts = statusFacts(record, connected);
        setText(pane.status, facts.state); setText(pane.child, facts.child); setText(pane.freshness, facts.freshness);
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
      // Reuse the application's existing member-drag contract on the handle,
      // leaving the conversation itself available for ordinary text selection.
      options.decorateHeader?.(name, record);
      name.addEventListener('pointerdown', () => { if (!focused) rememberSelection(); });
      const status = el('span', undefined, 'collaboration-member-state'); status.setAttribute('role', 'status');
      const child = el('span', undefined, 'collaboration-member-child'), freshness = el('span', undefined, 'collaboration-member-freshness');
      header.append(name, status, child, freshness);
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
      reader.append(messages, short, grip);
      return pane = { header, name, status, child, freshness, reader, messages, short, quote, truncation, source, notice, grip };
    }
    function render() {
      host.dataset.layout = layout; host.dataset.focused = String(Boolean(focused)); host.dataset.brief = String(brief); host.dataset.content = String(contentVisible);
      simplify.setAttribute('aria-pressed', String(brief)); grid.setAttribute('aria-pressed', String(layout === 'grid')); list.setAttribute('aria-pressed', String(layout === 'list'));
      back.hidden = !focused; simplify.hidden = Boolean(focused) || !contentVisible; layouts.hidden = Boolean(focused) || !contentVisible; readers.hidden = Boolean(focused) || !contentVisible; empty.hidden = records.length > 0 || !contentVisible;
      const retained = new Set(records.map(r => r.id));
      for (const [id, pane] of panes) if (!retained.has(id)) {
        options.disposeMessages?.(pane.messages); pane.header.remove(); pane.reader.remove(); panes.delete(id); weights.delete(id);
      }
      records.forEach((record, i) => {
        let pane = panes.get(record.id); if (!pane) { pane = makePane(record); panes.set(record.id, pane); }
        const label = options.label(record); setText(pane.name, label);
        pane.name.setAttribute('aria-label', `放大 ${label} 的会话`); pane.name.setAttribute('aria-pressed', String(focused === record.id));
        pane.header.classList.toggle('is-focused', focused === record.id);
        pane.messages.hidden = brief; pane.short.hidden = !brief;
        pane.messages.setAttribute('aria-label', `${label} 的原会话`);
        pane.grip.setAttribute('aria-label', `调整 ${label} 的阅读列宽`);
        // Stable nodes preserve text selection, process expansion and anchors.
        if (headers.children[i] !== pane.header) headers.insertBefore(pane.header, headers.children[i] || null);
        if (readers.children[i] !== pane.reader) readers.insertBefore(pane.reader, readers.children[i] || null);
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
    }
    return {
      update(people, isConnected = true, showContent = true, focusId = focused) {
        if (records.map(r => r.id).join('\n') !== people.map(r => r.id).join('\n')) dragging = null;
        records = people; connected = isConnected; contentVisible = showContent;
        if (!focusId || records.some(r => r.id === focusId)) { if (focusId !== focused) originSelection = null; focused = focusId; }
        if (focused && !records.some(r => r.id === focused)) { const previous = focused; focused = ''; options.onFocus?.('', previous, key(previous)); }
        render();
      },
      focus, key, refresh: refreshStatus, get focused() { return focused; },
      dispose() { for (const pane of panes.values()) options.disposeMessages?.(pane.messages); panes.clear(); host.replaceChildren(); },
    };
  }
  return { create, statusFacts, excerpt, adjustedWidths };
});
