const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const locale = require('../ui-locale.js');
const bootstrap = fs.readFileSync(require.resolve('../dsh/bootstrap.js'), 'utf8');
const helperStart = bootstrap.indexOf('    function createDisplayBindings('), helperEnd = bootstrap.indexOf('    function mountWorkspace(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const createBindings = vm.runInNewContext('(' + bootstrap.slice(helperStart, helperEnd).trim() + ')');
class Element {
  constructor(tag = 'div', text = '') { this.tag = tag; this.text = text; this.children = []; this.open = false; this.isConnected = true; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.scrollTop = 0; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  querySelector() { return this.heading ||= new Element('h2'); }
  querySelectorAll(selector) { if (!selector || selector === 'details') return this.details ||= [new Element('details'), new Element('details')]; const children = this.heading ? [...this.children, this.heading] : this.children; return children.flatMap(child => [...(child.hasAttribute('data-naw-i18n-bound') ? [child] : []), ...child.querySelectorAll(selector)]); }
  get childElementCount() { return this.children.length; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  closeEvent() { this.listeners.get('close')?.({ currentTarget: this }); }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(x => x.textContent).join(''); }
}
function pending() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; }
function fixture() {
  let language = 'zh'; const elements = new Map(), requests = [];
  const uiText = (key, params) => locale.format(language, key, params), display = createBindings(uiText);
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ $, uiText, ui: { display, displayText: (raw, message) => locale.displayText(language, raw, message), language: { getSnapshot: () => ({ active: language }) }, errorText: error => locale.errorText(language, error) }, spaceId: 'shared', spaceRecord: () => ({ id: 'shared', name: 'Synthetic shared' }), selectionRevision: 1, node: (tag, text) => new Element(tag, text), participantLabel: s => s.name,
    window: { nativeWorkspaceUsage: require('../native-usage.js') }, api: { initial() { const request = pending(); requests.push(request); return request.promise; } } });
  vm.runInContext(source.slice(source.indexOf('const uiNode ='), source.indexOf('const states =')), context);
  vm.runInContext(source.slice(source.indexOf('let trustScope ='), source.indexOf('function openCreate(')), context);
  return { $, context, requests, open: options => context.showTrust(options), refresh(value) { language = value; display.refresh({ querySelectorAll: () => [...elements.values()].flatMap(el => [el, ...el.querySelectorAll('[data-naw-i18n-bound]')]) }); } };
}
const snapshot = () => ({ sessions: [], services: [], diagnostics: {}, appVersion: 'fixture', runtimeVersion: 'fixture' });
test('refresh opens feedback immediately, prevents duplicate reads and records only local completion', async () => {
  const f = fixture(), first = f.open();
  assert.equal(f.$('privacy-dialog').open, true); assert.equal(f.$('refresh-trust').disabled, true);
  assert.equal(f.$('refresh-trust').textContent, '正在刷新…'); assert.equal(f.$('privacy-dialog').attributes['aria-busy'], 'true');
  await f.open(); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(snapshot()); await first;
  assert.equal(f.$('refresh-trust').disabled, false); assert.equal(f.$('refresh-trust').textContent, '刷新状态');
  assert.match(f.$('trust-refresh-status').textContent, /^已刷新本机状态 · /); assert.equal(f.$('privacy-dialog').attributes['aria-busy'], undefined);
});
test('closing before a refresh returns prevents hidden contents or status from being refilled', async () => {
  const f = fixture(), work = f.open(), dialog = f.$('privacy-dialog');
  dialog.querySelectorAll().forEach(d => { d.open = true; }); dialog.scrollTop = 99;
  dialog.close(); dialog.closeEvent(); f.requests[0].resolve(snapshot()); await work;
  assert.equal(dialog.open, false); assert.equal(f.$('trust-status').children.length, 0); assert.equal(f.$('trust-refresh-status').textContent, '');
  assert.equal(dialog.scrollTop, 0); assert.ok(dialog.querySelectorAll().every(d => !d.open)); assert.equal(dialog.querySelector().textContent, '隐私与用量');
});
test('a response that arrives before the queued close event still cannot refill a closed dialog', async () => {
  const f = fixture(), work = f.open(), dialog = f.$('privacy-dialog'); dialog.close();
  f.requests[0].resolve(snapshot()); await work; assert.equal(f.$('trust-status').children.length, 0);
  dialog.closeEvent(); assert.equal(f.$('trust-refresh-status').textContent, '');
});
test('an old response or old close event cannot clear a new refresh busy state', async () => {
  const f = fixture(), old = f.open(), dialog = f.$('privacy-dialog'); dialog.close(); dialog.closeEvent();
  const fresh = f.open(); dialog.closeEvent(); // An older queued event sees that the same node is open again.
  f.requests[0].resolve(snapshot()); await old;
  assert.equal(f.$('refresh-trust').disabled, true); assert.equal(f.$('trust-refresh-status').textContent, '正在读取本机状态…');
  f.requests[1].resolve(snapshot()); await fresh; assert.equal(f.$('refresh-trust').disabled, false);
});
test('global read failure is displayed as failure and allows one explicit retry', async () => {
  const f = fixture(), work = f.open(); f.requests[0].reject(Error('Synthetic local read failure')); await work;
  assert.equal(f.$('refresh-trust').disabled, false); assert.equal(f.$('trust-refresh-status').textContent, '读取本机状态失败：Synthetic local read failure');
  const retry = f.open(); assert.equal(f.requests.length, 2); f.requests[1].resolve(snapshot()); await retry;
  assert.match(f.$('trust-refresh-status').textContent, /^已刷新本机状态 · /);
});
test('scoped usage preserves the original native report time and existing unknown reasons', async () => {
  const f = fixture(), data = snapshot(), reportedAt = 1000;
  data.sessions = [{ id: 'one', name: 'Fixture', nativeId: 'native-one', usage: { source: 'claude-session-usage', context: { window: 200, tokens: 20 }, reportedAt }, provider: 'claude' }];
  const before = structuredClone(data), work = f.open({ usageScope: { kind: 'session', id: 'one', nativeId: 'native-one', name: 'Fixture' } });
  f.requests[0].resolve(data); await work;
  assert.match(f.$('trust-status').textContent, /本机读数时间：/); assert.ok(f.$('trust-status').textContent.includes(new Date(reportedAt).toLocaleString('zh'))); assert.deepEqual(data, before);
  f.$('privacy-dialog').close(); f.$('privacy-dialog').closeEvent();
  const next = f.open(); data.sessions[0].nativeContextPending = { reason: 'fixture' }; f.requests[1].resolve(data); await next;
  assert.match(f.$('trust-status').textContent, /原生上下文待核对/); assert.match(f.$('trust-status').textContent, /原生用量未报告；不能据此判断为零。/);
});

