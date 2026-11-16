const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
test('encrypted N equals the actual Main desktop records status command, through the phone adapter', async t => {
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'), commands = {};
  const start = source.indexOf('let mobileBroker;'), end = source.indexOf('const startupFile =', start);
  const records = source.indexOf("  register('records',"), recordsEnd = source.indexOf('\n  });', records) + '\n  });'.length;
  assert.ok(start >= 0 && end > start && records >= 0 && recordsEnd > records);
  let count = 37;
  const context = vm.createContext({ dataDir: '/synthetic-profile', operationsUnavailable: null, stewardRecord: null,
    recordReminders: { status: () => ({ count, records: [], privateName: 'PRIVATE_NAME' }), RECORDS: [] },
    roomState: {}, sessionLabels: { labels: new Map() }, broadcastRoom: async () => {},
    isCurrentHumanContext: () => true, register: (name, fn) => { commands[name] = fn; },
    require: name => { assert.equal(name, './mobile-workspace.cjs'); return { MobileWorkspace: class { constructor(options) { Object.assign(this, options); } } }; },
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(source.slice(records, recordsEnd), context);
  const workspace = context.appMobileWorkspace(), curve = crypto.createECDH('prime256v1'); curve.generateKeys();
  let body;
  const push = new (require('../mobile-push.cjs').MobilePush)({ authority: () => 'current-device',
    count: () => workspace.records.status().count, transport: async details => { body = details.body; return 201; } });
  t.after(() => push.close());
  const auth = crypto.randomBytes(16).toString('base64url');
  push.configuration(); push.subscribe({ endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth } });
  for (count of [37, 5, 0]) {
    await push.refresh();
    const desktop = await commands.records({}, 'status');
    const payload = JSON.parse(require('http_ece').decrypt(body, { version: 'aes128gcm', privateKey: curve, authSecret: auth }));
    assert.deepEqual(payload, { count: desktop.count });
  }
});
