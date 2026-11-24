const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const locale = require('../ui-locale.js'), messages = require('../ui-messages.js');

test('the wake chip persists, follows state and language, and opens the existing log from its detail', () => {
  const start = source.indexOf('function renderStewardWakeWarning('), end = source.indexOf('  // A saved full-page records view', start);
  const p = { textContent: '' }, button = { textContent: '' }, text = { textContent: '' }, step = { hidden: true }, summary = { setAttribute(k, v) { this[k] = v; } };
  const parts = { p, summary, '.wake-chip-text': text, '.steward-wake-step': step, '.steward-wake-record': button }, box = { hidden: true, open: false, querySelector: tag => parts[tag] };
  let opens = 0;
  const context = vm.createContext({ state: {}, rendering: false, disconnected: false, $: () => box, stewardSteps: { open: () => { opens++; } }, uiText: (k, v) => locale.format('zh', k, v) });
  vm.runInContext(source.slice(start, end) + '\n}', context);
  context.render(); assert.equal(box.hidden, true);
  for (const language of ['zh', 'en']) {
    context.uiText = (k, v) => locale.format(language, k, v);
    context.state = { stewardWakeStatus: { minutes: 12, reason: 'source-unavailable' } };
    context.render();
    const reason = locale.format(language, 'stewardWake.reason.source-unavailable');
    assert.equal(box.hidden, false);
    assert.equal(text.textContent, locale.format(language, 'stewardWake.chip', { minutes: 12 }));
    assert.ok(summary['aria-label'].includes(reason) && /12/u.test(summary['aria-label']));
    assert.ok(p.textContent.includes(reason));
    assert.equal(button.textContent, locale.format(language, 'stewardWake.openRecord'));
    assert.equal(step.hidden, true, 'no step of the person\'s for an ordinary reason');
    box.open = true; button.onclick(); assert.equal(box.open, false);
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

test('the wake chip is a live status that opens natively by keyboard and every fixed reason is bilingual', () => {
  const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
  // The chip's detail holds the person's step (R129) before the log button.
  assert.match(html, /<details id="steward-wake-chip" class="wake-chip" hidden><summary><span class="wake-chip-text" role="status"><\/span><\/summary><div class="wake-chip-detail"><p><\/p><button type="button" class="steward-wake-step primary" hidden><\/button><button type="button" class="steward-wake-record"/u);
  for (const reason of require('../steward-wake.cjs').BLOCK_REASONS) for (const language of ['zh', 'en']) {
    assert.ok(messages[language][`stewardWake.reason.${reason}`], `${language} ${reason}`);
  }
});
