const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const locale = require('../ui-locale.js'), { uiError } = require('../ui-errors.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
// Parse actual option objects without invoking a native dialog or Notification.
// The existing handler tests retain control-flow and confirmation coverage.
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });
const ast = box.exports.parse(main, { ecmaVersion: 'latest' }), options = [];
function visit(node) {
  if (!node || typeof node !== 'object') return;
  const callee = node.callee;
  const dialog = node.type === 'CallExpression' && callee?.object?.name === 'dialog' && ['showMessageBox', 'showOpenDialog', 'showSaveDialog'].includes(callee.property?.name);
  const routed = node.type === 'CallExpression' && callee?.name === 'showDialog';
  const notification = node.type === 'NewExpression' && callee?.name === 'Notification';
  if (dialog || routed || notification) {
    const object = node.arguments.find(arg => arg.type === 'ObjectExpression');
    assert.ok(object); const source = main.slice(object.start, object.end);
    // OS surfaces are evaluated with explicit synthetic lexical bindings below. Background
    // permission cards are covered separately and never open native dialogs.
    if (!source.includes("displayText('background.confirm')")) options.push({ type: notification ? 'notification' : routed ? ({ message: 'showMessageBox', open: 'showOpenDialog', save: 'showSaveDialog' })[node.arguments[1].value] : callee.property.name, source });
  }
  for (const value of Object.values(node)) if (value && typeof value === 'object') { if (Array.isArray(value)) value.forEach(visit); else visit(value); }
}
visit(ast);
test('the actual IPC catch labels only its own empty-message fallback and retains unknown native errors', async () => {
  const register = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'register'); assert.ok(register);
  let handle; const sender = { id: 17 }, frame = { url: 'synthetic-trusted' }; sender.mainFrame = frame;
  const context = vm.createContext({ applicationHandlers: new Map(), ipcMain: { handle(name, handler) { assert.equal(name, 'workspace:synthetic'); handle = handler; } }, windows: new Map([[17, {}]]), trusted: url => url === frame.url, uiLocale: locale, uiError });
  vm.runInContext(main.slice(register.start, register.end), context);
  context.register('synthetic', async () => { throw Error(''); });
  const fallback = await handle({ sender, senderFrame: frame });
  assert.equal(fallback.ok, false); assert.equal(fallback.error, '操作未完成。'); assert.equal(locale.displayText('en', fallback.error, fallback.uiMessage), 'The operation did not complete.');
  context.register('synthetic', async () => { throw Error('RAW native 中文 <reason>'); });
  const native = await handle({ sender, senderFrame: frame }); assert.equal(native.error, 'RAW native 中文 <reason>'); assert.equal(native.uiMessage, null);
  await assert.rejects(handle({ sender, senderFrame: { url: frame.url } }), /Unexpected IPC source/);
});
const plain = value => JSON.parse(JSON.stringify(value));

