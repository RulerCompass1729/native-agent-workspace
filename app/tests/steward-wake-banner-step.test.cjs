'use strict';
// R129 ① (the person, 2026-11-23: 「"没被叫醒"是个 bug,需要修」): when only the person's step ends the butler's hold,
// the wake banner offers that step itself, as the same call its sidebar menu item makes; the phone says to take it
// on the computer; the banner counts the messages to the butler NAW recorded as not delivered.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
const { StewardWake } = require('../steward-wake.cjs'), { healthSummary } = require('../mobile-workspace.cjs');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

function topLevel(name) {
  const at = source.search(new RegExp(`^(async )?function ${name}\\(`, 'mu'));
  assert.ok(at >= 0, name);
  return source.slice(at, source.indexOf('\n}\n', at) + 2);
}
const EPISODE = { nativeId: 'native-butler', epoch: 'epoch-a', tag: 'tag-a', state: 'invalid' };
const butler = (extra = {}) => ({ id: 'butler', nativeId: 'native-butler', name: 'Synthetic butler', rotationEpisode: { ...EPISODE }, ...extra });

function banner(language) {
  const p = { textContent: '' }, step = { hidden: true }, record = { textContent: '' }, summary = { setAttribute(k, v) { this[k] = v; } };
  // The header wake chip (statusbar-people) holds the step in its detail.
  const parts = { p, summary, '.wake-chip-text': { textContent: '' }, '.steward-wake-step': step, '.steward-wake-record': record }, box = { hidden: true, open: false, querySelector: selector => parts[selector] };
  const calls = [], pending = [];
  const context = vm.createContext({
    state: null, disconnected: false, $: () => box, stewardSteps: { open: () => calls.push(['record']) },
    uiText: (k, v) => locale.format(language, k, v), toastMessage: key => calls.push(['toast', key]),
    window: { nativeWorkspaceSpaces: { roomIds: r => r.roomIds || [] } },
    backendVersionNotice: (r, version) => r.backendVersion && r.backendVersion !== version ? { kind: 'old' } : null,
    api: {
      // Copied out of the page's realm, so the calls compare as plain values.
      spaceAction: async (...args) => { calls.push(['spaceAction', ...JSON.parse(JSON.stringify(args))]); },
      initial: async () => context.state,
      connectionUpdates: async () => { calls.push(['connectionUpdates']); return [{ key: 'other', sessions: [{ id: 'someone' }] }, { key: 'its', sessions: [{ id: 'butler' }] }]; },
    },
    runBackendOption: async option => { calls.push(['runBackendOption', option.key]); },
    updateState() {}, render() {}, attempt: run => { pending.push(run()); },
  });
  for (const name of ['rotationReleaseAction', 'backendUpdateAction', 'releaseSessionRotation', 'updateSessionBackend', 'renderStewardWakeWarning']) vm.runInContext(topLevel(name), context);
  const show = (record, block) => {
    context.state = { steward: { sessionId: 'butler' }, sessions: record ? [record] : [], appVersion: '0.1.0-alpha.290' };
    context.renderStewardWakeWarning({ minutes: 7, reason: 'rotation-control-unresolved', ...block });
  };
  const click = async () => { step.onclick(); await Promise.all(pending.splice(0)); };
  return { p, step, box, summary, calls, context, show, click };
}

test('the banner\'s step is its sidebar menu item: the same label and the same call, from the person\'s window', async () => {
  for (const language of ['zh', 'en']) {
    const b = banner(language), say = (k, v) => locale.format(language, k, v);
    b.show(butler(), { step: 'release' });
    assert.equal(b.box.hidden, false);
    assert.equal(b.step.hidden, false);
    assert.equal(b.step.textContent, say('queue.releaseRotation', { name: 'Synthetic butler' }));
    assert.equal(b.p.textContent, say('stewardWake.ownHandoffButton.release', { minutes: 7 }));
    await b.click();
    // The window's call: main.cjs spaceAction releaseRotation gives a window context the person's actor.
    assert.deepEqual(b.calls, [['spaceAction', 'shared', 'releaseRotation', ['butler', 'native-butler', 'epoch-a', 'tag-a', 'discard-unresolved-handoff']]]);

    const u = banner(language);
    u.show(butler({ backendVersion: '0.1.0-alpha.270' }), { step: 'update-backend' });
    assert.equal(u.step.hidden, false);
    assert.equal(u.step.textContent, say('menu.updateThisBackend'));
    assert.equal(u.p.textContent, say('stewardWake.ownHandoffButton.update-backend', { minutes: 7 }));
    await u.click();
    // runBackendOption keeps its own confirmation before anything ends.
    assert.deepEqual(u.calls, [['connectionUpdates'], ['runBackendOption', 'its']]);
  }
});

test('the sidebar menu builds and runs the same items', () => {
  const model = topLevel('sessionMenuModel');
  // sessionMenuModel keeps its own expression (other tests load it alone); the banner's helper is the same one.
  const menuUpdate = model.match(/const update = (.+);\n/u)?.[1], helper = topLevel('backendUpdateAction');
  assert.ok(menuUpdate && helper.includes(`return record && ${menuUpdate};`), helper);
  assert.match(model, /rotationReleaseAction\(record\)/u);
  assert.match(source, /else if \(action === 'rotation-release'\) attempt\(\(\) => releaseSessionRotation\(record\)\);/u);
  assert.match(source, /else if \(action === 'update-backend'\) attempt\(\(\) => updateSessionBackend\(id\)\);/u);
});

