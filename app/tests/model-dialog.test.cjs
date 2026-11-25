// The person's side of changing a session's model (N5): where the menus offer it, the dialog, what is said after,
// and the app's handlers. The page's own functions over stand-ins; the real window is checked apart.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js'), { uiError } = require('../ui-errors.cjs');
const modelDialog = require('../renderer/model-dialog.js'), { UNSURE_KEYS } = require('../session-model.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const renderer = read('renderer/renderer.js'), html = read('renderer/index.html'), main = read('main.cjs');
const cut = (source, from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start + from.length); assert.ok(start > 0 && end > start, from); return source.slice(start, end); };
const zh = (key, params) => locale.format('zh', key, params), display = (message, ui) => ui ? zh(ui.key, ui.params) : message;

// Just enough of a page for a list of radios and a select.
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.open = false; this.checked = false; this.listeners = {}; this.at = ''; }
  append(...values) { for (const value of values) { value.parent = this; this.children.push(value); } }
  replaceChildren(...values) { this.children = []; this.append(...values); if (this.tag === 'select') this.at = values[0]?.value ?? ''; }
  get options() { return this.children; }
  get value() { return this.tag === 'select' ? this.at : this.own ?? ''; }
  set value(next) { if (this.tag !== 'select') this.own = next; else this.at = this.children.some(child => child.value === next) ? next : ''; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  querySelector(selector) { const [tag, state] = selector.split(':'); return this.querySelectorAll(tag).find(el => !state || el[state]) || null; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  focus() { this.focused = true; }
  close() { if (!this.open) return; this.open = false; for (const fn of this.listeners.close || []) fn(); }
}
const S = extra => ({ id: 'a', nativeId: 'native-a', name: 'Worker', provider: 'claude', state: 'idle', model: 'claude-fable-5-2', serviceCapabilities: ['sessionModelV1'], ...extra });
const CHOICES = { provider: 'claude', nativeDefault: true, current: { model: 'claude-fable-5-2', effort: 'high' }, pending: null,
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'].map(model => ({ model, efforts: ['low', 'high', 'xhigh'] })) };
const CODEX = { provider: 'codex', nativeDefault: false, current: { model: 'gpt-6-sol', effort: null }, pending: null,
  models: [{ model: 'gpt-6-sol', efforts: ['low', 'high'], defaultEffort: 'high' }, { model: 'gpt-6-luna', efforts: ['low', 'max'], defaultEffort: 'low' }] };
function page(options = {}) {
  const elements = new Map(), calls = [], notices = [], state = { record: S(options.record), pending: options.pending || null, offline: false, ticket: 0 };
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id === 'model-effort' ? 'select' : id === 'model-dialog' ? 'dialog' : 'div')); return elements.get(id); };
  const api = { modelChoices: async id => { calls.push(['choices', id]); if (options.choices instanceof Error) throw options.choices; return options.choices || CHOICES; },
    changeModel: async (...args) => { calls.push(['change', ...structuredClone(args)]); if (options.change instanceof Error) throw options.change; return await options.change ?? { status: 'pending', waiting: 'turn' }; },
    cancelModelChange: async id => { calls.push(['cancel', id]); state.pending = null; return true; } };
  const dialog = modelDialog.bind({ $, document: { createElement: tag => new Element(tag) }, api, text: zh, display: { text: (el, key) => { el.textContent = zh(key); }, computed: (el, _slot, line) => { el.textContent = line(); } },
    openDialog: id => { $(id).open = true; return ++state.ticket; }, currentTicket: ticket => ticket === state.ticket && $('model-dialog').open, session: id => id === 'a' && !state.gone ? state.record : undefined,
    offline: () => state.offline, pending: () => state.pending, notify: notice => notices.push(notice), showError: (el, error) => { el.textContent = display(error.message, error.uiMessage); } });
  const radios = () => $('model-list').querySelectorAll('input');
  const pick = value => { for (const radio of radios()) radio.checked = radio.value === value; radios().find(radio => radio.checked).onchange(); };
  const effort = value => { $('model-effort').value = value; $('model-effort').onchange(); };
  return { $, api, calls, notices, state, dialog, radios, pick, effort, rows: () => $('model-list').children.map(row => row.children[1].textContent), checked: () => radios().find(radio => radio.checked)?.value ?? null };
}

