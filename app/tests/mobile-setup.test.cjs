const test = require('node:test'), assert = require('node:assert/strict');
const { bind } = require('../renderer/mobile-setup.js');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.checked = false; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  remove() { this.removed = true; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
function fixture({ pending = false, fail = false, revoked = true } = {}) {
  const root = new Element('container'), calls = [], timers = new Map(), records = [
    { id: 'session-a', nativeId: 'native-a', name: '<script>literal member</script>' },
    { id: 'session-b', nativeId: 'native-b', name: 'Original second' },
    { id: 'archived', nativeId: 'native-c', archived: true },
  ]; let at = 1000, nextTimer = 0, release;
  const api = { async mobilePairing(value) { calls.push(['pair', value]); if (pending && calls.filter(c => c[0] === 'pair').length === 1) await new Promise(resolve => { release = resolve; }); if (fail) throw Error('/PRIVATE_IPC_PATH'); return { secret: 's'.repeat(43), expiresAt: at + 120000 }; },
    async mobileRevoke() { calls.push(['revoke']); if (fail) throw Error('/PRIVATE_IPC_PATH'); return { authorizationRevoked: revoked, connectionClosed: true, committedWorkMayContinue: true }; } };
  const setup = bind({ container: root, document: { createElement: tag => new Element(tag) }, api, getSessions: () => records,
    now: () => at, setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimer(id) { timers.delete(id); } });
  const el = id => root.all().find(node => node.id === id), status = () => root.all().find(node => node.attributes.role === 'status').textContent;
  function valid() {
    el('mobile-origin').value = 'https://mobile.invalid'; el('mobile-actor').value = 'synthetic-human'; el('mobile-carrier').checked = true;
    const fields = root.all().filter(n => n.tag === 'fieldset')[0]; fields.children[1].all().find(n => n.tag === 'input').checked = true;
  }
  return { root, calls, setup, el, valid, status, records, timers, release: () => release(), advance: value => { at += value; } };
}
test('opening and closing the existing setup subsection grants nothing and leaves all scopes unselected', () => {
  const f = fixture(); f.setup.open(); assert.equal(f.root.all().filter(n => n.tag === 'fieldset')[0].children.length, 3);
  assert.ok(f.root.all().filter(n => n.tag === 'input' && n.type === 'checkbox').every(n => !n.checked));
  assert.deepEqual(f.calls, []); f.setup.close(); assert.deepEqual(f.calls, []); assert.equal(f.el('mobile-pair-link').value, '');
});
test('explicit selection binds only original session actions and the confirmed private carrier', async () => {
  const f = fixture(); f.setup.open(); f.valid();
  await f.el('mobile-prepare').listeners.click(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1], { actor: 'synthetic-human', origin: 'https://mobile.invalid', port: 0, carrierConfirmed: true, replace: false, selection: [{ sessionId: 'session-a', actions: ['read'] }] });
  assert.equal(f.el('mobile-pair-link').value, 'https://mobile.invalid/mobile/#pair=' + 's'.repeat(43)); assert.equal(f.timers.size, 1);
});
test('missing carrier check, malformed endpoint and stale native context refuse before any pairing call', async () => {
  for (const change of [f => { f.el('mobile-carrier').checked = false; }, f => { f.el('mobile-origin').value = 'http://mobile.invalid'; },
    f => { f.el('mobile-origin').value = 'https://mobile.invalid/private'; }, f => { f.records[0].nativeId = 'replaced-native'; }, f => { f.el('mobile-port').value = '80'; }]) {
    const f = fixture(); f.setup.open(); f.valid(); change(f); await f.el('mobile-prepare').listeners.click(); assert.equal(f.calls.length, 0); assert.match(f.status(), /没有创建配对/);
  }
});
test('send/answer and phone replacement require explicit independent local choices', async () => {
  const f = fixture(); f.setup.open(); f.valid();
  const fields = f.root.all().find(n => n.tag === 'fieldset'), inputs = fields.children[1].all().filter(n => n.tag === 'input'); inputs[1].checked = true; inputs[2].checked = true;
  f.el('mobile-replace').checked = true; await f.el('mobile-prepare').listeners.click();
  assert.deepEqual(f.calls[0][1].selection, [{ sessionId: 'session-a', actions: ['read', 'send', 'answer'] }]); assert.equal(f.calls[0][1].replace, true);
  const allText = f.root.all().map(n => n.textContent || '').join(' '); assert.match(allText, /待确认的交接需要重新确认/); assert.match(allText, /不含权限批准/);
});
test('closing or reopening while preparation waits suppresses the old secret without a stale automatic revoke', async () => {
  const f = fixture({ pending: true }); f.setup.open(); f.valid(); const old = f.el('mobile-prepare').listeners.click();
  f.setup.close(); f.setup.open(); f.release(); await old; assert.equal(f.el('mobile-pair-link').value, ''); assert.equal(f.timers.size, 0); assert.deepEqual(f.calls.map(c => c[0]), ['pair']);
});
test('a pairing link expires locally and is erased on close, without changing native sessions', async () => {
  const f = fixture(); f.setup.open(); f.valid(); await f.el('mobile-prepare').listeners.click();
  const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 120000); f.advance(120000); timer.fn(); assert.equal(f.el('mobile-pair-link').value, ''); assert.match(f.status(), /过期/);
  f.setup.close(); assert.equal(f.el('mobile-origin').value, ''); assert.equal(f.el('mobile-actor').value, ''); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
});
test('explicit revoke during preparation invalidates the old visible result and discloses committed-work limits', async () => {
  const f = fixture({ pending: true }); f.setup.open(); f.valid(); const old = f.el('mobile-prepare').listeners.click();
  await f.el('mobile-revoke').listeners.click(); f.release(); await old;
  assert.deepEqual(f.calls.map(c => c[0]), ['pair', 'revoke']); assert.equal(f.el('mobile-pair-link').value, ''); assert.match(f.status(), /原生工作可能继续/); assert.match(f.status(), /交接需要重新确认/);
});
test('a native identity change while preparation waits is not re-checked on screen; the stale selection cannot prepare again', async () => {
  // Stated limit: the screen checks native identity only before the call, and the request carries none.
  // The broker binds the identity it finds when it creates the pairing and later hides a changed one
  // (mobile-broker.test.cjs: "a changed native identity hides cached metadata").
  const f = fixture({ pending: true }); f.setup.open(); f.valid(); const held = f.el('mobile-prepare').listeners.click();
  f.records[0].nativeId = 'replaced-native'; f.release(); await held;
  assert.deepEqual(f.calls, [['pair', { actor: 'synthetic-human', origin: 'https://mobile.invalid', port: 0, carrierConfirmed: true, replace: false, selection: [{ sessionId: 'session-a', actions: ['read'] }] }]]);
  assert.equal(f.el('mobile-pair-link').value, 'https://mobile.invalid/mobile/#pair=' + 's'.repeat(43)); assert.equal(f.timers.size, 1);
  assert.match(f.status(), /不能据此认定手机已连接/);
  await f.el('mobile-prepare').listeners.click();
  assert.equal(f.calls.length, 1); assert.match(f.status(), /没有创建配对/); assert.equal(f.el('mobile-pair-link').value, ''); assert.equal(f.timers.size, 0);
});
test('a revoke the broker cannot confirm removes the visible link and never reports access as revoked', async () => {
  const f = fixture({ revoked: false }); f.setup.open(); f.valid(); await f.el('mobile-prepare').listeners.click();
  const link = f.el('mobile-pair-link'), box = f.root.all().find(n => n.children.includes(link));
  assert.notEqual(link.value, ''); assert.equal(box.hidden, false);
  await f.el('mobile-revoke').listeners.click();
  assert.deepEqual(f.calls.map(c => c[0]), ['pair', 'revoke']);
  assert.equal(link.value, ''); assert.equal(box.hidden, true); assert.equal(f.timers.size, 0);
  assert.equal(f.status(), '撤销未确认，请核对原会话；已写入的工作可能继续。'); assert.doesNotMatch(f.status(), /已撤销/);
});
test('IPC errors remain generic and never display local paths or success', async () => {
  const f = fixture({ fail: true }); f.setup.open(); f.valid(); await f.el('mobile-prepare').listeners.click(); assert.match(f.status(), /未确认/); assert.ok(!f.status().includes('PRIVATE_'));
  await f.el('mobile-revoke').listeners.click(); assert.match(f.status(), /未确认/); assert.ok(!f.status().includes('PRIVATE_')); assert.equal(f.el('mobile-pair-link').value, '');
});
test('the actual DSH builder includes the existing Setup slot and module before renderer, in disposable scratch only', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-ui-build-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'app/dsh'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../renderer'), path.join(root, 'app/renderer'), { recursive: true });
  for (const name of ['collaboration-spaces.cjs', 'room-mention.js', 'native-usage.js', 'room-threads.js', 'approval-policy.js', 'terminal-continuation.js', 'butler-entry-view.js', 'butler-reads-view.js', 'butler-review-policy.js', 'task-stream.js', 'ui-locale.js', 'ui-messages.js', 'dsh/bootstrap.js']) fs.copyFileSync(path.resolve(__dirname, '..', name), path.join(root, 'app', name));
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/build-ui.cjs'), path.join(root, 'scripts/build-ui.cjs'));
  fs.symlinkSync(path.resolve(__dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  const result = execFileSync(process.execPath, ['--max-old-space-size=64', path.join(root, 'scripts/build-ui.cjs')], { timeout: 5000, encoding: 'utf8', maxBuffer: 65536 });
  assert.match(result, /Built DSH native-workspace client plugin/);
  const built = fs.readFileSync(path.join(root, 'app/dsh/client.js'), 'utf8'); assert.ok(built.includes('mobile-prepare')); assert.ok(built.includes('mobile-setup'));
  const html = fs.readFileSync(path.resolve(__dirname, '../renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('src="mobile-setup.js"') < html.indexOf('src="renderer.js"'));
  const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer/renderer.js'), 'utf8'); assert.match(renderer, /mobileSetup\.open\(\)/); assert.match(renderer, /mobileSetup\.close\(\)/); assert.match(renderer, /mobileSetup\.dispose\(\)/);
});
