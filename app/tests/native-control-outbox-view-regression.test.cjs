const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const file = process.env.NAW_TEST_OUTBOX_VIEW_SOURCE || path.resolve(__dirname, '../computer-use-outbox-view.cjs');
const source = fs.readFileSync(file, 'utf8');
const loaded = { exports: {} };
const denied = () => { throw Error('Page-only regression must not allocate files, browsers or processes'); };
vm.runInNewContext(Module.wrap(source), {}, { filename: file })(loaded.exports, spec => {
  assert.match(spec, /^node:/, 'Review any new page module dependency explicitly');
  if (spec === 'node:child_process') return { spawn: denied };
  if (spec === 'node:fs') return { ...fs, mkdtempSync: denied, mkdirSync: denied,
    writeFileSync: denied, chmodSync: denied, rmSync: denied };
  return require(spec);
}, loaded, file, path.dirname(file));
const { outboxHTML: html, projectOutboxFacts } = loaded.exports;
assert.equal(typeof html, 'function'); assert.equal(typeof projectOutboxFacts, 'function');

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

test('projection preserves approved CRLF only for an unchanged DOM value and cannot invent readiness', { timeout: 1000 }, () => {
  const model = { recipient: { id: 'receiver' }, spaceId: 'shared', text: '  First\r\n\tSecond  ' };
  const grant = { callerValid: true, nativeId: 'receiver-native', memberRevision: 3, ready: true };
  const facts = { recipientId: 'receiver', body: model.text.replace(/\r\n?/g, '\n'), revision: '1', ready: true };
  const observed = projectOutboxFacts(model, grant, facts, 'owned-view');
  assert.equal(observed.body, model.text); assert.equal(observed.recipientId, 'receiver');
  assert.equal(observed.owner, 'owned-view'); assert.equal(observed.nativeId, grant.nativeId);
  const edited = facts.body + ' CHANGED';
  assert.equal(projectOutboxFacts(model, grant, { ...facts, body: edited }, 'owned-view').body, edited);
  assert.equal(projectOutboxFacts(model, { ...grant, ready: false }, facts, 'owned-view').ready, false);
});
