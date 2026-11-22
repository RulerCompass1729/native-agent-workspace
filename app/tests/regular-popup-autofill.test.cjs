const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const core = require('../regular-popup.cjs');
const rooms = [{ name: 'NAW 开发', queue: [{ text: '多 agent 协作' }, { text: '终端/桌面工具\nThis body must not be used' }] }];
function fixture(t) {
  let stored = null, dsh = 0, reads = 0, timers = 0;
  const store = { read: () => structuredClone(stored), write: value => stored = structuredClone(value) };
  const make = () => new core.RegularPopup({ store, permitted: true, requireAuthorization: true,
    readSource: () => { reads++; throw Error('Source must stay idle'); }, select: () => { dsh++; throw Error('DSH must stay idle'); },
    setTimer: () => ++timers, clearTimer() {} });
  const engine = make(); t.after(() => engine.dispose());
  return { engine, make, store, stored: () => stored, calls: () => ({ dsh, reads }) };
}
test('first open fills local interests and source without enabling, scheduling or calling DSH', async t => {
  const f = fixture(t), value = f.engine.prefill(rooms); f.engine.start(); await f.engine.tick();
  assert.match(value.config.concern, /AI agent.*多模型协作.*终端与桌面工具/);
  assert.equal(value.config.enabled, false); assert.equal(value.source, core.SOURCE); assert.equal(value.suggestion, 'local');
  assert.deepEqual(f.calls(), { dsh: 0, reads: 0 }); assert.equal(f.engine.timer, null);
});
test('saved manual edits, including a deliberately empty concern, survive later prefill and restart', t => {
  const f = fixture(t); f.engine.prefill(rooms);
  for (const concern of ['My own topic', '']) {
    f.engine.configure({ enabled: false, concern, time: '10:15', source: core.SOURCE + '?since=weekly' });
    assert.equal(f.engine.prefill([{ name: 'unrelated agent tool' }]).config.concern, concern);
    const next = f.make(); assert.equal(next.prefill(rooms).config.concern, concern); assert.equal(next.status().source, core.SOURCE + '?since=weekly'); next.dispose();
  }
});
test('legacy custom interests are never replaced; no local records still produces a safe editable default', t => {
  const f = fixture(t); f.engine.configure({ enabled: false, concern: 'Saved legacy choice', time: '09:00' });
  const old = f.stored(); delete old.origin; const next = f.make(); assert.equal(next.prefill(rooms).config.concern, 'Saved legacy choice'); next.dispose();
  assert.equal(typeof core.suggestConcern([]), 'string'); assert.ok(core.suggestConcern([]).trim());
});
test('unmodified local suggestions refresh from new titles, while a legacy saved empty setting remains owned by its user', t => {
  const f = fixture(t); assert.equal(f.engine.prefill([]).suggestion, 'generic');
  assert.equal(f.engine.prefill(rooms).suggestion, 'local'); assert.match(f.engine.status().config.concern, /多模型协作/);
  f.engine.configure({ enabled: false, concern: '', time: '10:15' }); delete f.stored().origin;
  const next = f.make(); assert.equal(next.prefill(rooms).config.concern, ''); next.dispose();
});
test('privacy filter only emits fixed generic topics, never Chinese names, companies, credentials or addresses', () => {
  const privateText = '合成人名甲 合成公司乙 ￥12345 synthetic.person@example.test /synthetic/private 账号 synthetic-account-72';
  const output = core.suggestConcern([{ name: privateText, queue: [{ text: privateText + ' 多模型协作 agent 终端' }] }]);
  for (const value of ['合成人名甲', '合成公司乙', '12345', 'synthetic.person', '/synthetic/', 'synthetic-account', '账号']) assert.equal(output.includes(value), false);
  assert.match(output, /多模型协作/); assert.match(output, /终端与桌面工具/);
  assert.doesNotMatch(core.suggestConcern([{ name: privateText }]), /合成|synthetic|12345/);
});
test('only space names and task title lines participate; archived rooms and conversation bodies do not', () => {
  const room = { name: 'ordinary', queue: [{ text: 'ordinary title\n多模型协作' }] };
  Object.defineProperties(room, { messages: { get() { assert.fail('Conversation read'); } }, notes: { get() { assert.fail('Notes read'); } } });
  assert.doesNotMatch(core.suggestConcern([room, { name: '多模型协作', archived: true }]), /多模型协作/);
});
test('one-click configure can enable the supplied draft while the fake model and source remain idle', t => {
  const f = fixture(t), value = f.engine.prefill(rooms); f.engine.start();
  f.engine.configure({ ...value.config, enabled: true });
  assert.equal(f.engine.status().config.enabled, true); assert.deepEqual(f.calls(), { dsh: 0, reads: 0 });
});
test('unapproved URLs refuse before any source request; approved source variants stay bounded', async () => {
  const { readSource } = require('../regular-popup-source.cjs'); let calls = 0;
  for (const url of ['https://127.0.0.1/', 'https://github.com/trending?token=private', 'https://example.test/', 'http://github.com/trending']) {
    await assert.rejects(readSource({ url }, { get: () => { calls++; throw Error('Must not request'); } }));
  }
  assert.equal(calls, 0);
});
test('Main keeps the human-window gate before collecting local metadata or saving configuration', () => {
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'); let handler, touched = 0;
  const roomState = { get value() { touched++; return rooms[0]; }, spaces: { rooms: [] } };
  const discoveries = { prefill: value => { touched++; return value; }, status: () => ({}), configure: () => touched++ };
  const start = source.indexOf("  register('discoveries',"), end = source.indexOf("  register('connectionUpdates',", start);
  vm.runInNewContext(source.slice(start, end), { register: (_, fn) => handler = fn, isCurrentHumanContext: c => c.human === true, uiError: code => Error(code), roomState, discoveries });
  assert.throws(() => handler({ human: false }, 'status'), /personOnly/); assert.throws(() => handler({ human: false }, 'configure', {}), /personOnly/); assert.equal(touched, 0);
  handler({ human: true }, 'status'); assert.ok(touched > 0);
});
test('all supported public source variants reach the existing parser through a fake HTTP reader', async () => {
  const { readSource, SOURCES } = require('../regular-popup-source.cjs'), { EventEmitter } = require('node:events');
  const seen = [], html = '<article class="Box-row"><h2><a href="/example/tool">Tool</a></h2><p>Public fixture</p></article>';
  for (const url of SOURCES) {
    const result = await readSource({ url }, { get(target, _, callback) {
      seen.push(target); const request = new EventEmitter(), response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html' }, destroy() {} }); request.destroy = () => {};
      queueMicrotask(() => { callback(response); response.emit('data', Buffer.from(html)); response.emit('end'); }); return request;
    } });
    assert.equal(result[0].url, 'https://github.com/example/tool');
  }
  assert.deepEqual(seen, SOURCES);
});
test('production autofill never acquires a DSH transport; selected source is forwarded only after explicit enable', async () => {
  const transport = require('../regular-popup-transport.cjs'), original = transport.createTransport; let saved = null, made = 0, dsh = 0, source = 0;
  transport.createTransport = () => { made++; return { readSource: async options => { source++; assert.equal(options.url, core.SOURCE + '?since=monthly'); return []; }, select: () => { dsh++; assert.fail('No DSH call'); }, close() {} }; };
  const e = core.create({ store: { read: () => saved, write: value => saved = structuredClone(value) } });
  try {
    e.prefill(rooms); await e.tick(); assert.deepEqual([made, source, dsh], [0, 0, 0]);
    e.configure({ ...e.status().config, enabled: true, source: core.SOURCE + '?since=monthly' }); await e.tick();
    assert.deepEqual([made, source, dsh], [1, 1, 0]);
  } finally { e.dispose(); transport.createTransport = original; }
});
