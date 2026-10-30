const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
// Exercise the actual existing renderer helpers, without booting a provider.
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const start = source.indexOf('function sessionTime('), end = source.indexOf('function renderDraftRecovery(', start);
assert.ok(start >= 0 && end > start);
const { sessionTime, sessionActivityTime, sessionTimes } = vm.runInNewContext(source.slice(start, end) + ';({sessionTime,sessionActivityTime,sessionTimes})', { Date });
const time = Date.UTC(2026, 9, 29, 9, 5), later = time + 3600000;
test('reported backend activity remains authoritative over message and creation times', () => {
  assert.equal(sessionActivityTime({ createdAt: later, lastActivityAt: time, messages: [{ time: later }] }), sessionTime(time));
});
test('missing activity uses the newest recorded message time despite display order and marks the estimate', () => {
  const s = { createdAt: time, messages: [{ time: later }, { time }, { text: 'No recorded timestamp' }] };
  assert.equal(sessionActivityTime(s), '推算 ' + sessionTime(later));
  assert.ok(sessionTimes(s).includes('最后活动 推算 '));
  assert.deepEqual(s, { createdAt: time, messages: [{ time: later }, { time }, { text: 'No recorded timestamp' }] });
});
for (const messages of [undefined, [], {}, [null, {}, { time: '2026-10-29T00:00:00Z' }, { time: null }, { time: 1e20 }]]) test('unknown activity is explicit and never fabricated from creation/clock: ' + JSON.stringify(messages), () => {
  assert.equal(sessionActivityTime({ createdAt: time, messages }), '时间未知');
  assert.ok(sessionTimes({ createdAt: time, messages }).endsWith('最后活动 时间未知'));
});
for (const value of [null, undefined, '', '1000', NaN, Infinity, -Infinity, 1e20]) test('invalid backend timestamp fails closed: ' + String(value), () => {
  assert.equal(sessionTime(value), '');
  assert.equal(sessionActivityTime({ lastActivityAt: value, messages: [{ time }] }), '推算 ' + sessionTime(time));
});
test('zero is a recorded epoch, and later reported metadata replaces an estimate without rewriting records', () => {
  assert.ok(sessionTime(0)); assert.equal(sessionActivityTime({ lastActivityAt: 0 }), sessionTime(0));
  const s = { messages: [{ time }] }; assert.match(sessionActivityTime(s), /^推算 /);
  s.lastActivityAt = later; assert.equal(sessionActivityTime(s), sessionTime(later)); assert.equal(s.messages[0].time, time);
});

test('local cache gap markers do not manufacture message activity', () => {
  assert.equal(sessionActivityTime({ messages: [{ time }, { kind: 'gap', time: later }] }), '推算 ' + sessionTime(time));
  assert.equal(sessionActivityTime({ messages: [{ kind: 'gap', time }] }), '时间未知');
});
test('volatile progress does not manufacture activity or make an estimate step backward on removal', () => {
  const progress = { kind: 'tool', role: 'tool', volatile: true, time: later };
  assert.equal(sessionActivityTime({ messages: [{ time }, progress] }), '推算 ' + sessionTime(time));
  assert.equal(sessionActivityTime({ messages: [progress] }), '时间未知');
});