test('locale changes during an existing privacy read keep its exact pending request and refresh state', async () => {
  const f = fixture(), work = f.open(); f.$('privacy-dialog').scrollTop = 71;
  f.refresh('en'); assert.equal(f.requests.length, 1); assert.equal(f.$('refresh-trust').disabled, true);
  assert.equal(f.$('trust-refresh-status').textContent, 'Reading local status…'); assert.equal(f.$('privacy-dialog').scrollTop, 71);
  f.requests[0].resolve(snapshot()); await work; const section = f.$('trust-status').children[0];
  assert.match(section.textContent, /Data destinations/); assert.equal(f.$('refresh-trust').textContent, 'Refresh status');
  f.refresh('zh'); assert.equal(f.$('trust-status').children[0], section); assert.equal(f.requests.length, 1); assert.match(section.textContent, /数据去向/);
});

test('usage locale repaint does not refresh native reports or rewrite model and session names', async () => {
  const f = fixture(), data = snapshot(); data.sessions = [{ id: 'A', nativeId: 'N', provider: 'codex', name: 'RAW NAME 中文', model: 'RAW MODEL 中文', usage: { total: { inputTokens: 2000, cachedInputTokens: 1000, outputTokens: 0 }, last: { inputTokens: 7, outputTokens: 0 }, modelContextWindow: 200000, reportedAt: 1000 } }];
  const before = structuredClone(data), work = f.open({ usageScope: { kind: 'session', id: 'A', nativeId: 'N', name: 'RAW NAME 中文' } }); f.requests[0].resolve(data); await work;
  const content = f.$('trust-status'), children = [...content.children]; f.refresh('en');
  assert.deepEqual(content.children, children); assert.match(content.textContent, /RAW NAME 中文/); assert.match(content.textContent, /RAW MODEL 中文/); assert.match(content.textContent, /Cumulative tokens: input 2,000/);
  assert.equal(f.requests.length, 1); assert.deepEqual(data, before);
});

test('usage repaints an owned model placeholder in place without a second report read', async () => {
  const f = fixture(), data = snapshot(), notice = locale.createNotice('notice.model.nativeDefault');
  data.sessions = [{ id: 'A', nativeId: 'N', provider: 'claude', name: 'RAW NAME 中文', model: notice.text, modelUiMessage: notice.uiMessage }];
  const before = structuredClone(data), work = f.open({ usageScope: { kind: 'session', id: 'A', nativeId: 'N', name: 'RAW NAME 中文' } });
  f.requests[0].resolve(data); await work; const content = f.$('trust-status'), children = [...content.children]; f.refresh('en');
  assert.deepEqual(content.children, children); assert.match(content.textContent, /Native default/); assert.match(content.textContent, /RAW NAME 中文/);
  assert.equal(f.requests.length, 1); assert.deepEqual(data, before);
});

test('a missing room usage heading repaints the owned fallback while retaining the raw stored name', async () => {
  const f = fixture(), scope = { kind: 'room', roomId: 'missing', name: '空间资料未能读取', unavailable: true }, before = structuredClone(scope), work = f.open({ usageScope: scope });
  f.requests[0].resolve(snapshot()); await work; f.refresh('en');
  assert.equal(f.$('privacy-dialog').querySelector('h2').textContent, 'Space data unavailable · Usage');
  assert.equal(f.requests.length, 1); assert.deepEqual(scope, before);
});
