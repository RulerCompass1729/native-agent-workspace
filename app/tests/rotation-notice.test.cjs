'use strict';
// main.cjs's own notifyRotation: the OS notice of a rotation that did not finish gives its reason in the person's
// language, never the code it was recorded with (the 11-14 drill showed 「（person-active）」).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const uiLocale = require('../ui-locale.js');
const queueRules = require('../queue-dispatch.cjs');

const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const start = main.indexOf('function notifyRotation(');
const end = main.indexOf('\n// An automatic move that did not finish', start);

function notifier(language) {
  const shown = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    once() {}
    show() { shown.push(this.options); }
  }
  const displayText = (key, params) => uiLocale.format(language, key, params);
  const notify = vm.runInNewContext(`(${main.slice(start, end)})`, { queueRules, displayText, Notification, focusOrOpen() {} });
  return { shown, notify };
}

test('the OS notice of a rotation that did not finish gives its reason in the person\'s language, never the code', () => {
  assert.ok(start > 0 && end > start, 'main.cjs still has notifyRotation');
  for (const [language, using, sentence] of [['zh', '你正在用这个会话', '旧会话没有回复。'], ['en', 'you were using this session', 'The old session did not answer.']]) {
    const { shown, notify } = notifier(language);
    notify('failed', { name: 'A', reason: 'person-active' });
    notify('failed', { name: 'A', reason: 'handoff-request-timeout' });
    notify('failed', { name: 'A', reason: 'a-code-added-later' });
    notify('failed', { name: 'A', reason: sentence });
    assert.equal(shown.length, 4);
    assert.ok(shown[0].body.includes(using), shown[0].body);
    for (const notice of shown.slice(0, 3)) {
      assert.doesNotMatch(notice.body, /person-active|handoff-request|a-code-added-later/, notice.body);
    }
    assert.ok(shown[3].body.includes(sentence), 'a reason already written as a sentence is shown as it is');
  }
});
