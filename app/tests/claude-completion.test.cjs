const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');

function fixture() {
  const runtime = Object.create(Claude.prototype); EventEmitter.call(runtime);
  runtime.record = { nativeId: 'synthetic-session' }; runtime.ready = true;
  let accept, reject, allowed = true;
  runtime.submission = { pending:{authorized:true}, request: () => new Promise((yes, no) => { accept = yes; reject = no; }) };
  runtime.terminal = { input() {} };
  const replies = [], states = [];
  runtime.on('complete', r => replies.push(r)); runtime.on('state', s => states.push(s));
  const stop = (text, promptId = 'new-prompt') => runtime.hook({ prompt_id: promptId, session_id: runtime.record.nativeId, hook_event_name: 'Stop', last_assistant_message: text, background_tasks: [], session_crons: [], stop_hook_active: false });
  return { runtime, replies, states, stop, send: () => runtime.send('task', 'request-1', () => allowed), accept: (promptId = 'new-prompt') => accept({promptId}), reject: () => reject(Error('not confirmed')), revoke: () => { allowed = false; } };
}
test('Claude queued input preserves the original task and binds only when the native next prompt starts', async () => {
  const f = fixture(), first = f.send(); f.accept('first'); await first;
  const original = f.runtime.pending;
  f.runtime.nativeQueue = true; f.runtime.rootLease = 'root'; f.runtime.chatAvailable = true;
  f.runtime.submission.pending = null;
  const queued = f.runtime.queue('next task', 'queue-id', () => true);
  assert.equal(f.runtime.pending, original);
  await assert.rejects(f.runtime.queue('duplicate', 'other', () => true), /等待输入/);
  f.stop('first result', 'first'); assert.equal(f.replies[0].tag, 'request-1');
  f.runtime.submission.pending = { authorized: true };
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'UserPromptSubmit', prompt_id: 'next', prompt: 'next task' });
  f.stop('next result', 'next');
  f.accept('next'); await queued;
  assert.deepEqual(f.replies.map(r => [r.tag, r.text]), [['request-1', 'first result'], ['queue-id', 'next result']]);
  assert.equal(f.runtime.queued, null); assert.equal(f.states.at(-1), 'idle');
});
test('late queued acceptance keeps a newer approval and an uncertain queued result remains private', async () => {
  const f = fixture(); f.runtime.nativeQueue = true; f.runtime.rootLease = 'root'; f.runtime.chatAvailable = true; f.runtime.submission.pending = null;
  const queued = f.runtime.queue('next task', 'queue-id', () => true);
  f.runtime.submission.pending = { authorized: true };
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'UserPromptSubmit', prompt_id: 'next', prompt: 'next task' });
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'PermissionRequest' });
  f.accept('next'); await queued;
  assert.equal(f.states.at(-1), 'approval'); assert.deepEqual(f.replies, []);
});
for (const identity of ['next', null]) test(`queued prompt with ${identity ? 'known' : 'unknown'} receipt cannot be idled by the previous Stop`, async () => {
  const f = fixture(), first = f.send(); f.accept('first'); await first;
  f.runtime.nativeQueue = true; f.runtime.rootLease = 'root'; f.runtime.chatAvailable = true; f.runtime.submission.pending = null;
  const queued = f.runtime.queue('next task', 'queue-id', () => true);
  f.runtime.submission.pending = { authorized: true };
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'UserPromptSubmit', prompt_id: 'next', prompt: 'next task' });
  f.stop('late old result', 'first'); assert.equal(f.states.at(-1), 'working');
  f.stop('next result', 'next'); f.accept(identity); await queued;
  assert.equal(f.states.at(-1), 'idle');
  assert.equal(f.replies.at(-1).text, 'next result');
  assert.equal(f.replies.at(-1).tag, identity ? 'queue-id' : undefined);
});
test('same-root reload retires an uncertain queue without stopping or replacing native work', async () => {
  const { SubmissionChannel } = require('../claude-submit.cjs');
  const f = fixture(); f.runtime.nativeQueue = true; f.runtime.rootLease = 'root'; f.runtime.chatAvailable = true;
  f.runtime.terminal.alive = true; f.runtime.submission = new SubmissionChannel();
  const response = new EventEmitter(); response.end = () => {};
  f.runtime.submission.receive(response);
  const queued = f.runtime.queue('next task', 'queue-id', () => true);
  f.runtime.submission.authorize({ id: 'queue-id', text: 'next task' });
  const rejected = assert.rejects(queued, /关闭/);
  f.runtime.bindRoot({ sessionId: f.runtime.record.nativeId, nativeBlocks: true, nativeQueue: true });
  await rejected; assert.equal(f.runtime.terminal.alive, true); assert.equal(f.runtime.queued, null);
});
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
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'PreToolUse', prompt_id: 'new-prompt', tool_name: 'Read' });
  f.accept(); await sent; assert.deepEqual(f.replies, []);
  f.stop('actual final'); assert.equal(f.replies.length, 1); assert.equal(f.replies[0].text, 'actual final');
});
for (const event of ['PermissionRequest', 'Notification', 'SessionEnd']) test(`late ACK preserves newer Claude ${event} and cannot publish its earlier Stop`, async () => {
  const f = fixture(), sent = f.send(); f.stop('stale candidate');
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: event, notification_type: 'permission_prompt' });
  f.accept(); await sent;
  assert.deepEqual(f.replies, []); assert.equal(f.states.at(-1), event === 'SessionEnd' ? 'stopping' : 'approval');
});