test('the actual backend-switch handler translates its confirmation reason and preserves the raw expected plan on cancel', async () => {
  const a = main.indexOf("  register('switchBackend',"), b = main.indexOf("  register('continueConnection',", a); assert.ok(a > 0 && b > a);
  const record = { id: 'original', nativeId: 'native-original', provider: 'codex', name: 'RAW 中文', owner: 'original-owner', state: 'idle' };
  const plan = require('../backend-switch.cjs').backendPlan({ capabilities: ['atomicShutdown', 'resume', 'conditionalMaintenanceStopV1'], servicePid: 42, sessions: [record] });
  assert.equal(plan.ready, true); assert.equal(plan.auto, false);
  for (const language of ['zh', 'en']) {
    const option = { backendKey: 'original-backend', switch: plan }, before = JSON.stringify(option), dialogs = []; let handler, refreshes = 0, updates = 0;
    const c = { win: {}, client: { async refresh() { refreshes++; } } };
    vm.runInNewContext(main.slice(a, b), { register(name, fn) { assert.equal(name, 'switchBackend'); handler = fn; },
      app: { getVersion: () => 'synthetic' }, backendSwitch: require('../backend-switch.cjs'), roomState: {}, connectionUpdateOptions: () => [option], uiError, uiLocale: locale, displayLanguage: () => language,
      displayText: (key, params) => locale.format(language, key, params), dialog: { async showMessageBox(win, options) { assert.equal(win, c.win); dialogs.push(options); return { response: 0 }; } },
      showDialog(context, kind, options) { return require('../background-control.cjs').dialog(context, kind, options, async (win, value) => { assert.equal(win, c.win); dialogs.push(value); return { response: 0 }; }); },
      runBackendSwitch() { updates++; throw Error('Cancel must not reach a backend operation'); } });
    assert.equal(await handler(c, plain(option)), false); assert.equal(refreshes, 1); assert.equal(updates, 0); assert.equal(dialogs.length, 1);
    const options = dialogs[0], translated = locale.displayText(language, plan.reason, plan.reasonUiMessage);
    assert.ok(options.detail.includes(translated)); assert.ok(options.detail.includes(record.name));
    if (language === 'en') assert.ok(options.detail.includes('Codex does not report background work. Updating ends'));
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(JSON.stringify(option), before); assert.deepEqual(plan.stops.map(s => s.nativeId), ['native-original']);
  }
});

function osOptions(language, codex = true, prefix = 'os.decision') {
  const raw = '/synthetic/RAW 中文 {name}';
  return options.map(option => ({ type: option.type, value: plain(vm.runInNewContext('(' + option.source + ')', {
    displayText: (key, params) => locale.format(language, key, params), displayLanguage: () => language, uiLocale: locale,
    backgroundOperation: require('../background-operation.cjs'),
    value: { name: 'RAW 中文 {space}' }, status: { reason: 'RAW 中文 native status' }, codex,
    names: 'RAW 中文 backend names', option: { switch: { stops: [{ name: 'RAW 中文 session' }], endsCodex: codex, reason: 'RAW 中文 background detail' } },
    textExtensions: ['txt', 'md'], record: { cwd: raw, actor: { name: 'RAW 中文 agent' }, command: { method: 'openLocalFile' } }, action: 'openLocalFile', snapshot: { defaultWorkspace: '/unused' },
    preview: { name: 'RAW 中文.txt' }, ext: '.txt', path, exported: { folder: '/synthetic/RAW 中文 export' },
    key: 'os.butlerQuitWaiting', prefix, name: 'RAW 中文 member', space: 'RAW 中文 space', task: 'RAW 中文 task', question: 'RAW 中文 question',
    notice: { key: 'os.rotationDoneBody', params: { old: 'RAW 中文 old', new: 'RAW 中文 new', reason: '' } },
    migrationNotice: { key: 'os.migrationSavedBody', params: { names: 'RAW 中文 session' } },
    // B6: the notice for one reason of an integration handoff, as integrator-words.cjs words it.
    words: require('../integrator-words.cjs').personWords({ reason: 'lock-held:RAW 中文 owner', count: 2 }),
    // Daily discoveries: the notify callback's own count parameter.
    count: 3,
  })) }));
}
// The two surfaces of the records bell and the daily discoveries notice, set aside where the checks below count positions.
const ordinary = (list, language) => list.filter(option => option.value.title !== locale.format(language, 'records.export.chooseTitle') &&
  option.value.message !== locale.format(language, 'records.delete.question', { count: 'RAW 中文 backend names'.length }) &&
  option.value.title !== locale.format(language, 'discoveries.title'));
