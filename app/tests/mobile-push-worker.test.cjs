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
test('worker shows fixed local titles for known alert codes and nothing for any other shape', async () => {
  const handlers = {}, shown = []; let pending;
  const self = { navigator: { language: 'zh-CN' }, location: { origin: 'https://private.invalid' },
    addEventListener: (name, fn) => { handlers[name] = fn; }, registration: { showNotification: async (...args) => shown.push(JSON.parse(JSON.stringify(args))) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-web/sw.js'), 'utf8'), { self, URL });
  const send = value => handlers.push({ data: { json: () => value }, waitUntil: p => { pending = p; } });
  for (const value of [{}, { alerts: ['PRIVATE'] }, { alerts: 'service-disconnected' }, { alerts: ['token-anomaly', 'token-anomaly'] },
    { count: 1, alerts: [], text: 'PRIVATE' }, { alerts: [{ code: 'token-anomaly' }] }, { count: -1, alerts: ['token-anomaly'] }]) send(value);
  assert.equal(shown.length, 0);
  send({ count: 3, alerts: ['service-disconnected', 'decision-waiting'] }); await pending;
  assert.deepEqual(shown.pop(), ['本机服务断开', { body: '有事等你决定 · 3 条提醒', tag: 'naw-alert', renotify: true }]);
  send({ alerts: ['steward-wake-stalled'] }); await pending;
  assert.deepEqual(shown.pop(), ['大管家该叫醒没叫醒', { body: '点开 NAW 查看', tag: 'naw-alert', renotify: true }]);
  send({ count: 0, alerts: ['token-anomaly'] }); await pending;
  assert.deepEqual(shown.pop(), ['token 异常', { body: '点开 NAW 查看', tag: 'naw-alert', renotify: true }]);
  send({ count: 2, alerts: [] }); await pending;
  assert.deepEqual(shown.pop(), ['告警已解除', { body: 'NAW 有 2 条提醒', tag: 'naw-alert' }]);
  send({ alerts: [] }); await pending;
  assert.deepEqual(shown.pop(), ['告警已解除', { body: '点开 NAW 查看', tag: 'naw-alert' }]);
  self.navigator.language = 'en-US'; send({ count: 1, alerts: ['token-anomaly', 'decision-waiting'] }); await pending;
  assert.deepEqual(shown.pop(), ['Token anomaly', { body: 'A decision is waiting for you · 1 reminder', tag: 'naw-alert', renotify: true }]);
});
test('a new worker replaces an older one without waiting for its pages to close', () => {
  const handlers = {}; let skipped = 0;
  const self = { addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: () => { skipped++; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-web/sw.js'), 'utf8'), { self, URL });
  handlers.install({}); assert.equal(skipped, 1);
});
