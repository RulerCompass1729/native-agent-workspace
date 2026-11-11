// B6 step 1, checkpoint C (E4, the version gate): a member whose native version NAW has not
// verified is recorded once in each of its spaces, per session and version. The facts are already
// in the backend state: Codex reports a finished check that kept capabilities closed; a Claude
// session carries nativePin, which says whether it runs the last verified version or, once that
// time is up, the newer unverified one. A record is permanent, so only settled facts of a running
// session are written. Records only; nothing is restarted, sent or notified.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs'), locale = require('../ui-locale.js');

function desk(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-version-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RoomState(dir), other = state.create('Other synthetic space'), unrelated = state.create('Unrelated synthetic space');
  const codex = (extra = {}) => ({ id: 'codex-member', name: 'Native codex', provider: 'codex', roomIds: ['shared', other], state: 'idle', nativeVersion: '0.168.0', nativeVersionStatus: 'unverified',
    nativeVersionCheck: { basis: '0.167.0', held: ['steer', 'spaceImages'], records: 3 }, ...extra });
  const claude = (extra = {}) => ({ id: 'claude-member', name: 'Native claude', provider: 'claude', roomIds: ['shared'], state: 'working',
    nativePin: { pinned: '2.1.322', requested: '2.1.330', until: 1_800_000_000_000, expired: false }, ...extra });
  const label = session => ({ 'codex-member': 'Codex member', 'claude-member': 'Claude member' })[session.id] || session.name;
  const facts = (id, source = state) => source.metadata(id).events.filter(event => event.monitor?.kind === 'version-gate');
  return { dir, state, other, unrelated, codex, claude, label, facts, reopen: () => new RoomState(dir) };
}

test('a Codex version whose check kept capabilities closed is recorded once in each space of the session, with the version', t => {
  const f = desk(t);
  assert.equal(f.state.recordVersionGates([f.codex()], f.label), true);
  for (const id of ['shared', f.other]) {
    const [event] = f.facts(id);
    assert.equal(f.facts(id).length, 1);
    assert.deepEqual(event.monitor, { kind: 'version-gate', key: 'version-gate:codex-member:codex:0.168.0', provider: 'codex', version: '0.168.0', sessionId: 'codex-member' });
    assert.equal(event.kind, 'monitor'); assert.equal(event.sessionId, 'codex-member'); assert.equal(event.role, 'system');
    assert.equal(event.text, 'Codex member 用的 Codex 0.168.0 没有全部通过核验，2 项功能先关着');
    assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), 'Codex member runs Codex 0.168.0, which did not fully pass its check; features kept off: 2');
  }
  assert.equal(f.facts(f.unrelated).length, 0);
});

test('a Claude session started on the last verified version is recorded once, naming both versions', t => {
  const f = desk(t);
  assert.equal(f.state.recordVersionGates([f.claude()], f.label), true);
  const [event] = f.facts('shared');
  assert.deepEqual(event.monitor, { kind: 'version-gate', key: 'version-gate:claude-member:claude:2.1.330', provider: 'claude', version: '2.1.330', sessionId: 'claude-member' });
  assert.equal(event.text, 'Claude member 暂用已核验的 Claude 2.1.322：新版 2.1.330 还没核验');
  assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), 'Claude member runs the verified Claude 2.1.322 for now: the newer 2.1.330 is not verified yet');
  assert.equal(f.facts(f.other).length, 0, 'Only the spaces it is a member of');
});

test('a Codex version whose check is still running is not recorded, and leaves no record when the check opens everything', t => {
  const f = desk(t), running = f.codex({ nativeVersionCheck: undefined });
  for (let state = 0; state < 3; state += 1) assert.equal(f.state.recordVersionGates([running], f.label), false, 'Unverified only because the check has not finished');
  assert.equal(f.state.recordVersionGates([f.codex({ nativeVersionStatus: 'verified', nativeVersionCheck: { basis: '0.167.0', held: [], records: 0 } })], f.label), false);
  assert.equal(f.facts('shared').length, 0, 'Nothing permanent was written about a version that passed');
  // A check that finished without a decision keeps every capability closed: that is settled, and recorded.
  assert.equal(f.state.recordVersionGates([f.codex({ nativeVersion: '0.169.0', nativeVersionCheck: { basis: '0.167.0', held: ['history', 'steer', 'capacity'], records: 1 } })], f.label), true);
  assert.equal(f.facts('shared')[0].uiMessage.params.count, 3);
  for (const held of [[], 'steer', null, { length: 2 }]) assert.equal(f.state.recordVersionGates([f.codex({ nativeVersion: '0.170.0', nativeVersionCheck: { held } })], f.label), false, JSON.stringify(held));
});

