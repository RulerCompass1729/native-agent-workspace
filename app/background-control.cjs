// Application commands share the GUI's handlers. This module has no desktop,
// browser debugger, provider connection, synthetic keyboard or permission API.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const operation = require('./background-operation.cjs');
const clone = v => JSON.parse(JSON.stringify(v));
const token = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
// Parameters use the existing application's names and order. All values still
// pass its normal validators. Snapshot supplies current native/turn identities.
const parameters = {
  initial: ['Selected foreign conversation requires confirmation; read the resulting operation receipt after approval.'], preflight: [], dataDirectory: [], retrySave: [], reconnect: [], connectionUpdates: [], quitService: [],
  interfaceSettings: ['action: describe|update', 'namespace: locale|client-ui-theme (update only)', 'patch (update only)', 'current revision from describe (update only)'],
  prepareInput: ['sessionId'], observe: ['sessionId'], unobserve: ['sessionId'], claim: ['sessionId', 'mode: chat|terminal'],
  terminal: ['sessionId'], terminalSnapshot: ['sessionId'], input: ['sessionId', 'exact terminal input'], resize: ['sessionId', 'cols', 'rows'],
  interrupt: ['sessionId'], pause: [], approve: ['sessionId', 'requestId', 'decision: accept|decline|cancel'], answer: ['sessionId', 'requestId', 'answers'],
  wakePolicy: ['sessionId or null for global', 'enabled?'], operatorAction: ['sessionId', 'action', 'value?'],
  join: ['sessionId', 'join: boolean'], roomRename: ['name'], roomNotes: ['text', 'expectedRevision'], roomMemberOrder: ['change'],
  archiveSession: ['sessionId'], restoreSession: ['sessionId'], archiveRoom: [], restoreRoom: [],
  spaceCreate: ['name'], spaceMerge: ['action: preview|status|commit|recover|discard|undo', 'value'],
  spaceAction: ['roomId', 'action: join|rename|notes|memberOrder|archive|restore|stageImages|removeImage|acceptImages|removeFile|queueAdd|queueCancel|queueResolve|forward|queueShared|steerShared|run|pause|clearSharedHistory', 'queueAdd: [text, assignee or null]; only the person-designated secretary may add; queueCancel/queueResolve are person-only; other arguments in the corresponding command order'],
  queueSecretary: ['sessionId or null to revoke; person-only, agents cannot designate themselves'],
  spaceFiles: ['roomId', 'fileId?; omit to import the explicit paths'], gitWorktreePreview: ['selected repository path', 'nonce', 'relative path'],
  create: ['options: {provider,cwd,name,view?,gitWorktree?}'], nativeHistory: ['options?'], importHistory: ['nativeId', 'options'],
  rename: ['sessionId', 'name'], sidebar: ['change'],
  send: ['sessionId', 'exact message', 'expectedNativeId'], forward: ['sessionId', 'exact message', 'expectedNativeId', 'replyTo?'],
  queue: ['sessionId', 'exact message', 'expectedNativeId'], queueShared: ['sessionId', 'exact message', 'expectedNativeId', 'replyTo?'],
  steer: ['sessionId', 'exact message', 'expectedNativeId', 'expectedTurnId'], steerShared: ['sessionId', 'exact message', 'expectedNativeId', 'expectedTurnId', 'replyTo?'],
  run: ['sessionIds', 'goal text', 'turn budget', 'mode: replies|task', 'expected names?', 'expected native contexts?', 'replyTo?'],
  runtimeLocation: ['program: claude|codex|python3', 'reset: boolean?'], clearSharedHistory: [],
  draft: ['sessionId', 'text'], retainDraftRecovery: ['sessionId', 'text'], discardDraftRecovery: ['sessionId', 'text'],
  backendSwitchSettings: ['auto: boolean?'], switchBackend: ['expected option from connectionUpdates'], continueConnection: ['sessionId', 'expected continuation option'],
  resume: ['sessionId'], forget: ['sessionId'], stop: ['sessionId'], openExternal: ['http(s) URL; background returns the URL without opening the desktop browser'],
  openMessageFile: ['source: {kind,sessionId,messageId,nativeId,cwd,roomId?}', 'local path', '{line}?'],
  readingState: ['positions', 'panorama?'], viewState: ['{selected,mode,spaceId?,roomViews?,terminalLayout?,terminalDisplay?,...}; independent agent view only'],
  openLocalFile: ['sessionId?; supply paths on the invocation'], closeLocalFile: ['preview token'], saveLocalFile: ['preview token; supply a new destination in paths'],
  chooseFolder: [], newWindow: ['sessionId?; returns an independent hidden view_id'], copy: ['text; independent clipboard only'], pasteText: [],
  stageImages: ['sessionId', 'nativeId', 'files'], pasteNativeContent: ['sessionId', 'nativeId'], previewImage: ['source'], expandImage: ['token'], copyImage: ['token'], releaseImage: ['token'],
};
const tool = { name: 'workspace_control', description: 'Operate NAW in the background without moving the desktop pointer or changing the human window. Discover commands with catalog, inspect the independent view with snapshot, invoke an exact existing application command, and read durable receipts. Native permissions and human confirmations remain required. Never resend an uncertain operation. This tool does not authorize new work.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['catalog', 'snapshot', 'invoke', 'receipt'] },
    view_id: { type: 'string', maxLength: 160 },
    method: { type: 'string', maxLength: 80 }, arguments: { type: 'array', maxItems: 12 },
    operation_id: { type: 'string', maxLength: 160 }, paths: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 8192 } },
  }, required: ['action'] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } };
function validate(value) {
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(tool.inputSchema.properties, k)) ||
      !['catalog', 'snapshot', 'invoke', 'receipt'].includes(value.action) || Buffer.byteLength(JSON.stringify(value)) > 131072) throw Error('Invalid background command');
  if (value.view_id !== undefined && !token(value.view_id)) throw Error('Invalid independent view');
  if (value.action === 'invoke') {
    if (typeof value.method !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value.method) ||
        !Array.isArray(value.arguments) || value.arguments.length > 12 || !token(value.operation_id)) throw Error('An exact command, arguments and unique operation_id are required');
    if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.length > 16 || value.paths.some(p => typeof p !== 'string' || p.length > 8192 || !path.isAbsolute(p) || p.includes('\0')))) throw Error('Invalid explicit file selection');
  } else if (value.action === 'receipt') {
    if (!token(value.operation_id) || Object.keys(value).some(k => !['action', 'operation_id'].includes(k))) throw Error('Invalid receipt request');
  } else if (Object.keys(value).some(k => !['action', ...(value.action === 'snapshot' ? ['view_id', 'operation_id'] : [])].includes(k)) ||
    value.action === 'snapshot' && value.operation_id !== undefined && !token(value.operation_id)) throw Error('Read command does not accept mutation arguments');
  return clone(value);
}
class ConfirmationRequired extends Error {
  constructor(value) { super('This operation needs the existing human confirmation'); this.confirmation = clone(value); }
}
class BackgroundControl {
  constructor({ dataDir, handlers, context, confirmation, audit, confirmationPending, project = record => record, changed = () => {}, now = Date.now }) {
    this.file = path.join(dataDir, 'background-operations.json'); this.handlers = handlers; this.context = context; this.changed = changed; this.now = now;
    this.data = { version: 1, records: [], views: {} }; this.inflight = new Map(); this.contexts = new Map(); this.failed = false;
    this.confirmation = confirmation; this.audit = audit;
    this.confirmationPending = confirmationPending;
    this.project = project;
    try {
      const st = fs.lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || st.mode & 0o077 || st.size > 32 * 1024 * 1024) throw Error('Unsafe background operation record');
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.data.version !== 1 || !Array.isArray(this.data.records) || this.data.records.some(r => !token(r.id) || !r.actor || !r.command || !token(r.state))) throw Error('Invalid background operation record');
      this.data.views ||= {};
      // A process died after recording intent. No automatic replay.
      if (this.data.records.some(r => r.state === 'running')) this.commit(d => { for (const r of d.records) if (r.state === 'running') r.state = 'unconfirmed'; });
    } catch (e) { if (e.code !== 'ENOENT') { this.failed = true; throw e; } }
  }
  commit(change) {
    if (this.failed) throw Error('Background operation storage is unavailable');
    const next = clone(this.data); change(next);
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error('Background operation record is full; existing records are retained');
    const temporary = `${this.file}.${randomUUID()}.tmp`; let renamed = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file); renamed = true;
      const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.data = next; this.changed();
    } catch (error) {
      this.failed = true; if (!renamed) fs.rmSync(temporary, { force: true });
      throw Error('Background operation save is unconfirmed; no automatic replay', { cause: error });
    }
  }
  key(sender) { return `${sender.provider}:${sender.id}:${sender.nativeId}`; }
  catalog() { return [...this.handlers.keys()].filter(name => !['backgroundDecision', 'uiReady'].includes(name)).sort().map(name => ({ method: name, parameters: parameters[name] || [],
    ...( ['chooseFolder', 'openLocalFile', 'saveLocalFile', 'runtimeLocation', 'spaceFiles'].includes(name) ? { fileSelection: 'Supply explicit absolute paths on the invocation; no desktop file picker is opened.' } : {}) })); }
  async view(sender, viewId = 'default') {
    if (this.closed) throw Error('Background control is closing');
    const key = this.key(sender) + ':' + viewId;
    if (viewId !== 'default' && !this.data.views[key]) throw Error('Independent view does not exist');
    if (!this.contexts.has(key)) this.contexts.set(key, Promise.resolve(this.context(sender, this.data.views[key] && clone(this.data.views[key]))));
    return this.contexts.get(key);
  }
  async newView(sender, selected, mode) {
    if (this.closed) throw Error('Background control is closing');
    const viewId = randomUUID(), key = this.key(sender) + ':' + viewId;
    this.commit(d => { d.views[key] = { owner: randomUUID(), selected: selected || '', mode, preference: mode, active: false }; });
    await this.view(sender, viewId);
    return { view_id: viewId, visible: false };
  }
  receipt(sender, id) {
    const record = this.data.records.find(r => r.id === id && this.key(r.actor) === this.key(sender));
    return record ? this.project(clone(record)) : null;
  }
  async publish(record, context) {
    if (!operation.maintenanceAction(record.command.method, record.command.arguments, record.actor)) return;
    if (typeof this.audit !== 'function') throw Error('Maintenance event storage is unavailable');
    await this.audit(clone(record), context);
  }
  async finishAudit(actor, id, context) {
    const record = this.receipt(actor, id);
    try { await this.publish(record, context); }
    catch (error) {
      // Never rerun a side effect because its display journal failed. Retain the
      // actual result separately and make the incomplete audit visible.
      this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(actor));
        Object.assign(r, { resultState: r.state, state: 'unconfirmed', auditError: String(error.message).slice(0, 2048), error: 'The maintenance space event could not be saved; inspect the recorded result and do not repeat.' }); });
    }
    return this.receipt(actor, id);
  }
  async call(binding, input) {
    if (this.closed) throw Error('Background control is closing');
    let args = validate(input); const { sender, identity } = binding;
    const valid = async () => { await binding.refresh?.(); if (!binding.valid()) throw Error('The originating native call is no longer valid'); };
    await valid();
    if (args.action === 'catalog') return { state: 'complete', commands: this.catalog(), background: true };
    if (args.action === 'receipt') {
      const saved = this.receipt(sender, args.operation_id);
      if (saved) {
        const context = await this.view(sender, saved.command.view_id);
        const delivery = await context.delivery?.(saved.command, saved.value, saved.actor, saved.guard);
        if (delivery) this.commit(d => { const r = d.records.find(r => r.id === saved.id && this.key(r.actor) === this.key(sender)); r.delivery = delivery; if (delivery.nativeReceived) r.state = 'received'; });
      }
      return { state: 'complete', receipt: this.receipt(sender, args.operation_id), retry: false };
    }
    const context = await this.view(sender, args.view_id); await valid();
    const selected = args.action === 'snapshot' || args.method === 'initial' ? context.view.selected : null;
    const target = selected && selected !== sender.id && context.client.snapshot?.().sessions?.some(s => s.id === selected) ? selected : null;
    const implicitSnapshot = args.action === 'snapshot' && args.operation_id === undefined;
    if (args.action === 'snapshot' && (!target || context.metadataOnly?.())) {
      const actor = operation.actor({ ...sender, callId: identity.callId, turnId: identity.turnId, operationId: identity.callId });
      return operation.run(actor, async () => ({ state: 'complete', value: await this.handlers.get('initial')(context) }), { context, args, actor, valid });
    }
    if (args.action === 'snapshot') args = { action: 'invoke', method: 'initial', arguments: [], operation_id: args.operation_id || randomUUID(), ...(args.view_id ? { view_id: args.view_id } : {}) };
    // Selection is navigation, never authority. Pin the actual selected target,
    // including for invoke initial, rather than trusting caller-supplied args.
    if (args.method === 'initial') args = { ...args, arguments: [target || sender.id] };
    if (implicitSnapshot) {
      const pending = this.data.records.findLast(r => this.key(r.actor) === this.key(sender) && r.state === 'confirmation-required' &&
        isDeepStrictEqual({ ...r.command, operation_id: args.operation_id }, args));
      if (pending && isDeepStrictEqual(pending.guard, clone(context.fingerprint?.(args) || null)))
        return { ...this.receipt(sender, pending.id), duplicate: true, retry: false };
    }
    const existing = this.receipt(sender, args.operation_id);
    if (existing) {
      if (!isDeepStrictEqual(existing.command, args)) throw Error('operation_id already belongs to a different command');
      await this.publish(existing, context);
      return { ...existing, duplicate: true, retry: false };
    }
    const handler = !['backgroundDecision', 'uiReady'].includes(args.method) && this.handlers.get(args.method);
    const key = this.key(sender);
    const actor = operation.actor({ ...sender, callId: identity.callId, turnId: identity.turnId, operationId: args.operation_id });
    const refuse = reason => {
      const refusal = { state: 'not-executed', reason, method: args.method, retry: false };
      if (!operation.maintenanceAction(args.method, args.arguments, actor)) return refusal;
      this.commit(d => d.records.push({ id: args.operation_id, actor, command: args, guard: clone(context.fingerprint?.(args) || null), ...refusal, at: this.now() }));
      return this.finishAudit(actor, args.operation_id, context);
    };
    if (!handler || this.inflight.has(key)) return refuse(handler ? 'another-operation-running' : 'unknown-command');
    // Busy decisions reserve their actor before awaits. Refresh only an idle
    // independent view, then check the reservation again before saving intent.
    await context.refresh?.(); await valid();
    if (this.inflight.has(key)) return refuse('another-operation-running');
    // Save intent before calling ANY mutation, including an independent draft.
    const guard = clone(context.fingerprint?.(args) || null);
    this.commit(d => d.records.push({ id: args.operation_id, actor, command: args, guard, state: 'running', at: this.now() }));
    return this.execute(actor, args, context, valid);
  }
  exclusive(actor, work) {
    const key = this.key(actor);
    if (this.closed || this.inflight.has(key)) throw Error('Another operation is running or background control is closing');
    // Reserve synchronously, before context lookup, identity refresh or prompts.
    const job = Promise.resolve().then(work);
    this.inflight.set(key, job);
    return job.finally(() => { if (this.inflight.get(key) === job) this.inflight.delete(key); });
  }
  execute(actor, args, context, valid, approved) {
    return this.exclusive(actor, () => this.perform(actor, args, context, valid, approved));
  }
  async perform(actor, args, context, valid, approved) {
    const key = this.key(actor), handler = this.handlers.get(args.method);
      let state, value, error, confirmation, delivery;
      try {
        await valid();
        if (this.closed) throw Error('Background control is closing');
        const row = this.receipt(actor, args.operation_id);
        if (row.guard && !isDeepStrictEqual(row.guard, clone(context.fingerprint?.(args)))) throw Error('The operation target changed before execution');
        const request = { context, args, actor, guard: row.guard, valid, approved, dialogIndex: 0 };
        value = await operation.run(actor, async () => {
          const action = operation.maintenanceAction(args.method, args.arguments, actor);
          if (action) {
            if (typeof this.confirmation !== 'function' || typeof this.audit !== 'function') throw Error('Human maintenance confirmation or event storage is unavailable');
            const answer = await dialog(context, 'message', this.confirmation(actor, args, action, context));
            if (answer.response !== 1) return { cancelled: true };
            request.maintenanceApproved = true;
            // If the event writer is broken, fail before an approved mutation.
            await this.publish({ ...row, state: 'running' }, context);
            if (action === 'readConversation') {
              const targetId = operation.conversationTarget(args.method, args.arguments, actor);
              const target = row.guard?.sessions?.find(s => s.id === targetId);
              if (!target) throw Error('The conversation target is unavailable');
              this.commit(data => { data.records.find(r => r.id === row.id && this.key(r.actor) === key).readAuthorization = { sessionId: target.id, nativeId: target.nativeId }; });
            }
          }
          return handler(context, ...args.arguments);
        }, request);
        delivery = await context.delivery?.(args, value, actor, row.guard);
        state = delivery ? delivery.nativeReceived ? 'received' : 'awaiting-native' : 'complete';
      } catch (e) {
        if (e instanceof ConfirmationRequired) { state = 'confirmation-required'; confirmation = e.confirmation; }
        else { state = 'unconfirmed'; error = typeof e.message === 'string' ? e.message.slice(0, 2048) : 'Operation outcome is unconfirmed'; }
      }
      this.commit(d => {
        const row = d.records.find(r => r.id === args.operation_id && this.key(r.actor) === key);
        d.views[key + ':' + (args.view_id || 'default')] = clone(context.view);
        delete row.confirmation;
        Object.assign(row, { state, finishedAt: this.now(), ...(value === undefined ? {} : { value: clone(value) }), ...(delivery ? { delivery } : {}), ...(error ? { error } : {}), ...(confirmation ? { confirmation } : {}) });
      });
      const result = await this.finishAudit(actor, args.operation_id, context);
      if (result.state === 'confirmation-required' && result.confirmation?.kind === 'message' && !result.confirmationNotifiedAt && this.confirmationPending) {
        this.commit(d => { d.records.find(r => r.id === result.id && this.key(r.actor) === key).confirmationNotifiedAt = this.now(); });
        try { await this.confirmationPending(this.receipt(actor, result.id)); } catch { /* The durable confirmation remains available. */ }
      }
      return { ...this.receipt(actor, args.operation_id), retry: false };
  }
  async decide(sessionId, nativeId, id, response) {
    const row = this.data.records.find(r => r.actor.id === sessionId && r.actor.nativeId === nativeId && r.id === id);
    if (!row || row.state !== 'confirmation-required' || row.confirmation?.kind !== 'message' || !Array.isArray(row.confirmation.options.buttons) ||
        !Number.isSafeInteger(response) || response < 0 || response >= row.confirmation.options.buttons.length || this.inflight.has(this.key(row.actor))) throw Error('This confirmation is no longer current');
    return this.exclusive(row.actor, async () => {
    const context = await this.view(row.actor, row.command.view_id);
    try { await context.checkActor(); }
    catch (error) {
      this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(row.actor));
        delete r.confirmation;
        Object.assign(r, { state: 'unconfirmed', error: String(error.message).slice(0, 2048), finishedAt: this.now() }); });
      return this.finishAudit(row.actor, id, context);
    }
    const current = this.receipt(row.actor, id);
    if (!current || current.state !== 'confirmation-required' || !isDeepStrictEqual(current.confirmation, row.confirmation)) throw Error('This confirmation was already handled');
    if (response === (row.confirmation.options.cancelId ?? 0)) {
      this.commit(d => { const r = d.records.find(r => r.id === id && r.actor.id === sessionId && r.actor.nativeId === nativeId); Object.assign(r, { state: 'cancelled', humanDecision: response, finishedAt: this.now() }); });
      return this.finishAudit(row.actor, id, context);
    }
    this.commit(d => { const r = d.records.find(r => r.id === id && r.actor.id === sessionId && r.actor.nativeId === nativeId); Object.assign(r, { state: 'running', humanDecision: response, humanDecisionAt: this.now() }); });
    return this.perform(row.actor, row.command, context, () => context.checkActor(), { operationId: id, confirmation: row.confirmation, response });
    });
  }
  rows(sessionId) {
    return this.data.records.filter(r => r.actor.id === sessionId).map(r => ({ id: `background:${r.actor.nativeId}:${r.id}`, role: 'system', kind: 'background-operation',
      name: operation.visibleText(r.actor.name), time: r.at, status: ['running', 'awaiting-native'].includes(r.state) ? 'working' : ['complete', 'received', 'cancelled'].includes(r.state) ? 'complete' : 'error',
      text: operation.visibleText(`${r.actor.name} · ${r.command.method}\n${JSON.stringify(r.command.arguments)}\n${({ running: '正在执行', complete: '操作已执行', received: '原生会话已收到', 'awaiting-native': '已提交，原生收件待确认', 'confirmation-required': '等待你的确认', cancelled: '已取消，未执行', unconfirmed: '结果未确认' })[r.state] || r.state}${r.error ? `: ${r.error}` : ''}`),
      backgroundOperation: { id: r.id, sessionId: r.actor.id, nativeId: r.actor.nativeId, state: r.state,
        confirmation: r.confirmation ? { ...r.confirmation, options: visibleOptions(r.confirmation.options) } : null,
        resultNotice: r.command.method === 'restoreSession' && r.value?.placement === 'unavailable' ? r.value.uiMessage : null } }));
  }
  async close() {
    this.closed = true;
    // Close our connections first so a queued native wait cannot hold GUI quit.
    // The native session and any input already accepted by it remain untouched.
    const contexts = await Promise.allSettled([...this.contexts.values()]);
    for (const item of contexts) if (item.status === 'fulfilled') {
      const c = item.value; c.client.close(); if (!c.win.isDestroyed?.()) c.win.destroy();
    }
    this.contexts.clear(); await Promise.allSettled([...this.inflight.values()]);
  }
}
function visibleOptions(options) {
  if (!options || typeof options !== 'object') return options;
  options = { ...options };
  for (const key of ['title', 'message', 'detail']) if (typeof options[key] === 'string') options[key] = operation.visibleText(options[key]);
  if (Array.isArray(options.buttons)) options.buttons = Array.from(options.buttons, text => operation.visibleText(text));
  return options;
}
function dialog(context, kind, options, nativeDialog) {
  if (!context.background) return nativeDialog(context.win, options);
  options = visibleOptions(options);
  const request = operation.request();
  if (!request || request.context !== context) throw Error('Background dialog has no originating operation');
  if (request.approved?.operationId === request.actor.operationId && isDeepStrictEqual(request.approved.confirmation, { kind, options }) && request.dialogIndex++ === 0)
    return Promise.resolve({ response: request.approved.response });
  if (kind === 'open' || kind === 'save') {
    const paths = request.args.paths;
    if (!paths?.length || (kind === 'save' || !options.properties?.includes('multiSelections')) && paths.length !== 1) throw new ConfirmationRequired({ kind, options });
    if (kind === 'open') for (const selected of paths) {
      const st = fs.statSync(selected);
      if (options.properties?.includes('openDirectory') ? !st.isDirectory() : !st.isFile()) throw Error('Explicit file selection has the wrong type');
    }
    return Promise.resolve(kind === 'save' ? { canceled: false, filePath: paths[0] } : { canceled: false, filePaths: [...paths] });
  }
  throw new ConfirmationRequired({ kind, options });
}
module.exports = { BackgroundControl, ConfirmationRequired, validate, tool, dialog };
