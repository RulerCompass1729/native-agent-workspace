const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const realWrite = fs.promises.writeFile;

// The timed checkpoint writes off the event loop; persist() still saves before it returns. Drafts mark which
// state reached the disk. A gate holds an asynchronous write so a test can act while it is on its way.
function fixture(t, { rooms = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-async-save-'));
  const host = { binaries: {}, codexTargets: new Map(), close() {} };
  const w = new Workspace(host, directory);
  if (rooms) w.rooms.set('second', { id: 'second', name: 'Second', revision: 0, run: null, messages: [] });
  assert.equal(fs.promises.writeFile, realWrite, 'one fixture at a time');
  const gates = [], writes = [];
  let open = 0, most = 0;
  fs.promises.writeFile = async (file, data, options) => {
    const entry = { file: path.basename(String(file)), data: String(data) }; writes.push(entry);
    open++; most = Math.max(most, open);
    try {
      if (entry.file.endsWith('.later.tmp')) await new Promise(resolve => { entry.resolve = resolve; gates.push(entry); });
      if (entry.fail) throw Object.assign(Error('synthetic write failure'), { code: 'EIO' });
      return await realWrite(file, data, options);
    } finally { open--; }
  };
  t.after(() => { fs.promises.writeFile = realWrite; w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const disk = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const gate = async () => { for (let i = 0; i < 400 && !gates.length; i++) await new Promise(r => setTimeout(r, 5)); assert.ok(gates.length, 'an asynchronous write is waiting'); return gates.shift(); };
  const settled = async () => { for (let i = 0; i < 400 && w.saveWriting; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(w.saveWriting, false); };
  return { w, directory, disk, gate, settled, writes, most: () => most };
}
const leftovers = directory => fs.readdirSync(directory).filter(name => name.endsWith('.tmp'));

test('a timed checkpoint writes off the event loop and nothing synchronous touches the store', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persist();
  // A temporary file left by an earlier run keeps its mode when written again; the store must still end up private.
  fs.writeFileSync(path.join(f.directory, 'workspace.json.later.tmp'), 'stale', { mode: 0o644 }); fs.chmodSync(path.join(f.directory, 'workspace.json.later.tmp'), 0o644);
  const realSync = fs.writeFileSync, syncWrites = [];
  fs.writeFileSync = (file, ...rest) => { syncWrites.push(path.basename(String(file))); return realSync(file, ...rest); };
  t.after(() => { fs.writeFileSync = realSync; });
  f.w.drafts.set('mark', 'B'); f.w.changed();
  const held = await f.gate();
  assert.equal(f.disk('workspace.json').drafts.mark, 'A', 'the old store stays while the write is on its way');
  held.resolve(); await f.settled();
  fs.writeFileSync = realSync;
  assert.deepEqual(syncWrites, []);
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  assert.equal(fs.statSync(path.join(f.directory, 'workspace.json')).mode & 0o777, 0o600);
  assert.deepEqual(leftovers(f.directory), []);
});

test('a reply streaming without pause is saved at the one-second deadline, also off the event loop', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persist();
  const realSync = fs.writeFileSync, syncWrites = [];
  fs.writeFileSync = (file, ...rest) => { syncWrites.push(path.basename(String(file))); return realSync(file, ...rest); };
  t.after(() => { fs.writeFileSync = realSync; });
  // A change every 50 ms keeps postponing the 150 ms checkpoint; only the deadline can fire.
  const started = Date.now();
  for (let i = 0; !f.writes.length && Date.now() - started < 2500; i++) { f.w.drafts.set('mark', `B${i}`); f.w.changed(); await new Promise(r => setTimeout(r, 50)); }
  fs.writeFileSync = realSync;
  assert.deepEqual(syncWrites, []);
  assert.equal(f.writes.length, 1);
  (await f.gate()).resolve(); await f.settled();
  assert.match(f.disk('workspace.json').drafts.mark, /^B\d+$/);
});

test('an older checkpoint finishing after persist() does not replace what persist() saved', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persistLater();
  const held = await f.gate();
  f.w.drafts.set('mark', 'B'); assert.equal(f.w.persist(), true);
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  held.resolve(); await f.settled();
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  assert.ok(!f.w.storageWarning);
  assert.deepEqual(leftovers(f.directory), []);
});

test('one write at a time; a checkpoint due meanwhile saves the state at the end of that write', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persistLater();
  const first = await f.gate();
  f.w.drafts.set('mark', 'B'); f.w.persistLater();
  f.w.drafts.set('mark', 'C'); f.w.persistLater();
  assert.equal(f.writes.length, 1, 'no second write starts while one is on its way');
  first.resolve();
  const second = await f.gate();
  assert.equal(JSON.parse(second.data).drafts.mark, 'C');
  assert.equal(f.disk('workspace.json').drafts.mark, 'A');
  second.resolve(); await f.settled();
  assert.equal(f.disk('workspace.json').drafts.mark, 'C');
  assert.equal(f.writes.length, 2); assert.equal(f.most(), 1);
});

