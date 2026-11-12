const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
// Exercise the actual existing renderer helpers, without booting a provider.
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const start = source.indexOf('function sessionTime('), end = source.indexOf('function renderDraftRecovery(', start);
assert.ok(start >= 0 && end > start);
const { sessionTime, sessionActivityTime, sessionTimes } = vm.runInNewContext(source.slice(start, end) + ';({sessionTime,sessionActivityTime,sessionTimes})', { Date, uiText: (key, params) => require('../ui-locale.js').format('zh', key, params), ui: { language: { getSnapshot: () => ({ active: 'zh' }) } } });
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
// The sidebar formats several times for every session on every draw, and while agents work the page draws several
// times a second. toLocaleTimeString with options builds a formatter on each call; one formatter per language is
// built once and gives the same text.
test('many times in one language build one formatter and read the same as before', () => {
  let built = 0;
  class CountingFormat extends Intl.DateTimeFormat { constructor(...args) { super(...args); built++; } }
  const language = { active: 'zh' }, context = { Date, Intl: { ...Intl, DateTimeFormat: CountingFormat }, uiText: (key, params) => require('../ui-locale.js').format('zh', key, params), ui: { language: { getSnapshot: () => language } } };
  const counted = vm.runInNewContext(source.slice(start, end) + ';({sessionTime,sessionTimes})', context);
  // Today's times are the clock time only, so compare times of today (around noon, whenever this runs) with the old way.
  const noon = new Date(); noon.setHours(12, 0, 0, 0); const today = noon.getTime();
  for (let i = 0; i < 50; i++) assert.equal(counted.sessionTime(today - i * 1000), new Date(today - i * 1000).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }));
  for (let i = 0; i < 20; i++) counted.sessionTimes({ createdAt: time, lastActivityAt: later });
  assert.equal(built, 1, 'One formatter for the language');
  language.active = 'en';
  assert.equal(counted.sessionTime(today), new Date(today).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }));
  assert.equal(built, 2, 'A second language gets its own formatter');
  language.active = 'zh'; counted.sessionTime(time); assert.equal(built, 2, 'and the first is kept');
});
test('a formatter is made again after the time zone offset changes', () => {
  let built = 0, offset = 0;
  class CountingFormat extends Intl.DateTimeFormat { constructor(...args) { super(...args); built++; } }
  // The page's clock: the same dates, with the offset the system reports now.
  class Clock extends Date { getTimezoneOffset() { return offset; } }
  const context = { Date: Clock, Intl: { DateTimeFormat: CountingFormat }, uiText: (key, params) => require('../ui-locale.js').format('zh', key, params), ui: { language: { getSnapshot: () => ({ active: 'zh' }) } } };
  const counted = vm.runInNewContext(source.slice(start, end) + ';({sessionTime})', context);
  counted.sessionTime(time); counted.sessionTime(later); assert.equal(built, 1);
  offset = -60; counted.sessionTime(time); assert.equal(built, 2, 'A new offset gets a new formatter');
  offset = 0; counted.sessionTime(time); assert.equal(built, 2, 'and the earlier one is kept');
});
