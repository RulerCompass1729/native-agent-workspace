// The butler's sidebar row and dialog over a stand-in document. No model, no process, no person-only entry:
// `api.butler` here only records what the dialog would ask the main process to do.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { bind, money, line, STATE_KEYS, HOLD_KEYS, FACTS } = require('../renderer/butler-entry.js');
const { buildInput } = require('../butler-policy.cjs');
const { summarizeUsage } = require('../butler-usage.cjs');
const os = require('node:os');
// Today's usage as the core reads it: `runs` recorded wake-ups, `unknown` of them without usage, the sums on one of the rest.
const NOW = Date.UTC(2026, 10, 11, 9);
const reading = (runs, unknown, totalTokens, costMicros) => summarizeUsage({ batches: [], attempts: Array.from({ length: runs }, (_, index) => ({ batchId: `batch-${index}`, startedAt: NOW - 60_000,
  usage: index < unknown ? null : { inputTokens: index === unknown ? totalTokens : 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: index === unknown ? totalTokens : 0, costMicros: index === unknown ? costMicros : 0 } })) }, { now: NOW });
const { entryView, HOLD_REASONS, ACTIONS } = require('../butler-entry-view.js');
const messages = require('../ui-messages.js'), locale = require('../ui-locale.js');
// The renderer's real display bindings, taken from the plugin source as app/tests/ui-locale-dom.test.cjs does.
const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
const createBindings = require('node:vm').runInNewContext('(' + bootstrap.slice(bootstrap.indexOf('    function createDisplayBindings('), bootstrap.indexOf('    function mountWorkspace(')).trim() + ')');

