const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const a = main.indexOf('function notifyButlerQuit('), b = main.indexOf('// A session rotation is announced', a);
test('quit notices reach the ordinary window and OS in the chosen language without focusing a window', () => {
  for (const language of ['zh', 'en']) {
    const sent = [], shown = [], window = { background: false }, hidden = { background: true };
    class Notification { static isSupported() { return true; } constructor(options) { this.options = options; } show() { shown.push(this.options); } }
    const context = vm.createContext({ windows: new Map([[1, window], [2, hidden]]), Notification,
      sendToPage(target, channel, key) { assert.equal(target, window); assert.equal(channel, 'workspace:quit-status'); sent.push(key); },
      displayText: key => locale.format(language, key) });
    vm.runInContext(main.slice(a, b), context);
    for (const key of ['os.butlerQuitWaiting', 'os.butlerQuitUnconfirmed']) context.notifyButlerQuit(key);
    assert.deepEqual(sent, ['os.butlerQuitWaiting', 'os.butlerQuitUnconfirmed']);
    assert.equal(shown.length, 2); assert.equal(shown[1].body, locale.format(language, sent[1]));
    if (language === 'en') assert.match(shown[1].body, /unconfirmed/); else assert.match(shown[1].body, /未确认/);
    Notification.isSupported = () => false;
    context.notifyButlerQuit('os.butlerQuitUnconfirmed'); assert.equal(sent.length, 3); assert.equal(shown.length, 2);
  }
});
test('renderer accepts only the two fixed quit messages', () => {
  const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
  const line = source.split('\n').find(value => value.trim().startsWith('api.onQuitStatus('));
  let handler; const shown = [];
  vm.runInNewContext(line.trim().replace(/,$/, ''), { api: { onQuitStatus(value) { handler = value; } }, toastMessage: key => shown.push(key) });
  handler('os.butlerQuitWaiting'); handler('os.butlerQuitUnconfirmed'); handler('untrusted raw text');
  assert.deepEqual(shown, ['os.butlerQuitWaiting', 'os.butlerQuitUnconfirmed']);
});
