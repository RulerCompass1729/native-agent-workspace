const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { ALERTS } = require('../mobile-push.cjs');
function health(scope, status) {
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const start = source.indexOf('function appHealth('), end = source.indexOf('function appMobileBroker()', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext(scope); vm.runInContext(source.slice(start, end), context);
  return JSON.parse(JSON.stringify(context.appHealth(status)));
}
const room = (queue, archived = false) => ({ archived, name: 'PRIVATE_SPACE', queue });
const item = (status, reason, finishedAt) => ({ status, ...(reason ? { reason } : {}), ...(finishedAt ? { finishedAt } : {}), text: 'PRIVATE_TASK', reply: 'PRIVATE_REPLY' });
test('phone health holds only fixed codes: a stalled wake and an item that waits for the person', () => {
  const quiet = { stewardWake: { view: () => ({ on: true }) },
    roomState: { value: room([item('sent'), item('waiting', 'no-reply'), item('failed')]), spaces: { rooms: [room([item('waiting')], true), room([item('done')])] } } };
  assert.deepEqual(health(quiet), { available: true, alerts: [] });
  const both = health({ stewardWake: { view: () => ({ on: true, blocked: { since: 1, reason: 'PRIVATE_REASON', minutes: 12 } }) },
    roomState: { value: room([item('waiting', null, 500)]), spaces: { rooms: [room([item('done', null, 900), item('waiting', null, 700), item('waiting', 'no-reply', 800)])] } } });
  assert.deepEqual(both, { available: true, alerts: [{ code: 'steward-wake-stalled' }, { code: 'decision-waiting', at: 700 }] });
  assert.ok(both.alerts.every(alert => ALERTS.includes(alert.code)), 'every code is in the push vocabulary');
  assert.deepEqual(health({ stewardWake: null, roomState: { value: room([item('waiting')]), spaces: { rooms: [] } } }),
    { available: true, alerts: [{ code: 'decision-waiting', at: 0 }] });
});
test('a confirmation card the person can act on is a waiting decision; its time is the newest case', () => {
  const card = (actionable, time) => ({ actionable, time, title: 'PRIVATE_TITLE', actorName: 'PRIVATE_ACTOR' });
  const idle = { stewardWake: null, roomState: { value: room([]), spaces: { rooms: [] } } };
  assert.deepEqual(health(idle, { count: 3, confirmations: [card(false, 900), card('yes', 950)] }), { available: true, alerts: [] });
  assert.deepEqual(health(idle, { count: 3, confirmations: [card(true, 400), card(true, 600), card(false, 900)] }),
    { available: true, alerts: [{ code: 'decision-waiting', at: 600 }] });
  const asked = { stewardWake: null, roomState: { value: room([item('waiting', null, 700)]), spaces: { rooms: [] } } };
  assert.deepEqual(health(asked, { confirmations: [card(true, 600)] }), { available: true, alerts: [{ code: 'decision-waiting', at: 700 }] });
  assert.deepEqual(health(asked, null), { available: true, alerts: [{ code: 'decision-waiting', at: 700 }] });
});
test('a source that cannot be read makes phone health unknown, never clean', () => {
  assert.deepEqual(health({ stewardWake: { view: () => { throw Error('PRIVATE_FAILURE'); } }, roomState: { value: room([item('waiting')]), spaces: { rooms: [] } } }),
    { available: false, alerts: [{ code: 'decision-waiting', at: 0 }] });
  assert.deepEqual(health({ stewardWake: null, roomState: undefined }), { available: false, alerts: [] });
});
