const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { inspect, acquire, release, canonicalDirectory, run } = require('../../scripts/integrator-lock.cjs');
const script = path.resolve(__dirname, '../../scripts/integrator-lock.cjs');
const checkpoint = { head: 'a'.repeat(40), installedVersion: null, evidence: 'synthetic rehearsal receipt', note: 'No daily app or real integration touched.' };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-rehearsal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lock: path.join(root, '.local', 'integrator.lock') };
}
async function cli(directory, ...args) {
  assert.ok(path.basename(directory) === 'integrator.lock' && path.basename(path.dirname(path.dirname(directory))).startsWith('naw-integrator-rehearsal-'));
  const [command, ...rest] = args;
  // Test scope precedes the child-command separator; it must never become an
  // argument to the command or silently select the real shared operator lock.
  const child = spawn(process.execPath, [script, command, '--directory', directory, ...rest], { cwd: path.dirname(script), env: { ...process.env, NAW_INTEGRATOR_REHEARSAL_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const [code] = await once(child, 'close'); return { code, out, err };
}
test('author worktree resolves the shared main-repository lock without creating it', () => {
  const repo = path.resolve(__dirname, '../..'), lock = canonicalDirectory(repo);
  assert.equal(path.basename(lock), 'integrator.lock'); assert.equal(path.basename(path.dirname(lock)), '.local');
  // Worktree metadata supplies an independent expectation for Git's common dir.
  const dotGit = path.join(repo, '.git');
  const gitdir = fs.statSync(dotGit).isDirectory() ? dotGit : path.resolve(repo, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir: /, '').trim());
  const common = fs.existsSync(path.join(gitdir, 'commondir')) ? path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()) : gitdir;
  assert.equal(lock, path.join(path.dirname(common), '.local', 'integrator.lock'));
  // The real canonical lock is never acquired or released by this suite.
});
test('explicit backup handoff, single writer, returning Main and durable checkpoint', t => {
  const { lock } = setup(t);
  assert.throws(() => acquire(lock, { owner: 'Codex2', reason: 'test' }), /secretary/);
  const backup = acquire(lock, { owner: 'Codex2', reason: 'Synthetic Main idle >=60 minutes', delegation: 'Synthetic secretary handoff at the clean checkpoint' });
  assert.equal(inspect(lock).owner.token, backup.token);
  assert.throws(() => acquire(lock, { owner: 'CodexMain', reason: 'Returning Main' }), e => e.exitCode === 75);
  assert.throws(() => release(lock, 'wrong-token', checkpoint), e => e.exitCode === 75);
  assert.equal(inspect(lock).owner.token, backup.token);
  const result = release(lock, backup.token, checkpoint), receipt = JSON.parse(fs.readFileSync(result.checkpoint));
  assert.equal(result.released, true); assert.deepEqual(receipt.checkpoint, checkpoint); assert.deepEqual(receipt.lease, backup); assert.equal(inspect(lock).state, 'free');
  const main = acquire(lock, { owner: 'CodexMain', reason: 'Read backup receipt and resume' });
  assert.throws(() => release(lock, backup.token, checkpoint), e => e.exitCode === 75);
  assert.equal(inspect(lock).owner.token, main.token); release(lock, main.token, checkpoint);
});
test('dead-looking timestamps, incomplete records and occupied directories never expire', t => {
  const { lock } = setup(t); const owner = acquire(lock, { owner: 'CodexMain', reason: 'Synthetic original batch' });
  const file = path.join(lock, 'owner.json'); fs.writeFileSync(file, JSON.stringify({ ...owner, acquiredAt: '1970-01-01T00:00:00Z', pid: 999999999 }));
  assert.throws(() => acquire(lock, { owner: 'Codex2', reason: 'old is not permission', delegation: 'reference' }), e => e.exitCode === 75);
  fs.writeFileSync(file, '{'); assert.equal(inspect(lock).incomplete, true);
  assert.throws(() => release(lock, owner.token, checkpoint), e => e.exitCode === 75);
  assert.equal(fs.readFileSync(file, 'utf8'), '{'); assert.equal(fs.existsSync(path.join(lock, 'releasing')), false);
});
test('checkpoint failures and unexpected files preserve original ownership', t => {
  const { root, lock } = setup(t); const owner = acquire(lock, { owner: 'CodexMain', reason: 'Synthetic original batch' });
  assert.throws(() => release(lock, owner.token, { ...checkpoint, installedVersion: undefined }), /Checkpoint/);
  const archive = path.join(root, '.local', 'integrator-handoffs'); fs.writeFileSync(archive, 'do not delete');
  assert.throws(() => release(lock, owner.token, checkpoint)); assert.equal(inspect(lock).owner.token, owner.token);
  fs.unlinkSync(archive); fs.writeFileSync(path.join(lock, 'unexpected'), 'preserve');
  assert.throws(() => release(lock, owner.token, checkpoint), /Unexpected/); assert.equal(fs.readFileSync(path.join(lock, 'unexpected'), 'utf8'), 'preserve');
  assert.equal(inspect(lock).owner.token, owner.token); fs.unlinkSync(path.join(lock, 'unexpected')); release(lock, owner.token, checkpoint);
});
test('interrupted release and an existing retired directory do not consume the current owner', t => {
  const { root, lock } = setup(t), owner = acquire(lock, { owner: 'CodexMain', reason: 'Synthetic current batch' });
  fs.mkdirSync(path.join(lock, 'releasing'));
  assert.throws(() => release(lock, owner.token, checkpoint), e => e.exitCode === 75); assert.equal(inspect(lock).owner.token, owner.token);
  fs.rmdirSync(path.join(lock, 'releasing'));
  const retired = path.join(root, '.local', 'integrator-handoffs', owner.token + '.lock'); fs.mkdirSync(retired, { recursive: true });
  assert.throws(() => release(lock, owner.token, checkpoint), /prior retired directory/);
  assert.equal(inspect(lock).owner.token, owner.token); assert.equal(fs.existsSync(path.join(lock, 'releasing')), false);
  fs.rmdirSync(retired); release(lock, owner.token, checkpoint);
});
test('two real CLI processes compete; one wins; two releases cannot delete the next owner', async t => {
  const { root, lock } = setup(t);
  const results = await Promise.all(['Codex2', 'Codex3'].map(owner => cli(lock, 'acquire', '--owner', owner, '--reason', 'Synthetic idle handoff', '--delegation', 'Synthetic secretary entry')));
  assert.deepEqual(results.map(r => r.code).sort((a, b) => a - b), [0, 75]);
  const winning = JSON.parse(results.find(r => r.code === 0).out), file = path.join(root, 'checkpoint.json'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  let current;
  const releaseOnce = () => cli(lock, 'release', '--token', winning.token, '--checkpoint', file).then(result => {
    if (result.code === 0) current = acquire(lock, { owner: 'CodexMain', reason: 'Read prior handoff immediately on release' });
    return result;
  });
  const released = await Promise.all([releaseOnce(), releaseOnce()]);
  assert.deepEqual(released.map(r => r.code).sort((a, b) => a - b), [0, 75]); assert.ok(current);
  assert.equal((await cli(lock, 'release', '--token', winning.token, '--checkpoint', file)).code, 75);
  assert.equal(inspect(lock).owner.token, current.token); assert.equal((await cli(lock, 'release', '--token', current.token, '--checkpoint', file)).code, 0);
});
test('committed release stays explicit when retired cleanup fails, even as Main returns', t => {
  const { lock } = setup(t), owner = acquire(lock, { owner: 'CodexMain', reason: 'Synthetic prior batch' });
  const original = fs.rmdirSync; let returning;
  fs.rmdirSync = function (target, ...args) {
    if (String(target).endsWith(owner.token + '.lock/releasing')) {
      returning ||= acquire(lock, { owner: 'CodexMain', reason: 'Synthetic return during retired cleanup' });
      const error = new Error('Synthetic cleanup denial'); error.code = 'EACCES'; throw error;
    }
    return original.call(this, target, ...args);
  };
  let result;
  try { result = release(lock, owner.token, checkpoint); } finally { fs.rmdirSync = original; }
  assert.equal(result.released, true); assert.equal(result.cleanupError, 'EACCES'); assert.ok(fs.existsSync(result.cleanupPending));
  assert.equal(inspect(lock).owner.token, returning.token); release(lock, returning.token, checkpoint);
});
test('bounded command retains declared integration HEAD and scopes observed wrapper HEAD', async t => {
  const { root, lock } = setup(t), file = path.join(root, 'checkpoint.json'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  const marker = path.join(root, 'worked');
  const work = `const {inspect,acquire}=require(${JSON.stringify(script)}); const lock=${JSON.stringify(lock)}; require('node:assert/strict').throws(()=>acquire(lock,{owner:'CodexMain',reason:'Synthetic return while command active'}),e=>e.exitCode===75); require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({ownerSeen:inspect(lock).owner.owner}));`;
  const result = await cli(lock, 'run', '--owner', 'Codex2', '--reason', 'Synthetic Main idle >=60 minutes', '--delegation', 'Synthetic current secretary handoff', '--checkpoint', file, '--', process.execPath, '-e', work);
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(fs.readFileSync(marker)).ownerSeen, 'Codex2');
  const receipt = JSON.parse(result.out.trim().split('\n').at(-1)); assert.equal(receipt.released, true); assert.equal(receipt.child.code, 0);
  const handoff = JSON.parse(fs.readFileSync(receipt.checkpoint)); assert.equal(handoff.checkpoint.head, checkpoint.head); assert.match(handoff.checkpoint.observedHead, /^[0-9a-f]{40}$/); assert.equal(handoff.checkpoint.cwd, path.dirname(script)); assert.equal(handoff.checkpoint.installedVersion, null);
  assert.equal(inspect(lock).state, 'free'); const main = acquire(lock, { owner: 'CodexMain', reason: 'Resume after actual child completion' }); release(lock, main.token, checkpoint);
});
test('occupied run starts no command; failed command returns its failure without a stale lease', async t => {
  const { root, lock } = setup(t), file = path.join(root, 'checkpoint.json'), marker = path.join(root, 'must-not-run'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  const main = acquire(lock, { owner: 'CodexMain', reason: 'Synthetic active Main' });
  const refused = await cli(lock, 'run', '--owner', 'Codex2', '--reason', 'Synthetic backup', '--delegation', 'Synthetic handoff', '--checkpoint', file, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
  assert.equal(refused.code, 75); assert.equal(fs.existsSync(marker), false); assert.equal(inspect(lock).owner.token, main.token); release(lock, main.token, checkpoint);
  const failed = await cli(lock, 'run', '--owner', 'CodexMain', '--reason', 'Synthetic failed task', '--checkpoint', file, '--', process.execPath, '-e', 'process.exit(7)');
  assert.equal(failed.code, 7); assert.equal(inspect(lock).state, 'free'); assert.equal(JSON.parse(failed.out.trim().split('\n').at(-1)).child.code, 7);
});
test('spawn failure records uncertainty and releases only after the child close event', async t => {
  const { root, lock } = setup(t), file = path.join(root, 'checkpoint.json'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  const result = await cli(lock, 'run', '--owner', 'CodexMain', '--reason', 'Synthetic missing command', '--checkpoint', file, '--', path.join(root, 'nonexistent-command'));
  assert.equal(result.code, 1); const receipt = JSON.parse(result.out.trim().split('\n').at(-1));
  assert.match(receipt.child.error, /ENOENT/); assert.equal(receipt.released, true); assert.equal(inspect(lock).state, 'free');
});
test('rehearsal boundary rejects a misdirected launcher before any coordination write', async t => {
  const { root, lock } = setup(t), other = path.join(root, 'wrong', 'integrator.lock');
  const result = await cli(lock, 'acquire', '--owner', 'CodexMain', '--reason', 'Synthetic wrong scope', '--directory', other);
  // Duplicate scope options are also a refusal; no last-option override.
  assert.equal(result.code, 1); assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(other), false);
  const child = spawn(process.execPath, [script, 'acquire', '--directory', other, '--owner', 'CodexMain', '--reason', 'Synthetic wrong scope'], { cwd: path.dirname(script), env: { ...process.env, NAW_INTEGRATOR_REHEARSAL_DIRECTORY: lock }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', b => err += b); const [code] = await once(child, 'close');
  assert.equal(code, 1); assert.match(err, /Rehearsal directory mismatch/); assert.equal(fs.existsSync(other), false); assert.equal(fs.existsSync(lock), false);
});
test('post-command release failure retains outcome and recovery token with distinct exit 74', async t => {
  const { root, lock } = setup(t), file = path.join(root, 'checkpoint.json'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  const result = await cli(lock, 'run', '--owner', 'CodexMain', '--reason', 'Synthetic incomplete handoff', '--checkpoint', file, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(lock, 'unexpected'))},'preserve')`);
  assert.equal(result.code, 74); const receipt = JSON.parse(result.out.trim().split('\n').at(-1));
  assert.equal(receipt.child.code, 0); assert.equal(receipt.released, false); assert.equal(receipt.lockState.state, 'occupied');
  assert.equal(receipt.token, inspect(lock).owner.token); assert.match(receipt.releaseError.message, /Unexpected/); assert.equal(receipt.attemptedCheckpoint.head, checkpoint.head);
  fs.unlinkSync(path.join(lock, 'unexpected')); release(lock, receipt.token, checkpoint);
});
test('outside Git, explicit integration HEAD stays intact and wrapper observation is unknown', async t => {
  const { root, lock } = setup(t), file = path.join(root, 'checkpoint.json'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  const result = await run(lock, { owner: 'CodexMain', reason: 'Synthetic distinct worktree', checkpoint: file }, [process.execPath, '-e', ''], root);
  assert.equal(result.exitCode, 0); const receipt = JSON.parse(fs.readFileSync(result.checkpoint));
  assert.equal(receipt.checkpoint.head, checkpoint.head); assert.equal(receipt.checkpoint.observedHead, null); assert.equal(receipt.checkpoint.cwd, root);
});
test('empty command is rejected before acquiring any lease', async t => {
  const { root, lock } = setup(t), file = path.join(root, 'checkpoint.json'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  await assert.rejects(run(lock, { owner: 'CodexMain', reason: 'Synthetic empty command', checkpoint: file }, ['']), /requires a bounded foreground command/);
  assert.equal(fs.existsSync(lock), false);
});
test('child exits 74 and 75 remain in receipts without impersonating wrapper refusal/release failure', async t => {
  const { root, lock } = setup(t), file = path.join(root, 'checkpoint.json'); fs.writeFileSync(file, JSON.stringify(checkpoint));
  for (const code of [74, 75]) {
    const result = await cli(lock, 'run', '--owner', 'CodexMain', '--reason', 'Synthetic child status collision', '--checkpoint', file, '--', process.execPath, '-e', `process.exit(${code})`);
    assert.equal(result.code, 1); const receipt = JSON.parse(result.out.trim().split('\n').at(-1));
    assert.equal(receipt.child.code, code); assert.equal(receipt.released, true); assert.equal(inspect(lock).state, 'free');
  }
});
