const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { RoomState } = require('../room-state.cjs'), { SessionLabels } = require('../session-labels.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { PersonActions } = require('../person-actions.cjs');
const root = path.resolve(__dirname, '../..'), req = createRequire(path.join(root, 'app/main.cjs'));
for (const file of ['scripts/fixtures/phone-acceptance-instance.cjs', 'scripts/test-phone-consent.cjs', 'scripts/test-phone-workspace.cjs']) {
  test('phone Main fixture constructs and records real person actions: ' + file, async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-b-phone-main-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const room = new RoomState(profile), labels = new SessionLabels(profile);
    let f;
    if (file.includes('/fixtures/')) f = req('../' + file).mainMobile(root, profile, room, labels, null, null);
    else {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const start = source.indexOf('function mainMobile('), end = source.indexOf('\nfunction proxy(', start);
      assert.ok(start >= 0 && end > start);
      const context = vm.createContext({ require: req, createRequire, path, vm, assert, root,
        mainSource: fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8'), recordReminders: req('./record-reminders.cjs'), Date, setTimeout, clearTimeout, AbortController });
      f = vm.runInContext('(' + source.slice(start, end) + ')', context)(profile, room, labels, null);
    }
    t.after(() => f.stop());
    assert.doesNotThrow(() => f.broker());
    const ledger = new ButlerLedger(profile), ingress = new ButlerIngress(profile, { roomState: room, ledger });
    f.context.personActions = new PersonActions({ ingress });
    f.context.appMobileWorkspace().personAction('spaceAction', ['shared', 'queueResolve', ['synthetic-item']], undefined);
    const events = ledger.eventsAfter(null).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.reason, 'person-action:queue:resolve');
    assert.equal(events[0].payload.itemId, 'synthetic-item');
  });
}
