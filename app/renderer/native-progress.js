/* Private observers never send native input, claim ownership or resize a PTY. */
class NativeProgressPanel {
  constructor(id, saved = {}) {
    this.id = id; this.index = 0; this.events = []; this.pendingEvents = []; this.progress = new Map(); this.progressRevision = 0; this.pendingBytes = 0;
    this.live = saved.live !== false; this.disposed = false; this.bytes = 0; this.paintRevision = 0;
    this.element = node('details', undefined, 'native-progress'); this.element.open = saved.open !== false; this.element.dataset.progressId = id;
    this.summary = node('summary'); this.heading = node('strong'); this.status = node('span', '', 'quiet');
    this.summary.append(this.heading, this.status);
    this.notice = node('p', '', 'quiet progress-notice'); this.notice.setAttribute('role', 'status');
    this.viewport = node('div', undefined, 'progress-viewport'); this.surface = node('div', undefined, 'progress-screen'); this.viewport.append(this.surface); this.followScreen = saved.followScreen !== false;
    const reading = () => { this.userScrollingUntil = performance.now() + 700; };
    this.viewport.addEventListener('wheel', reading, { passive: true });
    this.viewport.addEventListener('pointerdown', reading);
    this.viewport.addEventListener('keydown', reading);
    this.viewport.addEventListener('scroll', () => {
      // Mounting/reparenting an xterm can generate a scroll at zero. Only the
      // person's scroll gesture changes follow mode; layout must not do so.
      if (!this.borrowed || performance.now() < this.userScrollingUntil) this.followScreen = this.viewport.scrollTop + this.viewport.clientHeight >= this.viewport.scrollHeight - 4;
    });
    this.range = node('input'); this.range.type = 'range'; this.range.min = '0'; this.range.max = '0'; this.range.max = String(saved.target || 0); this.range.value = String(saved.target || 0); this.epoch = saved.epoch; this.range.setAttribute('aria-label', '回看原生过程');
    this.position = node('span', '实时', 'quiet');
    this.controls = node('div', undefined, 'progress-controls');
    this.controls.append(this.range, this.position, button('回到实时', () => { this.live = true; this.followScreen = true; this.savedScroll = null; this.replay(this.index); }), button('复制', () => api.copy(this.term?.getSelection() || '')), button('重新连接画面', () => this.reload()), button('操作终端', () => selected === 'room' ? selectRoom(this.id) : select(this.id, 'terminal')));
    this.range.oninput = () => { this.live = false; this.replay(Number(this.range.value)); };
    this.trace = node('details', undefined, 'progress-trace'); this.traceSummary = node('summary', '运行记录'); this.traceList = node('div'); this.trace.append(this.traceSummary, this.traceList); this.trace.open = !!saved.traceOpen; this.savedScroll = saved.scroll; this.traceChosen = typeof saved.traceOpen === 'boolean';
    this.traceSummary.addEventListener('click', () => { this.traceChosen = true; });
    this.element.append(this.summary, this.notice, this.viewport, this.controls, this.trace);
  }
  useNativeEntry(entry) {
    if (!entry?.ready) return;
    this.borrowed = entry;
    entry.element.hidden = false;
    entry.element.classList.add('terminal-mirror');
    const screen = entry.term.element.querySelector('.xterm-screen');
    entry.element.style.width = screen.style.width; entry.element.style.height = screen.style.height;
    if (entry.element.parentElement !== this.viewport) this.viewport.append(entry.element);
    this.viewport.hidden = false; this.surface.hidden = true; this.controls.hidden = true;
    this.notice.textContent = '同一原生终端的实时画面 · 仅你可见；在下方对话框输入，或切回原生终端操作。';
    if (!this.borrowedActions) {
      this.borrowedActions = node('div', undefined, 'progress-controls');
      this.borrowedActions.append(button('复制选中内容', () => api.copy(this.borrowed?.term.getSelection() || '')),
        button('操作终端', () => selected === 'room' ? selectRoom(this.id) : select(this.id, 'terminal')));
      this.viewport.after(this.borrowedActions);
    }
    this.followNativeEntry();
  }
  followNativeEntry() {
    requestAnimationFrame(() => {
      if (!this.disposed && this.borrowed && this.followScreen && !this.borrowed.term.hasSelection()) this.viewport.scrollTop = this.viewport.scrollHeight;
    });
  }
  releaseNativeEntry() {
    if (!this.borrowed) return;
    const entry = this.borrowed; this.borrowed = null;
    entry.element.classList.remove('terminal-mirror');
    entry.element.style.width = ''; entry.element.style.height = '';
    $('terminal-area').append(entry.element);
  }
  update(record, capable, connected = true) {
    this.connected = connected;
    this.heading.textContent = record.name;
    this.status.textContent = states[record.state] + (record.activity ? ' · ' + record.activity : '');
    if (!connected) { this.status.textContent = '已断开 · 最后收到的画面'; this.notice.textContent = '连接已断开，下面的画面与记录停止同步；重新连接后会核对缺口。'; return; }
    if (!capable) { this.notice.textContent = '旧连接尚无只读实时画面，可在原生终端核对。'; this.viewport.hidden = true; this.controls.hidden = true; return; }
    if (!this.started) { this.started = true; this.reload(); }
  }
  async reload() {
    if (this.loading || this.disposed || this.connected === false) return;
    this.loading = true;
    try {
      const snapshot = await api.observe(this.id);
      if (this.disposed || this.connected === false) return;
      const wasLive = this.live, previousTarget = Number(this.range.value), previousEpoch = this.epoch;
      this.progress = new Map(snapshot.progress.items.map(item => [item.id, item])); this.progressRevision = snapshot.progress.revision;
      this.traceTruncated = snapshot.progress.truncated; this.renderTrace();
      const raw = snapshot.terminal;
      this.raw = raw; this.events = raw?.events || []; this.index = raw?.index || 0;
      this.trace.hidden = !!raw?.legacySnapshots;
      this.bytes = raw?.bytes || 0; this.checkpoint = raw?.checkpoint; this.epoch = raw?.epoch;
      this.viewport.hidden = !this.checkpoint; this.controls.hidden = !this.checkpoint;
      if (!this.checkpoint && !this.traceChosen) this.trace.open = true;
      this.notice.textContent = raw?.unavailable || (!raw ? '尚未连接原生画面；运行记录仍会更新。打开一次原生终端后可在这里实时查看。' : raw.truncated ? '仅保留最近的原生过程；更早临时画面已移出内存。此处仅你可见。' : '原生实时画面 · 仅你可见，临时过程只在本机内存保留');
      if (raw?.legacySnapshots && !raw.unavailable) this.notice.textContent = '原会话实时画面 · 仅你可见。旧连接以画面快照同步，接入前或两次快照之间的临时变化无法完整回看。';
      if (this.checkpoint) {
        this.ensureScreen(); this.live = wasLive;
        const retained = previousEpoch === this.epoch && previousTarget >= this.checkpoint.index;
        if (!wasLive && !retained) this.notice.textContent = '此前回看位置已移出缓存，显示当前最早保留画面。';
        if (!(this.selectionHeld && this.term.hasSelection())) this.replay(wasLive ? this.index : retained ? Math.min(previousTarget, this.index) : this.checkpoint.index);
      }
      if (this.borrowed) this.useNativeEntry(this.borrowed);
    } catch { if (!this.disposed && this.connected !== false) this.notice.textContent = '实时连接暂不可用，原生会话未改动。'; }
    finally {
      this.loading = false;
      const pending = this.pendingEvents; this.pendingEvents = []; this.pendingBytes = 0;
      const overflow = this.pendingOverflow; this.pendingOverflow = false;
      for (const event of pending) event.progress ? this.receiveProgress(event.progress) : this.receive(event);
      if (overflow && !this.disposed) this.reload();
    }
  }
  ensureScreen() {
    if (this.term) return;
    this.term = new Terminal({ cols: this.checkpoint.cols, rows: this.checkpoint.rows, fontSize: 12, lineHeight: 1.2,
      fontFamily: 'Menlo, Monaco, monospace', cursorBlink: false, disableStdin: true, scrollback: 5000,
      theme: { background: '#191b1e', foreground: '#e6e8eb', selectionBackground: '#53677b88' } });
    this.term.open(this.surface);
    this.term.textarea?.setAttribute('aria-label', '只读原生实时画面');
    this.term.onSelectionChange(() => {
      if (!this.raw?.legacySnapshots || !this.term.hasSelection() || !this.live) return;
      // A complete legacy frame resets xterm. Keep the exact selected frame,
      // rather than trying to transplant a selection onto changed text.
      this.live = false; this.paintRevision++; this.paintPending = []; this.paintBytes = 0; this.pendingReplay = null;
      this.selectionHeld = true; this.range.value = String(this.paintedIndex || 0);
      this.position.textContent = '已停在选中文字的画面 · 可回到实时';
    });
    // No onData/onBinary handlers: device queries cannot reach the agent.
  }
  dimensions(cols, rows) {
    this.term.resize(cols, rows);
    const screen = this.term.element.querySelector('.xterm-screen');
    this.surface.style.width = screen.style.width; this.surface.style.height = screen.style.height;
  }
  writeScreen(data) { return new Promise(resolve => this.term.write(data, resolve)); }
  replay(target) {
    if (!this.term || !this.checkpoint || this.disposed) return;
    this.selectionHeld = false;
    const revision = ++this.paintRevision;
    this.paintPending = []; this.paintBytes = 0;
    this.pendingReplay = { revision, checkpoint: this.checkpoint, events: this.events.filter(event => event.index <= target), target };
    this.range.value = String(target); this.pump();
  }
  paint(event) {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    this.paintPending ||= []; this.paintBytes ||= 0;
    if (this.paintPending.length >= 1200 || this.paintBytes + bytes > 2 * 1024 * 1024) {
      this.paintRevision++; this.paintPending = []; this.paintBytes = 0; this.pendingReplay = null;
      this.notice.textContent = '输出暂时超过绘制速度，正在对齐最新画面；回看范围可能变化。';
      this.reload(); return;
    }
    this.paintPending.push({ event, bytes }); this.paintBytes += bytes; this.pump();
  }
  async pump() {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (!this.disposed && (this.pendingReplay || this.paintPending?.length)) {
        const replay = this.pendingReplay;
        if (replay) {
          this.pendingReplay = null;
          const { revision, checkpoint, events, target } = replay;
          this.term.reset(); this.dimensions(checkpoint.cols, checkpoint.rows); await this.writeScreen(checkpoint.buffer);
          // Yield between bounded batches and abandon a superseded rewind.
          for (let i = 0; i < events.length && !this.disposed && revision === this.paintRevision;) {
            const first = events[i], batch = []; this.dimensions(first.cols, first.rows);
            do { batch.push(events[i++].data); } while (i < events.length && batch.length < 64 && events[i].cols === first.cols && events[i].rows === first.rows);
            await this.writeScreen(batch.join(''));
          }
          if (this.disposed || revision !== this.paintRevision) continue;
          this.paintedIndex = target;
          this.range.min = String(checkpoint.index); this.range.max = String(this.index); this.range.value = String(target);
          const event = events.at(-1) || checkpoint;
          this.position.textContent = this.live ? '实时' : `回看 ${new Date(event.time).toLocaleTimeString()}`;
          this.viewport.scrollTop = this.followScreen ? this.viewport.scrollHeight : this.savedScroll ?? this.viewport.scrollTop; this.savedScroll = null;
        } else {
          const revision = this.paintRevision, first = this.paintPending[0].event, batch = [];
          do { const next = this.paintPending.shift(); this.paintBytes -= next.bytes; batch.push(next.event); }
          while (this.paintPending.length && batch.length < 64 && this.paintPending[0].event.cols === first.cols && this.paintPending[0].event.rows === first.rows);
          this.dimensions(first.cols, first.rows); await this.writeScreen(batch.map(event => event.data).join(''));
          if (this.disposed || revision !== this.paintRevision) continue;
          this.paintedIndex = batch.at(-1).index;
          if (this.live) this.range.value = String(batch.at(-1).index);
          requestAnimationFrame(() => { if (!this.disposed && revision === this.paintRevision) {
            this.element.dataset.paintLatency = String(Math.max(0, Date.now() - (first.receivedAt || first.time)));
            if (this.live && this.followScreen) this.viewport.scrollTop = this.viewport.scrollHeight;
          } });
        }
      }
    } catch { if (!this.disposed) this.notice.textContent = '原生画面绘制失败，请重新连接画面。'; }
    finally { this.pumping = false; }
  }
  queuePending(event) {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (this.pendingEvents.length >= 1200 || this.pendingBytes + bytes > 2 * 1024 * 1024) { this.pendingOverflow = true; return; }
    this.pendingBytes += bytes; this.pendingEvents.push(event);
  }
  receive(event) {
    if (event.observationError && !this.disposed && this.connected !== false) { this.notice.textContent = '原会话画面暂时未能同步，以下是最后收到的内容；可重新连接画面。'; return; }
    if (this.disposed || this.connected === false || !event.epoch) return;
    if (this.loading) {
      this.queuePending(event);
      return;
    }
    if (!this.raw || event.epoch !== this.epoch || event.checkpointRequired || this.pendingOverflow) {
      this.pendingOverflow = false; this.notice.textContent = '正在重新对齐原生画面；回看范围可能已变化。'; this.reload(); return;
    }
    if (event.index <= this.index) return;
    if (event.index !== this.index + 1) { this.notice.textContent = '检测到输出缺口，正在重新对齐原生画面。'; this.reload(); return; }
    this.index = event.index; this.bytes += new TextEncoder().encode(JSON.stringify(event)).length; this.events.push(event);
    if (this.events.length > 1200 || this.bytes > 2 * 1024 * 1024) { this.reload(); return; }
    this.range.max = String(this.index);
    if (this.live && this.term) { this.paint(event); this.range.value = String(this.index); }
    else this.position.textContent = '回看中 · 有新输出';
  }
  receiveProgress(event) {
    if (this.disposed || this.connected === false) return;
    if (this.loading) { this.queuePending({ progress: event }); return; }
    if (event.revision <= this.progressRevision) return;
    if (event.revision !== this.progressRevision + 1) { this.reload(); return; }
    this.progressRevision = event.revision; this.progress.set(event.item.id, event.item);
    for (const id of event.removed || []) this.progress.delete(id); this.traceTruncated = event.truncated;
    if (this.progress.size > 200) { this.reload(); return; }
    this.renderTrace();
  }
  renderTrace() {
    this.traceSummary.textContent = `运行记录 · ${this.progress.size}${this.traceTruncated ? '（仅最近记录）' : ''}`;
    const existing = new Map([...this.traceList.children].map(element => [element.dataset.itemId, element]));
    for (const item of this.progress.values()) {
      let row = existing.get(item.id);
      if (!row) {
        row = node('details'); row.dataset.itemId = item.id; row.append(node('summary'), node('pre'), button('附近原生画面', () => {
          const latest = this.progress.get(item.id); const target = this.events.filter(event => event.time <= latest.updatedAt).at(-1);
          if (target) { this.live = false; this.replay(target.index); } else this.notice.textContent = '这段原生画面已不在当前保留范围内。';
        })); this.traceList.append(row);
      }
      const heading = `${new Date(item.time).toLocaleTimeString()} · ${item.title || item.kind} · ${{ running: '进行中', completed: '完成', failed: '失败', waiting: '等待确认', observed: '已观察' }[item.status] || item.status || ''}`;
      if (row.children[0].textContent !== heading) row.children[0].textContent = heading;
      const text = (item.truncated ? '仅显示最近输出；完整过程请核对原生画面。\n' : '') + (item.text || '');
      if (row.children[1].textContent !== text) row.children[1].textContent = text;
      row.children[1].hidden = !item.text;
      existing.delete(item.id);
    }
    for (const row of existing.values()) row.remove();
  }
  readingState() { return { live: this.live, epoch: this.epoch, target: Number(this.range.value), open: this.element.open, traceOpen: this.trace.open, scroll: this.term ? this.viewport.scrollTop : undefined, followScreen: this.followScreen }; }
  dispose() { this.disposed = true; this.paintRevision++; this.releaseNativeEntry(); api.unobserve(this.id).catch(() => {}); this.term?.dispose(); this.element.remove(); this.pendingEvents = []; this.pendingReplay = null; this.paintPending = []; }
}
