const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');

function fixture() {
  const runtime = Object.create(Claude.prototype); EventEmitter.call(runtime);
  runtime.record = { nativeId: 'synthetic-session' }; runtime.ready = true;
  let accept, reject, allowed = true;
  runtime.submission = { request: () => new Promise((yes, no) => { accept = yes; reject = no; }) };
  runtime.terminal = { input() {} };
  const replies = [], states = [];
  runtime.on('complete', r => replies.push(r)); runtime.on('state', s => states.push(s));
  const stop = text => runtime.hook({ session_id: runtime.record.nativeId, hook_event_name: 'Stop', last_assistant_message: text, background_tasks: [], session_crons: [], stop_hook_active: false });
  return { runtime, replies, states, stop, send: () => runtime.send('task', 'request-1', () => allowed), accept: () => accept(), reject: () => reject(Error('not confirmed')), revoke: () => { allowed = false; } };
}
test('Claude completion before ACK remains private until exact request acceptance', async () => {
  const f = fixture(), sent = f.send(); f.stop('answer'); assert.deepEqual(f.replies, []);
  f.accept(); await sent;
  assert.equal(f.replies.length, 1); assert.equal(f.replies[0].tag, 'request-1'); assert.equal(f.replies[0].fleetPending, null);
});
for (const action of ['reject', 'revoke', 'human', 'interrupt']) test(`early Claude completion cannot route after ${action}`, async () => {
  const f = fixture(), sent = f.send(); f.stop('candidate');
  if (action === 'reject') { f.reject(); await assert.rejects(sent, /not confirmed/); }
  else {
    if (action === 'revoke') f.revoke();
    if (action === 'human') f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'UserPromptSubmit', prompt: 'private correction' });
    if (action === 'interrupt') f.runtime.interrupt();
    f.accept(); await sent;
  }
  assert.ok(f.replies.every(r => r.tag === undefined));
  if (action === 'human') assert.equal(f.states.at(-1), 'working', 'Late ACK must not overwrite newer native work');
});
test('native continued work invalidates an early Stop candidate', async () => {
  const f = fixture(), sent = f.send(); f.stop('intermediate');
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'PreToolUse', tool_name: 'Read' });
  f.accept(); await sent; assert.deepEqual(f.replies, []);
  f.stop('actual final'); assert.equal(f.replies.length, 1); assert.equal(f.replies[0].text, 'actual final');
});
for (const event of ['PermissionRequest', 'Notification', 'SessionEnd']) test(`late ACK preserves newer Claude ${event} and cannot publish its earlier Stop`, async () => {
  const f = fixture(), sent = f.send(); f.stop('stale candidate');
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: event, notification_type: 'permission_prompt' });
  f.accept(); await sent;
  assert.deepEqual(f.replies, []); assert.equal(f.states.at(-1), event === 'SessionEnd' ? 'stopping' : 'approval');
});