test('it opens on what the session runs: the list, the mark for now, its effort, and nothing to confirm yet', async () => {
  const p = page(); await p.dialog.open('a');
  assert.equal(p.$('model-title').textContent, '换模型 · Worker');
  assert.deepEqual(p.rows(), ['原生默认', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2（现在）']);
  assert.equal(p.checked(), 'claude-fable-5-2'); assert.equal(p.$('model-effort').value, 'high');
  assert.deepEqual(p.$('model-effort').options.map(option => option.value), ['', 'low', 'high', 'xhigh']);
  assert.equal(p.$('model-note').textContent, '它正在回复时，等这一轮结束再换；有队友或后台任务在跑时先不换。');
  assert.deepEqual([p.$('model-confirm').disabled, p.$('model-withdraw').hidden, p.$('model-pending').hidden, p.$('model-loading').hidden, p.$('model-error').hidden], [true, true, true, true, true]);
  p.effort('xhigh'); assert.equal(p.$('model-confirm').disabled, false); p.effort('high'); assert.equal(p.$('model-confirm').disabled, true);
  assert.deepEqual(p.calls, [['choices', 'a']], 'Nothing is changed by opening or choosing');
});

test('the choice and the conversation it was made for go to the app; what waits is said and the dialog closes', async () => {
  const p = page(); await p.dialog.open('a'); p.pick('claude-opus-5-5'); assert.equal(p.$('model-effort').value, 'high', 'The effort is kept'); p.effort('xhigh');
  await p.dialog.confirm();
  assert.deepEqual(p.calls.slice(1), [['change', 'a', { model: 'claude-opus-5-5', effort: 'xhigh' }, 'native-a']]);
  assert.equal(p.$('model-dialog').open, false); assert.deepEqual(p.notices, [{ sessionId: 'a', model: 'claude-opus-5-5', effort: 'xhigh', waiting: 'turn' }]);
  const idle = page({ change: { status: 'pending', waiting: null } }); await idle.dialog.open('a'); idle.pick(''); await idle.dialog.confirm();
  assert.deepEqual(idle.calls[1][2], { model: null, effort: 'high' }); assert.equal(idle.notices[0].waiting, 'applying');
  // The app itself says what has been done.
  const done = page({ record: { provider: 'codex', model: 'gpt-6-sol' }, choices: CODEX, change: { status: 'applied' } }); await done.dialog.open('a'); done.pick('gpt-6-luna'); await done.dialog.confirm();
  assert.deepEqual([done.calls[1][2], done.notices], [{ model: 'gpt-6-luna', effort: 'low' }, []]);
});

test('Codex offers its own models, each with its own efforts, and no native default', async () => {
  const p = page({ record: { provider: 'codex', model: 'gpt-6-sol' }, choices: CODEX }); await p.dialog.open('a');
  assert.deepEqual(p.rows(), ['gpt-6-sol（现在）', 'gpt-6-luna']); assert.equal(p.$('model-note').textContent, '从它的下一轮起生效。');
  assert.deepEqual(p.$('model-effort').options.map(option => option.value), ['low', 'high']); assert.equal(p.$('model-effort').value, 'high', 'Its own default where Codex reported none');
  assert.equal(p.$('model-confirm').disabled, false, 'The effort it runs is not known, so this is not known to be the same');
  p.pick('gpt-6-luna'); assert.deepEqual(p.$('model-effort').options.map(option => option.value), ['low', 'max']); assert.equal(p.$('model-effort').value, 'low', 'An effort this model does not have is not carried over');
});

test('a refusal stays in the dialog with its reason and nothing is said elsewhere; a second try is possible', async () => {
  const refusal = uiError('error.modelChange.busy', { reason: '有 2 个后台任务在跑' });
  const p = page({ change: refusal }); await p.dialog.open('a'); p.pick('claude-opus-5-5'); await p.dialog.confirm();
  assert.deepEqual([p.$('model-dialog').open, p.$('model-error').hidden, p.$('model-error').textContent, p.notices, p.$('model-confirm').disabled], [true, false, '现在不能换：有 2 个后台任务在跑', [], false]);
  const closed = page({ choices: uiError('error.modelChange.backend') }); await closed.dialog.open('a');
  assert.deepEqual([closed.$('model-error').hidden, closed.$('model-loading').hidden, closed.$('model-confirm').disabled, closed.rows()], [false, true, true, []]);
});

test('one click asks once: while it is being asked, the dialog takes nothing else', async () => {
  let release; const p = page({ change: new Promise(resolve => { release = resolve; }) }); await p.dialog.open('a'); p.pick('claude-opus-5-5');
  const asked = p.dialog.confirm();
  assert.deepEqual([p.$('model-confirm').disabled, p.$('model-effort').disabled, p.radios().every(radio => radio.disabled)], [true, true, true]);
  release({ status: 'pending', waiting: null }); await asked; assert.equal(p.calls.filter(([name]) => name === 'change').length, 1);
});

test('a change that waits is shown with its reason, can be replaced or withdrawn, and not while it is being made', async () => {
  const p = page({ pending: { sessionId: 'a', model: 'claude-opus-5-5', effort: 'xhigh', waiting: 'queue', applying: false } }); await p.dialog.open('a');
  assert.deepEqual([p.$('model-pending').hidden, p.$('model-pending').textContent], [false, '等着换成 claude-opus-5-5 · xhigh：等它手上这件 NAW 任务结束']);
  assert.deepEqual([p.checked(), p.$('model-effort').value, p.$('model-confirm').disabled, p.$('model-withdraw').hidden], ['claude-opus-5-5', 'xhigh', true, false]);
  p.pick('claude-sonnet-5-5'); assert.equal(p.$('model-confirm').disabled, false);
  p.state.pending = { ...p.state.pending, applying: true }; p.dialog.refresh();
  assert.deepEqual([p.$('model-confirm').disabled, p.$('model-withdraw').disabled, p.$('model-effort').disabled], [true, true, true]);
  p.state.pending = { ...p.state.pending, applying: false }; p.dialog.refresh(); await p.dialog.withdraw();
  assert.deepEqual([p.calls.at(-1), p.$('model-dialog').open, p.notices], [['cancel', 'a'], false, []]);
  // A native default that waits is what opens, not what the session runs.
  const none = page({ pending: { sessionId: 'a', model: null, effort: null, waiting: 'turn', applying: false } }); await none.dialog.open('a'); assert.equal(none.checked(), ''); assert.equal(none.$('model-effort').value, '');
});

test('it closes when the conversation, the session or the waiting change is no longer the one it shows', async () => {
  for (const change of [p => { p.state.record = S({ nativeId: 'native-b' }); }, p => { p.state.gone = true; }]) {
    const p = page(); await p.dialog.open('a'); change(p); p.dialog.refresh(); assert.equal(p.$('model-dialog').open, false);
    await assert.rejects(async () => p.dialog.confirm()); assert.equal(p.calls.some(([name]) => name === 'change'), false);
  }
  const p = page({ pending: { sessionId: 'a', model: 'claude-opus-5-5', effort: 'xhigh', waiting: 'turn', applying: false } }); await p.dialog.open('a'); p.state.pending = null; p.dialog.refresh(); assert.equal(p.$('model-dialog').open, false);
  const off = page(); off.state.offline = true; off.dialog.open('a'); assert.equal(off.$('model-dialog').open, false);
  const lost = page(); await lost.dialog.open('a'); lost.pick('claude-opus-5-5'); lost.state.offline = true; lost.dialog.refresh(); assert.equal(lost.$('model-confirm').disabled, true);
  // An answer that arrives after it closed changes nothing.
  let release; const late = page({ choices: CHOICES }); late.api.modelChoices = () => new Promise(resolve => { release = resolve; }); const opening = late.dialog.open('a'); late.$('model-dialog').close(); release(CHOICES); await opening; assert.deepEqual(late.rows(), []);
});

test('what happened is said in one line, with the reason it waits or failed for', () => {
  const line = (notice, record = S()) => modelDialog.noticeText({ sessionId: 'a', model: 'claude-opus-5-5', effort: 'xhigh', ...notice }, record, zh, display);
  assert.equal(line({ waiting: 'approval' }), '「Worker」等着换成 claude-opus-5-5 · xhigh：等你处理它的权限确认');
  assert.equal(line({}), '「Worker」已换成 claude-opus-5-5 · xhigh，同一个会话接着聊。');
  assert.equal(line({}, S({ provider: 'codex' })), '「Worker」从下一轮起用 claude-opus-5-5 · xhigh。');
  assert.equal(line({ error: 'x', errorUiMessage: uiError('error.modelChange.screen').uiMessage }), '「Worker」没换成 claude-opus-5-5 · xhigh：没能保存终端里没发出的字，所以没换模型。');
  // Not known to have failed, so it does not say that it did.
  assert.equal(line({ error: 'x', errorUiMessage: uiError('error.modelChange.unconfirmed').uiMessage }), '给「Worker」换 claude-opus-5-5 · xhigh：没能确认换成了没有。先看这个会话现在的模型，再决定要不要再换一次。');
  assert.equal(line({ error: 'x', errorUiMessage: uiError('error.modelChange.stopped').uiMessage }), '给「Worker」换 claude-opus-5-5 · xhigh：它停下了，没能自动接回来。点「继续原生会话」接着聊，再看它现在的模型。');
  assert.deepEqual(read('renderer/model-dialog.js').match(/UNSURE = \[([^\]]+)\]/)[1].match(/error[.\w]+/g).sort(), [...UNSURE_KEYS].sort());
  assert.ok(zh('error.modelChange.stopped').includes(zh('header.resume')) && locale.format('en', 'error.modelChange.stopped').includes(locale.format('en', 'header.resume')));
  assert.equal(line({ screen: '/saved/a' }).endsWith('可能有没发出的字，已存到 /saved/a'), true); assert.equal(line({ model: null, effort: null }).includes('原生默认'), true);
  assert.equal(line({ waiting: 'later-reason' }).endsWith('等这一轮结束'), true); assert.equal(line({}, null).startsWith('「a」'), true);
});

test('every waiting reason the app gives has words in both languages', () => {
  const reasons = new Set([...read('model-change.cjs').matchAll(/(?:wait|waiting)(?::| =) '([a-z]+)'|\? '([a-z]+)' : '([a-z]+)' \}|key === '[^']+' \? '([a-z]+)' : key === '[^']+' \? '([a-z]+)' : '([a-z]+)'/g)].flatMap(match => match.slice(1)).filter(Boolean));
  for (const name of ['approval', 'backend', 'message', 'person', 'question', 'queue', 'relay', 'report', 'turn', 'input']) assert.ok(reasons.has(name) || name === 'turn', name);
  for (const name of [...reasons, 'applying']) for (const language of ['zh', 'en']) assert.ok(locale.format(language, 'model.wait.' + name), name);
  for (const name of reasons) if (name !== 'turn') assert.notEqual(modelDialog.noticeText({ sessionId: 'a', model: 'm', effort: 'low', waiting: name }, S(), zh, display), modelDialog.noticeText({ sessionId: 'a', model: 'm', effort: 'low', waiting: 'turn' }, S(), zh, display), name);
});