test('all existing OS option groups use the chosen language while raw names, picker scope and cancel safeguards stay intact', () => {
  const zh = osOptions('zh'), en = osOptions('en'); assert.equal(en.length, 24);
  // Daily discoveries (regular popup): one notice carrying only a count, never candidate text.
  for (const [list, title, body] of [[en, 'Daily discoveries', '3 new discoveries today. Read when you have time.'], [zh, '每日发现', '今天有3项新发现，有空再看。']]) {
    const found = list.filter(option => option.value.title === title); assert.equal(found.length, 1);
    assert.deepEqual([found[0].type, found[0].value], ['notification', { title, body }]); list.splice(list.indexOf(found[0]), 1);
  }
  assert.equal(en.length, 23);
  // Records kept whole (the bell): the folder an export goes to, and the last confirmation before exported blocks are
  // deleted, whose safe answer, Cancel, is the default; the folder is shown as it is.
  for (const [list, language] of [[en, 'en'], [zh, 'zh']]) {
    const choose = list.findIndex(option => option.value.title === locale.format(language, 'records.export.chooseTitle'));
    assert.ok(choose >= 0); assert.deepEqual(list[choose].value.properties, ['openDirectory', 'createDirectory']); list.splice(choose, 1);
    const remove = list.findIndex(option => option.value.message === locale.format(language, 'records.delete.question', { count: 'RAW 中文 backend names'.length }));
    assert.ok(remove >= 0); const value = list[remove].value;
    assert.deepEqual([list[remove].type, value.buttons, value.defaultId, value.cancelId], ['showMessageBox', [locale.format(language, 'records.delete.cancel'), locale.format(language, 'records.delete.confirm')], 0, 0]);
    assert.ok(value.detail.includes('/synthetic/RAW 中文 export')); list.splice(remove, 1);
  }
  assert.equal(en.length, 21);
  // The last surface is the folder dialog for the project where merges are checked (B6, the queue panel): a title, and folders only.
  assert.deepEqual([en[20].type, en[20].value], ['showOpenDialog', { title: 'Choose the project folder: the top folder of the project the integrator merges into', properties: ['openDirectory'] }]);
  assert.deepEqual([zh[20].type, zh[20].value], ['showOpenDialog', { title: '选择项目文件夹：集成者把活合进去的那个项目最上层的文件夹', properties: ['openDirectory'] }]);
  en.pop(); zh.pop();
  // Before it comes the integration handoff notice (B6): a count and a reason, never task text.
  assert.deepEqual(en[19].value, { title: 'NAW · Integration handoff needs you', body: 'The merge lock is held by RAW 中文 owner. Deliveries waiting: 2' });
  assert.deepEqual(zh[19].value, { title: 'NAW · 集成交接要你处理', body: '合并锁被 RAW 中文 owner 占着，2 件交付在等' });
  assert.equal(en[19].type, 'notification'); en.pop(); zh.pop();
  const quit = en.findIndex(option => option.value.title === 'NAW · Quitting');
  assert.ok(quit >= 0); assert.equal(en[quit].value.body, 'Closing the butler; waiting up to 5 seconds.');
  assert.equal(zh[quit].value.body, '正在关闭大管家，最多等待 5 秒。');
  en.splice(quit, 1); zh.splice(quit, 1);
  // The background confirmation notice is built in confirmation-notifications.cjs; its zh/en text is checked there.
  // The eighteenth surface is the notice for a backend NAW migrated by itself (automatic migration).
  assert.deepEqual(en[17].value, { title: 'NAW · Backend migration', body: 'Moved “RAW 中文 session” to the new backend; the conversations continue, and typed-into terminals were saved first.' });
  assert.deepEqual(zh[17].value, { title: 'NAW · 迁移旧后台', body: '已把「RAW 中文 session」挪到新后台，对话原样继续；终端里打过字的先存下了画面。' });
  // The seventeenth names the sessions an automatic migration that did not finish left stopped.
  assert.deepEqual(en[16].value, { title: 'NAW · Backend migration', body: '“RAW 中文 backend names” could not move to the new backend and may have stopped; the conversation is kept. If it stopped, click Continue native session to pick it up.' });
  assert.deepEqual(zh[16].value, { title: 'NAW · 迁移旧后台', body: '「RAW 中文 backend names」没能挪到新后台，可能已经停下；对话记录都在，停下的点「继续原生会话」就能接着用。' });
  // The sixteenth surface is the session-rotation notice (queue-dispatch.cjs).
  assert.deepEqual(en[15].value, { title: 'NAW · Session rotation', body: '“RAW 中文 old” handed its work to the new session “RAW 中文 new”; the old session ended and its record is kept.' });
  assert.deepEqual(zh[15].value, { title: 'NAW · 换会话', body: '「RAW 中文 old」的工作已交给新会话「RAW 中文 new」，旧会话已结束，记录保留。' });
  assert.deepEqual(en.map(row => row.type), zh.map(row => row.type));
  const [notice, capacity, decision, space, files, program, shared, backend, hold, update, forget, stop, material, save, folder] = en.map(row => row.value);
  assert.equal(notice.title, 'NAW · Tool wait reminder'); assert.ok(notice.body.includes('not been resent automatically'));
  assert.equal(capacity.title, 'NAW · Automatic continuation limit reached'); assert.ok(capacity.body.includes('3 times'));
  assert.equal(zh[1].value.title, 'NAW · 自动继续已达上限'); assert.equal(zh[1].value.body, '会话已自动继续 3 次，仍需处理。请在侧栏检查标记的会话。');
  assert.deepEqual(decision, { title: 'NAW · Needs your decision', body: 'RAW 中文 member · RAW 中文 space: RAW 中文 question' });
  assert.deepEqual(zh[2].value, { title: 'NAW · 需要你决定', body: 'RAW 中文 member · RAW 中文 space：RAW 中文 question' });
  assert.deepEqual(ordinary(osOptions('en', true, 'os.queueFailed'), 'en')[2].value, { title: 'NAW · Task not delivered', body: 'RAW 中文 task → RAW 中文 member · RAW 中文 space; not resent automatically' });
  assert.deepEqual(ordinary(osOptions('zh', true, 'os.queueFailed'), 'zh')[2].value, { title: 'NAW · 派活没有完成', body: 'RAW 中文 task → RAW 中文 member · RAW 中文 space；不会自动重发' });
  assert.equal(space.message, 'Clear shared records for “RAW 中文 {space}”?'); assert.deepEqual(space.buttons, ['Cancel', 'Clear shared records']);
  assert.equal(files.title, 'Local files for “RAW 中文 {space}”'); assert.deepEqual(files.filters, [{ name: 'Text files', extensions: ['txt', 'md'] }]);
  assert.equal(program.buttonLabel, 'Use this program'); assert.equal(shared.message, 'Clear shared workspace records?');
  assert.equal(hold.detail, 'RAW 中文 native status'); assert.deepEqual(hold.buttons, ['OK']);
  assert.deepEqual(update.buttons, ['Keep current connection', 'Checked; update connection']); assert.ok(update.detail.includes('background or child tasks'));
  assert.deepEqual(forget.buttons, ['Cancel', 'Remove record']); assert.ok(forget.detail.includes('drafts'));
  assert.equal(stop.message, 'Disconnect this Codex session?'); assert.deepEqual(stop.buttons, ['Keep session', 'Disconnect']);
  const claude = ordinary(osOptions('en', false), 'en')[11].value; assert.equal(claude.message, 'End this native session?'); assert.deepEqual(claude.buttons, ['Keep session', 'End session']); assert.notEqual(stop.detail, claude.detail);
  assert.equal(material.defaultPath, '/synthetic/RAW 中文 {name}'); assert.equal(save.defaultPath, 'RAW 中文-copy.txt'); assert.equal(folder.title, 'Choose a working directory for this session');
  const nativeFacts = row => { const { title, body, message, detail, buttons, buttonLabel, filters, ...other } = row.value; return { ...other, ...(filters ? { filterExtensions: filters.map(filter => filter.extensions) } : {}) }; };
  assert.deepEqual(en.map(nativeFacts), zh.map(nativeFacts));
  assert.equal(backend.message, 'End and update this backend? Sessions affected: 1'); assert.ok(backend.detail.includes('RAW 中文 backend names')); assert.ok(backend.detail.includes('RAW 中文 background detail')); assert.deepEqual(backend.buttons, ['Keep current connection', 'Checked; end and update']);
  for (const index of [3, 6, 7, 9, 10, 11]) { assert.equal(en[index].value.defaultId, 0); assert.equal(en[index].value.cancelId, 0); }
});