test('no step without its menu item, none while disconnected, and none for a record changed since', async () => {
  for (const language of ['zh', 'en']) {
    const say = (k, v) => locale.format(language, k, v);
    const cases = [
      ['in a space', butler({ roomIds: ['room-a'] }), { step: 'release' }],
      ['episode resolved', butler({ rotationEpisode: { ...EPISODE, state: 'released' } }), { step: 'release' }],
      ['backend current', butler({ backendVersion: '0.1.0-alpha.290' }), { step: 'update-backend' }],
      ['archived', butler({ archived: true, backendVersion: '0.1.0-alpha.270' }), { step: 'update-backend' }],
      ['not loaded', null, { step: 'release' }],
    ];
    for (const [name, record, block] of cases) {
      const b = banner(language);
      b.show(record, block);
      assert.equal(b.step.hidden, true, name);
      assert.ok(b.p.textContent.startsWith(say(`stewardWake.ownHandoff.${block.step}`, { minutes: 7, action: record ? say('queue.releaseRotation', { name: 'Synthetic butler' }) : say('stewardWake.ownHandoff.action'), update: say('menu.updateThisBackend') })), `${name}: ${b.p.textContent}`);
      await b.click();
      assert.deepEqual(b.calls, [], name);
    }
    const off = banner(language);
    off.context.disconnected = true;
    off.show(butler(), { step: 'release' });
    assert.equal(off.step.hidden, false); assert.equal(off.step.disabled, true);
    await off.click(); assert.deepEqual(off.calls, []);
    const later = banner(language);
    later.show(butler(), { step: 'release' });
    later.context.state.sessions[0].rotationEpisode.state = 'released';
    await later.click(); assert.deepEqual(later.calls, [], 'released elsewhere before the click');
  }
});

test('the banner adds the undelivered count only with the person\'s step', () => {
  for (const language of ['zh', 'en']) {
    const say = (k, v) => locale.format(language, k, v), b = banner(language);
    b.show(butler(), { step: 'release', undelivered: 2 });
    assert.equal(b.p.textContent, say('stewardWake.withUndelivered', { text: say('stewardWake.ownHandoffButton.release', { minutes: 7 }), count: '2' }));
    b.show(butler(), { step: 'release', undelivered: 100, undeliveredMore: true });
    assert.equal(b.p.textContent, say('stewardWake.withUndelivered', { text: say('stewardWake.ownHandoffButton.release', { minutes: 7 }), count: '100+' }));
    assert.match(b.p.textContent, /100\+/u);
    b.show(butler(), { reason: 'source-unavailable', undelivered: 2 });
    assert.equal(b.p.textContent, say('stewardWake.chipDetail', { reason: say('stewardWake.reason.source-unavailable') }));
    assert.equal(b.summary['aria-label'], say('stewardWake.stalled', { minutes: 7, reason: say('stewardWake.reason.source-unavailable') }));
  }
});

test('the wake view counts only undelivered messages since its last wake, and only while the person\'s step holds it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-b-banner-step-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: 1800000000000 }, ledger = new ButlerLedger(dir, { now: () => clock.now });
  const ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger, now: () => clock.now });
  const identity = { sessionId: 'butler', nativeId: 'native-butler' };
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => identity, now: () => clock.now, record() {}, changed() {} });
  const undelivered = n => ingress.record({ eventId: `wake-undelivered:${String(n).padStart(64, '0')}`, sourceRef: 'wake-undelivered:sender', kind: 'blocked',
    payload: { memberId: 'sender', reason: 'wake-undelivered', outcome: 'not-sent:root-turn-unbound', title: new Date(clock.now).toISOString() } });
  undelivered(1);
  wake.set(true);
  undelivered(2); undelivered(3);
  ingress.record({ eventId: 'version-change:synthetic', sourceRef: 'version-change:synthetic', kind: 'blocked', payload: { reason: 'version-restarted', outcome: 'a->b', title: 'synthetic', text: 'synthetic' } });
  wake.hold('rotation-control-unresolved', 'release');
  const held = wake.view().blocked;
  assert.equal(held.step, 'release');
  assert.equal(held.undelivered, 2, 'the one before its last wake is not counted');
  assert.equal(held.undeliveredMore, undefined);
  wake.endHold();
  wake.skip('busy'); clock.now += 20 * 60000; wake.skip('busy');
  const plain = wake.view().blocked;
  assert.equal(plain.reason, 'busy'); assert.equal(plain.undelivered, undefined);
});

test('the phone names the computer step for the two fixed steps only, and its words are bilingual', () => {
  const reasons = ['rotation-control-unresolved'];
  for (const step of ['release', 'update-backend'])
    assert.deepEqual(healthSummary({ on: true, failed: false, blocked: { reason: 'rotation-control-unresolved', minutes: 3, step, undelivered: 4 } }, reasons),
      { available: true, alerts: [{ code: 'steward-wake-stalled', step }] });
  for (const step of [undefined, 'other', '__proto__'])
    assert.deepEqual(healthSummary({ on: true, failed: false, blocked: { reason: 'rotation-control-unresolved', minutes: 3, step } }, reasons),
      { available: true, alerts: [{ code: 'steward-wake-stalled' }] });
  const phone = fs.readFileSync(path.join(root, 'app/mobile-web/workspace.js'), 'utf8');
  for (const language of ['zh', 'en']) assert.match(phone, new RegExp(`words\\.${language}, \\{ wakeStepUpdate: '[^']+', wakeStepRelease: '[^']+' \\}`, 'u'));
  // The push stays the fixed codes alone (mobile-push.cjs).
  assert.match(fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8'), /if \(stewardWake\?\.view\(\)\.blocked\) alerts\.push\(\{ code: 'steward-wake-stalled' \}\);/u);
});
