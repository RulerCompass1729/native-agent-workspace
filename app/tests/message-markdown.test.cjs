const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
const component = bootstrap.slice(bootstrap.indexOf('function MessageMarkdown('), bootstrap.indexOf('\n        const ui ='));
function harness() {
  let cursor = 0, effects = [], hooks = [];
  const states = [], calls = [], Provider = Symbol('provider'), Markdown = Symbol('markdown');
  let language = 'zh';
  const locale = require('../ui-locale.js');
  const React = {
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useRef(value) { const index = cursor++; return hooks[index] ||= { current: value }; },
    useState(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = value; return [hooks[index], next => { hooks[index] = next; states.push(next); }]; },
    useEffect(effect, deps) { const index = cursor++, prior = hooks[index]; if (!prior || !deps || deps.some((x, n) => x !== prior.deps[n])) { prior?.cleanup?.(); hooks[index] = { deps: deps || [] }; effects.push(() => { hooks[index].cleanup = effect(); }); } },
    useLayoutEffect(effect, deps) { return this.useEffect(effect, deps); },
  };
  const window = { nativeWorkspaceLocale: locale, workspace: { openMessageFile: (...args) => { calls.push(args); return Promise.resolve({ accepted: true, lineNavigation: false }); }, openExternal: () => Promise.resolve() } };
  class Element {}
  const renderComponent = vm.runInNewContext(`(${component})`, { React, window, MarkdownDelegateProvider: Provider, MarkdownText: Markdown, Element, ui: {}, errorText: error => locale.errorText(language, error), subscribeLocale: () => () => {}, localeSnapshot: () => ({ active: language }), t: (key, params) => locale.format(language, key, params) });
  const find = (tree, type) => tree?.type === type ? tree : tree?.children?.map(child => find(child, type)).find(Boolean);
  return { calls, states, window, Element, setLanguage(value) { language = value; }, render(source, text = '[Report](report.md)') { cursor = 0; effects = []; const tree = renderComponent({ text, streaming: false, source }); for (const effect of effects) effect(); return { tree, delegate: find(tree, Provider).props, markdown: find(tree, Markdown).props }; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const source = id => ({ kind: 'session', sessionId: id, messageId: 'reply', nativeId: 'native-' + id, cwd: '/example/' + id });

test('the actual pinned DSH file renderer receives an opener and retains its target', () => {
  const h = harness(), { delegate } = h.render(source('a'));
  const bundle = fs.readFileSync(require.resolve('@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js'), 'utf8');
  const begin = bundle.indexOf('function iU('), end = bundle.indexOf('function oU(', begin);
  assert.ok(begin > 0 && end > begin, 'Requalify the pinned DSH FileLink probe when upgrading');
  const jsx = (type, props) => ({ type, props });
  const render = vm.runInNewContext(`(${bundle.slice(begin, end)})`, { f4: () => delegate, u: { jsx, jsxs: jsx, Fragment: 'fragment' }, St: { fileMention: 'mention', fileLink: 'file' }, de: (...parts) => parts.join(' ') });
  const link = render({ file: { path: 'report.md' }, glyph: false, children: 'Report' });
  assert.equal(link.type, 'button');
  assert.equal(link.props.title, 'report.md');
  assert.equal(h.calls.length, 0, 'Rendering does not open or read a file');
});
test('an explicit file activation carries its original message source, not the latest render', async () => {
  const h = harness(), first = h.render(source('a'));
  first.delegate.openFile('report.md');
  h.render(source('b'));
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0].sessionId, 'a');
  assert.equal(h.calls[0][0].cwd, '/example/a');
  assert.equal(h.calls[0][1], 'report.md');
});
test('duplicate activation is bounded and failure is contained in the originating message', async () => {
  const h = harness(); let reject;
  h.window.workspace.openMessageFile = (...args) => { h.calls.push(args); return new Promise((_resolve, fail) => { reject = fail; }); };
  const first = h.render(source('a')); first.delegate.openFile('report.md'); first.delegate.openFile('report.md');
  await flush(); assert.equal(h.calls.length, 1);
  h.render(source('b')); const length = h.states.length;
  reject(Error('OLD SOURCE FAILURE')); await flush();
  assert.ok(!h.states.slice(length).some(value => typeof value === 'string' && value.includes('OLD SOURCE FAILURE')));
});
test('a current failure is visible and HTTP hover exposes the actual full URL', async () => {
  const h = harness(); h.window.workspace.openMessageFile = () => Promise.reject(Error('Missing file'));
  const current = h.render(source('a')); current.delegate.openFile('missing.md'); await flush();
  assert.ok(h.states.some(value => value?.error?.message === 'Missing file'));
  assert.ok(h.render(source('a')).tree.children.some(child => child?.props?.role === 'status' && child.children[0].includes('Missing file')));
  const anchor = { title: '', getAttribute: () => 'https://example.com/full/path?q=1' };
  const target = new h.Element(); target.closest = () => anchor;
  const event = { target, currentTarget: { contains: () => true } };
  current.tree.props.onMouseOverCapture(event);
  assert.equal(anchor.title, 'https://example.com/full/path?q=1');
});
test('returning to the same message does not let an older request overwrite a newer request', async () => {
  const h=harness(), pending=[];
  h.window.workspace.openMessageFile=(...args)=>new Promise((resolve,reject)=>{h.calls.push(args);pending.push({resolve,reject});});
  h.render(source('a')).delegate.openFile('old.md');await flush();
  h.render(source('b'));h.render(source('a')).delegate.openFile('new.md');await flush();
  const length=h.states.length;pending[0].reject(Error('STALE SAME SOURCE'));await flush();
  assert.ok(!h.states.slice(length).some(value=>value===false||typeof value==='string'&&value.includes('STALE SAME SOURCE')));
  pending[1].resolve({accepted:true,lineNavigation:false});await flush();
  assert.equal(h.states.at(-1),false);
});
test('an unconfirmed system receipt and typed file failure repaint without repeating either open action', async () => {
  for (const kind of ['unconfirmed', 'typed']) {
    const h = harness(), original = 'RAW 中文 [report](report.md)', own = require('../ui-locale.js').createError('error.files.missing');
    h.window.workspace.openMessageFile = (...args) => { h.calls.push(args); return kind === 'unconfirmed' ? Promise.resolve(undefined) : Promise.reject(own); };
    h.render(source('a'), original).delegate.openFile('report.md'); await flush();
    const status = () => h.render(source('a'), original).tree.children.find(child => child?.props?.role === 'status').children[0];
    assert.match(status(), kind === 'unconfirmed' ? /系统打开结果未确认/ : /文件/);
    h.setLanguage('en'); assert.equal(status(), 'Could not open file: ' + (kind === 'unconfirmed' ? 'The system open result was not confirmed. Check the system window first.' : require('../ui-locale.js').errorText('en', own)));
    assert.equal(h.render(source('a'), original).markdown.text, original); assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0].nativeId, 'native-a');
    h.setLanguage('zh'); assert.match(status(), /无法打开文件/); assert.equal(h.calls.length, 1);
  }
});
test('the actual reading render updates a cached row when its message source changes', () => {
  const sourceText=fs.readFileSync(path.join(__dirname,'../renderer/reading-list.js'),'utf8');
  const start=sourceText.indexOf('    const displayText = '), end=sourceText.indexOf('    const footer = readingTurnFooter(m);',start);
  assert.ok(start>=0 && end>start,'Keep the file-origin probe on the actual Markdown rendering block');
  const owned = sourceText.slice(sourceText.indexOf('function readingOwnMessage('), sourceText.indexOf('function readingOwnText('));
  const block=owned+'{'+sourceText.slice(start,end)+'}';
  const entry={body:{}},calls=[],a={id:'a',nativeId:'native-a',cwd:'/example/a'},b={id:'b',nativeId:'native-b',cwd:'/example/b'};
  const context={entry,wakeBody:false,room:false,session:a,state:{sessions:[a,b]},m:{id:'same-row',role:'assistant',text:'[Report](report.md)',status:'complete',nativeId:'native-a'},nativeCompletionText:m=>m.text,ui:{display:{unbind(){}},markdown:(...args)=>calls.push(args),clearMarkdown(){}},view:{key:'view'},key:'view',scheduleReading(){}};
  vm.runInNewContext(block,context);
  context.session=b;context.m={...context.m,nativeId:'native-b'};vm.runInNewContext(block,context);
  context.room=true;context.session=null;context.m={...context.m,sessionId:'a',nativeId:'native-a'};vm.runInNewContext(block,context);
  assert.equal(calls.length,3);
  assert.equal(calls[0][4].sessionId,'a');assert.equal(calls[1][4].sessionId,'b');
  assert.equal(calls[2][4].kind,'room');assert.equal(calls[2][4].cwd,'/example/a');
  a.nativeId='new-native';a.cwd='/example/new-a';a.nativeContexts=[{nativeId:'native-a'}];
  context.m={...context.m,nativeId:'native-a'};vm.runInNewContext(block,context);
  assert.equal(calls.at(-1)[4].cwd,null,'An old shared row never borrows the new native context cwd');
  context.room=false;context.session=a;vm.runInNewContext(block,context);
  assert.equal(calls.at(-1)[4].cwd,null,'The same historical source guard applies to solo replies');
  let changes=0;context.m={id:'plain-tool',role:'tool',text:'ORIGINAL TOOL TEXT',status:'complete'};context.entry={body:{set textContent(value){changes++;}}};context.room=false;context.session=a;
  vm.runInNewContext(block,context);context.session=b;vm.runInNewContext(block,context);
  assert.equal(changes,1,'Plain native text is not replaced on file-origin metadata changes');
});

