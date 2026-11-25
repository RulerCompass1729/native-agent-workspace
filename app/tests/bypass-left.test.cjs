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
const row = (permissionMode, sessionId) => JSON.stringify({ type: 'permission-mode', permissionMode, sessionId }) + '\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'naw-bypass-left-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'argv.json'), binary = path.join(dir, 'claude');
  fs.writeFileSync(binary, `#!${process.execPath}\nif (process.argv[2] === 'agents') console.log('[]'); else require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const host = { binaries: { claude: binary }, privateDir: dir, hookTargets: new Map(), hookSocket: path.join(dir, 'hook.sock'), submitSocket: path.join(dir, 'submit.sock') };
  // modes: what its transcript says, in order; null: it has none. Returns the --permission-mode it was started with.
  return async function resumed(modes, { record = {}, by = 'update', prepare } = {}) {
    fs.rmSync(output, { force: true });
    const nativeId = randomUUID(), nativeTranscript = path.join(dir, `${nativeId}.jsonl`);
    if (modes) fs.writeFileSync(nativeTranscript, JSON.stringify({ type: 'user', sessionId: nativeId }) + '\n' + modes.map(mode => row(mode, nativeId)).join(''));
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

for (const by of ['update', 'person', 'model']) test(`left for another mode without a turn, then resumed by the ${by}: not put back into bypass`, async t => {
  const resumed = fixture(t);
  for (const mode of OTHERS) assert.deepEqual(await resumed([BYPASS, mode], { by }), { asked: null, mode }, mode);
  assert.deepEqual(await resumed([BYPASS, 'plan', 'auto'], { by }), { asked: null, mode: 'auto' }, 'The last one counts');
  assert.deepEqual(await resumed(['default', 'plan', BYPASS], { by }), { asked: BYPASS, mode: BYPASS }, 'Left and gone back to');
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

test('whatever its record says, a session comes back with no more than NAW knew it had', async t => {
  const resumed = fixture(t);
  for (const known of [...OTHERS, undefined]) for (const forged of [[BYPASS], ['plan', BYPASS], ['acceptEdits'], ['auto'], ['dangerously-skip-permissions']]) for (const by of forged.length > 1 ? ['update', 'person', 'model'] : ['update']) {
    assert.deepEqual(await resumed(forged, { by, record: { nativePermissionMode: known } }), { asked: null, mode: known }, `${by} ${known} ${forged}`);
  }
});

test('an imported conversation the person asked to have in bypass starts in it, whatever mode it was in before', async t => {
  const resumed = fixture(t), record = { externalHistory: true, state: 'recoverable', nativeTranscript: undefined, skipPermissions: undefined };
  assert.deepEqual(await resumed(['plan'], { by: 'person', record }), { asked: BYPASS, mode: BYPASS });
  assert.deepEqual(await resumed([BYPASS], { by: 'person', record: { ...record, nativePermissionMode: undefined } }), { asked: null, mode: undefined });
});

test('a resume that is refused leaves what NAW knows of the session alone', async t => {
  const resumed = fixture(t), refuses = name => error => error?.uiMessage?.key === name; let s;
  const attempt = (record, name, by) => assert.rejects(resumed(['plan'], { by, record, prepare: value => { s = value; } }), refuses(name));
  await attempt({ state: 'idle' }, 'error.workspace.cannotResume', 'person'); assert.equal(s.nativePermissionMode, BYPASS);
  await attempt({ processIdentity: { pid: process.pid } }, 'error.workspace.previousProcessMayRun', 'update'); assert.equal(s.nativePermissionMode, BYPASS);
  await attempt({ nativeContextPending: {} }, 'error.workspace.nativeContextIdentityUnconfirmed', 'person'); assert.equal(s.nativePermissionMode, BYPASS);
});