test('a delayed Stop from an older native prompt cannot become the new accepted reply', async () => {
  const f = fixture(), sent = f.send();
  f.runtime.hook({ session_id: 'synthetic-session', hook_event_name: 'Stop',
    prompt_id: 'previous-native-prompt', last_assistant_message: 'private older answer' });
  f.accept(); await sent;
  assert.ok(f.replies.every(reply => reply.tag === undefined), 'Acceptance alone does not correlate an older Stop');
});

for (const promptId of ['old-prompt', undefined]) test(`unmatched Stop ${promptId} cannot consume or idle an accepted prompt`, async () => {
  const f = fixture(), sent = f.send(); f.accept(); await sent;
  f.runtime.hook({session_id:'synthetic-session',hook_event_name:'Stop',prompt_id:promptId,last_assistant_message:'older private reply'});
  assert.equal(f.runtime.pending.tag, 'request-1'); assert.equal(f.states.at(-1), 'working'); assert.deepEqual(f.replies, []);
  f.stop('new exact reply'); assert.equal(f.replies[0].tag,'request-1'); assert.equal(f.replies[0].text,'new exact reply');
});
test('identical human text with another prompt ID cannot inherit an accepted tag', async () => {
  const f=fixture(),sent=f.send();f.accept();await sent;
  f.runtime.hook({session_id:'synthetic-session',hook_event_name:'UserPromptSubmit',prompt_id:'human-prompt',prompt:'task'});
  f.stop('human private reply','human-prompt');assert.equal(f.replies[0].tag,undefined);
});
test('missing correlation is accepted once and reported without authorizing a reply', async () => {
  const f=fixture();const accepted=[],unattributed=[];
  f.runtime.on('submitted', tag=>accepted.push(tag));f.runtime.on('unattributed',tag=>unattributed.push(tag));
  const sent=f.send();f.accept(null);await sent;
  assert.deepEqual(accepted,['request-1']);assert.deepEqual(unattributed,['request-1']);
  f.stop('unattributed');assert.ok(f.replies.every(r=>!r.tag));
});

test('identical human submission before authorization cancels the queued GUI request',async()=>{
 const {SubmissionChannel}=require('../claude-submit.cjs');const f=fixture();const channel=f.runtime.submission=new SubmissionChannel();
 const response=new EventEmitter();response.end=text=>{response.body=JSON.parse(text);response.emit('close')};channel.receive(response);
 let allowed=true;f.runtime.on('nativeInput',()=>{allowed=false});
 const sent=f.runtime.send('task','request-1',()=>allowed);
 f.runtime.hook({session_id:'synthetic-session',hook_event_name:'UserPromptSubmit',prompt:'task',prompt_id:'human-same-text'});
 assert.equal(channel.authorize(response.body),false);channel.result({id:'request-1',status:'blocked'});
 await assert.rejects(sent,/未接受/);channel.close();
});
