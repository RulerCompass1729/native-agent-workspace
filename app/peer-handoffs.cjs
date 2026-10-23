// A finite sequence across existing local services. No provider process, model
// router, replay worker or external endpoint is created here.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readLayout } = require('./service-layout.cjs');
const { connectService } = require('./service-connection.cjs');
const CAPABILITY = 'peerReplyHandoffsV1';
const fields = ['nativeId', 'owner', 'memberRevision', 'controlRevision', 'connectionRevision', 'peerRevision'];
const backendIdentity = s => { const value = s.provider === 'codex' ? s.serverIdentity : s.processIdentity; return { pid: value?.pid ?? s.pid ?? null, started: value?.started ?? null }; };
const identity = s => ({ ...Object.fromEntries(fields.map(k => [k, s[k] ?? (k === 'peerRevision' ? 0 : null)])), backend: backendIdentity(s) });
const sameIdentity = (s, expected) => s && fields.every(k => (s[k] ?? (k === 'peerRevision' ? 0 : null)) === expected[k]) && JSON.stringify(backendIdentity(s)) === JSON.stringify(expected.backend);
const clean = (text, max) => typeof text === 'string' && !!text.trim() && text.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
const counts = info => Object.fromEntries(['background', 'scheduled', 'fleetPending', 'stopHookActive'].map(k => [k, info[k] ?? null]));
const hasWork = value => value.stopHookActive === true || ['background', 'scheduled', 'fleetPending'].some(k => Number.isSafeInteger(value[k]) && value[k] > 0);

