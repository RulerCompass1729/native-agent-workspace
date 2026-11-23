const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const locale = require('../ui-locale.js'), messages = require('../ui-messages.js');

test('a desktop warning persists, follows state and language, opens the existing log without taking focus', () => {
  const start = source.indexOf('function renderStewardWakeWarning('), end = source.indexOf('  // A saved full-page records view', start);
  const p = { textContent: '' }, button = { textContent: '' }, step = { hidden: true }, parts = { p, '.steward-wake-step': step, '.steward-wake-record': button };
  const box = { hidden: true, querySelector: selector => parts[selector] };
  let opens = 0;
  const context = vm.createContext({ state: {}, rendering: false, disconnected: false, $: () => box, stewardSteps: { open: () => { opens++; } }, uiText: (k, v) => locale.format('zh', k, v) });
  vm.runInContext(source.slice(start, end) + '\n}', context);
  context.render(); assert.equal(box.hidden, true);
  for (const language of ['zh', 'en']) {
    context.uiText = (k, v) => locale.format(language, k, v);
    context.state = { stewardWakeStatus: { minutes: 12, reason: 'source-unavailable' } };
    context.render();
    assert.equal(box.hidden, false);
    assert.match(p.textContent, /12/u);
    assert.ok(p.textContent.includes(locale.format(language, 'stewardWake.reason.source-unavailable')));
    assert.equal(button.textContent, locale.format(language, 'stewardWake.openRecord'));
    assert.equal(step.hidden, true, 'no step of the person\'s for an ordinary reason');
    button.onclick();
    context.render(); assert.equal(box.hidden, false);
    context.state = { stewardWakeStatus: null }; context.render(); assert.equal(box.hidden, true);
  }
  assert.equal(opens, 2);
});

test('a disconnected backend cannot hide a wake alert: the existing page receives metadata without an initial query', () => {
  const main = fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8');
  const start = main.indexOf('function stewardWakeChanged() {'), end = main.indexOf('\nfunction ', start + 1);
  const blocked = { since: 1000, minutes: 12, reason: 'source-unavailable' }, sent = [];
  let records = 0;
  const context = vm.createContext({ stewardWake: { view: () => ({ blocked }) }, windows: new Map([['person', { client: { call: () => { throw Error('disconnected'); } } }]]),
    sendToPage: (...args) => sent.push(args), recordsChanged: force => { assert.equal(force, true); records++; } });
  vm.runInContext(main.slice(start, end), context);
  context.stewardWakeChanged();
  assert.equal(sent.length, 1); assert.equal(sent[0][1], 'workspace:steward-wake'); assert.equal(sent[0][2], blocked);
  assert.equal(records, 1);
  const r = vm.createContext({ state: null, renderStewardWakeWarning: value => sent.push(value), api: { onStewardWake: callback => { callback(blocked); } } });
  vm.runInContext(source.split('\n').find(line => line.includes('api.onStewardWake(status =>')).trim().replace(/,$/u, ''), r);
  assert.equal(sent.at(-1), blocked, 'also visible before an initial snapshot can load');
});

test('the warning is a live status with a native keyboard button and every fixed reason is bilingual', () => {
  const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
  assert.match(html, /<aside id="steward-wake-warning"[^>]*role="status"[^>]*hidden><p><\/p><div class="steward-wake-actions"><button type="button" class="steward-wake-step primary" hidden><\/button><button type="button" class="steward-wake-record"/u);
  for (const reason of require('../steward-wake.cjs').BLOCK_REASONS) for (const language of ['zh', 'en']) {
    assert.ok(messages[language][`stewardWake.reason.${reason}`], `${language} ${reason}`);
  }
});
