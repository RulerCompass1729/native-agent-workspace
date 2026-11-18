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
const rowsOf = root => root.all().filter(n => n.className === 'mobile-session');
const inputsOf = row => row.all().filter(n => n.tag === 'input');
// A person's click: the box changes, then its change listener runs.
function tick(input, checked = true) { input.checked = checked; input.listeners.change?.(); }
function fixture({ pending = false, fail = false, revoked = true, records: given, rooms = [], saved = null, approval = null } = {}) {
  const root = new Element('container'), calls = [], timers = new Map(), remembered = [], records = given || [
    { id: 'session-a', nativeId: 'native-a', name: '<script>literal member</script>' },
    { id: 'session-b', nativeId: 'native-b', name: 'Original second' },
    { id: 'archived', nativeId: 'native-c', archived: true },
  ]; let at = 1000, nextTimer = 0, release;
  const api = { async mobilePairing(value) { calls.push(['pair', value]); if (pending && calls.filter(c => c[0] === 'pair').length === 1) await new Promise(resolve => { release = resolve; }); if (fail) throw Error('/PRIVATE_IPC_PATH'); return { secret: 's'.repeat(43), expiresAt: at + 120000 }; },
    async mobileRevoke() { calls.push(['revoke']); if (fail) throw Error('/PRIVATE_IPC_PATH'); return { authorizationRevoked: revoked, connectionClosed: true, committedWorkMayContinue: true }; } };
  if (approval) api.mobileApprovalStatus = async () => approval;
  const setup = bind({ container: root, document: { createElement: tag => new Element(tag) }, api, getSessions: () => records, getRooms: () => rooms,
    remembered: () => saved, remember: value => { remembered.push(value); saved = value; },
    now: () => at, setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimer(id) { timers.delete(id); } });
  const el = id => root.all().find(node => node.id === id), status = () => root.all().find(node => node.attributes.role === 'status').textContent;
  function valid() {
    el('mobile-origin').value = 'https://mobile.invalid'; el('mobile-actor').value = 'synthetic-human'; el('mobile-carrier').checked = true;
    tick(inputsOf(rowsOf(root)[0])[0]);
  }
  return { root, calls, setup, el, valid, status, records, timers, remembered, rows: () => rowsOf(root), release: () => release(), advance: value => { at += value; } };
}
test('opening and closing the existing setup subsection grants nothing and leaves all scopes unselected', () => {
  const f = fixture(); f.setup.open(); assert.equal(f.rows().length, 2);
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
  const inputs = inputsOf(f.rows()[0]); tick(inputs[1]); tick(inputs[2]);
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
  for (const name of ['collaboration-spaces.cjs', 'room-mention.js', 'native-usage.js', 'room-threads.js', 'approval-policy.js', 'terminal-continuation.js', 'butler-entry-view.js', 'butler-reads-view.js', 'butler-review-policy.js', 'task-stream.js', 'mobile-identity.js', 'ui-locale.js', 'ui-messages.js', 'dsh/bootstrap.js']) fs.copyFileSync(path.resolve(__dirname, '..', name), path.join(root, 'app', name));
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/build-ui.cjs'), path.join(root, 'scripts/build-ui.cjs'));
  fs.symlinkSync(path.resolve(__dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  const result = execFileSync(process.execPath, ['--max-old-space-size=64', path.join(root, 'scripts/build-ui.cjs')], { timeout: 5000, encoding: 'utf8', maxBuffer: 65536 });
  assert.match(result, /Built DSH native-workspace client plugin/);
  const built = fs.readFileSync(path.join(root, 'app/dsh/client.js'), 'utf8'); assert.ok(built.includes('mobile-prepare')); assert.ok(built.includes('mobile-setup'));
  const html = fs.readFileSync(path.resolve(__dirname, '../renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('src="mobile-setup.js"') < html.indexOf('src="renderer.js"'));
  const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer/renderer.js'), 'utf8'); assert.match(renderer, /mobileSetup\.open\(\)/); assert.match(renderer, /mobileSetup\.close\(\)/); assert.match(renderer, /mobileSetup\.dispose\(\)/);
});

// About 90 sessions, as in the person's report. Synthetic names only.
function many() {
  const records = Array.from({ length: 90 }, (_, i) => ({ id: `synthetic-${String(i).padStart(3, '0')}`, nativeId: `native-${i}`, name: `Synthetic member ${i}` }));
  records.splice(57, 0, { id: 'q07-session', nativeId: 'native-q07', name: 'Q07 合成验收' });
  return records;
}
const visible = f => f.rows().filter(row => !row.hidden);
const rowName = row => row.all().find(n => n.tag === 'span').textContent;
test('typing Q07 then ticking its box selects only that session, and the request matches the earlier format exactly', async () => {
  const f = fixture({ records: many(), rooms: [{ id: 'room-a', name: 'Synthetic space' }, { id: 'room-b', name: 'Other space', archived: true }] });
  f.setup.open(); assert.equal(f.rows().length, 91);
  const search = f.el('mobile-session-filter'); search.value = 'q07'; search.listeners.input();
  assert.deepEqual(visible(f).map(rowName), ['Q07 合成验收 · q07-se']);
  tick(inputsOf(visible(f)[0])[0]);
  f.el('mobile-origin').value = 'https://mobile.invalid'; f.el('mobile-actor').value = 'synthetic-human'; f.el('mobile-carrier').checked = true;
  await f.el('mobile-prepare').listeners.click();
  assert.deepEqual(f.calls[0][1], { actor: 'synthetic-human', origin: 'https://mobile.invalid', port: 0, carrierConfirmed: true, replace: false, selection: [{ sessionId: 'q07-session', actions: ['read'] }] });
  // A granted space and record reminders add the same workspace field as before.
  const space = f.root.all().find(n => n.className === 'mobile-spaces').all().find(n => n.tag === 'input'); tick(space); tick(f.el('mobile-records'));
  const actions = inputsOf(visible(f)[0]); tick(actions[1]);
  await f.el('mobile-prepare').listeners.click();
  assert.deepEqual(f.calls[1][1], { actor: 'synthetic-human', origin: 'https://mobile.invalid', port: 0, carrierConfirmed: true, replace: false,
    workspace: { roomIds: ['room-a'], records: true }, selection: [{ sessionId: 'q07-session', actions: ['read', 'send'] }] });
});
test('chosen sessions are listed first and stay visible while another search hides the rest', () => {
  const f = fixture({ records: many() }); f.setup.open();
  const search = f.el('mobile-session-filter'); search.value = 'Q07'; search.listeners.input(); tick(inputsOf(visible(f)[0])[0]);
  search.value = ''; search.listeners.input();
  assert.equal(rowName(f.rows()[0]), 'Q07 合成验收 · q07-se'); assert.equal(visible(f).length, 91);
  search.value = 'no such member'; search.listeners.input();
  assert.deepEqual(visible(f).map(rowName), ['Q07 合成验收 · q07-se']);
  assert.equal(f.root.all().find(n => n.className === 'quiet mobile-count').textContent, '已选 1 个，共 91 个');
  const noMatch = f.root.all().find(n => n.textContent === '没有匹配的会话'); assert.equal(noMatch.hidden, true);
  tick(inputsOf(f.rows()[0])[0], false); search.listeners.input(); assert.equal(visible(f).length, 0); assert.equal(noMatch.hidden, false);
});
test('send and answer choices appear only for a chosen session, and unticking it clears them', () => {
  const f = fixture(); f.setup.open();
  const row = f.rows()[0], actions = row.all().find(n => n.className === 'mobile-session-actions'), [read, send, answer] = inputsOf(row);
  assert.equal(actions.hidden, true); tick(read); assert.equal(actions.hidden, false);
  tick(send); tick(answer); tick(read, false);
  assert.equal(actions.hidden, true); assert.equal(send.checked, false); assert.equal(answer.checked, false);
});
test('every checkbox comes before its own words inside one label', () => {
  const f = fixture({ rooms: [{ id: 'room-a', name: 'Synthetic space' }] }); f.setup.open();
  const boxes = f.root.all().filter(n => n.tag === 'input' && n.type === 'checkbox'); assert.equal(boxes.length, 2 * 3 + 1 + 3 + 2);
  for (const box of boxes) {
    const label = f.root.all().find(n => n.children.includes(box));
    assert.equal(label.tag, 'label'); assert.equal(label.className, 'mobile-check'); assert.equal(label.children[0], box); assert.equal(label.children.length, 2);
  }
});
test('address, Tailscale user and port are remembered after a checked attempt; secrets, links and choices are not', async () => {
  const f = fixture(); f.setup.open(); assert.equal(f.el('mobile-origin').value, '');
  await f.el('mobile-prepare').listeners.click(); assert.deepEqual(f.remembered, []);
  f.valid(); f.el('mobile-port').value = '8443'; await f.el('mobile-prepare').listeners.click();
  assert.deepEqual(f.remembered, [{ origin: 'https://mobile.invalid', actor: 'synthetic-human', port: '8443' }]);
  f.setup.close(); assert.equal(f.el('mobile-origin').value, ''); assert.equal(f.el('mobile-port').value, '0');
  f.setup.open();
  assert.equal(f.el('mobile-origin').value, 'https://mobile.invalid'); assert.equal(f.el('mobile-actor').value, 'synthetic-human'); assert.equal(f.el('mobile-port').value, '8443');
  assert.equal(f.el('mobile-carrier').checked, false); assert.ok(f.rows().every(row => inputsOf(row).every(input => !input.checked)));
});
test('sensitive approvals start folded on every opening', () => {
  const f = fixture(); f.setup.open(); const section = f.el('mobile-approval-section');
  assert.equal(section.tag, 'details'); assert.equal(section.open, false); assert.equal(section.children[0].tag, 'summary');
  section.open = true; f.setup.close(); f.setup.open(); assert.equal(section.open, false);
});
test('advanced setup starts folded and folding it changes no choices or pairing payload', async () => {
  const f = fixture({ rooms: [{ id: 'room-a', name: 'Synthetic space' }] }); f.setup.open();
  const advanced = f.el('mobile-advanced'); assert.ok(advanced); assert.equal(advanced.tag, 'details'); assert.equal(advanced.open, false);
  assert.equal(f.el('mobile-advanced-title').textContent, '高级设置');
  assert.equal(f.el('mobile-port').value, '0');
  assert.ok(advanced.all().filter(n => n.type === 'checkbox').every(n => !n.checked));
  advanced.open = true; advanced.open = false; f.valid(); await f.el('mobile-prepare').listeners.click();
  assert.deepEqual(f.calls[0][1], { actor: 'synthetic-human', origin: 'https://mobile.invalid', port: 0, carrierConfirmed: true, replace: false, selection: [{ sessionId: 'session-a', actions: ['read'] }] });
  advanced.open = true; f.setup.close(); f.setup.open(); assert.equal(advanced.open, false);
});
test('only a valid remembered endpoint is summarized and Edit reveals its unchanged values', () => {
  const saved = { origin: 'https://device.example.invalid', actor: 'synthetic-human', port: '0' };
  const f = fixture({ saved }); f.setup.open();
  assert.equal(f.el('mobile-connection-summary').hidden, false); assert.equal(f.el('mobile-connection-fields').hidden, true);
  assert.equal(f.el('mobile-endpoint-host').textContent, 'device.example.invalid'); assert.equal(f.el('mobile-endpoint-actor').textContent, saved.actor); assert.equal(f.el('mobile-endpoint-port').textContent, '端口自动');
  f.el('mobile-edit-connection').listeners.click();
  assert.equal(f.el('mobile-connection-summary').hidden, true); assert.equal(f.el('mobile-connection-fields').hidden, false);
  assert.deepEqual(['mobile-origin', 'mobile-actor', 'mobile-port'].map(id => f.el(id).value), [saved.origin, saved.actor, saved.port]);
  for (const endpoint of [null, { ...saved, origin: 'http://device.example.invalid' }, { ...saved, port: '80' }]) {
    const other = fixture({ saved: endpoint }); other.setup.open();
    assert.equal(other.el('mobile-connection-summary').hidden, true); assert.equal(other.el('mobile-connection-fields').hidden, false);
  }
});
test('folded advanced setup exposes each nondefault choice in its count', () => {
  const f = fixture({ rooms: [{ id: 'room-a', name: 'Synthetic space' }] }); f.setup.open();
  const title = f.el('mobile-advanced-title'), advanced = f.el('mobile-advanced');
  tick(f.el('mobile-records')); assert.equal(title.textContent, '高级设置（已开 1 项）');
  tick(f.el('mobile-replace')); f.el('mobile-port').value = '43125'; f.el('mobile-port').listeners.input();
  tick(f.root.all().find(n => n.className === 'mobile-spaces').all().find(n => n.tag === 'input'));
  assert.equal(title.textContent, '高级设置（已开 4 项）'); assert.equal(advanced.open, false);
  f.setup.close(); f.setup.open(); assert.equal(title.textContent, '高级设置');
  const remembered = fixture({ saved: { origin: 'https://device.example.invalid', actor: 'synthetic-human', port: '43125' } }); remembered.setup.open();
  assert.equal(remembered.el('mobile-advanced-title').textContent, '高级设置（已开 1 项）'); assert.equal(remembered.el('mobile-advanced').open, false);
  assert.equal(remembered.el('mobile-endpoint-port').textContent, '端口 43125');
});
test('an unconfirmed pairing points to the explicit replacement choice in advanced setup', async () => {
  const f = fixture({ fail: true }); f.setup.open(); f.valid(); await f.el('mobile-prepare').listeners.click();
  assert.match(f.status(), /高级设置/); assert.match(f.status(), /替换/);
  assert.equal(f.el('mobile-replace').checked, false); assert.equal(f.calls.length, 1);
});
test('existing sensitive registration and enabling remain visible in the folded advanced count', async () => {
  const f = fixture({ approval: { paired: true, registered: true, enabled: true } }); f.setup.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.el('mobile-advanced').open, false); assert.equal(f.el('mobile-approval-enabled').checked, true);
  assert.equal(f.el('mobile-advanced-title').textContent, '高级设置（已开 2 项）');
  assert.deepEqual(f.calls, [], 'reading existing authority never pairs, revokes or changes a grant');
});
test('the saved window view accepts only an https address, a Tailscale user and a port for phone access', () => {
  const { validViews } = require('../view-store.cjs'), base = { owner: 'synthetic-owner', selected: '', mode: 'chat' };
  const ok = { origin: 'https://device.example.invalid', actor: 'synthetic-human', port: '0' };
  assert.equal(validViews([{ ...base, mobileEndpoint: ok }]), true);
  for (const bad of [{ ...ok, secret: 's'.repeat(43) }, { ...ok, link: 'https://device.example.invalid/mobile/#pair=x' }, { ...ok, origin: 'http://device.example.invalid' },
    { ...ok, origin: 'https://device.example.invalid/path' }, { ...ok, port: '70000' }, { ...ok, port: 0 }, { ...ok, actor: 'x'.repeat(321) }, 'https://device.example.invalid'])
    assert.equal(validViews([{ ...base, mobileEndpoint: bad }]), false, JSON.stringify(bad));
});


test('B1 pasted links and malformed users are refused before remembering or pairing, even if IPC would fail', async () => {
  const link = 'https://device.example.invalid/mobile/#pair=' + 's'.repeat(43);
  for (const fail of [false, true]) for (const actor of [link, 'http://device.example.invalid', '//device.example.invalid/mobile/', '/mobile/#pair=synthetic', 'mailto:member@example.invalid', 'two users', 'user\\name', 'user\u0000name', 'user@@example.invalid', 'x'.repeat(321)]) {
    const f = fixture({ fail }); f.setup.open(); f.valid(); f.el('mobile-actor').value = actor;
    await f.el('mobile-prepare').listeners.click();
    assert.deepEqual(f.remembered, [], 'bad account must never reach remember');
    assert.deepEqual(f.calls, [], 'bad account must never reach pairing IPC');
    assert.equal(f.root.all().find(node => node.children.includes(f.el('mobile-pair-link'))).hidden, true);
    assert.match(f.status(), /这里填登录 Tailscale 的账号，不是链接/);
    assert.equal(f.status().includes(actor), false, 'error must not reflect the pasted value');
    assert.equal(f.el('mobile-actor').attributes['aria-invalid'], 'true');
    assert.equal(f.el('mobile-actor').attributes['aria-describedby'], 'mobile-status');
    f.el('mobile-actor').value = 'synthetic-human'; f.el('mobile-actor').listeners.input();
    assert.equal(f.el('mobile-actor').attributes['aria-invalid'], 'false'); assert.equal(f.status(), '');
  }
});
test('B1 legitimate usernames and emails keep their exact pairing payload and are remembered even when IPC fails', async () => {
  for (const fail of [false, true]) for (const actor of ['synthetic-human', 'member.name_2', 'member+phone@example.invalid', '_member@example.invalid', '+phone@example.invalid', "o'example@example.invalid", 'member@github', '成员@passkey']) {
    const f = fixture({ fail }); f.setup.open(); f.valid(); f.el('mobile-actor').value = '  ' + actor + '  ';
    await f.el('mobile-prepare').listeners.click();
    assert.deepEqual(f.remembered, [{ origin: 'https://mobile.invalid', actor, port: '0' }]);
    assert.deepEqual(f.calls, [['pair', { actor, origin: 'https://mobile.invalid', port: 0, carrierConfirmed: true, replace: false,
      selection: [{ sessionId: 'session-a', actions: ['read'] }] }]]);
    assert.equal(f.root.all().find(node => node.children.includes(f.el('mobile-pair-link'))).hidden, fail);
    if (fail) { assert.match(f.status(), /未确认/); assert.equal(f.status().includes('PRIVATE_IPC_PATH'), false); }
  }
});
test('B1 a bad remembered actor is not restored or summarized, and a rejected edit preserves the last good endpoint', async () => {
  const saved = { origin: 'https://device.example.invalid', actor: 'synthetic-human', port: '0' };
  const link = saved.origin + '/mobile/#pair=' + 's'.repeat(43);
  const bad = fixture({ saved: { ...saved, actor: link } }); bad.setup.open();
  assert.equal(bad.el('mobile-connection-fields').hidden, false);
  assert.equal(bad.el('mobile-connection-summary').hidden, true);
  assert.equal(bad.el('mobile-actor').value, '');
  const f = fixture({ saved, fail: true }); f.setup.open(); f.valid(); f.el('mobile-actor').value = link;
  await f.el('mobile-prepare').listeners.click(); assert.deepEqual(f.remembered, []); assert.deepEqual(f.calls, []);
  f.setup.close(); f.setup.open(); assert.equal(f.el('mobile-endpoint-actor').textContent, saved.actor);
});