class PeerLeases {
  constructor(workspace) { this.w = workspace; this.leases = new Map(); this.cancelled = new WeakMap(); }
  prepare(client, owner, spec) {
    const { id, ids, expected, deadline, maxSteps, names } = spec || {};
    if (!/^[a-f0-9-]{36}$/i.test(id || '') || !Array.isArray(ids) || ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && id.length <= 100) || ![2, 3, 4, 5, 6].includes(maxSteps) || maxSteps < ids.length ||
      !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 600000 || !expected || !names ||
      Object.keys(expected).length === 0 || Object.keys(expected).some(id => !ids.includes(id)) ||
      ids.some(id => typeof names[id] !== 'string' || !names[id].trim() || names[id].length > 160 || /[\x00-\x1f\x7f]/.test(names[id]))) throw Error('跨后台授权无效。');
    if (this.cancelled.get(client)?.has(id) || this.leases.has(id) || [...this.leases.values()].some(g => g.status === 'running') || this.w.room.run?.status === 'running') throw Error('已有协作或授权已撤销，请重新确认。');
    if (this.w.storageWarning) throw Error('请先处理本地保存问题。');
    for (const [sessionId, proof] of Object.entries(expected)) {
      const s = this.w.sessions.get(sessionId), r = this.w.runtimes.get(sessionId);
      if (!sameIdentity(s, proof) || s.owner !== owner || s.roomId !== 'shared' || s.state !== 'idle' || s.pendingTag || s.approval ||
        s.nativeContextPending || r?.nativeInputRequired || !r || r.chatAvailable === false || [s.background, s.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) throw Error('成员的原生身份、控制权或就绪状态已变化。');
    }
    const g = { peerLease: true, id, ids: [...ids], expected, names, deadline, maxSteps, status: 'running', owner, client, steps: new Set(), awaiting: null, result: null };
    for (const [key, previous] of this.leases) if (this.leases.size >= 32 && previous.status !== 'running') this.leases.delete(key);
    this.leases.set(id, g); this.w.changed(); return true;
  }
  valid(g) {
    return this.leases.get(g.id) === g && g.status === 'running' && Date.now() < g.deadline && !g.client.destroyed &&
      !this.w.storageWarning && Object.entries(g.expected).every(([id, proof]) => {
        const s = this.w.sessions.get(id), r = this.w.runtimes.get(id);
        return sameIdentity(s, proof) && s.roomId === 'shared' && !s.nativeContextPending && !s.approval &&
          !['ended', 'recoverable', 'disconnected', 'error', 'approval', 'stopping'].includes(s.state) && !r?.nativeInputRequired;
      });
  }
  pause(client, id, reason = '跨后台交接已暂停') {
    let stopped = this.cancelled.get(client); if (!stopped) this.cancelled.set(client, stopped = new Set());
    stopped.add(id); while (stopped.size > 32) stopped.delete(stopped.values().next().value);
    const g = this.leases.get(id);
    if (g?.client === client && g.status === 'running') { g.status = 'paused'; g.reason = reason; this.w.changed(); }
    return true;
  }
  revoke(reason, id) {
    for (const g of this.leases.values()) if (g.status === 'running' && (!id || g.ids.includes(id))) this.pause(g.client, g.id, reason);
  }
  observedWork(id, reason) {
    for (const g of this.leases.values()) if (g.status === 'running' && g.ids.includes(id)) {
      if (g.awaiting?.sessionId === id) g.stopAfterReply = reason; else this.pause(g.client, g.id, reason);
    }
  }
  working(id) { for (const g of this.leases.values()) if (g.status === 'running' && g.expected[id] && g.awaiting?.sessionId !== id) this.pause(g.client, g.id, '成员开始了授权之外的工作。'); }
  disconnected(client) { for (const g of this.leases.values()) if (g.client === client) this.pause(client, g.id, '协调连接已断开；未重发任务。'); }
  snapshot() {
    for (const g of this.leases.values()) if (g.status === 'running' && !this.valid(g)) this.pause(g.client, g.id, '成员状态、连接或授权期限已变化。');
    return [...this.leases.values()].map(g => ({ id: g.id, status: g.status, reason: g.reason, awaiting: g.awaiting, result: g.result }));
  }
  async send(client, owner, spec) {
    const { runId, step, sessionId, text, sourceId, senderId, displayText } = spec || {}, g = this.leases.get(runId);
    if (!g || g.client !== client || g.owner !== owner || !this.valid(g) || !Number.isInteger(step) || step < 1 || step > g.maxSteps ||
      g.steps.has(step) || (g.lastStep && step <= g.lastStep) || g.awaiting || g.ids[(step - 1) % g.ids.length] !== sessionId || !g.expected[sessionId] ||
      !clean(text, 16000) || !clean(displayText, 16000) || !/^[a-f0-9-]{36}$/i.test(sourceId || '') ||
      (step === 1 ? senderId !== null : senderId !== g.ids[(step - 2) % g.ids.length])) throw Error('跨后台派发已失效或已经申请；未自动重试。');
    const s = this.w.get(sessionId);
    if (s.state !== 'idle' || s.pendingTag || s.approval || this.w.runtime(sessionId).pendingQueue) throw Error('接收方尚未就绪。');
    g.steps.add(step); g.lastStep = step; g.result = null;
    const source = { id: randomUUID(), role: senderId ? 'assistant' : 'human', ...(senderId ? { sessionId: senderId } : { recipientId: sessionId }),
      name: senderId ? g.names[senderId] : '你', text: displayText, status: 'complete', time: Date.now(), runId,
      handoffFrom: sourceId, peerHandoff: true, deliveryTracked: true };
    this.w.room.messages.push(source); this.w.changed();
    try {
      const tag = await this.w.send(sessionId, text, null, g, null, source);
      if (!this.valid(g)) throw Error('本次输入可能已由原生接收，后续交接已停止；请核对发送详情。');
      return { tag, sourceId: source.id };
    } catch (error) { this.pause(client, runId, error.message); throw error; }
  }
  take(client, spec) {
    const g = this.leases.get(spec?.id), result = g?.result;
    if (!g || g.client !== client || !this.valid(g) || !result || result.step !== spec.step || result.tag !== spec.tag || result.consumed) throw Error('源回复的交接凭据已撤销或已经使用。');
    const message = this.w.room.messages.find(m => m.id === result.sourceId && m.sourceTag === result.tag && m.finalReply);
    if (!message || !clean(message.text, 10000)) throw Error('源回复不再完整或过长，请人工查看。');
    result.consumed = true; this.w.changed();
    return { ...result, text: message.text };
  }
  complete(s, info) {
    const g = [...this.leases.values()].find(g => g.awaiting?.sessionId === s.id && g.awaiting.tag === info.tag);
    if (!g || !this.valid(g)) return;
    const message = this.w.sharedReplies.final(s, info, g);
    if (!message || !message.finalReply || typeof info.text !== 'string' || !info.text.trim()) return this.pause(g.client, g.id, '原生回复归属未确认。');
    g.result = { tag: info.tag, sessionId: s.id, sourceId: message.id, nativeId: s.nativeId, step: g.lastStep, nativeWork: counts(info), stopAfterReply: g.stopAfterReply || null };
    g.awaiting = null; this.w.changed();
  }
}

