'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// The butler's read log is kept in blocks under history/butler-reads (record-history.cjs).
const readLogStore = directory => path.join(directory, 'history', 'butler-reads');
const hasReadLog = directory => fs.existsSync(path.join(directory, 'history')) || fs.existsSync(path.join(directory, 'butler-business-reads.jsonl'));
const readLogText = directory => { const store = readLogStore(directory); return fs.existsSync(store) ? fs.readdirSync(store).filter(name => name.endsWith('.jsonl')).sort().map(name => fs.readFileSync(path.join(store, name), 'utf8')).join('') : ''; };
const readLogBlocks = directory => { const store = readLogStore(directory); return fs.existsSync(store) ? fs.readdirSync(store).filter(name => name.endsWith('.jsonl')).map(name => fs.lstatSync(path.join(store, name))) : []; };
const auditExports = require('../butler-read-audit.cjs');
const { ButlerRole } = require('../butler-role.cjs');
const { RoomState } = require('../room-state.cjs');
const ActualAudit = auditExports.ButlerReadAudit;
const NOW = Date.UTC(2026, 10, 11, 12), BODY = 'Synthetic approved task for an export replacement counterexample';
const runner = { purpose: 'butler', runnerRef: 'export-runner', backendRef: 'export-backend', profile: 'fixture', provider: 'fixture', model: 'fixture' };

test('audit export properties reject assignment and defineProperty while identical descriptors remain valid', () => {
  const originals = Object.getOwnPropertyDescriptors(auditExports);
  const observations = [];
  try {
    for (const [name, replacement] of [['ButlerReadAudit', function FakeAudit() {}], ['MAX_PAGES_PER_UTC_DAY', 999]]) {
      let assignment, definition;
      try { auditExports[name] = replacement; } catch (error) { assignment = error; }
      try { Object.defineProperty(auditExports, name, { ...originals[name], value: replacement }); } catch (error) { definition = error; }
      observations.push({ name, assignmentRejected: assignment instanceof TypeError, definitionRejected: definition instanceof TypeError,
        originalPreserved: auditExports[name] === originals[name].value });
    }
    assert.deepEqual(observations, [
      { name: 'ButlerReadAudit', assignmentRejected: true, definitionRejected: true, originalPreserved: true },
      { name: 'MAX_PAGES_PER_UTC_DAY', assignmentRejected: true, definitionRejected: true, originalPreserved: true },
    ]);
    assert.equal(Object.isFrozen(auditExports), true);
    assert.equal(Object.isFrozen(ActualAudit.prototype), false, 'The export guard does not freeze the prototype');
  } finally {
    // Redefining an unchanged descriptor is legal even after Object.freeze.
    // This also restores the mutable old implementation after its real RED run.
    for (const [name, descriptor] of Object.entries(originals)) Object.defineProperty(auditExports, name, descriptor);
  }
});

test('replacing the exported constructor before Business loads cannot replace its real root check, journal or page allowance', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-audit-export-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('synthetic person'), role = new ButlerRole(directory, { authorizePerson: value => value === person });
  const actor = { id: 'export-instance', nativeId: 'export-native', provider: 'dsh', state: 'idle', roomIds: [], runner };
  role.set(person, { identity: { sessionId: actor.id, nativeId: actor.nativeId }, runner }, 0);
  const audit = new ActualAudit(directory, { authorizePerson: value => value === person, now: () => NOW });
  const room = new RoomState(directory); room.queueAdd(BODY, null);
  const businessFile = require.resolve('../butler-business.cjs'), cachedBusiness = require.cache[businessFile];
  const descriptor = Object.getOwnPropertyDescriptor(auditExports, 'ButlerReadAudit');
  const calls = { constructed: 0, matches: 0, receipts: 0 };
  class FakeAudit {
    constructor() { calls.constructed++; }
    static matchesDataDir() { calls.matches++; return true; }
    static record() { calls.receipts++; return { sequence: 1, pageOfDay: 1 }; }
  }
  try {
    // Do not fail early on mutation: the old implementation must demonstrate
    // the actual Business bypass after importing this fake constructor export.
    Reflect.set(auditExports, 'ButlerReadAudit', FakeAudit);
    Reflect.defineProperty(auditExports, 'ButlerReadAudit', { ...descriptor, value: FakeAudit });
    delete require.cache[businessFile];
    const { ButlerBusiness } = require(businessFile);
    const business = new ButlerBusiness({ role, roomState: room, view: () => ({ records: [actor] }), readAudit: audit, dataDir: directory });
    const capability = business.bind(actor, { selectionRevision: 1, runnerRef: runner.runnerRef });
    let returnedPages = 0, rejectedPages = 0, rejection = null;
    for (let index = 0; index < 65; index++) {
      try {
        assert.equal(capability.invoke('readBusiness', { kind: 'queue', spaceId: 'shared' }).records[0].text, BODY);
        returnedPages++;
      } catch (error) {
        if (error.code !== 'ERR_BUTLER_BUSINESS_READ_LIMIT') throw error;
        rejectedPages++; rejection = error.code;
      }
    }
    const first = audit.read(person), last = audit.read(person, { afterSequence: first.nextAfterSequence });
    const rows = [...first.records, ...last.records];
    assert.deepEqual({ returnedPages, rejectedPages, rejection, journalRows: rows.length, journalHead: last.throughSequence,
      fakeMatches: calls.matches, fakeReceipts: calls.receipts },
    { returnedPages: 64, rejectedPages: 1, rejection: 'ERR_BUTLER_BUSINESS_READ_LIMIT', journalRows: 64, journalHead: 64,
      fakeMatches: 0, fakeReceipts: 0 });
    assert.equal(calls.constructed, 0);
    assert.equal(rows.at(-1).pageOfDay, 64);
    assert.ok(rows.every(row => row.actor.sessionId === actor.id && row.actor.nativeId === actor.nativeId && row.query.kind === 'queue'));
    assert.equal(readLogText(directory).includes(BODY), false);
    assert.equal(Object.isExtensible(audit), true, 'Instances keep their existing composition behavior');
  } finally {
    Object.defineProperty(auditExports, 'ButlerReadAudit', descriptor);
    if (cachedBusiness) require.cache[businessFile] = cachedBusiness;
    else delete require.cache[businessFile];
  }
});
