const test = require('node:test');
const assert = require('node:assert/strict');
const { createComputerUseViewGate } = require('../native-computer-use.cjs');

const body = '[Task] Keep  two spaces; English, \u4e2d\u6587 \ud83d\ude42\nSecond line: exact.';
function fixture({ prefilled = false, corrupt = false, failReadback = false } = {}) {
  const grant = { owner: 'owned', spaceId: 'shared', recipientId: 'receiver', nativeId: 'native-receiver', memberRevision: 1, text: body };
  const facts = { ...grant, selected: 'room', surface: 'records', revision: '0', ready: true, body: prefilled ? body : '' };
  let writes = 0, sends = 0, revoked = 0;
  const calls = [];
  const gate = createComputerUseViewGate({ grant, onRevoke: () => revoked++,
    inspect: async () => { if (failReadback && writes) throw Error('owned readback unavailable'); return { ...facts }; },
    target: async ref => ({ id: ref === 'e1' ? 'shared-input' : 'forward-button', kind: ref === 'e1' ? 'other' : 'send', visible: true }),
    invoke: async (name, args) => {
      calls.push({ name, args });
      if (name === 'browser_snapshot') return { content: [{ type: 'text', text: '### Snapshot\n```yaml\n- textbox "Task" [ref=e1]\n- button "Send" [ref=e2]\n```' }] };
      if (name === 'browser_type') { writes++; facts.body = corrupt ? body.replace('  ', '') : args.text; facts.revision += 'x'; }
      else if (args.target === 'e2') sends++;
      return { content: [{ type: 'text', text: 'ACK only' }] };
    } });
  const action = async (name, target, text) => {
    const snap = JSON.parse((await gate.call('browser_snapshot')).content[0].text).snapshot;
    return gate.call(name, { snapshot: snap, target, ...(text === undefined ? {} : { text }) });
  };
  return { gate, facts, calls, action, counts: () => ({ writes, sends, revoked }) };
}
test('an already bound literal body is observed without typing or IME-dependent key synthesis', async () => {
  const f = fixture({ prefilled: true });
  const result = JSON.parse((await f.action('browser_type', 'e1', body)).content[0].text);
  assert.equal(result.outcome, 'postcondition_observed');
  assert.equal(result.mutationDispatched, false);
  assert.equal(result.delivery, 'unconfirmed');
  assert.deepEqual(f.counts(), { writes: 0, sends: 0, revoked: 0 });
  await f.action('browser_click', 'e2');
  assert.equal(f.facts.body, body);
  assert.deepEqual(f.counts(), { writes: 0, sends: 1, revoked: 0 });
  await assert.rejects(f.action('browser_click', 'e2'));
  assert.equal(f.counts().sends, 1);
});
test('necessary replacement uses one stock whole-field fill, never slow key typing or Enter', async () => {
  const f = fixture(); await f.action('browser_type', 'e1', body);
  const call = f.calls.find(c => c.name === 'browser_type');
  assert.deepEqual(call.args, { target: 'e1', element: 'Authorized space composer', text: body, submit: false, slowly: false });
  assert.equal(f.facts.body, body);
  await f.action('browser_click', 'e2');
  assert.deepEqual(f.counts(), { writes: 1, sends: 1, revoked: 0 });
});
test('the existing @ mention key-handler path stays intact before replacing the full task body', async () => {
  const f = fixture(); await f.action('browser_type', 'e1', '@');
  const prefix = f.calls.find(c => c.name === 'browser_type');
  assert.equal(prefix.args.slowly, true); assert.equal(prefix.args.submit, false);
  assert.equal(f.facts.body, '@');
  await f.action('browser_type', 'e1', body);
  assert.equal(f.calls.filter(c => c.name === 'browser_type').at(-1).args.slowly, false);
  assert.equal(f.facts.body, body);
});
test('changed text or unavailable immediate readback revokes before any submit and never retries', async () => {
  for (const options of [{ corrupt: true }, { failReadback: true }]) {
    const f = fixture(options);
    await assert.rejects(f.action('browser_type', 'e1', body), /refused/);
    await assert.rejects(f.action('browser_click', 'e2'));
    await assert.rejects(f.action('browser_type', 'e1', body));
    assert.deepEqual(f.counts(), { writes: 1, sends: 0, revoked: 1 });
  }
});
test('prefilled-body optimization never bypasses recipient, draft or native identity guards', async () => {
  for (const delta of [{ nativeId: 'replacement' }, { owner: 'other' }, { memberRevision: 2 }]) {
    const f = fixture({ prefilled: true }); Object.assign(f.facts, delta);
    await assert.rejects(f.action('browser_type', 'e1', body));
    assert.deepEqual(f.counts(), { writes: 0, sends: 0, revoked: 1 });
  }
  const f = fixture({ prefilled: true }); f.facts.body = 'HUMAN_DRAFT';
  await assert.rejects(f.action('browser_type', 'e1', body));
  assert.equal(f.facts.body, 'HUMAN_DRAFT');
  assert.deepEqual(f.counts(), { writes: 0, sends: 0, revoked: 0 });
});
