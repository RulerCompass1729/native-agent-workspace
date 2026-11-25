const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueSecretary, successor, follow, rotationEdges } = require('../queue-secretary.cjs');
const { StewardRole } = require('../steward-role.cjs');
const { IntegratorRole } = require('../integrator-role.cjs');
const selected = { sessionId: 'secretary', nativeId: 'native-secretary' };
const next = { sessionId: 'next', nativeId: 'native-next' };
const entry = (event, from = selected, to = next) => ({ time: 100, event, spaces: ['shared'], old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-secretary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, role: new QueueSecretary(dir) };
}
// The file an earlier version wrote when the person chose the secretary; this version only reads it.
function chosen(dir, value) {
  fs.writeFileSync(path.join(dir, 'queue-secretary.json'), JSON.stringify({ version: 1, selected: value }), { mode: 0o600 });
  return new QueueSecretary(dir);
}
test('the secretary an earlier version recorded is read and never written', t => {
  const { dir, role } = setup(t);
  assert.equal(role.current(), null);
  const read = chosen(dir, selected), before = fs.readFileSync(read.file);
  assert.deepEqual(read.current(), selected);
  assert.deepEqual(fs.readFileSync(read.file), before);
  assert.equal(chosen(dir, null).current(), null);
  assert.equal(['set', 'creator', 'author'].some(name => name in read), false);
});
test('only done follows a unique successor chain; kept, branches and native mismatches stay put', () => {
  assert.deepEqual(successor(selected, [entry('requested')]), selected);
  assert.deepEqual(successor(selected, [entry('kept')]), selected);
  assert.deepEqual(successor(selected, [entry('done')]), next);
  assert.deepEqual(successor(selected, [entry('done'), entry('done', next, { sessionId: 'third', nativeId: 'n-third' })]), { sessionId: 'third', nativeId: 'n-third' });
  for (const second of [entry('kept', selected, { sessionId: 'other', nativeId: null }), entry('done', selected, { sessionId: 'other', nativeId: 'native-other' })]) {
    assert.deepEqual(successor(selected, [entry('done'), second]), selected, 'ambiguous branch must not delegate');
  }
  assert.deepEqual(successor(selected, [entry('done'), entry('kept')]), selected);
  assert.deepEqual(successor(selected, [entry('done', { ...selected, nativeId: 'different' })]), selected);
  const mismatch = entry('done', { ...selected, nativeId: 'different' });
  assert.deepEqual(successor(selected, [mismatch, entry('done')]), selected, 'contradictory native identities cannot be upgraded by a later line');
  assert.deepEqual(successor(selected, [entry('done'), entry('done', next, selected)]), selected, 'cycle cannot grant a successor');
  assert.deepEqual(successor(selected, [entry('done'), entry('done', { sessionId: 'another-parent', nativeId: 'n-parent' }, next)]), selected);
});
test('actual written log moves authorization after done and keeps it at the source for a branch', t => {
  const role = chosen(setup(t).dir, selected);
  const write = entries => fs.writeFileSync(role.logFile, entries.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
  write([entry('kept')]);
  assert.deepEqual(role.current(), selected);
  write([entry('done')]);
  assert.deepEqual(role.current(), next);
  write([entry('done'), entry('done', selected, { sessionId: 'other', nativeId: 'n-other' })]);
  assert.deepEqual(role.current(), selected);
});
test('unreadable selection or rotation records fail closed', t => {
  const { dir } = setup(t), role = chosen(dir, selected);
  fs.writeFileSync(role.logFile, '{broken\n', { mode: 0o600 });
  assert.throws(() => role.current(), error => error.uiMessage.key === 'error.queue.secretaryState');
  fs.writeFileSync(role.file, '{broken');
  assert.throws(() => new QueueSecretary(dir).current(), error => error.uiMessage.key === 'error.queue.secretaryState');
});
test('review note 5: a rotation log past 32 MB still names the successor, for the butler, the secretary and the integrator', t => {
  const { dir } = setup(t), role = chosen(dir, selected);
  const steward = new StewardRole(dir);
  steward.set(selected);
  const integrator = new IntegratorRole(dir);
  integrator.set(selected);
  const log = path.join(dir, 'rotation-log.jsonl');
  // The first replacement, then 33 MB of other sessions' steps, then the next replacement.
  const third = { sessionId: 'third', nativeId: 'native-third' };
  const other = JSON.stringify({ ...entry('requested', { sessionId: 'x', nativeId: 'native-x' }), pad: 'p'.repeat(400) });
  fs.writeFileSync(log, `${JSON.stringify(entry('done'))}\n${`${other}\n`.repeat(Math.ceil(33 * 1024 * 1024 / (other.length + 1)))}`, { mode: 0o600 });
  assert.ok(fs.statSync(log).size > 32 * 1024 * 1024);
  for (const record of [steward, role, integrator]) assert.deepEqual(record.current(), next);
  fs.appendFileSync(log, `${JSON.stringify(entry('done', next, third))}\n`);
  for (const record of [steward, role, integrator]) assert.deepEqual(record.current(), third);
  assert.deepEqual(follow(log, next), { ...third, at: 100, replaced: true, spaces: ['shared'] });
});

test('the log is read on from where the last read stopped, and again from the start when it is another file', t => {
  const { dir } = setup(t);
  const log = path.join(dir, 'rotation-log.jsonl');
  const third = { sessionId: 'third', nativeId: 'native-third' };
  fs.writeFileSync(log, `${JSON.stringify(entry('requested'))}\n${JSON.stringify(entry('done'))}\n`, { mode: 0o600 });
  assert.deepEqual(rotationEdges(log).map(line => line.event), ['done'], 'only done and kept lines are kept');
  // A line still being written counts as it is now, and once it ends it is not taken twice.
  fs.appendFileSync(log, JSON.stringify(entry('kept', next, third)));
  assert.deepEqual(rotationEdges(log).map(line => line.event), ['done', 'kept']);
  fs.appendFileSync(log, '\n');
  assert.deepEqual(rotationEdges(log).map(line => line.event), ['done', 'kept']);
  // Written over in place, longer than before: read from its start.
  fs.writeFileSync(log, `${JSON.stringify({ ...entry('done', next, third), time: 200 })}\n${JSON.stringify(entry('requested'))}\n`.repeat(2));
  assert.deepEqual(rotationEdges(log).map(line => [line.event, line.time]), [['done', 200], ['done', 200]]);
  // Another file at the path.
  const swap = path.join(dir, 'swap.jsonl');
  fs.writeFileSync(swap, `${JSON.stringify(entry('kept'))}\n`, { mode: 0o600 });
  fs.renameSync(swap, log);
  assert.deepEqual(rotationEdges(log).map(line => line.event), ['kept']);
  // A line that does not parse is an error on this read and every later one, as before; so is a link.
  fs.appendFileSync(log, 'not a log line\n');
  assert.throws(() => rotationEdges(log), SyntaxError);
  fs.appendFileSync(log, `${JSON.stringify(entry('done'))}\n`);
  assert.throws(() => rotationEdges(log), /Unreadable/);
  const link = path.join(dir, 'link.jsonl');
  fs.symlinkSync(log, link);
  assert.throws(() => rotationEdges(link), error => error.code === 'ELOOP');
  assert.throws(() => rotationEdges(path.join(dir, 'none.jsonl')), error => error.code === 'ENOENT');
});

test('after a short line is added, later reads read only what is new, not the whole log again', t => {
  const { dir } = setup(t);
  const log = path.join(dir, 'rotation-log.jsonl');
  const line = JSON.stringify(entry('requested'));
  fs.writeFileSync(log, `${line}\n`.repeat(2000), { mode: 0o600 });
  rotationEdges(log);
  const read = fs.readSync;
  let bytes = 0;
  t.after(() => { fs.readSync = read; });
  fs.readSync = (...args) => { const n = read(...args); bytes += n; return n; };
  for (const short of ['{"event":"x"}', '{"event":"y"}', '{"event":"z"}']) {
    fs.appendFileSync(log, `${short}\n`);
    bytes = 0;
    rotationEdges(log);
    assert.ok(bytes <= 256 + short.length + 1, `read ${bytes} bytes after adding ${short.length + 1}`);
    bytes = 0;
    rotationEdges(log);
    assert.ok(bytes <= 256, `read ${bytes} bytes with nothing added`);
  }
  // What a caller does to the answer does not change the next one.
  fs.appendFileSync(log, `${JSON.stringify(entry('done'))}\n`);
  rotationEdges(log).push({ event: 'done' });
  assert.equal(rotationEdges(log).length, 1);
  // Also while a line of another kind is still being written.
  fs.appendFileSync(log, JSON.stringify(entry('requested')));
  rotationEdges(log).push({ event: 'done' });
  assert.equal(rotationEdges(log).length, 1);
});