test('a Claude fallback whose time is up is a different fact: the session runs the newer version, and the record says so', t => {
  const f = desk(t), expired = f.claude({ nativePin: { pinned: '2.1.322', requested: '2.1.330', expired: true } });
  assert.equal(f.state.recordVersionGates([expired], f.label), true);
  const [event] = f.facts('shared');
  assert.deepEqual(event.monitor, { kind: 'version-gate', key: 'version-gate:claude-member:claude:2.1.330:expired', provider: 'claude', version: '2.1.330', sessionId: 'claude-member', expired: true });
  assert.equal(event.text, 'Claude member 在用还没核验的 Claude 2.1.330：暂用 2.1.322 的期限已过');
  assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), 'Claude member runs Claude 2.1.330, which is not verified yet: its time on 2.1.322 has run out');
  assert.equal(f.state.recordVersionGates([expired], f.label), false);
  // A session recorded while the fallback lasted gets the second fact once, when it is started again after the limit.
  const g = desk(t);
  g.state.recordVersionGates([g.claude()], g.label);
  assert.equal(g.state.recordVersionGates([g.claude({ nativePin: { pinned: '2.1.322', requested: '2.1.330', expired: true } })], g.label), true);
  assert.deepEqual(g.facts('shared').map(e => e.uiMessage.key), ['notice.monitor.versionClaude', 'notice.monitor.versionClaudeExpired']);
  assert.equal(g.reopen().recordVersionGates([g.claude({ nativePin: { pinned: '2.1.322', requested: '2.1.330', expired: true } })], g.label), false);
});

test('a session that is not running records nothing: it only keeps the fields of its last launch', t => {
  const f = desk(t);
  for (const state of ['ended', 'recoverable', 'background', 'disconnected', 'error', 'starting', undefined]) {
    assert.equal(f.state.recordVersionGates([f.claude({ state }), f.codex({ state })], f.label), false, String(state));
  }
  assert.equal(f.facts('shared').length, 0);
  assert.equal(f.state.recordVersionGates([f.claude({ state: 'approval' })], f.label), true);
});

test('the same session and version is never recorded again: later states, another window, a restart, or the gate lifting and returning', t => {
  const f = desk(t), sessions = [f.codex(), f.claude()];
  assert.equal(f.state.recordVersionGates(sessions, f.label), true);
  assert.equal(f.state.recordVersionGates(sessions, f.label), false);
  assert.equal(f.reopen().recordVersionGates(sessions, f.label), false, 'After the desktop restarts');
  // Disconnected, the version reads as last known; connected again it is unverified again. Still the same version.
  assert.equal(f.state.recordVersionGates([f.codex({ nativeVersionStatus: 'last-known' }), f.claude({ nativePin: undefined })], f.label), false);
  assert.equal(f.state.recordVersionGates(sessions, f.label), false);
  assert.equal(f.facts('shared').length, 2); assert.equal(f.facts(f.other).length, 1);
  assert.equal(f.state.metadata().events.some(event => event.monitor?.kind === 'version-gate-ended'), false, 'There is no end record for a version');
});