class Element {
  constructor(tag, page) { this.tag = tag; this.page = page; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.id = ''; this.open = false; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  removeAttribute(key) { delete this.attributes[key]; }
  get childElementCount() { return this.children.length; }
  querySelectorAll(selector) { const names = selector.split(',').map(part => part.trim().slice(1, -1)); return this.children.flatMap(child => [...(names.some(name => child.hasAttribute(name)) ? [child] : []), ...child.querySelectorAll(selector)]); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(value => value !== callback); }
  fire(name) { return (this.listeners[name] || []).map(callback => callback())[0]; }
  focus() { this.page.activeElement = this; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  contains(other) { return this.all().includes(other); }
  showModal() { this.open = true; this.page.shown++; }
  close() { if (!this.open) return; this.open = false; this.fire('close'); }
  // What a person can read: nothing under a hidden element.
  text() { return this.hidden ? '' : [this.textContent, ...this.children.map(child => child.text())].filter(Boolean).join(' | '); }
}
const selected = { runner: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' }, budget: { limitMicros: 2_000_000, dayBoundary: 'UTC' } };
const none = { version: 1, role: { revision: 4, selected: null }, offer: selected, startable: false, actions: [...ACTIONS] };
const designated = extra => ({ version: 1, role: { revision: 5, selected }, startable: false, backend: null, intake: { recordPeriod: 'off' }, actions: [...ACTIONS], ...extra });
const ready = extra => designated({ startable: true, backend: { state: 'ready', ready: true, blocked: [] }, ...extra });
const nokey = extra => designated({ startable: true, backend: { state: 'blocked', ready: false, blocked: ['credential-missing'] }, ...extra });
function fixture({ entry = true, fail = false, pending = false, showError, openReview } = {}) {
  const page = { activeElement: null, shown: 0, createElement: tag => new Element(tag, page) };
  const row = new Element('button', page), dialog = new Element('dialog', page), calls = []; dialog.id = 'butler-dialog'; row.hidden = true;
  let release; const api = entry ? { async butler(...args) { calls.push(args); if (pending) await new Promise(resolve => { release = resolve; }); if (fail) throw Error('/PRIVATE_IPC_PATH'); return { ok: true }; } } : {};
  const entryUi = bind({ row, dialog, document: page, api, showError, openReview });
  const buttons = () => dialog.all().filter(node => node.tag === 'button' && !dialog.all().some(parent => parent.hidden && parent.contains(node)));
  const button = action => buttons().find(node => node.dataset.action === action);
  return { page, row, dialog, calls, entryUi, buttons, button, names: () => buttons().map(node => node.dataset.action), release: () => release() };
}
const zh = (key, params) => locale.format('zh', key, params);

test('with no view the row stays hidden and nothing opens', () => {
  const f = fixture();
  for (const value of [undefined, null, {}, { version: 1 }]) { f.entryUi.render(value); assert.equal(f.row.hidden, true); }
  f.row.fire('click'); f.entryUi.open();
  assert.equal(f.dialog.open, false); assert.equal(f.page.shown, 0); assert.deepEqual(f.calls, []);
});

test('the default is empty: one row, one sentence, and a designation only after a complete confirmation', async () => {
  const f = fixture(); f.entryUi.render(none);
  assert.equal(f.row.hidden, false); assert.equal(f.row.dataset.butlerState, 'empty');
  assert.equal(f.row.attributes['aria-label'], '大管家：未指定'); assert.equal(f.row.attributes.title, '大管家：未指定'); assert.equal(f.row.attributes['aria-haspopup'], undefined);
  assert.match(f.row.text(), /大管家 \| 未指定/);
  f.row.fire('click');
  assert.equal(f.dialog.open, true); assert.equal(f.dialog.attributes['aria-labelledby'], 'butler-dialog-title');
  assert.deepEqual(f.names(), ['designate', 'done']); assert.equal(f.page.activeElement, f.button('done'), 'opening never focuses an action that changes something');
  assert.ok(f.dialog.text().includes(zh('butler.note.empty'))); assert.equal(/模型：|提醒线|用量/.test(f.dialog.text()), false, 'no model or usage line before there is a butler');
  f.button('designate').fire('click');
  assert.deepEqual(f.calls, [], 'asking is not designating');
  assert.deepEqual(f.names(), ['back', 'confirmDesignate']); assert.equal(f.page.activeElement, f.button('back'));
  const text = f.dialog.text();
  for (const key of FACTS) assert.ok(text.includes(zh(`butler.confirm.${key}`)), key);
  assert.ok(text.includes('DeepSeek pro（当前配置：deepseek-v4-pro）')); assert.ok(text.includes('$2.00（按 UTC 日）：到线后当天不再叫醒它，可能超出'));
  assert.ok(text.includes('会话正文')); assert.ok(text.includes(zh('butler.confirm.sentValue'))); assert.ok(text.includes('会调用 DeepSeek 并计费'));
  assert.ok(text.includes(zh('butler.confirm.notYet')), 'said before the person decides');
  await f.button('confirmDesignate').fire('click');
  // The call carries what the page stated, so the main process can refuse a designation the person did not read.
  assert.deepEqual(f.calls, [['designate', 4, { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro', limitMicros: 2_000_000, dayBoundary: 'UTC', startable: false }]]); assert.deepEqual(f.names(), ['designate', 'done']); assert.equal(f.page.activeElement, f.button('done'));
  // A version that can start says nothing about not starting.
  const g = fixture(); g.entryUi.render({ ...none, startable: true }); g.entryUi.open(); g.button('designate').fire('click');
  assert.equal(g.dialog.text().includes(zh('butler.confirm.notYet')), false);
});

test('cancelling a question changes nothing, and a question that went stale is not acted on', async () => {
  const f = fixture(); f.entryUi.render(none); f.entryUi.open(); f.button('designate').fire('click');
  f.button('back').fire('click');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.names(), ['designate', 'done']); assert.equal(f.page.activeElement, f.button('done'));
  // Another window designated meanwhile: the confirmation the person was reading no longer describes the state.
  f.button('designate').fire('click'); const stale = f.button('confirmDesignate');
  f.entryUi.render(designated()); assert.equal(f.button('confirmDesignate'), undefined); assert.equal(f.dialog.dataset.butlerState, 'blocked-build');
  await stale.fire('click'); assert.deepEqual(f.calls, []);
  // The same for what would be designated, and for whether it would start.
  for (const change of [{ offer: { ...selected, runner: { ...selected.runner, model: 'deepseek-v5-pro' } } }, { startable: true }, { role: { revision: 9, selected: null } }]) {
    const g = fixture(); g.entryUi.render(none); g.entryUi.open(); g.button('designate').fire('click'); const old = g.button('confirmDesignate');
    g.entryUi.render({ ...none, ...change }); assert.deepEqual(g.names(), ['designate', 'done']);
    await old.fire('click'); assert.deepEqual(g.calls, []);
  }
  // Designating stops being offered while the question is open: the person is taken back, not left with a dead button.
  const k = fixture(); k.entryUi.render(none); k.entryUi.open(); k.button('designate').fire('click'); const dead = k.button('confirmDesignate');
  k.entryUi.render({ ...none, actions: ['revoke'] }); assert.deepEqual(k.names(), ['done']); assert.equal(k.page.activeElement, k.button('done'));
  await dead.fire('click'); assert.deepEqual(k.calls, []);
  // Closing the dialog on a question drops the question.
  const h = fixture(); h.entryUi.render(none); h.entryUi.open(); h.button('designate').fire('click'); const kept = h.button('confirmDesignate'); h.dialog.close();
  await kept.fire('click'); assert.deepEqual(h.calls, []); h.entryUi.open(); assert.deepEqual(h.names(), ['designate', 'done']);
});

test('this version after a designation: cannot start, said first, with the missing key second and usage unverified', () => {
  const f = fixture(); f.entryUi.render(designated({ backend: { state: 'blocked', ready: false, blocked: ['credential-missing', 'tools-unqualified'] } })); f.entryUi.open();
  assert.equal(f.row.attributes['aria-label'], '大管家：起不来'); assert.equal(f.row.dataset.butlerState, 'blocked-build');
  const text = f.dialog.text();
  assert.ok(text.indexOf(zh('butler.note.blockedBuild')) > 0 && text.indexOf(zh('butler.note.blockedBuild')) < text.indexOf(zh('butler.note.alsoMissingKey')));
  assert.ok(text.includes('模型：DeepSeek pro（当前配置：deepseek-v4-pro）'));
  assert.ok(text.includes('今天的用量还没有核实 · 提醒线 $2.00'), 'no recorded total is not zero');
  assert.deepEqual(f.names(), ['revoke', 'done'], 'revoking sits apart, first');
  assert.match(f.button('revoke').className, /butler-apart/);
  f.entryUi.render(designated()); assert.equal(f.dialog.text().includes(zh('butler.note.alsoMissingKey')), false);
});

test('revoking asks first and sends the revision it was asked about', async () => {
  const f = fixture(); f.entryUi.render(designated()); f.entryUi.open();
  f.button('revoke').fire('click');
  assert.deepEqual(f.calls, []); assert.ok(f.dialog.text().includes(zh('butler.revoke.text'))); assert.equal(f.page.activeElement, f.button('back'));
  f.button('back').fire('click'); assert.deepEqual(f.calls, []);
  f.button('revoke').fire('click'); await f.button('confirmRevoke').fire('click');
  assert.deepEqual(f.calls, [['revoke', 5]], 'only the revision: there is nothing else to agree to');
});

test('an action runs once at a time, and a failure is said without the raw error', async () => {
  const f = fixture({ pending: true }); f.entryUi.render(nokey()); f.entryUi.open();
  assert.deepEqual(f.names(), ['revoke', 'recheck', 'done']);
  const first = f.button('recheck').fire('click');
  assert.deepEqual(f.calls, [['recheck', 5]]); assert.equal(f.button('recheck').disabled, true); assert.equal(f.button('done').disabled, false);
  f.button('recheck').fire('click'); f.button('revoke').fire('click');
  assert.deepEqual(f.calls, [['recheck', 5]]); assert.deepEqual(f.names(), ['revoke', 'recheck', 'done'], 'no question opens while an action is running');
  f.release(); await first;
  assert.equal(f.button('recheck').disabled, false); assert.equal(f.page.activeElement, f.button('done'));
  const g = fixture({ fail: true }); g.entryUi.render(nokey()); g.entryUi.open();
  await g.button('recheck').fire('click');
  assert.deepEqual(g.calls, [['recheck', 5]]); assert.ok(g.dialog.text().includes(zh('error.operation'))); assert.equal(g.dialog.text().includes('PRIVATE'), false);
  const alert = g.dialog.all().find(node => node.attributes.role === 'alert'); assert.equal(alert.hidden, false);
  g.dialog.close(); g.entryUi.open(); assert.equal(alert.hidden, true, 'an old failure is not shown again');
  const shown = []; const h = fixture({ fail: true, showError: (element, error) => shown.push([element.attributes.role, error.message]) }); h.entryUi.render(nokey()); h.entryUi.open();
  await h.button('recheck').fire('click'); assert.deepEqual(shown, [['alert', '/PRIVATE_IPC_PATH']], 'the renderer\'s own error display decides what is shown');
});

test('a window without the person-only entry can look and not act', () => {
  const f = fixture({ entry: false }); f.entryUi.render(none); f.entryUi.open(); assert.deepEqual(f.names(), ['done']);
  f.entryUi.render(ready({ reviewAvailable: true })); assert.deepEqual(f.names(), ['done'], 'no record table without a way to open it');
  assert.equal(f.entryUi.press('revoke'), undefined); assert.equal(f.entryUi.press('confirmRevoke'), undefined); assert.equal(f.dialog.text().includes(zh('butler.revoke.text')), false);
  let opened = 0; const g = fixture({ entry: false, openReview: () => { opened++; } }); g.entryUi.render(ready({ reviewAvailable: true })); g.entryUi.open();
  assert.deepEqual(g.names(), ['review', 'done']); g.button('review').fire('click'); assert.equal(opened, 1); assert.equal(g.dialog.open, false);
  // What the main process does not name is not offered, whatever this window can call.
  const h = fixture(); h.entryUi.render(ready({ actions: ['revoke'] })); h.entryUi.open(); assert.deepEqual(h.names(), ['revoke', 'done']);
});

test('each state says what the core reported, and usage only what was recorded', () => {
  const f = fixture(); f.entryUi.open();
  const shows = (entry, state, label, ...sentences) => {
    f.entryUi.render(entry); if (!f.dialog.open) f.entryUi.open();
    assert.equal(f.dialog.dataset.butlerState, state); assert.equal(f.row.attributes['aria-label'], `大管家：${label}`);
    for (const sentence of sentences) assert.ok(f.dialog.text().includes(sentence), `${state}: ${sentence}\n${f.dialog.text()}`);
  };
  shows(ready(), 'ready', '已就绪', '已就绪 · 记录期未开始', zh('butler.note.ready'));
  assert.equal(f.dialog.text().includes('记录期进行中'), false);
  shows(ready({ intake: { recordPeriod: 'on' } }), 'recording', '记录期', '记录期进行中', '会调用 DeepSeek 并计费');
  for (const reason of HOLD_REASONS) shows(ready({ hold: reason }), 'held', '已暂停', zh(`butler.hold.${HOLD_KEYS[reason]}`));
  shows(ready({ hold: 'something-new' }), 'held', '已暂停', zh('butler.hold.other'));
  shows(designated({ startable: true, backend: { state: 'blocked', ready: false, blocked: ['credential-missing'] } }), 'blocked-credential', '起不来', 'DEEPSEEK_API_KEY', '不读它的值');
  shows(designated({ startable: true, backend: { state: 'unknown', ready: false, blocked: ['liveness-unconfirmed'] } }), 'unknown', '状态不明', zh('butler.note.unknown'));
  const usage = reading;
  shows(ready({ usage: usage(0, 0, 0, 0) }), 'ready', '已就绪', '2026-11-11（UTC）还没有叫醒过它 · 提醒线 $2.00');
  shows(ready({ usage: usage(3, 0, 5074, 6100) }), 'ready', '已就绪', '2026-11-11（UTC）：叫醒 3 次 · 5,074 token · $0.0061 · 提醒线 $2.00');
  shows(ready({ usage: usage(3, 1, 3331, 3940) }), 'ready', '已就绪', '2026-11-11（UTC）：叫醒 3 次，至少 1 次的用量没有记全 · 已记下 3,331 token · $0.0040 · 提醒线 $2.00');
  shows(ready({ usage: usage(2, 0, 860000, 2115000), hold: 'daily-budget-reached' }), 'held', '已暂停', '$2.1150 · 提醒线 $2.00');
  shows(ready({ usage: { runs: 1 } }), 'ready', '已就绪', '今天的用量还没有核实');
});

test('a language switch repaints the row and the dialog in place, also after the view has gone', () => {
  let language = 'zh'; const format = (key, params) => locale.format(language, key, params), display = createBindings(format);
  const page = { activeElement: null, shown: 0, createElement: tag => new Element(tag, page) }, row = new Element('button', page), dialog = new Element('dialog', page), body = new Element('body', page);
  body.append(row, dialog);
  const shown = [], showError = (element, error) => { shown.push(error.message); display.text(element, 'error.operation'); };
  const entryUi = bind({ row, dialog, document: page, api: { butler: async () => { throw Error('refused'); } }, text: format, display, showError });
  entryUi.render(nokey({ usage: reading(3, 0, 1234567, 6100) })); entryUi.open();
  assert.equal(row.attributes['aria-label'], '大管家：起不来'); assert.ok(dialog.text().includes('2026-11-11（UTC）：叫醒 3 次 · 1,234,567 token · $0.0061 · 提醒线 $2.00'));
  return dialog.all().find(node => node.dataset.action === 'recheck').fire('click').then(() => {
    assert.deepEqual(shown, ['refused']); assert.ok(dialog.text().includes('操作未完成。'));
    language = 'en'; display.refresh(body);
    assert.equal(row.attributes['aria-label'], 'Butler: Cannot start'); assert.equal(row.attributes.title, 'Butler: Cannot start'); assert.match(row.text(), /Butler \| Cannot start/);
    const text = dialog.text();
    for (const sentence of ['Cannot start', locale.format('en', 'butler.note.blockedCredential'), 'Model: DeepSeek pro (current configuration: deepseek-v4-pro)', '2026-11-11 (UTC): woken 3× · 1,234,567 tokens · $0.0061 · reminder line $2.00', 'The operation did not complete.', 'Revoke', 'Check again', 'Done']) assert.ok(text.includes(sentence), sentence + '\n' + text);
    assert.equal(/[一-鿿]/.test(text + row.text()), false, 'nothing is left in the other language');
    // A question page repaints too.
    dialog.all().find(node => node.dataset.action === 'revoke').fire('click'); language = 'zh'; display.refresh(body);
    assert.ok(dialog.text().includes(locale.format('zh', 'butler.revoke.text'))); assert.ok(dialog.text().includes('撤销指定'));
    // The view goes away, then the language changes again: nothing throws and nothing is shown.
    entryUi.render(undefined); language = 'en'; assert.doesNotThrow(() => display.refresh(body)); assert.equal(row.hidden, true); assert.equal(dialog.open, false);
    entryUi.dispose(); assert.doesNotThrow(() => display.refresh(body));
  });
});

test('what was spent is never shown lower than it is, and the line never higher', () => {
  assert.deepEqual([0, 10000, 6100, 1, 99, 3940, 999_999, 1_000_000, 1_999_999, 2_000_000, 2_115_000].map(money), ['$0.00', '$0.01', '$0.0061', '$0.0001', '$0.0001', '$0.0040', '$1.0000', '$1.00', '$2.0000', '$2.00', '$2.1150']);
  // The line is never shown higher than it is.
  assert.deepEqual([2_000_000, 2_500_000, 1_234_567, 99].map(line), ['$2.00', '$2.50', '$1.2345', '$0.0000']);
});

test('a state push redraws only what changed and keeps the keyboard focus usable', () => {
  const f = fixture(); f.entryUi.render(ready()); f.entryUi.open();
  const before = f.button('revoke'); f.entryUi.render(ready()); f.entryUi.render(JSON.parse(JSON.stringify(ready())));
  assert.equal(f.button('revoke'), before, 'an unchanged view is not rebuilt');
  before.focus(); f.entryUi.render(ready({ hold: 'daily-budget-reached' }));
  assert.notEqual(f.button('revoke'), before); assert.equal(f.page.activeElement, f.button('done'), 'focus does not stay on a button that is gone');
  // The view going away (the switch closing) closes the dialog and hides the row.
  f.entryUi.render(undefined); assert.equal(f.dialog.open, false); assert.equal(f.row.hidden, true);
  f.entryUi.render(ready()); assert.equal(f.row.hidden, false); assert.equal(f.dialog.open, false);
  f.entryUi.dispose(); assert.equal(f.row.hidden, true); assert.deepEqual(f.row.children, []); assert.deepEqual(f.dialog.children, []);
  f.row.fire('click'); assert.equal(f.dialog.open, false);
});

test('every sentence the entry can show is in the catalog in both languages, and the catalog has no others', () => {
  const expected = new Set(['butler.name', 'butler.rowLabel', 'butler.model', 'butler.note.alsoMissingKey', 'butler.usage', 'butler.usage.partial', 'butler.usage.none', 'butler.usage.unverified',
    'butler.confirm.title', 'butler.confirm.confirm', 'butler.confirm.notYet', 'butler.revoke.title', 'butler.revoke.text', 'butler.revoke.confirm', 'butler.action.review']);
  for (const key of Object.values(STATE_KEYS)) { expected.add(`butler.row.${key}`); expected.add(`butler.status.${key}`); if (key !== 'held') expected.add(`butler.note.${key}`); }
  for (const key of Object.values(HOLD_KEYS)) expected.add(`butler.hold.${key}`);
  for (const key of FACTS) { expected.add(`butler.confirm.${key}`); expected.add(`butler.confirm.${key}Value`); }
  for (const action of ACTIONS) expected.add(`butler.action.${action}`);
  for (const language of ['zh', 'en']) assert.deepEqual(Object.keys(messages[language]).filter(key => key.startsWith('butler.')).sort(), [...expected].sort());
  // Every state and hold reason the view can answer has its keys.
  const states = new Set(); const role = { revision: 1, selected };
  for (const entry of [none, designated(), ready(), ready({ intake: { recordPeriod: 'on' } }), ready({ hold: 'x' }), nokey(), designated({ startable: true })]) states.add(entryView({ ...entry, role: entry.role || role }).state);
  assert.deepEqual([...states].sort(), Object.keys(STATE_KEYS).sort());
  assert.deepEqual(Object.keys(HOLD_KEYS).sort(), [...HOLD_REASONS, 'other'].sort());
  // No field takes a key, and the entry's source names no secret-bearing value.
  const source = fs.readFileSync(path.join(__dirname, '../renderer/butler-entry.js'), 'utf8');
  assert.equal(/createElement\('(input|textarea|select)'\)|make\('(input|textarea|select)'/.test(source), false);
  assert.equal(/process\.env|API_KEY|apiKey/.test(source + fs.readFileSync(path.join(__dirname, '../butler-entry-view.js'), 'utf8')), false);
});

test('the sentence about what is sent was written for what the core can put before the model', t => {
  // butler.confirm.sentValue lists what the person agrees to send to the model's provider. It was written for the
  // two shapes below: what buildInput returns for input that uses every field, and what the butler's one read
  // capability returns for a space with a delivered item. A new field in either fails here first: read the sentence
  // again before changing these lists.
  const paths = value => { const found = new Set(); const walk = (item, at) => {
    if (Array.isArray(item)) { for (const child of item) walk(child, at + '[]'); return; }
    if (item && typeof item === 'object') { for (const [key, child] of Object.entries(item)) walk(child, at ? `${at}.${key}` : key); return; }
    found.add(at);
  }; walk(value, ''); return [...found].sort(); };
  const policy = fs.readFileSync(path.join(__dirname, '../butler-policy.cjs'), 'utf8');
  const list = pattern => [...policy.match(pattern)[1].matchAll(/'([^']+)'|(\w+):/g)].map(match => match[1] || match[2]);
  const kinds = ['request', 'queue-empty', 'ready', 'decision', 'failure', 'blocked', 'recovery'], statuses = ['queued', 'sent', 'waiting', 'done', 'failed', 'cancelled'];
  const payload = ['text', 'title', 'spaceId', 'spaceName', 'memberName', 'memberId', 'itemId', 'outcome', 'reason', 'decisionKind', 'questionKey', 'supersedes'];
  assert.deepEqual(list(/const EVENT_KINDS = \[([^\]]+)\]/), kinds); assert.deepEqual(list(/const PAYLOAD_LIMITS = \{([^}]+)\}/), payload);
  // Private-looking extras on the way in must not come out.
  const input = buildInput({ batchId: 'batch-1',
    events: kinds.map((kind, index) => ({ eventId: `event-${index}`, kind, sourceRef: `source-${index}`, payload: Object.fromEntries(payload.map(key => [key, `${key}-value`])), sequence: index, time: 1, transcript: 'not sent' })),
    catalog: [{ id: 'space-1', name: 'Space', archived: false, writable: true, cwd: '/not/sent', notes: 'not sent',
      members: [{ id: 'member-1', name: 'Member', state: 'idle', conversation: 'not sent', nativeId: 'not-sent' }], queue: [{ id: 'item-1', text: 'not sent by default', status: 'queued', author: 'not sent' }] }],
    questions: [{ questionId: 'question-1', sourceRef: 'source-9', decisionKind: 'queue-decision', text: 'Question', decisionSource: 'source-8', status: 'open', answer: 'not sent' }] });
  assert.deepEqual(paths(input), ['version', 'mode', 'batchId', 'events[].eventId', 'events[].kind', 'events[].sourceRef', ...payload.map(key => `events[].payload.${key}`),
    'spaces[].id', 'spaces[].name', 'spaces[].writable', ...statuses.map(status => `spaces[].queueCounts.${status}`),
    'pendingQuestions[].questionId', 'pendingQuestions[].sourceRef', 'pendingQuestions[].decisionKind', 'pendingQuestions[].text', 'pendingQuestions[].decisionSource'].sort());
  assert.equal(/not sent|not-sent|\/not\/sent/.test(JSON.stringify(input)), false);
  // The read capability, on the product's own room state in a scratch directory.
  const { ButlerBusiness } = require('../butler-business.cjs'), { RoomState } = require('../room-state.cjs'), { ButlerRole } = require('../butler-role.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-entry-sent-')); fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runner = { runnerRef: 'butler-runner', backendRef: 'butler-backend', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
  const person = {}, role = new ButlerRole(directory, { authorizePerson: value => value === person }), actor = { id: 'butler-a', nativeId: 'native-a', provider: 'dsh', state: 'idle', roomIds: [], runner };
  role.set(person, { identity: { sessionId: actor.id, nativeId: actor.nativeId }, runner }, 0);
  const room = new RoomState(directory), read = new ButlerBusiness({ role, roomState: room, view: () => ({ records: [actor] }) }).bind(actor, { selectionRevision: 1, runnerRef: runner.runnerRef });
  assert.deepEqual(read.catalog().methods.map(method => [method.name, method.kinds]), [['readBusiness', ['spaces', 'queue', 'deliveries']]]);
  const itemId = room.queueAdd('Synthetic task', null, 'shared'); room.queueMarkSent('shared', itemId, 'worker-a', 'Synthetic worker', Date.now());
  room.queueSettle('shared', itemId, 'done', '', 'Synthetic worker', 'A native reply stays private', undefined, { branch: 'lane/synthetic', commit: 'abcdef1234567' });
  const records = query => { const result = read.invoke('readBusiness', query); assert.equal(JSON.stringify(result).includes('stays private'), false); return paths(result).filter(value => value.startsWith('records[].')).map(value => value.slice(10)); };
  const space = ['archived', 'metadataRevision', 'readOnly', 'recordRef', 'spaceId', 'spaceRecordRef', 'time', 'writable'];
  assert.deepEqual(records({ kind: 'spaces' }), [...space, 'name', ...statuses.map(status => `queueCounts.${status}`)].sort());
  assert.deepEqual(records({ kind: 'queue', spaceId: 'shared' }), [...space, 'assignee', 'finishedAt', 'itemId', 'ready.branch', 'ready.commit', 'sentAt', 'status', 'text'].sort());
  assert.deepEqual(records({ kind: 'deliveries', spaceId: 'shared', fromTime: Date.now() - 3_600_000, throughTime: Date.now() + 3_600_000 }),
    [...space, 'branch', 'commit', 'eventId', 'itemId', 'itemRecordRef', 'kind', 'sourceTask', 'sourceTaskStatus', 'status'].sort());
  for (const language of ['zh', 'en']) for (const part of language === 'zh' ? ['你对它说的话', '答复', '队列正文', '交付记录', '分支名', '提交号', '失败或被拦下的原因', '空间名', '成员名', '状态', '时间', '内部编号'] :
    ['What you say to it', 'answers', 'queue text', 'delivery records', 'branch names', 'commit ids', 'failure and block reasons', 'space names', 'member names', 'status', 'times', 'internal ids']) assert.ok(messages[language]['butler.confirm.sentValue'].includes(part), part);
});

test('the page loads the view before the entry and the entry before the renderer, in the page and in the bundle', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8'), build = fs.readFileSync(path.join(__dirname, '../../scripts/build-ui.cjs'), 'utf8');
  const order = (source, names) => names.map(name => source.indexOf(name));
  for (const positions of [order(html, ['src="../butler-entry-view.js"', 'src="butler-entry.js"', 'src="renderer.js"']), order(build, ["read('app/butler-entry-view.js')", "'butler-entry.js'", "'renderer.js'"])]) {
    assert.ok(positions.every(value => value > 0) && positions[0] < positions[1] && positions[1] < positions[2]);
  }
  // The row is in the markup hidden, above "new session"; the dialog is empty until the entry fills it.
  assert.match(html, /<button id="butler-row" class="butler-row" type="button" aria-haspopup="dialog" hidden><\/button>\n\s*<button class="new-button" id="new-session"/);
  assert.match(html, /<dialog closedby="any" id="butler-dialog" class="butler-dialog"><\/dialog>/);
});