class PeerRunner {
  constructor(workspace, dataDir, connect = connectService) {
    this.w = workspace; this.dataDir = dataDir; this.connect = connect; this.channels = new Map(); this.revision = 0;
    if (workspace.room.run?.kind === 'cross-service') {
      this.run = workspace.room.run;
      this.lastChannels = (this.run.peerServices || []).map(key => ({ key, owner: 'peer-pause-verification' }));
    }
    this.w.on('change', () => {
      if (this.run?.status === 'running' && this.w.room.run !== this.run) this.pause('协作已被替换').catch(() => {});
      else if (this.run && this.run.status !== 'running' && this.channels.size) this.revoke().catch(() => {});
    });
  }
  root() {
    return /^[a-f0-9]{20}$/.test(path.basename(this.dataDir)) && path.basename(path.dirname(this.dataDir)) === 'backends'
      ? path.dirname(path.dirname(this.dataDir)) : this.dataDir;
  }
  async start(owner, spec) {
    if (this.starting || this.processing || this.run?.pauseUnconfirmed || this.run?.status === 'running' || this.w.room.run?.status === 'running' || this.revoking) throw Error('已有协作或正在暂停，请稍候。');
    const { ids, goal, maxSteps, mode, labels, contexts, routes, replyTo, identities } = spec || {};
    if (mode !== 'replies' || !Array.isArray(ids) || ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length ||
      ![2, 3, 4, 5, 6].includes(maxSteps) || maxSteps < ids.length || !clean(goal, 6000) || !routes || !contexts || !labels || !identities) throw Error('跨后台目前支持明确授权的有限顺序核查。');
    const root = this.root(), layout = readLayout(root);
    if (path.resolve(root, layout.active) !== path.resolve(this.dataDir) || ids.some(id => !layout.entries.includes(routes[id]))) throw Error('后台归属已变化，请重新连接。');
    const epoch = ++this.revision, runId = randomUUID(), deadline = Date.now() + 600000;
    this.run = null; this.channels = new Map(); this.pendingRunId = runId;
    const valid = () => { if (epoch !== this.revision || this.w.storageWarning) throw Error('真人操作或保存问题使授权失效。'); };
    this.starting = (async () => {
      try {
        const records = new Map();
        for (const key of new Set(ids.map(id => routes[id]))) {
          const client = await this.connect(path.join(root, key), owner);
          const channel = { client, key, owner }; this.channels.set(key, channel); valid();
          channel.state = await client.call('initial'); valid();
          if (!channel.state.capabilities?.includes(CAPABILITY) || channel.state.storageWarning) throw Error('有后台缺少可撤销交接接口；原会话保留，可人工分享。');
          for (const id of ids.filter(id => routes[id] === key)) {
            const s = channel.state.sessions.find(s => s.id === id);
            if (!sameIdentity(s, identities[id] || {}) || s.nativeId !== contexts[id] || s.owner !== owner || s.roomId !== 'shared' || s.state !== 'idle' || s.pendingTag || s.approval || s.nativeInputRequired || s.chatAvailable === false) throw Error('请先接管并核对所选会话的原生身份和就绪状态。');
            records.set(id, s);
          }
        }
        const names = Object.fromEntries(ids.map(id => {
          const s = records.get(id), name = labels[id] ?? s.name;
          if (!clean(name, 60) || /[\r\n]/.test(name)) throw Error('参与者名称已变化。');
          return [id, `${name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${id.slice(0, 6)}`];
        }));
        for (const channel of this.channels.values()) {
          valid(); const expected = Object.fromEntries(ids.filter(id => routes[id] === channel.key).map(id => [id, identities[id]]));
          await channel.client.call('peerPrepare', { id: runId, ids, expected, deadline, maxSteps, names }); valid();
          channel.client.on('state', state => { channel.state = { ...channel.state, ...state }; this.schedule(); });
          channel.client.on('closed', () => { if (this.run?.id === runId && this.run.status === 'running') this.pause('后台连接断开；未重发任务。').catch(() => {}); });
        }
        valid();
        const source = { id: randomUUID(), role: 'human', name: '你', text: goal.trim(), time: Date.now(), runId, deliveryTracked: true, ...(replyTo ? { replyTo } : {}) };
        this.run = { id: runId, ids, names, goal: goal.trim(), maxSteps, mode: 'replies', kind: 'cross-service', steps: 0, status: 'running',
          startedAt: Date.now(), deadline, peerServices: [...this.channels.keys()], sourceId: source.id, awaiting: null, replies: {} };
        this.routes = routes; this.w.room.run = this.run; this.w.room.messages.push(source); this.w.changed();
        this.w.runEvent(`已授权跨后台按顺序核查，最多 ${maxSteps} 次回复、10 分钟；原生进程保持不变。`);
        this.w.persist(); valid();
        await this.deliver(ids[0], this.run.goal, source.id, null, this.run.goal);
        return true;
      } catch (error) { await this.pause(error.message); throw error; }
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }
  active(run = this.run) { return this.run === run && run?.status === 'running' && this.w.room.run === run && !this.w.storageWarning && Date.now() < run.deadline; }
  async deliver(id, text, sourceId, senderId, displayText) {
    if (!this.active()) throw Error('交接授权已失效。');
    const run = this.run, channel = this.channels.get(this.routes[id]);
    run.awaiting = { sessionId: id, pending: true, step: run.steps + 1 }; this.w.changed();
    const result = await channel.client.call('peerSend', { runId: run.id, step: run.steps + 1, sessionId: id, text, sourceId, senderId, displayText });
    if (!this.active(run)) return;
    if (typeof result?.tag !== 'string') throw Error('原生接收凭据未确认；未重发。');
    run.awaiting = { sessionId: id, tag: result.tag, step: run.steps + 1 }; this.w.changed(); this.schedule();
  }
  schedule() {
    if (!this.active()) return;
    if (this.processing) { this.dirty = true; return; }
    if (this.scheduled) return;
    this.scheduled = true;
    const run = this.run;
    queueMicrotask(() => { this.scheduled = false; if (!this.active(run)) return; this.processing = this.advance().catch(error => this.run === run ? this.pause(error.message) : undefined).finally(() => { this.processing = null; if (this.dirty) { this.dirty = false; this.schedule(); } }); });
  }
  async advance() {
    if (!this.active()) return;
    const run = this.run, awaiting = run.awaiting;
    for (const channel of this.channels.values()) {
      const lease = channel.state.peerLeases?.find(g => g.id === run.id);
      if (lease && lease.status !== 'running') return this.pause(lease.reason || '成员授权已变化。');
    }
    if (!awaiting || awaiting.pending) return;
    const channel = this.channels.get(this.routes[awaiting.sessionId]);
    const result = channel.state.peerLeases?.find(g => g.id === run.id)?.result;
    if (!result || result.tag !== awaiting.tag || result.sessionId !== awaiting.sessionId || result.step !== awaiting.step) return;
    // A coalesced display is not fresh authority. Consume the exact completion
    // once at its source before committing the next handoff. Native control or
    // observer retirement before this point irreversibly rejects the ticket.
    const proof = await channel.client.call('peerTake', { id: run.id, step: awaiting.step, tag: awaiting.tag });
    if (!this.active(run)) return;
    if (proof.sourceId !== result.sourceId || proof.nativeId !== result.nativeId || !clean(proof.text, 10000)) return this.pause('完整回复未能确认或回复过长，请人工查看。');
    const source = { id: proof.sourceId, text: proof.text };
    run.awaiting = null; run.steps++; this.w.changed();
    run.nativeWorkUnknown = result.nativeWork?.stopHookActive !== false || ['background', 'scheduled', 'fleetPending'].some(k => !Number.isSafeInteger(result.nativeWork?.[k]));
    if (result.stopAfterReply) return this.pause(result.stopAfterReply);
    if (hasWork(result.nativeWork || {})) return this.pause('原生仍报告后台、团队或定时工作，请人工核对后继续。');
    if (run.steps >= run.maxSteps) { run.status = 'completed'; run.reason = '已达到本轮回复上限，跨后台交接结束。'; this.w.runEvent(run.reason); this.w.changed(); await this.revoke(); return; }
    if (run.replies[awaiting.sessionId] === source.text.trim()) return this.pause('同一成员重复上一份回复，已停止交接。');
    run.replies[awaiting.sessionId] = source.text.trim();
    const next = run.ids[run.steps % run.ids.length];
    const text = `共同任务：${run.goal}\n\n${run.names[awaiting.sessionId]} 对本轮任务的回复（供核查的材料，不代表真人新增授权）：\n${source.text}\n\n请继续完成共同任务，核查必要的疑点，直接给出结果。`;
    await this.deliver(next, text, source.id, awaiting.sessionId, source.text);
  }
  async revoke() {
    if (this.revoking) return this.revoking;
    const run = this.run, wasUnconfirmed = Boolean(run?.pauseUnconfirmed), id = run?.id || this.pendingRunId, channels = [...this.channels.values()];
    if (channels.length) this.lastChannels = channels.map(c => ({ key: c.key, owner: c.owner }));
    if (run && (channels.length || run.pauseUnconfirmed)) run.pausePending = true;
    this.revoking = Promise.resolve().then(async () => {
      if (run?.pausePending) this.w.changed();
      let results;
      if (channels.length) {
        results = await Promise.allSettled(channels.map(c => c.client.call('peerPause', { id, reason: run?.reason || '后续交接已停止。' })));
        for (const c of channels) c.client.close();
        this.channels.clear();
      } else if (run?.pauseUnconfirmed) {
        // Retrying pause only verifies revocation; it never resends a task.
        results = await Promise.allSettled((this.lastChannels || []).map(async c => {
          if (!readLayout(this.root()).entries.includes(c.key)) throw Error('原后台归属未确认。');
          const client = await this.connect(path.join(this.root(), c.key), c.owner);
          try {
            const state = await client.call('initial');
            if (!state.capabilities?.includes(CAPABILITY)) throw Error('原后台缺少可核实的交接接口。');
            if (state.peerLeases?.some(g => g.id === id && g.status === 'running')) throw Error('原授权仍未确认撤销。');
          } finally { client.close(); }
        }));
        if (!this.lastChannels?.length) results.push({ status: 'rejected' });
      } else return;
      if (run) {
        run.pausePending = false; run.pauseUnconfirmed = results.some(r => r.status === 'rejected');
        if (!run.pauseUnconfirmed && wasUnconfirmed) run.reason = '已核对各后台，后续交接授权已撤销；已接收的原生工作仍保留。';
        if (run.pauseUnconfirmed) run.reason = '后续派发已停止；部分后台未确认撤销授权。请重新核对暂停，已接收的原生工作仍可能继续。';
        this.w.changed();
      }
    });
    try { await this.revoking; } finally { this.revoking = null; }
  }
  async pause(reason = '你暂停了跨后台交接；已接收的原生工作保留。') {
    this.revision++;
    if (this.run?.status === 'running') {
      this.run.status = 'paused'; this.run.pausePending = true; this.run.reason = reason; this.w.runEvent('正在撤销后续交接授权；已接收的原生工作仍可能继续。'); this.w.changed();
    }
    await this.revoke();
  }
}

// Merge an explicitly delegated send into the original human/final-reply block.
// Persisted native blocks remain in their original service; display adds receipts.
function mergePeerMessages(messages) {
  const map = new Map(messages.map(m => [m.id, m])), aliases = new Map();
  for (const m of messages) if (m.peerHandoff && m.handoffFrom) {
    const source = map.get(m.handoffFrom);
    if (!source || source.role !== m.role || source.sessionId !== m.sessionId || (source.role !== 'human' && !source.finalReply)) continue;
    map.set(source.id, { ...source, deliveries: [...(source.deliveries || []), ...(m.deliveries || [])], deliveryTracked: true });
    aliases.set(m.id, source.id); map.delete(m.id);
  }
  return [...map.values()].map(m => aliases.has(m.replyTo) ? { ...m, replyTo: aliases.get(m.replyTo) } : m);
}
module.exports = { PeerLeases, PeerRunner, CAPABILITY, identity, mergePeerMessages };
