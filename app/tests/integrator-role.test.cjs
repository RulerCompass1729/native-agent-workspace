const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { IntegratorRole } = require('../integrator-role.cjs');
const { QueueSecretary } = require('../queue-secretary.cjs');

// The record of who the person designated as integrator (B6, section 5). Synthetic identities only.
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-role-'));
  t.after(() => { try { fs.chmodSync(directory, 0o700); } catch {} fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file: path.join(directory, 'integrator.json'), log: path.join(directory, 'rotation-log.jsonl'), open: () => new IntegratorRole(directory) };
}
const ONE = { sessionId: 'session-1', nativeId: 'native-1' };
const stateError = error => error.uiMessage?.key === 'error.integrator.state';
const edge = (event, from, to) => JSON.stringify({ event, old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });

test('nobody is designated until the person designates one session; the record survives a restart and can be cleared', t => {
  const { open, file } = fixture(t);
  const role = open();
  assert.equal(role.current(), null); assert.equal(fs.existsSync(file), false);
  role.set(ONE);
  assert.deepEqual(role.current(), ONE);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, selected: ONE });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(open().current(), ONE);
  // There is one integrator: designating another replaces the first.
  const two = { sessionId: 'session-2', nativeId: 'native-2' };
  role.set(two); assert.deepEqual(open().current(), two);
  role.set(null); assert.equal(open().current(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, selected: null });
});

test('only a session id with its native id is a designation', t => {
  const { open, file } = fixture(t);
  const role = open(); role.set(ONE);
  const before = fs.readFileSync(file, 'utf8');
  for (const bad of [undefined, {}, { sessionId: 'a' }, { sessionId: 'a', nativeId: '' }, { sessionId: 'a', nativeId: 'b', extra: 1 }, { sessionId: 'a\nb', nativeId: 'b' }, { sessionId: 'x'.repeat(101), nativeId: 'b' }, ['a', 'b'], 'session-1']) {
    assert.throws(() => role.set(bad), /Invalid integrator identity/, JSON.stringify(bad));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(role.current(), ONE);
});

test('after a session rotation the designation follows the written log to the successor, as the secretary does', t => {
  const { open, log, directory } = fixture(t);
  const role = open(); role.set(ONE);
  const two = { sessionId: 'session-2', nativeId: 'native-2' }, three = { sessionId: 'session-3', nativeId: 'native-3' };
  fs.writeFileSync(log, [edge('done', ONE, two), edge('done', two, three)].join('\n') + '\n', { mode: 0o600 });
  assert.deepEqual(role.current(), three);
  // The same log gives the secretary the same successor: one rule for both.
  const secretary = new QueueSecretary(directory); secretary.set(ONE);
  assert.deepEqual(secretary.current(), role.current());
  // A handoff that was only kept, not done, does not move the designation.
  fs.writeFileSync(log, edge('kept', ONE, two) + '\n', { mode: 0o600 });
  assert.deepEqual(role.current(), ONE);
});

test('a record or log that cannot be trusted is an error, never "nobody designated"', t => {
  const cases = {
    'other people can read it': file => { fs.writeFileSync(file, JSON.stringify({ version: 1, selected: ONE }), { mode: 0o600 }); fs.chmodSync(file, 0o644); },
    'a link': file => { fs.writeFileSync(file + '.target', JSON.stringify({ version: 1, selected: ONE }), { mode: 0o600 }); fs.symlinkSync(file + '.target', file); },
    'not JSON': file => fs.writeFileSync(file, '{', { mode: 0o600 }),
    'another version': file => fs.writeFileSync(file, JSON.stringify({ version: 2, selected: ONE }), { mode: 0o600 }),
    'no selection field': file => fs.writeFileSync(file, JSON.stringify({ version: 1 }), { mode: 0o600 }),
    'a selection with extra fields': file => fs.writeFileSync(file, JSON.stringify({ version: 1, selected: { ...ONE, admin: true } }), { mode: 0o600 }),
    'too large': file => fs.writeFileSync(file, JSON.stringify({ version: 1, selected: ONE, pad: 'x'.repeat(5000) }), { mode: 0o600 }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const { open, file } = fixture(t);
    make(file);
    const role = open();
    assert.equal(role.failed, true, name);
    assert.throws(() => role.current(), stateError, name);
  }
  // A good record with a log that cannot be read: also an error.
  const { open, log } = fixture(t);
  const role = open(); role.set(ONE);
  fs.writeFileSync(log, 'not a log line\n', { mode: 0o600 });
  assert.throws(() => role.current(), stateError);
  fs.writeFileSync(log, '', { mode: 0o644 }); fs.chmodSync(log, 0o644);
  assert.throws(() => role.current(), stateError);
});

test('a designation that cannot be saved is refused, and the record is not trusted until it is read again', t => {
  const { open, directory, file } = fixture(t);
  const role = open(); role.set(ONE);
  const saved = fs.readFileSync(file, 'utf8');
  fs.chmodSync(directory, 0o500);
  assert.throws(() => role.set({ sessionId: 'session-2', nativeId: 'native-2' }), stateError);
  fs.chmodSync(directory, 0o700);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.throws(() => role.current(), stateError);
  assert.deepEqual(open().current(), ONE);
  assert.deepEqual(fs.readdirSync(directory), ['integrator.json']);
});

test('the record names a session and nothing else, and its messages exist in both languages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../integrator-role.cjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort(), ['./queue-secretary.cjs', './ui-errors.cjs', 'node:crypto', 'node:fs', 'node:path']);
  const locale = require('../ui-locale.js');
  for (const key of ['menu.integratorSet', 'menu.integratorRevoke', 'error.integrator.invalid', 'error.integrator.inSpace', 'error.integrator.state', 'error.integrator.personOnly']) {
    const zh = locale.format('zh', key), en = locale.format('en', key);
    assert.ok(zh && en && zh !== en && zh !== key && en !== key, key);
  }
});