const action = (record, state = {}, api = { changeModel() {} }) => {
  const context = vm.createContext({ api, state, uiText: zh, ui: { displayText: display }, window: { nativeWorkspaceModelDialog: modelDialog } });
  vm.runInContext(cut(renderer, 'function modelAction(record) {', '\n}\n') + '\n}', context); context.record = record;
  return JSON.parse(JSON.stringify(vm.runInContext('modelAction(record)', context)));
};
test('the session menus offer it where the session\'s backend can do it, with the model it runs', () => {
  assert.deepEqual(action(S()).map(item => [item.id, item.label]), [['change-model', '换模型…（现在 claude-fable-5-2）']]);
  assert.equal(action(S({ model: '' }))[0].label, '换模型…');
  assert.equal(action(S(), { modelChanges: [{ sessionId: 'a', model: 'claude-opus-5-5', effort: 'xhigh' }] })[0].label, '换模型…（等着换成 claude-opus-5-5 · xhigh）');
  for (const extra of [{ provider: 'codex' }, { provider: 'codex', vendor: 'openai' }, { state: 'working' }, { state: 'approval' }, { state: 'starting' }]) assert.equal(action(S(extra)).length, 1, JSON.stringify(extra));
  for (const extra of [{ provider: 'dsh' }, { provider: 'agy' }, { provider: 'codex', vendor: 'deepseek' }, { archived: true }, { nativeId: null }, { serviceCapabilities: [] }, ...['ended', 'background', 'error', 'recoverable', 'disconnected'].map(state => ({ state }))]) assert.deepEqual(action(S(extra)), [], JSON.stringify(extra));
  assert.equal(action(S({ serviceCapabilities: undefined }), { capabilities: ['sessionModelV1'] }).length, 1); assert.deepEqual(action(S({ serviceCapabilities: undefined })), []);
  assert.deepEqual(action(S(), {}, {}), []);
  assert.equal(renderer.match(/\.\.\.modelAction\(/g).length, 2, 'The row\'s menu and the title bar\'s');
  assert.equal(renderer.match(/else if \(action === 'change-model'\) modelDialog\?\.open\(/g).length, 2);
});

test('the dialog is a native modal with named controls, and its buttons are wired', () => {
  const dialog = cut(html, '<dialog closedby="any" id="model-dialog"', '</dialog>');
  assert.match(dialog, /aria-labelledby="model-title"/); assert.match(dialog, /role="radiogroup" aria-labelledby="model-title"/); assert.match(dialog, /<label for="model-effort"/);
  for (const id of ['model-title', 'model-list', 'model-loading', 'model-effort-row', 'model-effort', 'model-pending', 'model-error', 'model-note', 'model-cancel', 'model-withdraw', 'model-confirm']) assert.equal(html.split(`id="${id}"`).length, 2, id);
  assert.match(dialog, /id="model-error"[^>]*role="alert"/); assert.match(renderer, /\$\('model-confirm'\)\.onclick = \(\) => attempt\(\(\) => modelDialog\.confirm\(\)\)/);
  assert.ok(html.indexOf('src="model-dialog.js"') < html.indexOf('src="renderer.js"'));
});

// The window runs the bundle, not the page's own script tags: a module the page loads and the bundle lacks leaves it broken.
test('every module the page loads is in the bundle, and this one is there before the renderer', () => {
  const build = fs.readFileSync(path.join(__dirname, '../../scripts/build-ui.cjs'), 'utf8');
  for (const [, source] of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(new RegExp(`'(?:[^']*/)?${path.basename(source).replaceAll('.', '\\.')}'`).test(build) || /^\.\.\/\.\.\/node_modules\//.test(source), source);
  assert.ok(build.indexOf("'model-dialog.js'") > 0 && build.indexOf("'model-dialog.js'") < build.indexOf("'renderer.js'"));
});

// The app's handlers, as written.
function handlers(request) {
  const registered = new Map(), notices = [], asked = [], changes = { choices: async id => ({ id }), request: async (...args) => { asked.push(args); return request(...args); }, cancel: id => id };
  const context = vm.createContext({ register: (name, handler) => registered.set(name, handler), applicationHandlers: registered, modelChanges: () => changes, notifyModelChange: notice => notices.push(JSON.parse(JSON.stringify(notice))), require: name => require(path.join(__dirname, '..', name)) });
  vm.runInContext(cut(main, "  register('modelChoices',", "  register('interfaceSettings',"), context);
  const client = { snapshot: () => ({ sessions: [{ id: 'a', nativeId: 'native-a' }] }) };
  return { registered, notices, asked, person: (...args) => registered.get('changeModel')({ client }, ...args), agent: (...args) => registered.get('changeModel')({ client, background: true }, ...args) };
}
const VALUE = { model: 'claude-opus-5-5', effort: 'xhigh' };
test('the person\'s window names the conversation it chose for, and gets every refusal', async () => {
  const f = handlers(() => { throw uiError('error.modelChange.busy', { reason: 'x' }); });
  await assert.rejects(f.person('a', VALUE, 'native-seen'), error => error.uiMessage.key === 'error.modelChange.busy');
  assert.deepEqual([f.asked, f.notices], [[['a', VALUE, 'native-seen']], []]);
  assert.deepEqual([...f.registered.keys()], ['modelChoices', 'changeModel'], 'Withdrawing is the person\'s window only');
});
test('an agent cannot name a conversation; the person who confirmed its card is told what waits or was refused', async () => {
  const pending = handlers(() => ({ status: 'pending', waiting: 'turn' }));
  assert.deepEqual(await pending.agent('a', VALUE, 'native-forged'), { status: 'pending', waiting: 'turn' });
  assert.deepEqual([pending.asked, pending.notices], [[['a', VALUE, 'native-a']], [{ sessionId: 'a', ...VALUE, waiting: 'turn' }]]);
  const refused = handlers(() => { throw uiError('error.modelChange.busy', { reason: 'x' }); }), answer = await refused.agent('a', VALUE);
  assert.equal(answer.status, 'refused'); assert.equal(answer.reason, refused.notices[0].error); assert.equal(refused.notices[0].errorUiMessage.key, 'error.modelChange.busy');
  // Whether it took place is not known, or it is another kind of failure: the record keeps it open.
  for (const error of [uiError('error.modelChange.unconfirmed'), uiError('error.modelChange.stopped'), Error('gone')]) { const f = handlers(() => { throw error; }); await assert.rejects(f.agent('a', VALUE), thrown => thrown === error); assert.deepEqual(f.notices, []); }
});
