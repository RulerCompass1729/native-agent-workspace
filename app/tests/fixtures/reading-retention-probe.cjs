// Run in an --expose-gc subprocess. The normal source and in-memory negative
// controls retain actual row callbacks, never a copy of messageList's logic.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
assert.equal(typeof global.gc, 'function');
const readingFile = path.resolve(process.argv[2] || path.join(__dirname, '../../renderer/reading-list.js'));
const helperFile = path.join(__dirname, '../reading-locale.test.cjs'), helperRequire = createRequire(helperFile);
const helper = fs.readFileSync(helperFile, 'utf8'), boundary = helper.indexOf('\ntest(');
assert.ok(boundary > 0);
const source = fs.readFileSync(readingFile, 'utf8'), anchor = 'const messageName = () => {';
assert.ok(source.includes(anchor));
const turn = () => new Promise(resolve => setImmediate(resolve));
globalThis.liveReadingFixtures = [];
function fixture(mode) {
  const body = mode === 'normal' ? source : source.replace(anchor, () => anchor + '\n      if (globalThis.retentionProbe) return ' +
    ({ session: 'session.name', messages: 'messages.length', context: 'context.extra' }[mode]) + ';');
  const localFS = { ...fs, readFileSync(file, ...args) {
    return path.resolve(file) === path.join(__dirname, '../../renderer/reading-list.js') ? body : fs.readFileSync(file, ...args);
  } };
  const localRequire = name => name === 'node:fs' ? localFS : helperRequire(name);
  const create = vm.compileFunction(helper.slice(0, boundary) + '\nreturn fixture;', ['require', '__dirname'])(localRequire, path.dirname(helperFile));
  return create([]); // The helper's own current() must not own a probe history.
}
function draw(f) {
  const messages = Array.from({ length: 100 }, (_, i) => ({ id: 'history-' + i, role: 'assistant', text: 'Original history ' + i + ' body '.repeat(256), status: 'complete' }));
  const session = { id: 'session-A', nativeId: 'native-A', name: 'Same reader', provider: 'codex', messages };
  const context = { session, extra: messages };
  f.context.messageList(f.root, messages, false, session.id, context);
  return { session: new WeakRef(session), original: new WeakRef(messages), filtered: new WeakRef(f.view.pageData.messages), context: new WeakRef(context) };
}
(async () => {
  const result = {};
  for (const mode of ['normal', 'session', 'messages', 'context']) {
    const f = fixture(mode), old = draw(f); draw(f);
    globalThis.liveReadingFixtures.push(f);
    assert.equal(f.view.entries.size, 50, 'Keep a real current page and its callbacks alive');
    await turn();
    for (let n = 0; n < 8; n++) { global.gc(); await turn(); }
    // Dereference only after all collection turns; each deref pins its target
    // for the current job and would invalidate repeated collection attempts.
    result[mode] = { rows: f.view.entries.size, retained: Object.fromEntries(Object.entries(old).map(([key, ref]) => [key, Boolean(ref.deref())])) };
  }
  process.stdout.write(JSON.stringify(result));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