test('connection refusal metadata translates known facts while preserving exact original reasons, names and readiness guards', () => {
  const { continuationStatus } = require('../service-client.cjs'), record = { id: 's', nativeId: 'native-s', name: 'RAW 中文 <name>', state: 'ended' };
  const states = [
    { sessions: [{ ...record, nativeId: null }], capabilities: ['atomicShutdown'] },
    { sessions: [{ ...record, state: 'working' }], capabilities: ['atomicShutdown'] },
    { sessions: [record], capabilities: ['atomicShutdown'], storageWarning: 'RAW storage detail' },
    { sessions: [record], capabilities: [] },
  ];
  for (const state of states) {
    const before = JSON.stringify(state), status = continuationStatus(state, 's'); assert.equal(status.ready, false);
    const text = locale.displayText('en', status.reason, status.reasonUiMessage); assert.notEqual(text, status.reason); assert.ok(status.reason);
    assert.equal(JSON.stringify(state), before); assert.equal(locale.displayText('zh', status.reason, status.reasonUiMessage), status.reason);
    if (state.sessions[0].state === 'working') assert.ok(text.includes(record.name));
  }
  assert.deepEqual(continuationStatus({ sessions: [record], capabilities: ['atomicShutdown'] }, 's'), { ready: true, nativeId: 'native-s' });
});