test('language updates only Markdown controls and keep the exact original body and pending file identity', async () => {
  const h = harness(), original = '<native> 中文 English {name}\n[Report](report.md)';
  let reject;
  h.window.workspace.openMessageFile = (...args) => { h.calls.push(args); return new Promise((_resolve, fail) => { reject = fail; }); };
  const first = h.render(source('a'), original);
  first.delegate.openFile('report.md'); await flush();
  assert.equal(first.markdown.text, original);
  assert.equal(first.markdown.labels.code.copyLabel, '复制');
  h.setLanguage('en');
  const translated = h.render(source('a'), original);
  assert.equal(translated.markdown.text, original);
  assert.equal(translated.markdown.labels.code.copyLabel, 'Copy');
  assert.equal(h.calls.length, 1);
  reject(Error('ORIGINAL ERROR 中文 {error}')); await flush();
  const failed = h.render(source('a'), original);
  const paragraph = failed.tree.children.find(child => child?.props?.role === 'status');
  assert.equal(paragraph.children[0], 'Could not open file: ORIGINAL ERROR 中文 {error}');
  assert.equal(failed.markdown.text, original);
  assert.equal(h.calls[0][0].sessionId, 'a');
  assert.equal(h.calls.length, 1, 'Language changes cannot repeat a file action');
});
