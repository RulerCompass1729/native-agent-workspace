// A Claude session the person left bypass in is never put back into it. The real resume and launch over a stand-in
// binary that records its arguments: no provider process, no model. The real CLI was run apart.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { maintenanceProof } = require('../backend-switch.cjs');
const { uiError } = require('../ui-errors.cjs');
const BYPASS = 'bypassPermissions', OTHERS = ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'];
const EXIT = Symbol('exit');
const row = (permissionMode, sessionId) => JSON.stringify({ type: 'permission-mode', permissionMode, sessionId }) + '\n';
// A turn names the mode it runs in, not one that Claude comes back in.
const turn = (permissionMode, sessionId) => JSON.stringify({ type: 'user', permissionMode, sessionId }) + '\n';
// Claude writes this as it exits, and the mode only where it is not the one written last.
const exit = sessionId => JSON.stringify({ type: 'cost-state', sessionId }) + '\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'naw-bypass-left-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'argv.json'), binary = path.join(dir, 'claude');
  fs.writeFileSync(binary, `#!${process.execPath}\nif (process.argv[2] === 'agents') console.log('[]'); else require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const host = { binaries: { claude: binary }, privateDir: dir, hookTargets: new Map(), hookSocket: path.join(dir, 'hook.sock'), submitSocket: path.join(dir, 'submit.sock') };
  // modes: what its transcript says, in order, { turn } as a turn says it, EXIT: Claude ended; null: it has none. Returns the --permission-mode it was started with.
  return async function resumed(modes, { record = {}, by = 'update', prepare } = {}) {
    fs.rmSync(output, { force: true });
    const nativeId = randomUUID(), nativeTranscript = path.join(dir, `${nativeId}.jsonl`);
    if (modes) fs.writeFileSync(nativeTranscript, JSON.stringify({ type: 'user', sessionId: nativeId }) + '\n' + modes.map(mode => mode.turn ? turn(mode.turn, nativeId) : mode === EXIT ? exit(nativeId) : row(mode, nativeId)).join(''));
    const s = { id: randomUUID(), nativeId, nativeTranscript, name: 'Agent A', provider: 'claude', state: 'ended', cwd: dir, owner: 'window', view: 'terminal', model: 'claude-opus-5-5', controlRevision: 3, connectionRevision: 2,
      messages: [], fleet: [], skipPermissions: true, nativePermissionMode: BYPASS, ...record };
    const w = Object.create(Workspace.prototype); EventEmitter.call(w); let runtime;
    Object.assign(w, { sessions: new Map([[s.id, s]]), runtimes: new Map(), stops: new Map(), draftRevisions: new Map(), rooms: new Map(), bind: () => {}, pause: () => {}, changed: () => {},
      nativeHistory: { ready: async () => {} }, host: { create: value => (runtime = new Claude(value, host)) } });
    prepare?.(s, nativeTranscript);
    try {
      if (by === 'update') await w.maintenanceResume(s.id, { ...maintenanceProof(s), draftRevision: 0 }, s.owner); else await w.resume(s.id, s.owner, by === 'model');
      await once(runtime.terminal, 'closed');
    } finally { runtime?.submission.close(); }
    const argv = JSON.parse(fs.readFileSync(output, 'utf8')); assert.deepEqual(argv.slice(0, 2), ['--resume', nativeId]);
    assert.equal(argv.filter(value => value === '--permission-mode').length, argv.includes('--permission-mode') ? 1 : 0);
    assert.equal(argv.some(value => /dangerously/.test(value)), false);
    return { asked: argv.includes('--permission-mode') ? argv[argv.indexOf('--permission-mode') + 1] : null, mode: s.nativePermissionMode };
  };
}

for (const by of ['update', 'person', 'model']) test(`left for another mode without a turn, then resumed by the ${by}: started in that mode, not in bypass`, async t => {
  const resumed = fixture(t);
  // By name: left to itself, Claude comes back from default into the person's own default, which can be bypass.
  for (const mode of OTHERS) assert.deepEqual(await resumed([BYPASS, mode], { by }), { asked: mode, mode }, mode);
  assert.deepEqual(await resumed([BYPASS, 'plan', 'auto'], { by }), { asked: 'auto', mode: 'auto' }, 'The last one counts');
  assert.deepEqual(await resumed(['default', 'plan', BYPASS], { by }), { asked: BYPASS, mode: BYPASS }, 'Left and gone back to');
});

test('a session known in another mode is never started in bypass, and in default only if it was left in it', async t => {
  const resumed = fixture(t);
  for (const by of ['update', 'person', 'model']) for (const known of OTHERS) {
    assert.deepEqual(await resumed([known, BYPASS], { by, record: { nativePermissionMode: known } }), { asked: known, mode: known }, `${by} ${known}, its transcript ends in bypass`);
    assert.deepEqual(await resumed([known, 'default'], { by, record: { nativePermissionMode: known } }), { asked: 'default', mode: known }, `${by} ${known}, its transcript ends in default`);
  }
  // Claude brings these back by itself.
  for (const known of OTHERS) for (const left of ['plan', 'acceptEdits', 'auto', 'dontAsk']) assert.deepEqual(await resumed([left], { record: { nativePermissionMode: known } }), { asked: null, mode: known }, `${known} ${left}`);
  for (const unusable of [null, ['someday']]) for (const known of ['plan', 'default']) assert.deepEqual(await resumed(unusable, { record: { nativePermissionMode: known } }), { asked: null, mode: known }, 'Nothing usable: as before');
  for (const [unread, prepare] of [[[], (s, file) => { fs.unlinkSync(file); fs.mkdirSync(file); }], [['plan'], s => { s.nativeTranscript = undefined; }]]) assert.deepEqual(await resumed(unread, { prepare, record: { nativePermissionMode: 'plan' } }), { asked: null, mode: 'plan' });
  assert.deepEqual(await resumed([BYPASS], { record: { nativePermissionMode: undefined } }), { asked: null, mode: undefined });
});

test('killed outright, a session comes back in what its last turn ran in where that allows no more than default', async t => {
  const resumed = fixture(t);
  for (const by of ['update', 'person']) {
    for (const known of ['plan', 'default', 'manual', 'dontAsk']) for (const older of [BYPASS, 'auto', 'acceptEdits']) assert.deepEqual(await resumed([older, { turn: known }], { by, record: { nativePermissionMode: known } }), { asked: known, mode: known }, `${older}, then a turn in ${known}`);
    assert.deepEqual(await resumed([], { by, record: { nativePermissionMode: 'plan' } }), { asked: 'plan', mode: 'plan' }, 'The end of a long one names no mode');
    // A key after the turn is lost with the process: nothing looser is asked for than before.
    for (const known of ['acceptEdits', 'auto']) assert.deepEqual(await resumed([BYPASS, { turn: known }], { by, record: { nativePermissionMode: known } }), { asked: null, mode: known }, known);
    assert.deepEqual(await resumed(['plan', { turn: BYPASS }], { by }), { asked: BYPASS, mode: BYPASS }, 'Back in bypass with a turn');
    assert.deepEqual(await resumed(['plan', { turn: BYPASS }, 'default'], { by }), { asked: 'default', mode: 'default' }, 'Left again');
    assert.deepEqual(await resumed([BYPASS, { turn: BYPASS }], { by, record: { nativePermissionMode: undefined } }), { asked: null, mode: undefined });
    // A tool's result names no mode; another conversation's turns, and a subagent's, say nothing here.
    assert.deepEqual(await resumed([BYPASS, { turn: BYPASS }, 'plan'], { by, prepare: (s, file) => fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: s.nativeId }) + '\n') }), { asked: 'plan', mode: 'plan' });
    assert.deepEqual(await resumed([BYPASS, 'plan'], { by, prepare: (s, file) => fs.appendFileSync(file, turn(BYPASS, randomUUID())) }), { asked: 'plan', mode: 'plan' });
    assert.deepEqual(await resumed([BYPASS, 'plan'], { by, prepare: (s, file) => fs.appendFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, permissionMode: BYPASS, sessionId: s.nativeId }) + '\n') }), { asked: 'plan', mode: 'plan' });
  }
});

test('a session that is still in bypass, and one whose record says nothing that can be used, come back as before', async t => {
  const resumed = fixture(t), kept = { asked: BYPASS, mode: BYPASS };
  for (const by of ['update', 'person', 'model']) {
    assert.deepEqual(await resumed([BYPASS], { by }), kept); assert.deepEqual(await resumed([], { by }), kept, 'It names no mode'); assert.deepEqual(await resumed(null, { by }), kept, 'It is not there');
    assert.deepEqual(await resumed(['someday'], { by }), kept, 'A mode NAW does not know');
    assert.deepEqual(await resumed(['plan'], { by, record: { nativeTranscript: undefined } }), kept, 'None was reported');
    assert.deepEqual(await resumed(null, { by, prepare: (s, file) => fs.writeFileSync(file, row('plan', randomUUID())) }), kept, 'Another conversation\'s');
    assert.deepEqual(await resumed(null, { by, prepare: (s, file) => { fs.writeFileSync(file + '.else', row('plan', s.nativeId)); fs.symlinkSync(file + '.else', file); } }), kept, 'A link to another file');
    assert.deepEqual(await resumed(null, { by, prepare: (s, file) => fs.mkdirSync(file) }), kept, 'No file');
    assert.deepEqual(await resumed(null, { by, prepare: (s, file) => fs.writeFileSync(file, '{"type":"permission-mode","permissionMode":"pl') }), kept, 'Cut short');
    assert.deepEqual(await resumed(null, { by, prepare: (s, file) => { fs.writeFileSync(file + '.else', row('plan', s.nativeId)); s.nativeTranscript = file + '.else'; } }), kept, 'A file of another name');
  }
});

test('an imported conversation the person asked to have in bypass starts in it, whatever mode it was in before', async t => {
  const resumed = fixture(t), record = { externalHistory: true, state: 'recoverable', nativeTranscript: undefined, skipPermissions: undefined };
  assert.deepEqual(await resumed(['plan'], { by: 'person', record }), { asked: BYPASS, mode: BYPASS });
  assert.deepEqual(await resumed([BYPASS], { by: 'person', record: { ...record, nativePermissionMode: undefined } }), { asked: null, mode: undefined }, 'And not without being asked');
});

test('a resume that is refused leaves what NAW knows of the session alone', async t => {
  const resumed = fixture(t), refuses = name => error => error?.uiMessage?.key === name; let s;
  const attempt = (record, name, by) => assert.rejects(resumed(['plan'], { by, record, prepare: value => { s = value; } }), refuses(name));
  await attempt({ state: 'idle' }, 'error.workspace.cannotResume', 'person'); assert.equal(s.nativePermissionMode, BYPASS);
  await attempt({ processIdentity: { pid: process.pid } }, 'error.workspace.previousProcessMayRun', 'update'); assert.equal(s.nativePermissionMode, BYPASS);
  await attempt({ nativeContextPending: {} }, 'error.workspace.nativeContextIdentityUnconfirmed', 'person'); assert.equal(s.nativePermissionMode, BYPASS);
});

test('ended in the mode written last, with a turn in another one between, a session comes back in it though it is not written again', async t => {
  const resumed = fixture(t);
  for (const by of ['update', 'person']) {
    for (const left of ['plan', 'default', 'acceptEdits', 'auto']) assert.deepEqual(await resumed([left, { turn: BYPASS }, EXIT], { by }), { asked: left, mode: left }, `Opened in bypass, back to ${left}`);
    for (const known of ['acceptEdits', 'auto', 'plan']) assert.deepEqual(await resumed(['default', { turn: known }, EXIT], { by, record: { nativePermissionMode: known } }), { asked: 'default', mode: known }, `${known}, back to default`);
    assert.deepEqual(await resumed(['plan', { turn: 'auto' }, EXIT], { by, record: { nativePermissionMode: 'auto' } }), { asked: null, mode: 'auto' }, 'Claude restores it');
    assert.deepEqual(await resumed([BYPASS, { turn: 'auto' }, EXIT], { by, record: { nativePermissionMode: 'auto' } }), { asked: 'auto', mode: 'auto' });
    assert.deepEqual(await resumed([BYPASS, { turn: BYPASS }, EXIT], { by }), { asked: BYPASS, mode: BYPASS });
    // Ended before that turn, then killed: as any killed one.
    assert.deepEqual(await resumed(['plan', EXIT, { turn: BYPASS }], { by }), { asked: BYPASS, mode: BYPASS });
    assert.deepEqual(await resumed(['auto', EXIT, { turn: 'plan' }], { by, record: { nativePermissionMode: 'plan' } }), { asked: 'plan', mode: 'plan' });
    assert.deepEqual(await resumed(['plan', { turn: BYPASS }], { by, prepare: (s, file) => fs.appendFileSync(file, exit(randomUUID())) }), { asked: BYPASS, mode: BYPASS }, "Another conversation's end");
    assert.deepEqual(await resumed([EXIT], { by }), { asked: BYPASS, mode: BYPASS }, 'The end of a long one names no mode');
  }
});