test('room records keep the snapshot of the workspace file they were saved with', async t => {
  const f = fixture(t, { rooms: true });
  f.w.rooms.get('second').name = 'A'; f.w.drafts.set('mark', 'A'); f.w.persistLater();
  (await f.gate()).resolve();
  const rooms = await f.gate();
  assert.equal(f.disk('workspace.json').drafts.mark, 'A');
  f.w.rooms.get('second').name = 'B'; f.w.drafts.set('mark', 'B'); assert.equal(f.w.persist(), true);
  rooms.resolve(); await f.settled();
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  assert.equal(f.disk('room-records.json').rooms[0].name, 'B');
  assert.deepEqual(leftovers(f.directory), []);
  // Without a newer save in between, both files of one checkpoint arrive.
  f.w.rooms.get('second').name = 'C'; f.w.drafts.set('mark', 'C'); f.w.persistLater();
  (await f.gate()).resolve(); (await f.gate()).resolve(); await f.settled();
  assert.equal(f.disk('workspace.json').drafts.mark, 'C'); assert.equal(f.disk('room-records.json').rooms[0].name, 'C');
});

test('a failed checkpoint warns like persist()', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persist();
  f.w.drafts.set('mark', 'B'); f.w.persistLater();
  const held = await f.gate(); held.fail = true; held.resolve();
  await f.settled();
  assert.equal(f.w.storageFailure, 'write'); assert.ok(f.w.storageWarning);
  assert.equal(f.disk('workspace.json').drafts.mark, 'A');
});

test('a checkpoint that fails after a newer save reached the disk does not warn', async t => {
  const g = fixture(t);
  g.w.drafts.set('mark', 'A'); g.w.persistLater();
  const late = await g.gate();
  g.w.drafts.set('mark', 'B'); g.w.persist();
  late.fail = true; late.resolve(); await g.settled();
  assert.ok(!g.w.storageWarning);
  assert.equal(g.disk('workspace.json').drafts.mark, 'B');
});

test('close saves at once; a write still on its way and a checkpoint due meanwhile change nothing after it', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persistLater();
  const held = await f.gate();
  f.w.drafts.set('mark', 'B'); f.w.persistLater();
  f.w.drafts.set('mark', 'C'); f.w.close();
  assert.equal(f.disk('workspace.json').drafts.mark, 'C');
  held.resolve(); await f.settled();
  assert.equal(f.disk('workspace.json').drafts.mark, 'C');
  assert.equal(f.writes.length, 1, 'no checkpoint is taken after close');
  assert.ok(!f.w.storageWarning);
});

// A caller that removes the folder after close() must not race a checkpoint still on its way
// (ENOTEMPTY when its temporary file appears during the removal).
test('close() returns a promise that settles only after a write on its way has ended and removed its temporary file', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persistLater();
  const held = await f.gate();
  f.w.drafts.set('mark', 'B'); const closing = f.w.close();
  assert.ok(closing instanceof Promise, 'close() hands back the in-flight checkpoint');
  let done = false; closing.then(() => { done = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(done, false, 'not settled while the write is held');
  held.resolve(); await closing;
  assert.equal(f.w.saveWriting, false); assert.deepEqual(leftovers(f.directory), []);
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  assert.ok((f.w.close()) instanceof Promise, 'with nothing on its way close() still returns a settled promise');
});

test('when close() could not save, a write still on its way renames nothing after it', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persist();
  f.w.drafts.set('mark', 'B'); f.w.persistLater();
  const held = await f.gate();
  fs.mkdirSync(path.join(f.directory, 'workspace.json.tmp'));
  f.w.drafts.set('mark', 'C'); f.w.close();
  assert.ok(f.w.storageWarning, 'close() reports its own failed save');
  held.resolve(); await f.settled();
  assert.equal(f.disk('workspace.json').drafts.mark, 'A');
  assert.deepEqual(leftovers(f.directory), ['workspace.json.tmp']);
  fs.rmdirSync(path.join(f.directory, 'workspace.json.tmp'));
});

