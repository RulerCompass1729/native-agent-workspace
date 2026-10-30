// Private operator coordination, not product scheduling or backup authorization.
// A backup must first validate the current secretary handoff on the task board.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const owners = ['CodexMain', 'Codex2', 'Codex3'];
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function refusal(message) { const e = new Error(message); e.code = 'INTEGRATOR_LOCKED'; e.exitCode = 75; return e; }
function canonicalDirectory(repo = process.cwd()) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  return path.join(path.dirname(common), '.local', 'integrator.lock');
}
function inspect(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (e) { if (e.code === 'ENOENT') return { state: 'free' }; throw e; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refusal('Integrator lock is not an ordinary directory; keep it intact.');
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (owner.protocol !== 1 || !owners.includes(owner.owner) || !uuid(owner.token) || !text(owner.reason)) throw Error('Incomplete owner record');
    return { state: 'occupied', owner };
  } catch (e) { return { state: 'occupied', owner: null, incomplete: true }; }
}
function acquire(directory, { owner, reason, delegation = null }) {
  if (!owners.includes(owner) || !text(reason)) throw Error('Supply a supported owner and a reason.');
  if (owner !== 'CodexMain' && !text(delegation)) throw Error('Backup acquisition requires an explicitly verified current secretary handoff reference.');
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw refusal('Integrator lock occupied; do not infer expiry or steal it.'); throw e; }
  const record = { protocol: 1, owner, token: randomUUID(), acquiredAt: new Date().toISOString(), reason, delegation };
  try { fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    // Retain an uncertain creation instead of deleting a partial owner record.
    try { fs.rmdirSync(directory); } catch {}
    throw e;
  }
  return record;
}
function validateCheckpoint(checkpoint) {
  if (!checkpoint || !(checkpoint.head === null || typeof checkpoint.head === 'string' && /^[0-9a-f]{40}$/.test(checkpoint.head)) ||
      !(checkpoint.installedVersion === null || text(checkpoint.installedVersion)) || !text(checkpoint.evidence) || !text(checkpoint.note)) {
    throw Error('Checkpoint requires explicit head/installedVersion (or null if unknown), evidence and note.');
  }
}
function release(directory, token, checkpoint) {
  validateCheckpoint(checkpoint);
  // Serialize competing releases before checking the fresh token. Without this
  // guard a delayed release could remove a newly acquired owner's directory.
  if (!uuid(token) || inspect(directory).owner?.token !== token) throw refusal('Owner token does not match; current lock retained.');
  const guard = path.join(directory, 'releasing');
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch (e) { if (['EEXIST', 'ENOENT'].includes(e.code)) throw refusal('Release unavailable; inspect the current lock.'); throw e; }
  const identity = fs.lstatSync(guard);
  let retired, moved = false;
  try {
    const current = inspect(directory);
    if (!token || current.owner?.token !== token) throw refusal('Owner token does not match; current lock retained.');
    if (fs.readdirSync(directory).some(name => !['owner.json', 'releasing'].includes(name))) throw refusal('Unexpected lock contents; retain them for inspection.');
    const archive = path.join(path.dirname(directory), 'integrator-handoffs');
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    retired = path.join(archive, token + '.lock');
    if (fs.existsSync(retired)) throw refusal('A prior retired directory needs inspection; current lock retained.');
    const file = path.join(archive, token + '.json'), pending = path.join(archive, token + '.' + randomUUID() + '.tmp');
    const record = { lease: current.owner, checkpoint, releaseRequestedAt: new Date().toISOString() };
    try { fs.writeFileSync(pending, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(pending, file); }
    finally { try { fs.unlinkSync(pending); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    // Atomically free the canonical name. All later cleanup addresses this
    // token's retired directory, never a returning Main's newly acquired lock.
    fs.renameSync(directory, retired); moved = true;
    try { fs.unlinkSync(path.join(retired, 'owner.json')); fs.rmdirSync(path.join(retired, 'releasing')); fs.rmdirSync(retired); }
    catch (e) { return { released: true, checkpoint: file, cleanupPending: retired, cleanupError: e.code || e.message }; }
    return { released: true, checkpoint: file };
  } finally {
    if (!moved) {
      try { const stat = fs.lstatSync(guard); if (stat.dev === identity.dev && stat.ino === identity.ino) fs.rmdirSync(guard); }
      catch (e) { if (e.code !== 'ENOENT') throw refusal('Release aborted; canonical lock retained and release guard needs inspection.'); }
    }
  }
}
async function run(directory, options, command, cwd = process.cwd()) {
  if (!Array.isArray(command) || !command.length || command[0] === '' || command.some(s => typeof s !== 'string' || s.includes('\0')) || typeof cwd !== 'string' || cwd.includes('\0')) throw Error('run requires a bounded foreground command after --.');
  const original = JSON.parse(fs.readFileSync(options.checkpoint, 'utf8')); validateCheckpoint(original);
  const lease = acquire(directory, options);
  // Keep ownership within this invocation, never across a model/wait boundary.
  // An interrupted wrapper stays fail-closed; no timeout/PID-based reclamation.
  const child = await new Promise(resolve => {
    let process, error;
    try { process = spawn(command[0], command.slice(1), { cwd, stdio: 'inherit' }); }
    catch (e) { resolve({ code: null, signal: null, error: e.message }); return; }
    process.once('error', e => { error = e.message; });
    process.once('close', (code, signal) => resolve({ code, signal, ...(error ? { error } : {}) }));
  });
  let checkpoint;
  try { checkpoint = JSON.parse(fs.readFileSync(options.checkpoint, 'utf8')); validateCheckpoint(checkpoint); }
  catch { checkpoint = { ...original, installedVersion: null, note: 'Command checkpoint missing/invalid; inspect the owned worktree and command evidence.' }; }
  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  // The operator's integration result may be in a different worktree. Do not
  // replace that declaration with this wrapper's incidental launch-directory HEAD.
  checkpoint = { ...checkpoint, observedHead: head, cwd, note: checkpoint.note + ` Command exit=${child.code}, signal=${child.signal || 'none'}.` };
  let result;
  try { result = release(directory, lease.token, checkpoint); }
  catch (e) {
    let lockState;
    try { lockState = inspect(directory); } catch { lockState = { state: 'unknown' }; }
    // 75 is reserved for refusal BEFORE starting a command. Preserve its actual
    // outcome and recovery token even when checkpoint/release cannot complete.
    return { released: false, child, lockState, token: lease.token, releaseError: { code: e.code || null, message: e.message }, attemptedCheckpoint: checkpoint, exitCode: 74 };
  }
  return { ...result, child, exitCode: child.code === 0 && !result.cleanupPending ? 0 : child.code > 0 && child.code <= 255 && ![74, 75].includes(child.code) ? child.code : 1 };
}
module.exports = { canonicalDirectory, inspect, acquire, release, run };
if (require.main === module) {
  (async () => { try {
    const [command, ...all] = process.argv.slice(2), options = {}, split = all.indexOf('--');
    const args = split < 0 ? all : all.slice(0, split), foreground = split < 0 ? [] : all.slice(split + 1);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.slice(2);
      if (!args[i]?.startsWith('--') || args[i + 1] === undefined || !['owner', 'reason', 'delegation', 'token', 'checkpoint', 'directory'].includes(key) || Object.hasOwn(options, key)) throw Error('Options require a known, unique name and a value.');
      options[key] = args[i + 1];
    }
    if (!['acquire', 'inspect', 'release', 'run'].includes(command)) throw Error('Usage: integrator-lock.cjs run --owner CodexMain --reason TEXT --checkpoint FILE -- COMMAND [ARGS]; also acquire/inspect/release. Optional --directory PATH for an isolated rehearsal.');
    const directory = options.directory ? path.resolve(options.directory) : canonicalDirectory();
    if (process.env.NAW_INTEGRATOR_REHEARSAL_DIRECTORY && directory !== path.resolve(process.env.NAW_INTEGRATOR_REHEARSAL_DIRECTORY)) throw Error('Rehearsal directory mismatch; no coordination lock touched.');
    const result = command === 'run' ? await run(directory, options, foreground) : command === 'acquire' ? acquire(directory, options) : command === 'inspect' ? inspect(directory) : release(directory, options.token, JSON.parse(fs.readFileSync(options.checkpoint, 'utf8')));
    console.log(JSON.stringify(result));
    if (result.state === 'occupied') process.exitCode = 75;
    else if (result.exitCode || result.cleanupPending) process.exitCode = result.exitCode || 1;
  } catch (e) { console.error(e.message); process.exitCode = e.exitCode || 1; } })();
}
