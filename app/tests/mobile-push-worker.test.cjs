const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
test('worker accepts only a count and clicking always opens the fixed private entry', async () => {
  const handlers = {}, shown = [], opened = []; let pending;
  const self = { navigator: { language: 'zh-CN' }, location: { origin: 'https://private.invalid' },
    addEventListener: (name, fn) => { handlers[name] = fn; }, registration: { showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-web/sw.js'), 'utf8'), { self, URL });
  const send = value => handlers.push({ data: { json: () => value }, waitUntil: p => { pending = p; } });
  for (const value of [{ count: 2, name: 'PRIVATE' }, { count: '2' }, { count: -1 }, { count: 1.5 }, null, ['PRIVATE']]) send(value);
  assert.equal(shown.length, 0);
  send({ count: 19 }); await pending; assert.equal(shown.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(shown[0])), ['NAW', { body: 'NAW 有 19 条提醒', tag: 'naw-count' }]);
  handlers.notificationclick({ notification: { data: { url: 'https://outside.invalid/approve?token=PRIVATE' }, close() {} }, waitUntil: p => { pending = p; } });
  await pending; assert.deepEqual(opened, ['https://private.invalid/mobile/']);
});
test('worker reuse navigates only an existing window at the exact private entry', async () => {
  const handlers = {}, calls = []; let pending;
  const self = { location: { origin: 'https://private.invalid' }, addEventListener: (n, f) => { handlers[n] = f; },
    clients: { matchAll: async () => [{ url: 'https://outside.invalid/mobile/', navigate: () => assert.fail('outside') },
      { url: 'https://private.invalid/mobile/#zh/chat', navigate: async u => calls.push(u), focus: async () => calls.push('focus') }] } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-web/sw.js'), 'utf8'), { self, URL });
  handlers.notificationclick({ notification: { close() {} }, waitUntil: p => { pending = p; } }); await pending;
  assert.deepEqual(calls, ['https://private.invalid/mobile/', 'focus']);
});