test('when close() could not save, room records still on their way are not renamed after it', async t => {
  const f = fixture(t, { rooms: true });
  f.w.rooms.get('second').name = 'A'; f.w.drafts.set('mark', 'A'); f.w.persist();
  f.w.rooms.get('second').name = 'B'; f.w.drafts.set('mark', 'B'); f.w.persistLater();
  (await f.gate()).resolve();
  const rooms = await f.gate();
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  fs.mkdirSync(path.join(f.directory, 'workspace.json.tmp'));
  f.w.close();
  assert.ok(f.w.storageWarning, 'close() reports its own failed save');
  rooms.resolve(); await f.settled();
  assert.equal(f.disk('room-records.json').rooms[0].name, 'A');
  assert.deepEqual(leftovers(f.directory), ['workspace.json.tmp']);
  fs.rmdirSync(path.join(f.directory, 'workspace.json.tmp'));
});

test('a persist() whose rename errors after it took place still keeps an older checkpoint out', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persistLater();
  const held = await f.gate();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { fs.renameSync = rename; rename(from, to); throw Object.assign(Error('synthetic error after the rename'), { code: 'EIO' }); };
  t.after(() => { fs.renameSync = rename; });
  f.w.drafts.set('mark', 'B'); assert.equal(f.w.persist(), false);
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  held.resolve(); await f.settled();
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
});

test('after a failed read no checkpoint writes over the store', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persist();
  f.w.storageFailure = 'read'; f.w.storageWarning = 'synthetic read failure';
  f.w.drafts.set('mark', 'B'); f.w.persistLater();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(f.writes.length, 0);
  assert.equal(f.disk('workspace.json').drafts.mark, 'A');
});

// Most reported changes are of state that is not saved; a checkpoint of the JSON already on disk writes nothing.
const quiet = () => new Promise(r => setTimeout(r, 30));
const pass = async (f, count) => { for (let i = 0; i < count; i++) (await f.gate()).resolve(); await f.settled(); };

test('a checkpoint of what is already on disk writes nothing; the next real change is written', async t => {
  const f = fixture(t, { rooms: true });
  f.w.drafts.set('mark', 'A'); f.w.persist();
  const before = fs.statSync(path.join(f.directory, 'workspace.json')).ino;
  f.w.changed(); f.w.persistLater(); f.w.persistLater(); await quiet();
  assert.equal(f.writes.length, 0, 'the state persist() saved is not written again');
  assert.equal(f.w.saveWriting, false);
  f.w.drafts.set('mark', 'B'); f.w.persistLater(); await pass(f, 2);
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
  assert.notEqual(fs.statSync(path.join(f.directory, 'workspace.json')).ino, before);
  f.w.persistLater(); await quiet();
  assert.equal(f.writes.length, 2, 'nor is the state a checkpoint saved');
  f.w.drafts.set('mark', 'A'); f.w.persistLater(); await pass(f, 2);
  assert.equal(f.disk('workspace.json').drafts.mark, 'A', 'going back to an earlier state is a change');
});

test('a change of room records alone is written', async t => {
  const f = fixture(t, { rooms: true });
  f.w.rooms.get('second').name = 'A'; f.w.persist();
  f.w.rooms.get('second').name = 'B'; f.w.persistLater(); await pass(f, 2);
  assert.equal(f.disk('room-records.json').rooms[0].name, 'B');
});

test('a full checkpoint finds a message changed in place that nothing reported', async t => {
  const f = fixture(t);
  f.w.room.messages.push({ id: 'm', role: 'human', text: 'A' }); f.w.persist();
  f.w.sessions.set('s', { id: 's', provider: 'claude', state: 'idle', messages: [{ id: 'n', role: 'user', text: 'A' }], usage: {} });
  f.w.persist();
  f.w.sessions.get('s').messages[0].text = 'B'; f.w.savedAllAt = -Infinity;
  f.w.persistLater(); await pass(f, 1);
  assert.equal(f.disk('workspace.json').sessions[0].messages[0].text, 'B');
});

test('a full checkpoint of the same state writes nothing and keeps only the newer strings', async t => {
  const f = fixture(t);
  f.w.sessions.set('s', { id: 's', provider: 'claude', state: 'idle', messages: [{ id: 'n', role: 'user', text: 'A' }], usage: {} });
  f.w.persist(); f.w.savedAllAt = -Infinity;
  const kept = f.w.saved.state;
  f.w.persistLater(); await quiet();
  assert.equal(f.writes.length, 0);
  assert.notEqual(f.w.saved.state, kept); assert.deepEqual(f.w.saved.state, kept);
});

