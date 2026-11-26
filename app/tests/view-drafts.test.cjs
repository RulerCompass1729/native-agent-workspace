const test = require('node:test'), assert = require('node:assert/strict');
const { backups, beginDraft, acknowledgeDraft, acceptSentDraft, forgetDraft, retainRecovery, discardRecovery, returnCopy, returnWindow } = require('../view-drafts.cjs');

test('legacy window drafts are retained as unconfirmed copies, including after serialization', () => {
  const view = { draft: { id: 'session', text: 'older private draft' } };
  assert.deepEqual(backups(view).session, { text: 'older private draft', acknowledged: false });
  const disk = JSON.parse(JSON.stringify(view));
  assert.deepEqual(backups(disk), backups(view));
});

test('a late save or send cannot erase a newer edit, including identical retyped text', () => {
  const view = {}, old = beginDraft(view, 'a', 'same text');
  const newer = beginDraft(view, 'a', 'same text');
  assert.equal(acknowledgeDraft(view, 'a', old), false);
  assert.equal(acceptSentDraft(view, 'a', old, 'same text'), false);
  assert.equal(backups(view).a.acknowledged, false);
  assert.equal(acknowledgeDraft(view, 'a', newer), true);
  assert.equal(acceptSentDraft(view, 'a', newer, 'same text'), true);
  assert.equal(backups(view).a.text, '');
});

test('switching sessions retains unresolved copies and accepting one send only clears that session', () => {
  const view = {}, a = beginDraft(view, 'a', 'draft A');
  beginDraft(view, 'b', 'draft B');
  assert.equal(acceptSentDraft(view, 'a', a, 'draft A'), true);
  assert.equal(backups(view).b.text, 'draft B');
  assert.deepEqual(view.draft, { id: 'b', text: 'draft B' });
  forgetDraft(view, 'b');
  assert.equal(Object.hasOwn(backups(view), 'b'), false);
  assert.equal(view.draft, undefined);
});

test('unresolved recovery copies survive later normal editing/sending and only explicit removal clears a chosen copy', () => {
  const view = {};
  beginDraft(view, 'a', 'rejected A'); retainRecovery(view, 'a', 'rejected A');
  const edited = beginDraft(view, 'a', 'new normal draft'); acknowledgeDraft(view, 'a', edited);
  retainRecovery(view, 'a', 'other recovery');
  acceptSentDraft(view, 'a', edited, 'new normal draft');
  const restored = JSON.parse(JSON.stringify(view));
  assert.deepEqual(backups(restored).a.recoveries, ['rejected A', 'other recovery']);
  assert.deepEqual(discardRecovery(restored, 'a', 'rejected A'), ['other recovery']);
  assert.equal(backups(restored).a.text, '');
  const acknowledged = beginDraft(restored, 'b', 'memory ack only'); acknowledgeDraft(restored, 'b', acknowledged);
  retainRecovery(restored, 'b', 'memory ack only'); discardRecovery(restored, 'b', 'memory ack only');
  assert.equal(backups(restored).b.discarded, true, 'A discarded copy must not reappear after a service recovery');
  assert.deepEqual(retainRecovery(restored, 'b', 'memory ack only'), [], 'Late state/ACK cannot revive the same discarded edit');
  beginDraft(restored, 'b', 'memory ack only');
  assert.deepEqual(retainRecovery(restored, 'b', 'memory ack only'), ['memory ack only'], 'A new actual edit can independently need recovery even when text is identical');
});

test('words given back after a handoff become a copy of that session\'s draft, also for a session never typed into here, once each', () => {
  const view = {};
  assert.deepEqual(returnCopy(view, 'b', 'held words'), ['held words']);
  assert.deepEqual(returnCopy(view, 'b', 'held words'), ['held words'], 'given back twice, kept once');
  assert.equal(backups(view).b.text, '', 'the draft itself is left as it was');
  beginDraft(view, 'a', 'typing');
  assert.deepEqual(returnCopy(view, 'a', 'older'), ['older']);
  assert.equal(backups(view).a.text, 'typing');
  assert.equal(Object.hasOwn(backups(view), '__proto__'), false);
  assert.deepEqual(returnCopy(view, '__proto__', 'x'), ['x']);
  assert.equal(Object.getPrototypeOf(backups(view)), Object.prototype, 'an id is never a prototype');
});

test('words go back to the open window they came from, else to another open one: a closed window never returns', () => {
  const a = { view: { owner: 'owner-a' } }, b = { view: { owner: 'owner-b' } };
  assert.equal(returnWindow([a, b], 'owner-b'), b);
  assert.equal(returnWindow([a], 'owner-b'), a, 'from a window that was closed');
  assert.equal(returnWindow([], 'owner-b'), null, 'no window open: asked again');
});
