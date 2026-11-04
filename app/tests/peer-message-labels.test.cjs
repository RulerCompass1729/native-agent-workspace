const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const take = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); };
const functions = take('function sessionShortId(', 'async function moveSidebarSession(') +
  take('function participantLabel(', 'function timeline()');
const sender = 'abcdef00-0000-4000-8000-000000000001', recipient = 'fedcba00-0000-4000-8000-000000000002';
const record = (id, name, provider = 'claude') => ({ id, name, provider });
const message = () => ({ id: 'recorded-peer', role: 'system', kind: 'agent-peer', text: 'EXACT ORIGINAL 中文 <body>',
  peerMessage: { senderId: sender, senderName: 'Stored name', recipientId: recipient, recipientName: 'Receiver' } });
function label(lang, sessions, row) {
  const original = JSON.stringify(row), context = { state: { sessions }, ui: { displayText: value => value }, uiText: (key, params) => locale.format(lang, key, params) };
  vm.createContext(context); vm.runInContext(functions, context);
  const result = context.roomMessageLabel(row);
  assert.equal(JSON.stringify(row), original, 'Formatting cannot alter the stored peer row or original body');
  return result;
}
for (const lang of ['en', 'zh']) {
  test(lang + ': a removed recorded sender retains its ID and unverified status', () => {
    const result = label(lang, [record(recipient, 'Receiver')], message());
    assert.equal(result, locale.format(lang, 'identity.unverifiedSender', { name: 'Stored name · abcdef', recipient: 'Receiver' }));
  });
  test(lang + ': both removed endpoints retain their recorded identity', () => {
    assert.equal(label(lang, [], message()), locale.format(lang, 'identity.unverifiedSender', { name: 'Stored name · abcdef', recipient: 'Receiver · fedcba' }));
  });
  test(lang + ': unmapped names stay quoted without an invented ID', () => {
    const row = message(); row.peerMessage.senderId = null;
    assert.equal(label(lang, [record(recipient, 'Receiver')], row), locale.format(lang, 'identity.unverifiedSender', { name: '「Stored name」', recipient: 'Receiver' }));
  });
  test(lang + ': an active sender keeps its current name and existing collision-aware ID behavior', () => {
    const sessions = [record(sender, 'Live name'), record(recipient, 'Live name', 'codex'),
      record('abcdef11-0000-4000-8000-000000000003', 'Other')];
    assert.equal(label(lang, sessions, message()), locale.format(lang, 'identity.unverifiedSender', {
      name: 'Live name · Claude · abcdef0', recipient: 'Live name · Codex · fedcba' }));
  });
}
