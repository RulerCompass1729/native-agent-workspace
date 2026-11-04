const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const bootstrap = fs.readFileSync(require.resolve('../dsh/bootstrap.js'), 'utf8');
const a = bootstrap.indexOf('    function createDisplayBindings('), b = bootstrap.indexOf('    function mountWorkspace(', a);
assert.ok(a >= 0 && b > a);
const createBindings = vm.runInNewContext('(' + bootstrap.slice(a, b).trim() + ')');
class Element {
  constructor(tag, text = '', cls = '') { this.tagName = tag; this.content = text; this.className = cls; this.children = []; this.attrs = new Map(); this.dataset = {}; this.value = ''; this.isConnected = true; this.open = false; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { const list = this.parentElement?.children || []; return list[list.indexOf(this) + 1] || null; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.replaceChildren(); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  hasAttribute(key) { return this.attrs.has(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) { node.remove(); node.parentElement = this; const index = before ? this.children.indexOf(before) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; } }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const cls = selector.startsWith(':scope > .') ? selector.slice(10) : null;
    const matches = node => cls ? node.className.split(' ').includes(cls) : selector === '[data-naw-i18n-bound]' ? node.hasAttribute('data-naw-i18n-bound') : selector === 'input[type="radio"]' ? node.tagName === 'input' && node.type === 'radio' : false;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...(cls ? [] : child.querySelectorAll(selector))]);
  }
  addEventListener(name, fn) { if (name === 'click') this.onclick = fn; }
  click() { return this.onclick?.(); }
}
function fixture() {
  let language = 'zh'; const root = new Element('div'), calls = [];
  const node = (tag, text, cls) => new Element(tag, text, cls), uiText = (key, params) => locale.format(language, key, params), display = createBindings(uiText);
  const context = vm.createContext({ uiText, ui: { display, displayText: (raw, message) => locale.displayText(language, raw, message) }, node, document: { createElement: tag => node(tag) }, button: (text, onclick, cls) => Object.assign(node('button', text, cls), { onclick }), operateNative: id => calls.push(['native', id]) });
  vm.runInContext(renderer.slice(renderer.indexOf('const uiNode ='), renderer.indexOf('const states =')), context);
  vm.runInContext(renderer.slice(renderer.indexOf('function appendNativeQuestions('), renderer.indexOf('function renderAdvanced(')), context);
  context.root = root;
  return { root, calls, context, render: session => { context.session = session; vm.runInContext('renderNativeOnlyApproval(root, session, false)', context); }, refresh(value) { language = value; display.refresh(root); } };
}
const walk = root => root.children.flatMap(child => [child, ...walk(child)]);
test('open native-only cards keep receipt nodes, expanded raw bodies and selection while own labels repaint', () => {
  const f = fixture(), input = ' {"file_path":"RAW 中文.txt","old_string":"OLD 中文\\n  raw","new_string":"NEW 中文\\n  raw","replace_all":true} ';
  const session = { id: 'original-session', nativeId: 'original-native', name: 'RAW AGENT 中文', nativeApproval: { requests: [{ id: 'original-request', turnId: 'original-turn', title: 'Edit', input }] } };
  const before = structuredClone(session); f.render(session);
  const row = f.root.children[0]; row.open = true; const original = walk(row).find(node => node.className === 'native-approval-original'); original.open = true;
  const body = original.children[1], selection = { anchorNode: body, anchorOffset: 3, focusOffset: 19 }; f.context.selection = selection;
  f.refresh('en');
  assert.equal(f.root.children[0], row); assert.equal(row.open, true); assert.equal(original.open, true); assert.equal(original.children[1], body); assert.equal(body.textContent, input);
  assert.equal(selection.anchorNode, body); assert.equal(selection.anchorOffset, 3); assert.match(row.textContent, /Awaiting approval/); assert.match(row.textContent, /All matches/); assert.match(row.textContent, /Full original request/);
  assert.match(row.firstChild.getAttribute('aria-label'), /RAW AGENT 中文 · Awaiting your approval · Edit RAW 中文.txt/);
  assert.equal(walk(f.root).filter(node => node.tagName === 'button').length, 1, 'Native-only requests offer only the existing terminal action');
  assert.deepEqual(session, before); assert.deepEqual(f.calls, []);
  f.render(session); assert.equal(f.root.children[0], row, 'An unchanged source request keeps its exact existing details node');
  session.nativeApproval.requests = []; f.render(session); assert.equal(f.root.hidden, true); assert.equal(f.root.children.length, 0);
});

