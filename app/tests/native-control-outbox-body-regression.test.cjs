const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const app = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const source = process.env.NAW_TEST_OUTBOX_SOURCE || path.join(app, 'computer-use-outbox.cjs');
const { validateArgs } = require(path.join(app, 'session-wake.cjs'));

// Stop at the dedicated view boundary. Accepting a body here is not a lease,
// browser typing, send, native receipt or first-command qualification.
async function probe(text) {
  const views = []; let leases = 0, forwards = 0, watches = 0;
  const module = { exports: {} };
  vm.runInThisContext(Module.wrap(fs.readFileSync(source, 'utf8')), { filename: source })(module.exports, id => {
    if (id === './native-computer-use.cjs') return { createComputerUseViewLease: async () => {
      leases++; throw Error('Unexpected lease after controlled view stop');
    } };
    assert.equal(id, 'node:crypto'); return require(id);
  }, module, source, path.dirname(source));
  await assert.rejects(module.exports.openOutbox({ callerId: 'caller', callerNativeId: 'native-caller',
    spaceId: 'shared', recipientId: 'receiver', recipientName: 'Receiver', nativeId: 'native-receiver',
    memberRevision: 4, text }, {
    createView: async payload => { views.push(payload); throw Error('Controlled view boundary stop'); },
    forwardOnce: async () => { forwards++; throw Error('Unexpected forward'); },
    watchReceipt: async () => { watches++; throw Error('Unexpected subscription'); },
  }));
  assert.equal(leases, 0); assert.equal(forwards, 0); assert.equal(watches, 0);
  return views;
}

for (const [label, body] of [
  ['single-line witness', 'Read  the exact task 中文 🙂.'],
  ['LF paragraphs', 'Read  the exact task 中文 🙂.\n\nKeep the second paragraph.\n'],
  ['CRLF body', 'First line.\r\nSecond  line 中文.\r\n'],
]) {
  test('native-approved ' + label + ' reaches the dedicated outbox view unchanged', { timeout: 1000 }, async () => {
    assert.doesNotThrow(() => validateArgs({ recipient_id: 'receiver', message: body }));
    const views = await probe(body);
    assert.equal(views.length, 1, 'An approved native body must reach its authorized view without flattening or dropping it.');
    assert.equal(views[0].text, body);
    assert.deepEqual(views[0].recipient, { id: 'receiver', label: 'Receiver' });
    assert.equal(views[0].spaceId, 'shared');
    assert.deepEqual(Object.keys(views[0]).sort(), ['recipient', 'requestId', 'spaceId', 'text']);
  });
}

test('invalid NUL body stays refused before any dedicated view or transport', { timeout: 1000 }, async () => {
  const body = 'Invalid\0body';
  assert.throws(() => validateArgs({ recipient_id: 'receiver', message: body }));
  assert.deepEqual(await probe(body), []);
});
