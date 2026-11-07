const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const file = process.env.NAW_TEST_OUTBOX_VIEW_SOURCE || path.resolve(__dirname, '../computer-use-outbox-view.cjs');
const { outboxHTML: html } = require(file);
assert.equal(typeof html, 'function', 'Use the exported production page entry point.');

function page(text = 'One  approved task 中文 🙂.\nKeep the paragraph.') {
  const model = { requestId: 'owned-request', spaceId: 'shared', recipient: { id: 'receiver', label: 'Receiver <literal>' }, text };
  const output = html(model, 'owned-nonce');
  const scripts = [...output.matchAll(/<script nonce="owned-nonce">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const elements = Object.fromEntries(['recipient-label', 'shared-input', 'forward-button', 'receipt'].map(id => {
    const element = { value: '', textContent: '', readOnly: false, disabled: false };
    Object.defineProperty(element, 'innerHTML', { set() { throw Error('Raw HTML sink is forbidden in this fixture'); } });
    return [id, element];
  }));
  // These are property-level page tests, not a browser DOM. In particular they
  // do not qualify textarea newline normalization, layout, focus or real input.
  const context = vm.createContext({ window: {}, document: { getElementById(id) {
    assert.ok(elements[id], 'Only the dedicated composer controls may be read'); return elements[id];
  } } });
  vm.runInContext(scripts[0][1], context, { filename: file + ':embedded-page' });
  return { model, output, elements, window: context.window, context };
}

test('dedicated page exposes its exact recipient and approved body as text', { timeout: 1000 }, () => {
  const f = page(), facts = f.window.outboxFacts();
  assert.equal(f.elements['recipient-label'].textContent, '收件人：' + f.model.recipient.label);
  assert.equal(f.elements['shared-input'].value, f.model.text);
  assert.equal(facts.recipientId, f.model.recipient.id); assert.equal(facts.body, f.model.text);
  assert.equal(facts.ready, true); assert.equal(f.window.takeOutboxSend(), false);
});

test('hostile message text cannot terminate the page script or become markup', { timeout: 1000 }, () => {
  const text = '</script><script>globalThis.INJECTED=true</script>\n中文 & "literal"';
  const f = page(text);
  assert.equal((f.output.match(/<\/script>/gi) || []).length, 1);
  assert.equal(f.elements['shared-input'].value, text);
  assert.equal(f.window.outboxFacts().body, text);
});

test('one click yields one consumable send intent and repeated clicks cannot rearm it', { timeout: 1000 }, () => {
  const f = page(), before = f.window.outboxFacts().revision, button = f.elements['forward-button'];
  button.onclick(); button.onclick();
  assert.equal(button.disabled, true); assert.equal(f.elements['shared-input'].readOnly, true);
  assert.notEqual(f.window.outboxFacts().revision, before); assert.equal(f.window.outboxFacts().ready, false);
  assert.equal(f.window.takeOutboxSend(), true); assert.equal(f.window.takeOutboxSend(), false);
  button.onclick(); assert.equal(f.window.takeOutboxSend(), false);
  assert.equal(f.window.outboxFacts().body, f.model.text);
});

test('page facts report body edits and receipt rendering leaves the approved input intact', { timeout: 1000 }, () => {
  const f = page(), before = f.window.outboxFacts().revision;
  f.elements['shared-input'].value += ' CHANGED';
  assert.notEqual(f.window.outboxFacts().revision, before);
  assert.equal(f.window.outboxFacts().body, f.model.text + ' CHANGED');
  const receipt = { status: 'unconfirmed', nativeReceived: false, firstCommand: null, detail: '<img src=untrusted>' };
  f.window.showOutboxReceipt(receipt);
  assert.equal(f.elements.receipt.textContent, JSON.stringify(receipt));
  assert.equal(f.elements['shared-input'].value, f.model.text + ' CHANGED');
  assert.equal(f.window.takeOutboxSend(), false);
});
