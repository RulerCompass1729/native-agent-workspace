const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
const { MobileAccess } = require('../mobile-access.cjs');
const { ApprovalQueue } = require('../approval-policy.js');
const { SubmissionChannel } = require('../claude-submit.cjs');
const { writeLayout } = require('../service-layout.cjs');
const mobile = require('../mobile-session.cjs');
async function fixture(t, provider = 'codex') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-session-'))), stat = fs.lstatSync(root);
  const calls = [], r = new EventEmitter(); r.chatAvailable = true;
  r.start = async () => r.emit('state', 'idle');
  r.send = async (text, tag, guard) => { assert.equal(guard(), true); calls.push({ text, tag }); r.emit('submitted', tag); };
  const host = { binaries: {}, close() {}, create: () => r, rpc: { reply: (...args) => calls.push(args) } };
  const w = new Workspace(host, root), id = await w.create(provider, root, 'desktop-owner', 'Synthetic member');
  const s = w.get(id); s.nativeId ||= 'synthetic-native-id';
  const access = new MobileAccess(root, { exclusive: () => true }); access.initialize();
  const target = { serviceKey: '.', sessionId: id, nativeId: s.nativeId }, actor = 'synthetic-human', site = 'https://mobile.invalid';
  const qr = access.beginPairing({ actor, origin: site, scopes: [{ ...target, actions: ['read', 'send', 'answer'] }] });
  const device = access.pair({ secret: qr.secret, actor, origin: site });
  const ticket = action => access.authorize({ token: device.cookieValue, actor, origin: site, csrf: device.csrf, action, target });
  const read = () => w.mobileRead(ticket('read'));
  const spec = (text = '  Exact original\n手机输入  ') => ({ requestId: randomUUID(), proof: read().proof, text });
  t.after(() => { w.close(); const now = fs.lstatSync(root); assert.equal(now.uid, process.getuid()); assert.equal(now.ino, stat.ino); assert.equal(now.dev, stat.dev); fs.rmSync(root, { recursive: true }); });
  return { w, s, r, host, calls, root, id, access, device, target, ticket, read, spec };
}
test('selected mobile read returns original text and omits desktop drafts and unrelated room data', async t => {
  const f = await fixture(t), { w, s, id } = f;
  w.setDraft(id, 'Private desktop draft', 'desktop-owner'); s.cwd = '/synthetic/private-path'; s.environment = 'private';
  w.room.messages.push({ id: 'unrelated-room', text: 'Unrelated private content' });
  s.messages.push({ id: 'native-original', role: 'assistant', text: '<script>original text only</script>\n保留原文', status: 'complete', nativeId: s.nativeId });
  const result = f.read(), bytes = JSON.stringify(result);
  assert.equal(result.messages[0].text, s.messages[0].text); assert.equal(result.messages[0].id, 'native-original');
  for (const privateText of ['Private desktop draft', '/synthetic/private-path', 'environment', 'Unrelated private content', 'desktop-owner']) assert.equal(bytes.includes(privateText), false);
  assert.equal(result.id, id); assert.equal(result.nativeId, s.nativeId); assert.equal(result.canSend, true);
});
test('oversized replies and unsupported attachments are explicit without silently truncating original text', async t => {
  const f = await fixture(t);
  f.s.messages.push(...Array.from({ length: 7 }, (_, i) => ({ id: 'm' + i, role: 'assistant', text: i === 6 ? 'x'.repeat(65537) : '原文' + i, images: i === 6 ? [{ path: '/synthetic/image.png' }] : [], status: 'complete' })));
  const view = f.read(); assert.equal(view.messages.length, 6); assert.equal(view.earlierMessagesOmitted, 1);
  assert.equal(view.messages.at(-1).text, null); assert.equal(view.messages.at(-1).textOmitted, true); assert.equal(view.messages.at(-1).unsupportedAttachments, 1);
  assert.equal(JSON.stringify(view).includes('/synthetic/image.png'), false);
});
for (const provider of ['claude', 'codex']) test(provider + ' mobile private input preserves desktop owner, view, draft and native identity', async t => {
  const f = await fixture(t, provider), spec = f.spec(); f.w.setDraft(f.id, spec.text, 'desktop-owner');
  const before = { owner: f.s.owner, view: f.s.view, nativeId: f.s.nativeId, room: f.s.roomId }, status = f.w.room.messages.length;
  const result = await f.w.mobileSend(f.ticket('send'), spec);
  assert.equal(result.status, 'submitted'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].text, spec.text);
  assert.deepEqual({ owner: f.s.owner, view: f.s.view, nativeId: f.s.nativeId, room: f.s.roomId }, before);
  assert.equal(f.w.drafts.get(f.id), spec.text); assert.equal(f.w.room.messages.length, status); assert.equal(f.s.messages.at(-1).origin, 'human-mobile');
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8'));
  assert.equal(disk.mobileRequests[0].requestId, spec.requestId); assert.equal(disk.sessions[0].messages.at(-1).id, result.tag);
});
test('phone text identical to a trimmed desktop draft does not clear the desktop field', async t => {
  const f = await fixture(t), spec = f.spec('Identical desktop and phone text');
  f.w.setDraft(f.id, spec.text, 'desktop-owner');
  const result = await f.w.mobileSend(f.ticket('send'), spec);
  assert.equal(result.status, 'submitted'); assert.equal(f.w.drafts.get(f.id), spec.text); assert.equal(f.s.owner, 'desktop-owner');
});
test('concurrent duplicate phone requests read the reserved receipt without dispatch or human intervention again', async t => {
  const f = await fixture(t), spec = f.spec(); let finish, pauses = 0;
  const pause = f.w.pause.bind(f.w); f.w.pause = (...args) => { pauses++; return pause(...args); };
  f.r.send = (text, tag, valid) => { assert.ok(valid()); f.calls.push({ text, tag }); return new Promise(resolve => { finish = () => { f.r.emit('submitted', tag); resolve(); }; }); };
  const first = f.w.mobileSend(f.ticket('send'), spec);
  const duplicate = await f.w.mobileSend(f.ticket('send'), spec);
  assert.equal(duplicate.status, 'awaiting-native'); assert.equal(f.calls.length, 1); assert.equal(pauses, 1);
  finish(); const done = await first; assert.equal(done.tag, duplicate.tag); assert.equal(done.status, 'submitted');
  assert.deepEqual(await f.w.mobileSend(f.ticket('send'), spec), done); assert.equal(pauses, 1);
  await assert.rejects(f.w.mobileSend(f.ticket('send'), { ...spec, text: 'Different payload' })); assert.equal(f.calls.length, 1);
});
test('bad authority, slash commands and stale context cannot change human control or dispatch', async t => {
  const f = await fixture(t), spec = f.spec(), before = f.s.controlRevision;
  await assert.rejects(f.w.mobileSend({ ...f.ticket('send'), serviceKey: 'backends/' + 'a'.repeat(20) }, spec));
  await assert.rejects(f.w.mobileSend(f.ticket('read'), spec));
  await assert.rejects(f.w.mobileSend(f.ticket('send'), { ...spec, text: '/model hidden' }));
  for (const text of ['/plugin:cmd', '/mcp__tool__command', '/foo_bar', 'bad\x1bcontrol', 'bad\x00control', 'bad\x08control']) await assert.rejects(f.w.mobileSend(f.ticket('send'), { ...spec, text }));
  await assert.rejects(f.w.mobileSend(f.ticket('send'), { ...spec, proof: { ...spec.proof, nativeId: 'old-native' } }));
  assert.equal(f.s.controlRevision, before); assert.equal(f.w.mobileRequests.length, 0); assert.equal(f.calls.length, 0);
});
test('busy sessions refuse phone input instead of queueing, steering or taking the desktop owner', async t => {
  const f = await fixture(t), spec = f.spec(); f.s.state = 'working';
  await assert.rejects(f.w.mobileSend(f.ticket('send'), spec)); assert.equal(f.calls.length, 0); assert.equal(f.s.owner, 'desktop-owner');
});
test('persist failure prevents native input even when the in-memory reservation exists', async t => {
  const f = await fixture(t), spec = f.spec(); f.w.setDraft(f.id, spec.text, 'desktop-owner');
  f.w.persist = () => { f.w.storageWarning = 'Synthetic disk failure'; };
  const result = await f.w.mobileSend(f.ticket('send'), spec);
  assert.equal(result.status, 'not-sent'); assert.equal(f.calls.length, 0); assert.equal(f.w.drafts.get(f.id), spec.text);
  assert.match(result.error, /回执未能保存/);
  assert.equal(f.s.messages.length, 0, 'A failed preflight does not fabricate a native user turn');
  assert.equal((await f.w.mobileSend(f.ticket('send'), spec)).tag, result.tag);
});
test('revocation after Claude delivered text prevents its actual late native authorization', async t => {
  const f = await fixture(t, 'claude'), channel = new SubmissionChannel(); t.after(() => channel.close());
  channel.connected = true; let delivered;
  channel.poll = { end: bytes => { delivered = JSON.parse(bytes); } };
  f.r.send = (text, tag, guard) => channel.request(text, tag, guard);
  const pending = f.w.mobileSend(f.ticket('send'), f.spec()); assert.ok(delivered?.text);
  assert.deepEqual(f.access.revoke(), { confirmed: true }); assert.equal(channel.authorize(delivered), false);
  channel.finish(Error('Synthetic revoked before authorize'));
  assert.equal((await pending).status, 'not-sent'); assert.equal(f.s.owner, 'desktop-owner');
});
test('native or desktop intervention invalidates a pending phone guard without erasing a newer draft', async t => {
  const f = await fixture(t), spec = f.spec(); let guard, finish;
  f.r.send = (_text, _tag, valid) => { guard = valid; return new Promise(resolve => { finish = resolve; }); };
  const pending = f.w.mobileSend(f.ticket('send'), spec); assert.equal(guard(), true);
  f.s.controlRevision++; f.w.setDraft(f.id, 'Newer desktop draft', 'desktop-owner'); assert.equal(guard(), false);
  finish(); assert.equal((await pending).status, 'unconfirmed'); assert.equal(f.w.drafts.get(f.id), 'Newer desktop draft');
});
test('a backend restart keeps an unanswered reservation unconfirmed and never sends it again', async t => {
  const f = await fixture(t), spec = f.spec(); f.r.send = () => new Promise(() => {});
  f.w.mobileSend(f.ticket('send'), spec); assert.equal(f.w.mobileRequests[0].status, 'awaiting-native');
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  const result = await reopened.mobileSend(f.ticket('send'), spec);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.tag, f.w.mobileRequests[0].tag); assert.equal(reopened.runtimes.size, 0);
});
function codexQuestion(f, extra = {}) {
  const queue = new ApprovalQueue(randomUUID), approval = { requestId: 17, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', header: 'Pick', question: 'Original question?', options: [{ label: 'A', description: 'Original A' }], ...extra }] } };
  const route = queue.add(approval, f.host.rpc, f.r); f.w.approvalRoutes.set(f.id, queue); Object.assign(f.s, queue.snapshot(), { state: 'approval' });
  return { queue, route, spec: { requestId: randomUUID(), proof: f.read().proof, questionId: route.requestId, answers: { q: ['A'] } } };
}
test('Codex phone answers use the original held native request and duplicate receipt without granting permissions', async t => {
  const f = await fixture(t), q = codexQuestion(f); assert.equal(f.read().question.questions[0].question, 'Original question?');
  const receipt = f.w.mobileAnswer(f.ticket('answer'), q.spec);
  assert.equal(receipt.status, 'reply-written'); assert.deepEqual(f.calls[0], [17, { answers: { q: { answers: ['A'] } } }]);
  assert.equal(f.s.owner, 'desktop-owner'); assert.equal(q.route.approval.pending, true); assert.equal(f.read().question, null);
  q.queue.resolve(17, f.host.rpc); assert.deepEqual(f.w.mobileAnswer(f.ticket('answer'), q.spec), receipt); assert.equal(f.calls.length, 1);
});
test('secret, changed, unsupported or malformed native questions never acquire phone permission', async t => {
  const f = await fixture(t), q = codexQuestion(f, { isSecret: true }), before = f.s.controlRevision;
  assert.equal(f.read().question, null); assert.throws(() => f.w.mobileAnswer(f.ticket('answer'), q.spec));
  q.route.approval.params.questions[0].isSecret = false;
  assert.throws(() => f.w.mobileAnswer(f.ticket('answer'), { ...q.spec, questionId: randomUUID() }));
  assert.throws(() => f.w.mobileAnswer(f.ticket('answer'), { ...q.spec, answers: { q: ['not-an-option'] } }));
  q.route.approval.method = 'item/commandExecution/requestApproval';
  assert.throws(() => f.w.mobileAnswer(f.ticket('answer'), q.spec));
  assert.equal(f.calls.length, 0); assert.equal(f.s.controlRevision, before); assert.equal(f.w.mobileRequests.length, 0);
});
test('Claude held solo questions preserve original answers and cannot be handed back or answered twice', async t => {
  const f = await fixture(t, 'claude'); let open = true;
  f.w.holdQuestion(f.s, f.r, { questions: [{ question: 'Original Claude question?', header: 'Choose', multiSelect: false, options: [{ label: 'A', description: 'Original' }] }], open: () => open, reply: answer => { f.calls.push(answer); open = false; } });
  const q = f.read().question, spec = { requestId: randomUUID(), proof: f.read().proof, questionId: q.requestId, answers: { 'Original Claude question?': ['A'] } };
  assert.throws(() => f.w.mobileAnswer(f.ticket('answer'), { ...spec, answers: null })); assert.equal(open, true);
  const result = f.w.mobileAnswer(f.ticket('answer'), spec);
  assert.equal(result.status, 'reply-written'); assert.deepEqual(f.calls, [{ answers: { 'Original Claude question?': 'A' } }]);
  assert.deepEqual(f.w.mobileAnswer(f.ticket('answer'), spec), result); assert.equal(f.calls.length, 1); assert.equal(f.s.owner, 'desktop-owner');
});
test('desktop answering first and state changes during receipt persistence prevent a second native reply', async t => {
  const f = await fixture(t), q = codexQuestion(f);
  f.w.answer(f.id, q.route.requestId, q.spec.answers, 'desktop-owner');
  assert.throws(() => f.w.mobileAnswer(f.ticket('answer'), q.spec)); assert.equal(f.calls.length, 1);
  const other = await fixture(t), next = codexQuestion(other), persist = other.w.persist.bind(other.w);
  other.w.persist = () => { persist(); next.route.approval.pending = true; };
  const result = other.w.mobileAnswer(other.ticket('answer'), next.spec);
  assert.equal(result.status, 'not-sent'); assert.equal(other.calls.length, 0);
});
test('forgetting a session cannot erase the current device request namespace for another target', async t => {
  const f = await fixture(t), spec = f.spec(); await f.w.mobileSend(f.ticket('send'), spec);
  f.w.sessions.delete(f.id); f.w.persist();
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8')); assert.equal(disk.mobileRequests[0].requestId, spec.requestId);
});
test('phone receipt exhaustion refuses new work and never evicts still-authorized request IDs', async t => {
  const f = await fixture(t), spec = f.spec(); await f.w.mobileSend(f.ticket('send'), spec);
  const original = f.w.mobileRequests[0];
  f.w.mobileRequests.push(...Array.from({ length: mobile.MAX_REQUESTS - 1 }, () => ({ ...original, requestId: randomUUID(), tag: randomUUID() })));
  f.s.pendingTag = null; const next = f.spec('Do not dispatch');
  await f.w.mobileSend(f.ticket('send'), next).then(() => assert.fail('receipt exhaustion must reject'), () => {});
  assert.equal(f.calls.length, 1); assert.equal(f.w.mobileRequests.length, mobile.MAX_REQUESTS);
  assert.equal((await f.w.mobileSend(f.ticket('send'), spec)).tag, original.tag);
});
test('a caller-supplied function cannot impersonate the internal human delegate', async t => {
  const f = await fixture(t);
  await assert.rejects(f.w.send(f.id, 'Forged mobile', null, null, null, null, null, null, { valid: () => true, human() {}, reserve() {} }));
  assert.equal(f.calls.length, 0); assert.equal(f.s.owner, 'desktop-owner');
});
test('mobile reads exclude another native ID while retaining the current original message', async t => {
  const f = await fixture(t), current = { id: 'current-original', role: 'assistant', nativeId: f.s.nativeId, text: 'Current original' };
  f.s.messages.push(current); assert.deepEqual(f.read().messages.map(m => m.id), [current.id]);
  f.s.messages.unshift({ id: 'other-native-original', role: 'assistant', nativeId: 'different-native', text: 'Old private native context' });
  assert.deepEqual(f.read().messages.map(m => m.id), [current.id]);
  assert.equal(JSON.stringify(f.read()).includes('Old private native context'), false);
});
test('a context boundary excludes earlier untagged originals without removing the new context', async t => {
  const f = await fixture(t), current = { id: 'after-reset', role: 'assistant', text: 'After reset original' };
  f.s.messages.push(current); assert.deepEqual(f.read().messages.map(m => m.id), [current.id]);
  f.s.nativeContexts = [{ boundaryId: 'reset-boundary', nativeId: 'old-native' }];
  f.s.messages.unshift({ id: 'before-reset', role: 'assistant', text: 'Old untagged private reply' }, { id: 'reset-boundary', role: 'system', text: 'Native boundary' });
  assert.deepEqual(f.read().messages.map(m => m.id), [current.id]);
  assert.equal(JSON.stringify(f.read()).includes('Old untagged private reply'), false);
});
test('the newest original receives the bounded text budget before an older large reply', async t => {
  const f = await fixture(t);
  f.s.messages.push({ id: 'older-big', role: 'assistant', text: 'x'.repeat(65536) }, { id: 'newest', role: 'assistant', text: 'Newest original must remain readable' });
  const rows = f.read().messages;
  assert.equal(rows.at(-1).text, 'Newest original must remain readable'); assert.equal(rows[0].textOmitted, true); assert.equal(rows[0].text, null);
});
test('disconnected, stopped and exited runtimes never advertise phone send readiness', async t => {
  const f = await fixture(t); assert.equal(f.read().canSend, true);
  for (const flag of ['transportDisconnected', 'stopped', 'backendExitConfirmed']) { f.r[flag] = true; assert.equal(f.read().canSend, false); f.r[flag] = false; assert.equal(f.read().canSend, true); }
});
test('a new phone human input invalidates a native guard retained from the earlier desktop instruction', async t => {
  const f = await fixture(t); let earlier;
  f.r.send = async (_text, tag, guard) => { earlier = guard; f.r.emit('submitted', tag); f.r.emit('state', 'idle'); f.s.pendingTag = null; };
  await f.w.send(f.id, 'Earlier desktop input', 'desktop-owner'); assert.equal(earlier(), true);
  const oldGuard = earlier;
  await f.w.mobileSend(f.ticket('send'), f.spec('New explicit phone input'));
  assert.equal(oldGuard(), false); assert.equal(f.s.owner, 'desktop-owner');
});
test('storage state changed during reservation cannot become native input, and both surfaces say not-sent', async t => {
  const f = await fixture(t), spec = f.spec(), persist = f.w.persist.bind(f.w);
  let saves = 0;
  f.w.persist = () => { persist(); if (++saves === 2) f.w.storageWarning = 'Synthetic post-save failure'; };
  const result = await f.w.mobileSend(f.ticket('send'), spec);
  assert.equal(result.status, 'not-sent'); assert.equal(f.s.messages.at(-1).status, 'not-sent'); assert.equal(f.calls.length, 0);
});
test('an ambiguous native-send failure stays unconfirmed on desktop and phone and is never retried', async t => {
  const f = await fixture(t), spec = f.spec();
  f.r.send = async (text, tag, valid) => { assert.equal(valid(), true); f.calls.push({ text, tag }); throw Error('Synthetic native result lost after invocation'); };
  const result = await f.w.mobileSend(f.ticket('send'), spec);
  assert.equal(f.calls.length, 1); assert.equal(result.status, 'unconfirmed'); assert.equal(f.s.messages.at(-1).status, 'unconfirmed');
  assert.equal(result.error, 'Synthetic native result lost after invocation');
  assert.deepEqual(await f.w.mobileSend(f.ticket('send'), spec), result); assert.equal(f.calls.length, 1);
});
test('preparing saves a receipt but performs no human intervention, and duplicates get no lease', async t => {
  const f = await fixture(t), client = {}, spec = f.spec(), control = f.s.controlRevision;
  f.w.setDraft(f.id, spec.text, 'desktop-owner');
  const ready = f.w.mobilePrepare(f.ticket('send'), spec, 'send', client);
  assert.equal(ready.prepared, true); assert.equal(typeof ready.lease, 'string'); assert.equal(ready.receipt.status, 'prepared');
  assert.equal(f.s.controlRevision, control); assert.equal(f.calls.length, 0); assert.equal(f.s.messages.length, 0); assert.equal(f.w.drafts.get(f.id), spec.text);
  const bytes = fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8');
  const duplicate = f.w.mobilePrepare(f.ticket('send'), spec, 'send', {});
  assert.deepEqual(duplicate, { receipt: ready.receipt }); assert.equal(Object.hasOwn(duplicate, 'lease'), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8'), bytes); assert.equal(f.s.controlRevision, control);
});
test('the private commit is bound to its original client and cannot replace the prepared body', async t => {
  const f = await fixture(t), client = {}, spec = f.spec(), original = spec.text;
  const ready = f.w.mobilePrepare(f.ticket('send'), spec, 'send', client);
  assert.throws(() => f.w.mobileCommit(f.ticket('send'), ready.lease, 'send', {})); assert.equal(f.calls.length, 0);
  spec.text = 'Changed after prepare';
  const result = await f.w.mobileCommit(f.ticket('send'), ready.lease, 'send', client);
  assert.equal(result.status, 'submitted'); assert.equal(result.tag, ready.receipt.tag); assert.equal(f.calls[0].text, original);
  assert.deepEqual(await f.w.mobileCommit(f.ticket('send'), ready.lease, 'send', client), result); assert.equal(f.calls.length, 1);
});
test('a successful new pairing preparation drops the old receipt namespace before lease pruning', async t => {
  const f = await fixture(t), client = {}, spec = f.spec(), oldTicket = f.ticket('send');
  const old = f.w.mobilePrepare(oldTicket, spec, 'send', client);
  const actor = 'synthetic-human', origin = 'https://mobile.invalid';
  const qr = f.access.beginPairing({ actor, origin, scopes: [{ ...f.target, actions: ['read', 'send', 'answer'] }], replace: true });
  const device = f.access.pair({ secret: qr.secret, actor, origin });
  const ticket = f.access.authorize({ token: device.cookieValue, actor, origin, csrf: device.csrf, action: 'send', target: f.target });
  assert.throws(() => f.w.mobileCommit(oldTicket, old.lease, 'send', client));
  assert.throws(() => f.w.mobileReceipt(oldTicket, spec, 'send'));
  assert.equal(f.w.mobileReceipt(ticket, spec, 'send'), null, 'The new device cannot read the old namespace');
  const next = { ...spec, requestId: randomUUID() }, ready = f.w.mobilePrepare(ticket, next, 'send', client);
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8')).mobileRequests;
  assert.equal(stored.length, 1); assert.equal(stored[0].requestId, next.requestId); assert.equal(stored[0].status, 'prepared');
  assert.equal(stored[0].deviceId, ticket.deviceId); assert.equal(stored[0].generation, ticket.generation);
  assert.equal(stored.some(r => r.requestId === spec.requestId), false);
  assert.throws(() => f.w.mobileCommit(ticket, old.lease, 'send', client));
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  assert.deepEqual(reopened.mobileRequests.map(r => [r.requestId, r.status]), [[next.requestId, 'unconfirmed']]);
  assert.equal(ready.prepared, true); assert.equal(f.calls.length, 0); assert.equal(reopened.runtimes.size, 0);
});
test('an expired preparation is definitely not-sent without invoking native', async t => {
  const f = await fixture(t), client = {}, ready = f.w.mobilePrepare(f.ticket('send'), f.spec(), 'send', client), real = process.hrtime.bigint;
  try {
    process.hrtime.bigint = () => real() + BigInt(mobile.PREPARE_MS + 1) * 1000000n;
    const result = f.w.mobileCommit(f.ticket('send'), ready.lease, 'send', client);
    assert.equal(result.status, 'not-sent'); assert.equal(f.calls.length, 0);
  } finally { process.hrtime.bigint = real; }
});
test('an expired preparation is not-sent on receipt reads and duplicate prepares without a commit', async t => {
  const f = await fixture(t), client = {}, spec = f.spec(), ready = f.w.mobilePrepare(f.ticket('send'), spec, 'send', client), real = process.hrtime.bigint;
  const saved = fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8'), control = f.s.controlRevision;
  assert.equal(f.w.mobileReceipt(f.ticket('send'), spec, 'send').status, 'prepared');
  try {
    process.hrtime.bigint = () => real() + BigInt(mobile.PREPARE_MS + 1) * 1000000n;
    const receipt = f.w.mobileReceipt(f.ticket('send'), spec, 'send');
    assert.equal(receipt.status, 'not-sent'); assert.equal(receipt.tag, ready.receipt.tag); assert.match(receipt.error, /过期/);
    assert.deepEqual(f.w.mobilePrepare(f.ticket('send'), spec, 'send', {}), { receipt });
    assert.equal(f.calls.length, 0); assert.equal(f.s.controlRevision, control);
    assert.equal(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8'), saved, 'Receipt derivation never writes or renews the reservation');
  } finally { process.hrtime.bigint = real; }
});
test('disconnect durably marks an unused preparation not-sent before any unrelated write', async t => {
  const f = await fixture(t), client = {}, spec = f.spec(), ready = f.w.mobilePrepare(f.ticket('send'), spec, 'send', client);
  const stored = () => JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8')).mobileRequests.find(r => r.requestId === spec.requestId);
  assert.equal(stored().status, 'prepared');
  client.destroyed = true; f.w.mobileDisconnected(client);
  assert.equal(stored().status, 'not-sent', 'Read disk immediately; commit, socket release and fixture cleanup cannot mask a missing save');
  assert.equal(stored().tag, ready.receipt.tag); assert.equal(f.calls.length, 0);
});
test('disconnect invalidates only uncommitted preparations, never accepted native work', async t => {
  const f = await fixture(t), client = {}, ready = f.w.mobilePrepare(f.ticket('send'), f.spec(), 'send', client);
  client.destroyed = true; f.w.mobileDisconnected(client);
  assert.equal((await f.w.mobileCommit(f.ticket('send'), ready.lease, 'send', client)).status, 'not-sent'); assert.equal(f.calls.length, 0);
  const other = await fixture(t), connected = {}, next = other.w.mobilePrepare(other.ticket('send'), other.spec(), 'send', connected); let finish;
  other.r.send = (text, tag, valid) => { assert.equal(valid(), true); other.calls.push({ text, tag }); return new Promise(resolve => { finish = () => { assert.equal(valid(), true); other.r.emit('submitted', tag); resolve(); }; }); };
  const pending = other.w.mobileCommit(other.ticket('send'), next.lease, 'send', connected);
  connected.destroyed = true; other.w.mobileDisconnected(connected); finish();
  assert.equal((await pending).status, 'submitted'); assert.equal(other.calls.length, 1);
});
test('a prepared row after restart stays unconfirmed and its private lease cannot be reconstructed', async t => {
  const f = await fixture(t), client = {}, spec = f.spec(), ready = f.w.mobilePrepare(f.ticket('send'), spec, 'send', client);
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  assert.throws(() => reopened.mobileCommit(f.ticket('send'), ready.lease, 'send', client));
  const result = await reopened.mobileSend(f.ticket('send'), spec);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.tag, ready.receipt.tag); assert.equal(reopened.runtimes.size, 0);
});
test('question preflight validates without consuming the original question or intervening', async t => {
  const f = await fixture(t), q = codexQuestion(f), client = {}, control = f.s.controlRevision;
  assert.throws(() => f.w.mobilePrepare(f.ticket('answer'), { ...q.spec, answers: { q: ['Invalid'] } }, 'answer', client));
  assert.equal(f.w.mobileRequests.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.s.controlRevision, control);
  const ready = f.w.mobilePrepare(f.ticket('answer'), q.spec, 'answer', client);
  assert.equal(f.calls.length, 0); assert.equal(q.route.approval.pending, undefined); assert.equal(f.s.controlRevision, control);
  q.route.approval.pending = true;
  assert.equal(f.w.mobileCommit(f.ticket('answer'), ready.lease, 'answer', client).status, 'not-sent'); assert.equal(f.calls.length, 0);
});
test('explicit precommit cancellation is a receipt, and cancellation cannot retract a committed send', async t => {
  const f = await fixture(t), client = {}, ready = f.w.mobilePrepare(f.ticket('send'), f.spec(), 'send', client);
  assert.equal(f.w.mobileCancel(f.ticket('send'), ready.lease, 'send', client).status, 'not-sent');
  assert.equal((await f.w.mobileCommit(f.ticket('send'), ready.lease, 'send', client)).status, 'not-sent'); assert.equal(f.calls.length, 0);
  const other = await fixture(t), connected = {}, next = other.w.mobilePrepare(other.ticket('send'), other.spec(), 'send', connected);
  const result = await other.w.mobileCommit(other.ticket('send'), next.lease, 'send', connected);
  assert.deepEqual(other.w.mobileCancel(other.ticket('send'), next.lease, 'send', connected), result); assert.equal(other.calls.length, 1);
});
test('a new backend after commit prevents the actual late Claude native authorization', async t => {
  const f = await fixture(t, 'claude'), channel = new SubmissionChannel(); t.after(() => channel.close());
  channel.connected = true; let delivered; channel.poll = { end: bytes => { delivered = JSON.parse(bytes); } };
  f.r.send = (text, tag, guard) => channel.request(text, tag, guard);
  const client = {}, ready = f.w.mobilePrepare(f.ticket('send'), f.spec(), 'send', client);
  const sending = f.w.mobileCommit(f.ticket('send'), ready.lease, 'send', client); assert.ok(delivered?.text);
  const key = 'backends/' + 'a'.repeat(20); fs.mkdirSync(path.join(f.root, key), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(f.root, 'backends'), 0o700);
  writeLayout(f.root, { format: 1, active: '.', entries: ['.', key] });
  assert.equal(channel.authorize(delivered), false); channel.finish(Error('Synthetic backend set changed before authorize'));
  assert.equal((await sending).status, 'not-sent');
});
test('a Codex native-reply failure after invocation is unconfirmed without a second native reply', async t => {
  const f = await fixture(t), q = codexQuestion(f), before = f.s.messages.length;
  f.host.rpc.reply = (...args) => { f.calls.push(args); throw Error('Synthetic Codex reply result lost'); };
  const result = f.w.mobileAnswer(f.ticket('answer'), q.spec);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.error, 'Synthetic Codex reply result lost'); assert.equal(f.calls.length, 1);
  assert.equal(f.s.messages.length, before, 'Question audit must not fabricate a model user turn');
  assert.deepEqual(f.w.mobileAnswer(f.ticket('answer'), q.spec), result); assert.equal(f.calls.length, 1);
});
test('a Claude held-reply failure after release stays unconfirmed instead of encouraging a new input', async t => {
  const f = await fixture(t, 'claude');
  f.w.holdQuestion(f.s, f.r, { questions: [{ question: 'Original question?', options: [{ label: 'A', description: 'A' }] }], open: () => true,
    reply: value => { f.calls.push(value); throw Error('Synthetic Claude held reply result lost'); } });
  const q = f.read().question, spec = { requestId: randomUUID(), proof: f.read().proof, questionId: q.requestId, answers: { 'Original question?': ['A'] } };
  const result = f.w.mobileAnswer(f.ticket('answer'), spec);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.error, 'Synthetic Claude held reply result lost'); assert.equal(f.calls.length, 1);
  assert.equal(f.w.claudeAsks.has(f.id), false); assert.deepEqual(f.w.mobileAnswer(f.ticket('answer'), spec), result); assert.equal(f.calls.length, 1);
});
test('positive native acceptance remains submitted if a later transport result is lost', async t => {
  const f = await fixture(t), spec = f.spec();
  f.r.send = async (text, tag, valid) => { assert.equal(valid(), true); f.calls.push({ text, tag }); f.r.emit('submitted', tag); throw Error('Synthetic later transport error'); };
  const result = await f.w.mobileSend(f.ticket('send'), spec);
  assert.equal(result.status, 'submitted'); assert.equal(f.s.messages.at(-1).status, 'submitted'); assert.equal(result.error, 'Synthetic later transport error');
  assert.deepEqual(await f.w.mobileSend(f.ticket('send'), spec), result); assert.equal(f.calls.length, 1);
});