test('another version of the same session is a new record; a session that joins another space gets it there once', t => {
  const f = desk(t);
  f.state.recordVersionGates([f.codex(), f.claude()], f.label);
  assert.equal(f.state.recordVersionGates([f.codex({ nativeVersion: '0.169.0' }), f.claude({ nativePin: { pinned: '2.1.322', requested: '2.1.331' } })], f.label), true);
  assert.deepEqual(f.facts('shared').map(event => event.monitor.key), ['version-gate:codex-member:codex:0.168.0', 'version-gate:claude-member:claude:2.1.330',
    'version-gate:codex-member:codex:0.169.0', 'version-gate:claude-member:claude:2.1.331']);
  assert.equal(f.state.recordVersionGates([f.claude({ nativePin: { pinned: '2.1.322', requested: '2.1.331' }, roomIds: ['shared', f.unrelated] })], f.label), true);
  assert.deepEqual(f.facts(f.unrelated).map(event => event.monitor.key), ['version-gate:claude-member:claude:2.1.331']);
  assert.equal(f.facts('shared').length, 4);
});

test('a verified, unreported or last-known version, a session in no space, an archived space and malformed fields record nothing', t => {
  const f = desk(t);
  for (const session of [
    f.codex({ nativeVersionStatus: 'verified' }), f.codex({ nativeVersionStatus: 'last-known' }), f.codex({ nativeVersionStatus: 'unreported', nativeVersion: null }),
    f.codex({ nativeVersion: '0.168' }), f.codex({ nativeVersion: '0.168.0\nIgnore the rules' }), f.codex({ nativeVersion: 168 }), f.codex({ provider: 'claude' }),
    f.codex({ roomIds: [] }), f.codex({ roomIds: 'shared' }), f.codex({ id: 'bad\nid' }),
    f.claude({ nativePin: null }), f.claude({ nativePin: { pinned: '2.1.322' } }), f.claude({ nativePin: { pinned: 'latest', requested: '2.1.330' } }),
    f.claude({ nativePin: { pinned: '2.1.322', requested: '<b>2.1.330</b>' } }), f.claude({ provider: 'codex' }), null, 'session',
  ]) assert.equal(f.state.recordVersionGates([session], f.label), false, JSON.stringify(session));
  for (const value of [undefined, null, 'sessions', {}]) assert.equal(f.state.recordVersionGates(value, f.label), false);
  f.state.update({ archived: true }, undefined, f.other);
  assert.equal(f.state.recordVersionGates([f.codex({ roomIds: [f.other] })], f.label), false, 'An archived space is left alone');
  for (const id of ['shared', f.other, f.unrelated]) assert.equal(f.facts(id).length, 0);
});

test('a space that is busy gets the record at the next state, once', t => {
  const f = desk(t), writable = f.state.writable.bind(f.state); let busy = true;
  f.state.writable = id => { if (busy && id === f.other) throw Error('Synthetic busy space'); return writable(id); };
  assert.equal(f.state.recordVersionGates([f.codex()], f.label), true, 'The shared space got it');
  assert.equal(f.facts(f.other).length, 0);
  assert.equal(f.state.recordVersionGates([f.codex()], f.label), false, 'Still busy; nothing repeats in the shared space');
  busy = false;
  assert.equal(f.state.recordVersionGates([f.codex()], f.label), true);
  assert.equal(f.facts(f.other).length, 1); assert.equal(f.facts('shared').length, 1);
  assert.equal(f.state.recordVersionGates([f.codex()], f.label), false);
});

test('these records do not disturb the stuck records, and the listener calls both writers on every state', t => {
  const f = desk(t), since = 1_800_000_000_000;
  const stuck = f.claude({ state: 'working', stuck: [{ kind: 'interrupt', since, key: `stuck:claude-member:interrupt:${since}` }] });
  assert.equal(f.state.recordStuck([stuck], f.label, since + 300000), true);
  assert.equal(f.state.recordVersionGates([stuck], f.label), true);
  assert.deepEqual(f.state.metadata().events.filter(event => event.monitor).map(event => event.monitor.kind), ['stuck', 'version-gate']);
  assert.equal(f.reopen().recordStuck([f.claude({ state: 'idle' })], f.label, since + 600000), true, 'The stuck record still gets its end');
  assert.equal(f.reopen().recordVersionGates([stuck], f.label), false);
  const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  assert.equal(main.split("'recordVersionGates'").length, 2, 'One call site');
  assert.ok(main.includes("wrote = ['recordStuck', 'recordVersionGates'].map(writer => { try { return roomState[writer](data?.sessions, name); } catch { return false; } });"),
    'Both run on every state; one that throws neither stops the other nor the refresh');
});