test('native answer choices, draft, checked state and submit callback retain original data across locale', () => {
  const f = fixture(), questions = [{ id: 'question-original', header: 'RAW 问题', question: 'ORIGINAL question 中文?', isOther: true, options: [{ label: 'RAW 选项', description: 'ORIGINAL description 中文' }] }];
  f.context.questions = questions; f.context.answers = null; vm.runInContext('appendQuestionForm(root, questions, false, value => { answers = value; })', f.context);
  const all = walk(f.root), radio = all.find(node => node.type === 'radio'), other = all.find(node => node.type === 'text'), send = all.find(node => node.tagName === 'button');
  other.value = 'UNSENT answer 中文'; other.oninput(); const callback = send.onclick; f.refresh('en');
  assert.equal(other.value, 'UNSENT answer 中文'); assert.equal(radio.value, 'RAW 选项'); assert.equal(send.onclick, callback); assert.equal(other.getAttribute('placeholder'), 'Other…'); assert.equal(other.getAttribute('aria-label'), 'RAW 问题: Other…');
  send.click(); assert.deepEqual(JSON.parse(JSON.stringify(f.context.answers)), { 'question-original': ['UNSENT answer 中文'] }); assert.deepEqual(f.calls, []);
});

test('unknown native tools and incomplete request bodies stay raw while only their warning changes language', () => {
  const f = fixture(), raw = 'ORIGINAL 未知请求 <body> {approval.nativeRequest}';
  f.render({ id: 'A', nativeId: 'N', name: 'RAW', nativeApproval: { requests: [{ id: 'R', title: 'NativeUnrecognized', input: raw, incomplete: true }] } });
  f.refresh('en'); const pre = walk(f.root).find(node => node.tagName === 'pre'); assert.equal(pre.textContent, raw); assert.match(f.root.textContent, /Content not fully synchronized/); assert.match(f.root.textContent, /NativeUnrecognized/); assert.deepEqual(f.calls, []);
});

test('the existing DSH menu label child observes locale without recreating menu actions', () => {
  let language = 'zh', subscriptions = 0; const from = bootstrap.indexOf('        function MenuMessage('), to = bootstrap.indexOf('        let mounted =', from); assert.ok(from >= 0 && to > from);
  const context = vm.createContext({ React: { useSyncExternalStore(subscribe, read) { subscriptions++; return read(); } }, subscribeLocale() {}, localeSnapshot: () => ({ active: language }), t: (key, params) => locale.format(language, key, params) });
  vm.runInContext(bootstrap.slice(from, to), context);
  const run = () => {}, item = { id: 'original-action', labelKey: 'menu.joinSpace', labelParams: { name: 'RAW SPACE 中文' }, disabled: false, run };
  context.item = item; assert.equal(vm.runInContext('MenuMessage({item})', context), '加入「RAW SPACE 中文」'); language = 'en'; assert.equal(vm.runInContext('MenuMessage({item})', context), 'Join “RAW SPACE 中文”');
  assert.equal(item.run, run); assert.equal(item.disabled, false); assert.equal(item.id, 'original-action'); assert.equal(subscriptions, 2);
});


test('owned ambiguity reason repaints both selected detail and pending option while a native reason with identical text stays raw', () => {
  const f = fixture(), own = locale.createNotice('notice.nativeConfirm.ambiguous'), raw = { requestId: 'native-raw', method: 'item/commandExecution/requestApproval', params: { reason: own.text, command: '', cwd: '/synthetic' } }, request = { requestId: 'owned', method: 'native/requestAmbiguous', params: { reason: own.text, reasonUiMessage: own.uiMessage } };
  f.root.classList = { toggle() {} }; Object.assign(f.context, { $: id => { assert.equal(id, 'approval'); return f.root; }, approvalViews: new Map(), nativeStatusFresh: () => true, window: { nativeWorkspaceApproval: require('../approval-policy.js') } });
  const session = { id: 's', nativeId: 'native-s', name: 'RAW NAME 中文', state: 'approval', approval: request, approvals: [request, raw] }, before = JSON.stringify(session);
  f.context.renderApproval(session, true); const select = walk(f.root).find(el => el.id === 'approval-request'); assert.ok(select); f.refresh('en');
  assert.ok(select.children[0].textContent.includes(locale.format('en', 'notice.nativeConfirm.ambiguous'))); assert.ok(select.children[1].textContent.includes(own.text));
  assert.ok(f.root.textContent.includes(locale.format('en', 'notice.nativeConfirm.ambiguous'))); assert.equal(JSON.stringify(session), before); assert.deepEqual(f.calls, []);
});