for (const name of ['workspace.json', 'room-records.json']) {
  for (const [what, act] of [
    ['missing', file => fs.rmSync(file)],
    ['replaced', file => { fs.writeFileSync(`${file}.other`, '{}'); fs.renameSync(`${file}.other`, file); }],
    ['overwritten', file => fs.writeFileSync(file, '{}')],
    ['rewritten at the same size and time', file => { const { size, atimeMs, mtimeMs } = fs.statSync(file); fs.writeFileSync(file, ' '.repeat(size)); fs.utimesSync(file, atimeMs / 1000, mtimeMs / 1000); }],
    ['made readable to others', file => fs.chmodSync(file, 0o644)],
    ['a link to the file saved', file => { fs.renameSync(file, `${file}.moved`); fs.symlinkSync(`${file}.moved`, file); }],
  ]) test(`an unchanged store is written again when ${name} is ${what}`, async t => {
    const f = fixture(t, { rooms: true });
    f.w.drafts.set('mark', 'A'); f.w.rooms.get('second').name = 'A'; f.w.persist();
    act(path.join(f.directory, name));
    f.w.persistLater(); await pass(f, 2);
    assert.equal(f.disk('workspace.json').drafts.mark, 'A');
    assert.equal(f.disk('room-records.json').rooms[0].name, 'A');
    const left = fs.lstatSync(path.join(f.directory, name)); assert.equal(left.isFile(), true); assert.equal(left.mode & 0o777, 0o600);
  });
}

test('removing the last session is a change', async t => {
  const f = fixture(t), row = id => ({ id, provider: 'claude', state: 'idle', messages: [], usage: {} });
  f.w.sessions.set('s', row('s')); f.w.sessions.set('u', row('u')); f.w.persist();
  f.w.sessions.delete('u'); f.w.persistLater(); await pass(f, 1);
  assert.deepEqual(f.disk('workspace.json').sessions.map(s => s.id), ['s']);
});

test('persist() and close() write what is already on disk', async t => {
  const f = fixture(t), file = path.join(f.directory, 'workspace.json'); const ino = () => fs.statSync(file).ino;
  f.w.drafts.set('mark', 'A'); f.w.persist();
  let before = ino(); assert.equal(f.w.persist(), true); assert.notEqual(ino(), before);
  before = ino(); f.w.close(); assert.notEqual(ino(), before);
});

test('a replacement persist() saved is not taken for the state of the session', async t => {
  const f = fixture(t);
  const row = { id: 's', provider: 'claude', state: 'idle', name: 'A', messages: [], usage: {} };
  f.w.sessions.set('s', row); f.w.persist();
  assert.equal(f.w.persist({ id: 's', next: { ...row, name: 'B' } }), true);
  f.w.persistLater(); await pass(f, 1);
  assert.equal(f.disk('workspace.json').sessions[0].name, 'A');
});

test('a checkpoint that saved only the workspace file is not taken for saved', async t => {
  const f = fixture(t, { rooms: true });
  f.w.rooms.get('second').name = 'A'; f.w.drafts.set('mark', 'A'); f.w.persist();
  f.w.rooms.get('second').name = 'B'; f.w.drafts.set('mark', 'B'); f.w.persistLater();
  (await f.gate()).resolve();
  const rooms = await f.gate(); rooms.fail = true; rooms.resolve(); await f.settled();
  assert.equal(f.w.storageFailure, 'write');
  assert.equal(f.disk('workspace.json').drafts.mark, 'B'); assert.equal(f.disk('room-records.json').rooms[0].name, 'A');
  f.w.storageFailure = null; f.w.storageWarning = null; // as retrySave(), without its own save
  f.w.persistLater(); await pass(f, 2);
  assert.equal(f.disk('room-records.json').rooms[0].name, 'B');
});

test('a retry after a failed checkpoint saves the state', async t => {
  const f = fixture(t);
  f.w.drafts.set('mark', 'A'); f.w.persist();
  f.w.drafts.set('mark', 'B'); f.w.persistLater();
  const held = await f.gate(); held.fail = true; held.resolve(); await f.settled();
  assert.equal(f.w.retrySave(), true);
  assert.equal(f.disk('workspace.json').drafts.mark, 'B');
});
