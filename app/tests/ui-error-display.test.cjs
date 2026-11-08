const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const locale = require('../ui-locale.js'), { uiError } = require('../ui-errors.cjs');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

test('known English reader guards retain their raw English while both UI languages and causes can format them', t => {
  const os = require('node:os'), cache = require('../reader-cache.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-locale-reader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'reader.json');
  fs.writeFileSync(file, JSON.stringify({ nativeId: 'original', messages: [], processIdentity: { pid: 1 } }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  let original;
  assert.throws(() => cache.readReaderCache(file, { nativeId: 'original' }), error => {
    original = error; assert.equal(error.message, 'Unsafe reader cache');
    assert.equal(locale.errorText('zh', error), '阅读缓存不安全。'); assert.equal(locale.errorText('en', error), error.message); return true;
  });
  fs.chmodSync(file, 0o600);
  assert.throws(() => cache.readReaderCache(file, { nativeId: 'different' }), error => {
    assert.equal(error.message, 'Reader identity changed'); assert.equal(locale.errorText('zh', error), '阅读缓存的会话身份已变化。'); return true;
  });
  const wrapped = uiError('error.sharedClearedRetained', { reason: original.message }, { cause: original, param: 'reason' });
  assert.ok(wrapped.message.endsWith('Unsafe reader cache'));
  assert.ok(locale.errorText('zh', wrapped).endsWith('阅读缓存不安全。')); assert.ok(locale.errorText('en', wrapped).endsWith('Unsafe reader cache'));
});

test('joined warnings translate each known own part while retaining unknown native text and the original join', () => {
  const first = uiError('error.sessionMissing'), native = Error('ORIGINAL native warning 中文 {body}'), last = uiError('error.labels.saveFailed');
  const parts = [first, native, last], raw = parts.map(error => error.message).join('\n');
  const error = uiError('error.warningLines', { warnings: raw }, { parts, param: 'warnings', separator: '\n' });
  const translated = [locale.errorText('en', first), native.message, locale.errorText('en', last)].join('\n');
  assert.equal(error.message, raw); assert.equal(locale.errorText('en', error), translated);
  assert.equal(locale.errorText('zh', error), raw); assert.ok(Object.isFrozen(error.uiMessage.parts));
  assert.equal(error.uiMessage.parts[1].uiMessage, null);
  const wire = { message: raw, uiMessage: plain(error.uiMessage) }; assert.equal(locale.errorText('en', wire), translated);
  assert.equal(Object.hasOwn(error.uiMessage.parts[0], 'stack'), false, 'Display metadata carries no error stack or native control flags');
});

test('the existing compound formatter preserves the backend plan semicolon and rejects altered raw parts', () => {
  const first = uiError('error.sessionMissing'), last = uiError('error.labels.saveFailed'), parts = [first, last], raw = parts.map(part => part.message).join('；');
  const error = uiError('error.warningLines', { warnings: raw }, { parts, param: 'warnings', separator: '；' });
  assert.ok(locale.displayMessage(error.uiMessage)?.parts); assert.equal(error.message, raw); assert.equal(locale.errorText('zh', error), raw);
  assert.equal(locale.errorText('en', error), parts.map(part => locale.errorText('en', part)).join('；'));
  for (const separator of [';', '； ', 'OTHER']) assert.equal(locale.displayMessage({ ...plain(error.uiMessage), separator }), null);
  assert.equal(locale.displayMessage({ ...plain(error.uiMessage), parts: [{ message: 'CHANGED RAW', uiMessage: first.uiMessage }, plain(error.uiMessage.parts[1])] }), null);
});

test('warning parts cannot hide, reorder or replace raw text and are bounded before rendering', () => {
  const part = uiError('error.sessionMissing'), raw = part.message;
  const valid = { version: 1, key: 'error.warningLines', params: { warnings: raw }, causeParam: 'warnings', separator: '\n', parts: [{ message: raw, uiMessage: part.uiMessage }] };
  for (const value of [
    { ...valid, parts: [] }, { ...valid, parts: Array(65).fill(valid.parts[0]) }, { ...valid, separator: 'OTHER' },
    { ...valid, causeParam: 'other' }, { ...valid, cause: part.uiMessage },
    { ...valid, parts: [{ message: 'DIFFERENT RAW', uiMessage: part.uiMessage }] },
    { ...valid, parts: [{ message: raw, uiMessage: { ...part.uiMessage, version: 2 } }] },
  ]) {
    assert.equal(locale.displayMessage(value), null); assert.equal(locale.errorText('en', { message: raw, uiMessage: value }), raw);
  }
  const cycle = { ...valid }; cycle.parts = [{ message: raw, uiMessage: cycle }]; assert.equal(locale.displayMessage(cycle), null);
  let shared = { version: 1, key: 'error.warningLines', params: { warnings: '' } };
  for (let level = 0; level < 2; level++) shared = { ...valid, params: { warnings: '' }, parts: Array(64).fill({ message: '', uiMessage: shared }) };
  assert.equal(locale.displayMessage(shared), null, 'A shared branching object graph also has a total validation budget');
});

test('display metadata remains optional when a known error parameter cannot be represented', () => {
  for (const reason of ['ORIGINAL '.repeat(3000), undefined, ['ORIGINAL', 'DATA']]) {
    const error = Object.assign(uiError('error.sharedClearedRetained', { reason }), { notSent: true });
    assert.equal(error.message, '共享消息已清除，时间线和笔记已保留。' + String(reason));
    assert.equal(error.notSent, true); assert.equal(Object.hasOwn(error, 'uiMessage'), false);
    assert.equal(locale.errorText('en', error), error.message);
  }
});

test('a known wrapped own error localizes both levels without changing raw messages or control flags', () => {
  const cause = Object.assign(uiError('error.sessionMissing'), { nativeActiveWriter: true });
  const error = Object.assign(uiError('error.mobileCancelUnconfirmed', { reason: cause.message }, { cause, param: 'reason' }), { notSent: true });
  const raw = cause.message + '\n取消回执未能确认；提交没有发出，请保留手机草稿并核对。';
  assert.equal(error.message, raw); assert.equal(error.notSent, true); assert.equal(cause.nativeActiveWriter, true);
  assert.equal(locale.errorText('en', error), locale.errorText('en', cause) + '\nCancellation receipt is unconfirmed; the commit was not sent. Retain the mobile draft and check.');
  assert.equal(error.uiMessage.cause.key, 'error.sessionMissing'); assert.equal(error.uiMessage.causeParam, 'reason');
  assert.ok(Object.isFrozen(error.uiMessage.cause)); assert.equal(locale.errorText('en', { message: error.message, uiMessage: plain(error.uiMessage) }), locale.errorText('en', error));
  assert.equal(error.message, raw);
});

test('cause metadata cannot retarget an unrelated original reason and recursive unknown data falls back raw', () => {
  const cause = uiError('error.sessionMissing'), rawReason = 'ORIGINAL native reason 中文';
  const error = uiError('error.sharedClearedRetained', { reason: rawReason }, { cause, param: 'reason' });
  assert.equal(Object.hasOwn(error.uiMessage, 'cause'), false); assert.equal(locale.errorText('en', error), 'Shared messages were cleared; the timeline and notes are retained. ' + rawReason);
  const cycle = { version: 1, key: 'error.sharedClearedRetained', params: { reason: 'RAW' }, causeParam: 'reason' }; cycle.cause = cycle;
  assert.equal(locale.displayMessage(cycle), null);
  const future = { ...cycle, cause: { version: 2, key: 'error.sessionMissing', params: {} } };
  assert.equal(locale.displayMessage(future), null); assert.equal(locale.errorText('en', { message: 'ORIGINAL RAW', uiMessage: future }), 'ORIGINAL RAW');
  cause.message += '\nORIGINAL native detail';
  const appended = uiError('error.sharedClearedRetained', { reason: cause.message }, { cause, param: 'reason' });
  assert.equal(Object.hasOwn(appended.uiMessage, 'cause'), false);
  assert.ok(locale.errorText('en', appended).endsWith(cause.message), 'Stale metadata cannot hide an appended original detail');
  const mismatched = { version: 1, key: 'error.sharedClearedRetained', params: { reason: rawReason }, cause: uiError('error.sessionMissing').uiMessage, causeParam: 'reason' };
  assert.equal(locale.displayMessage(mismatched), null);
  let nested = uiError('error.sessionMissing').uiMessage;
  for (let level = 0; level < 4; level++) nested = { version: 1, key: 'error.sharedClearedRetained', params: { reason: locale.format('zh', nested.key, nested.params) }, cause: nested, causeParam: 'reason' };
  assert.equal(locale.displayMessage(nested), null, 'Wire metadata has a fixed four-level limit');
  assert.equal(locale.errorText('en', cause), cause.message, 'Top-level stale metadata cannot hide appended original details either');
});

test('known display metadata preserves raw error text and independent control flags', () => {
  const error = Object.assign(uiError('error.confirmationTimeout'), { nativeActiveWriter: true });
  const original = error.message;
  assert.equal(locale.errorText('en', error), 'Timed out waiting for local confirmation. Check the native session. No automatic retry will be made.');
  assert.equal(error.message, original); assert.equal(error.nativeActiveWriter, true);
  assert.equal(Object.hasOwn(error, 'notSent'), false, 'A timeout is not evidence that the input was not sent');
  assert.equal(locale.errorText('zh', error), original);
  assert.ok(Object.isFrozen(error.uiMessage)); assert.ok(Object.isFrozen(error.uiMessage.params));
});

test('native RPC error display leaves original code-derived flags and oversized codes intact', async () => {
  const { Rpc } = require('../adapters.cjs');
  const thread = '11111111-1111-4111-8111-111111111111';
  for (const [code, message, flag] of [
    [-32600, 'goals feature is disabled', 'nativeGoalsDisabled'],
    [-32601, 'list_turns is not supported yet', 'nativeUnsupportedTurns'],
    [-32600, 'no rollout found for thread id ' + thread, 'nativeMissingHistory'],
    [-32600, 'thread ' + thread + ' is not materialized yet; thread/turns/list is unavailable before first user message', 'nativeUnmaterializedThread'],
    [-32600, 'session already has an active writer', 'nativeActiveWriter'],
    ['X'.repeat(17000), 'ORIGINAL private upstream reason', null],
  ]) {
    const socket = new EventEmitter(); socket.readyState = 1; const writes = [];
    socket.send = frame => writes.push(JSON.parse(frame));
    const rpc = new Rpc(socket), pending = rpc.call('fixture/read', { threadId: thread });
    const rejected = assert.rejects(pending, error => {
      if (flag) assert.ok(error[flag]);
      if (flag === 'nativeMissingHistory') assert.equal(error.nativeMissingHistoryThread, thread);
      if (flag === 'nativeActiveWriter') {
        assert.equal(error.uiMessage.key, 'error.nativeActiveWriter');
        assert.equal(locale.errorText('en', error), 'This session is still in use by another native connection. End that connection first, then continue. The original connection was not changed.');
      } else {
        assert.equal(error.message, '原生接口拒绝请求（' + code + '），请查看原生会话。');
        if (typeof code === 'string') { assert.equal(Object.hasOwn(error, 'uiMessage'), false); assert.equal(locale.errorText('en', error), error.message); }
        else assert.equal(locale.errorText('en', error), 'The native interface rejected the request (' + code + '). Check the native session.');
      }
      assert.equal(Object.hasOwn(error, 'notSent'), false); return true;
    });
    socket.emit('message', JSON.stringify({ id: writes[0].id, error: { code, message } })); await rejected;
    assert.equal(writes.length, 1); assert.equal(rpc.pending.size, 0);
  }
});

test('unknown, malformed, future and extra-field metadata falls back without guessing from Chinese text', () => {
  const raw = uiError('error.sessionMissing').message;
  for (const uiMessage of [undefined, null, {}, { version: 2, key: 'error.sessionMissing' }, { version: 1, key: 'unknown' }, { version: 1, key: 'menu.quit' },
    { version: 1, key: 'error.sessionMissing', params: ['ignored'] }, { version: 1, key: 'error.sessionMissing', params: { unexpected: 'PRIVATE must not render' } },
    Object.defineProperty({}, 'version', { get() { throw Error('Untrusted getter'); } })]) {
    assert.equal(locale.displayMessage(uiMessage), null);
    assert.equal(locale.errorText('en', { message: raw, uiMessage }), raw);
  }
  assert.throws(() => uiError('menu.quit'));
  assert.equal(locale.errorText('en', null), 'The operation did not complete.');
  assert.equal(locale.errorText('en', Error('RAW native 中文 {key}')), 'RAW native 中文 {key}');
});

function serviceFixture() {
  const timers = [], module = { exports: {} };
  class Socket extends EventEmitter {
    constructor() { super(); this.writes = []; }
    setEncoding(value) { assert.equal(value, 'utf8'); }
    write(frame) { this.writes.push(JSON.parse(frame)); }
    end() { this.destroyed = true; }
    destroy() { this.destroyed = true; }
  }
  vm.runInNewContext(read('service-connection.cjs'), { module, exports: module.exports, Buffer,
    require: createRequire(path.join(__dirname, '../service-connection.cjs')),
    setTimeout(fn, milliseconds) { const timer = { fn, milliseconds }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; } });
  const socket = new Socket(), client = new module.exports.ServiceClient(socket);
  return { client, socket, timers, reply(frame) { socket.emit('data', JSON.stringify(frame) + '\n'); } };
}

function daemonFailure(error, request) {
  const source = read('daemon.cjs');
  const start = source.indexOf('Promise.resolve().then(() => request.backgroundActor');
  const end = source.indexOf('\n', source.indexOf('error => send(client,', start));
  const line = start >= 0 && end > start && source.slice(start, end);
  assert.ok(line, 'Exercise the actual failed dispatch response, never launch a daemon');
  return new Promise(resolve => vm.runInNewContext(line, { Promise, request, owner: 'fixture-owner', client: {}, displayMessage: locale.displayMessage,
    dispatch() { throw error; }, send(_client, frame) { resolve(plain(frame)); } }));
}
function mainFailure(handler) {
  const source = read('main.cjs'), start = source.indexOf('function register('), end = source.indexOf('async function boot()', start);
  const frame = { url: 'app://synthetic' }, sender = { id: 42, mainFrame: frame }, handlers = new Map();
  const context = vm.createContext({ applicationHandlers: new Map(), ipcMain: { handle(name, callback) { handlers.set(name, callback); } }, windows: new Map([[42, {}]]), trusted: () => true, uiLocale: locale });
  vm.runInContext(source.slice(start, end), context);
  context.register('send', handler);
  return (...args) => handlers.get('workspace:send')({ sender, senderFrame: frame }, ...args);
}
function preloadFailure(invoke) {
  const exposed = {}, calls = [];
  const electron = { contextBridge: { exposeInMainWorld(key, value) { exposed[key] = value; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke(channel, ...args) { calls.push([channel, ...args]); return invoke(channel, ...args); } } };
  vm.runInNewContext(read('preload.cjs'), { process: { argv: [] }, require(name) { assert.equal(name, 'electron', 'Sandboxed preload cannot load project modules'); return electron; } });
  return { api: exposed.workspace, calls };
}

test('actual daemon response, ServiceClient parser, Main wrapper and sandbox preload retain optional display metadata', async () => {
  const f = serviceFixture(), original = uiError('error.sessionMissing');
  const invoke = mainFailure(async (_context, ...args) => f.client.call('send', ...args));
  const p = preloadFailure((_channel, ...args) => invoke(...args));
  const pending = p.api.send('session-A', 'ORIGINAL 中文 UNSENT {body}');
  const rejection = assert.rejects(pending, error => {
    // Plain rejection values are copied by the pinned Electron bridge; custom
    // Error fields are not. This unit checks source shape, not actual Electron.
    const transferred = structuredClone(error);
    assert.equal(transferred.message, original.message);
    assert.deepEqual(transferred.uiMessage, plain(original.uiMessage));
    assert.equal(locale.errorText('en', transferred), 'This session could not be found.');
    assert.equal(Object.hasOwn(transferred, 'notSent'), false); return true;
  });
  assert.equal(f.socket.writes.length, 1);
  const request = f.socket.writes[0];
  assert.deepEqual(request.args, ['session-A', 'ORIGINAL 中文 UNSENT {body}']);
  const response = await daemonFailure(original, request); f.reply(response); await rejection;
  assert.equal(f.socket.writes.length, 1, 'A localized failure must not retry or issue another action');
  assert.equal(p.calls.length, 1); assert.equal(f.timers[0].cleared, true);
});

test('compound own display metadata crosses the existing RPC and preload chain without replay or raw changes', async () => {
  const f = serviceFixture(), cause = uiError('error.sessionMissing');
  const original = uiError('error.sharedClearedRetained', { reason: cause.message }, { cause, param: 'reason' });
  const invoke = mainFailure(async (_context, ...args) => f.client.call('send', ...args));
  const p = preloadFailure((_channel, ...args) => invoke(...args));
  const pending = p.api.send('session-A', 'ORIGINAL native body');
  const rejection = assert.rejects(pending, value => {
    const copied = structuredClone(value);
    assert.equal(copied.message, original.message); assert.deepEqual(copied.uiMessage, plain(original.uiMessage));
    assert.equal(locale.errorText('en', copied), 'Shared messages were cleared; the timeline and notes are retained. This session could not be found.');
    return true;
  });
  f.reply(await daemonFailure(original, f.socket.writes[0])); await rejection;
  assert.equal(f.socket.writes.length, 1); assert.equal(p.calls.length, 1);
});

test('old backend errors remain raw across the same chain; successful values are unchanged', async () => {
  const old = { message: 'RAW older/native 中文 error' };
  const response = await daemonFailure(old, { id: 1, method: 'send', args: [] });
  assert.equal(response.uiMessage, null); assert.equal(response.error, old.message);
  const p = preloadFailure(async () => ({ ok: false, error: old.message, uiMessage: { version: 7, key: 'error.sessionMissing' } }));
  await assert.rejects(p.api.send(), error => error.message === old.message && !Object.hasOwn(error, 'uiMessage'));
  const success = { nativeId: 'native-A', owner: 'original-owner', draft: 'UNSENT 中文', accepted: null };
  const ok = preloadFailure(async () => ({ ok: true, value: success }));
  assert.equal(await ok.api.send(), success);
});

test('merged Git preview and space-merge preload actions retain their routes and optional display errors', async () => {
  const error = uiError('error.sessionMissing');
  const p = preloadFailure(async () => ({ ok: false, error: error.message, uiMessage: error.uiMessage }));
  await assert.rejects(p.api.gitWorktreePreview('/synthetic/source', 'choice', ''), value => value.uiMessage.key === 'error.sessionMissing');
  await assert.rejects(p.api.spaceMerge('preview', { name: 'raw user name' }), value => value.uiMessage.key === 'error.sessionMissing');
  await assert.rejects(p.api.connectionUpdates(), value => value.uiMessage.key === 'error.sessionMissing');
  assert.deepEqual(plain(p.calls), [
    ['workspace:gitWorktreePreview', '/synthetic/source', 'choice', ''],
    ['workspace:spaceMerge', 'preview', { name: 'raw user name' }],
    ['workspace:connectionUpdates'],
  ]);
});

test('disconnect and timeout are explicitly labeled without retrying, canceling or claiming not-sent', async () => {
  const timeout = serviceFixture(), waiting = timeout.client.call('send', 'session-A', 'ORIGINAL input');
  const rejection = assert.rejects(waiting, error => {
    assert.equal(error.uiMessage.key, 'error.confirmationTimeout'); assert.equal(Object.hasOwn(error, 'notSent'), false); return true;
  });
  assert.equal(timeout.timers[0].milliseconds, 40000); timeout.timers[0].fn(); await rejection;
  assert.equal(timeout.socket.writes.length, 1);
  const queue = serviceFixture(), queued = queue.client.call('queue', 'session-A', 'ORIGINAL queued input');
  const closed = assert.rejects(queued, error => error.uiMessage.key === 'error.serviceClosed' && !Object.hasOwn(error, 'notSent'));
  assert.equal(queue.timers.length, 0, 'Native queued inputs keep their existing no-arbitrary-timeout contract');
  queue.socket.emit('close'); await closed; assert.equal(queue.socket.writes.length, 1);
});

test('missing session and ended runtime errors use the same original guard and do not touch native processes', () => {
  const { Workspace } = require('../workspace.cjs');
  const holder = { sessions: new Map(), runtimes: new Map() };
  for (const [method, key] of [['get', 'error.sessionMissing'], ['runtime', 'error.sessionEnded']]) {
    assert.throws(() => Workspace.prototype[method].call(holder, 'missing'), error => error.uiMessage.key === key);
  }
});

test('the existing writable-runtime copy list includes every new backend display dependency', () => {
  const source = read('service-client.cjs'), match = source.match(/const names = (\[[^\n]+\]);/);
  assert.ok(match);
  const names = vm.runInNewContext(match[1]);
  for (const file of ['ui-errors.cjs', 'ui-locale.js', 'ui-messages.js']) {
    assert.equal(names.filter(name => name === file).length, 1, file); assert.ok(fs.existsSync(path.join(__dirname, '..', file)));
  }
  assert.ok(!read('preload.cjs').includes("require('./ui-"), 'Do not relax sandboxing to import these dependencies');
});


test('notice cause composition translates only an exact application reason and rejects stale or cross-prefix metadata', () => {
  const cause = { version: 1, key: 'notice.run.approval', params: {} };
  const reason = locale.format('zh', cause.key), body = 'RAW body 中文 {reason}\n  ';
  const message = { version: 1, key: 'notice.wake.observationBoundaryKnownReason', params: { reason, body }, cause, causeParam: 'reason' };
  const raw = locale.format('zh', message.key, message.params);
  const known = locale.displayMessage(message, 'notice.', raw);
  assert.ok(known); assert.equal(locale.displayText('en', raw, known), `The native observation or control boundary changed (Waiting for native permission approval); the automatic message was not delivered.\n${body}`);
  assert.equal(locale.displayText('zh', raw, known), raw);
  for (const invalid of [
    { ...message, params: { reason: reason + ' RAW native detail', body } },
    { ...message, cause: uiError('error.sessionMissing').uiMessage },
    { ...message, cause: { ...cause, version: 2 } },
    { ...message, causeParam: 'body' },
  ]) assert.equal(locale.displayMessage(invalid, 'notice.'), null);
});