test('active-session refusal uses a neutral owned list separator without rewriting separators inside native names', () => {
  const { continuationStatus } = require('../service-client.cjs');
  const state = { sessions: [{ id: 'A', nativeId: 'native-A', name: 'RAW A、part', state: 'working' }, { id: 'B', nativeId: 'native-B', name: 'RAW B 中文', state: 'working' }], capabilities: ['atomicShutdown'] }, before = structuredClone(state);
  const status = continuationStatus(state, 'A'); assert.equal(status.ready, false);
  assert.ok(locale.displayText('en', status.reason, status.reasonUiMessage).includes('RAW A、part, RAW B 中文'));
  assert.ok(status.reason.includes('RAW A、part, RAW B 中文')); assert.deepEqual(state, before);
});

test('preflight retains an optional known error descriptor without executing a provider or exposing an unrelated error as owned', () => {
  const source = fs.readFileSync(require.resolve('../preflight.cjs'), 'utf8'); let failure = uiError('error.runtime.locationsUnreadable'), lookups = 0;
  const module = { exports: {} };
  const requireStub = name => name === './platform.cjs' ? { executable: () => { lookups++; return '/synthetic/program'; }, pythonExecutable: () => { lookups++; return '/synthetic/python'; } }
    : name === './runtime-locations.cjs' ? { readLocations() { throw failure; } }
    : name === 'node:child_process' ? { execFile() { throw Error('Unexpected process'); } } : require(name);
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})')(requireStub, module, module.exports);
  const own = module.exports.preflight(); assert.equal(own.error, failure.message); assert.equal(locale.displayText('en', own.error, own.errorUiMessage), locale.errorText('en', failure)); assert.equal(lookups, 3);
  failure = Error('RAW 原生 <error>{key}'); const raw = module.exports.preflight(); assert.equal(raw.error, failure.message); assert.equal(raw.errorUiMessage, null); assert.equal(locale.displayText('en', raw.error, raw.errorUiMessage), failure.message);
});
