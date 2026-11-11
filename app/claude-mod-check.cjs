// Background check of a Claude Code version NAW has not qualified (B3, the person 2026-11-10:
// 「后台自动跑 plugin test 写进核验记录」). When the launcher points at such a version, NAW runs
// the managed mod's own tests once with that version's `claude plugin test` and keeps the result
// for the manual qualification. It decides nothing: the hand-qualified list and the fallback
// (claude-pin.cjs) are unchanged, and a pass does not qualify the version. A pass says only that
// every engine interface those tests reach still exists in that version; a failure names the
// tests, and the engine's own message when it gives one.
//
// The run starts no session and sends nothing. `plugin test` runs under a system sandbox that
// denies all network and the keychain and allows no write under the person's home, with a private
// home and configuration directory, on a private copy of the mod, with a time limit. When the
// sandbox cannot be applied, nothing runs and the record says so.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PLUGIN = Object.freeze(['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js']);
const TESTS = Object.freeze(['native-media.test.ts', 'queued-input.test.ts', 'submission.test.ts', 'turn-records.test.ts']);
const SANDBOX = '/usr/bin/sandbox-exec';
const KEEP = 20, OUTPUT_LIMIT = 1024 * 1024;

// In the checkout the tests sit beside the mod. The copied daemon runtime keeps them in a sibling
// folder, so the directory real sessions load stays exactly the three mod files.
function sources(dir = __dirname) {
  const mod = path.join(dir, 'claude-bridge'), beside = path.join(dir, 'claude-bridge-tests');
  const tests = fs.existsSync(beside) ? beside : mod;
  return [...PLUGIN.map(name => ({ name, file: path.join(mod, name) })), ...TESTS.map(name => ({ name, file: path.join(tests, name) }))];
}
// A result belongs to the mod and tests it ran: a NAW update that changes either is checked again.
function modHash(files = sources()) {
  const hash = crypto.createHash('sha256');
  for (const { name, file } of files) { hash.update(name); hash.update('\0'); hash.update(fs.readFileSync(file)); hash.update('\0'); }
  return hash.digest('hex').slice(0, 16);
}

// The test runner's own summary and failure lines. Counts stay null when no summary was printed.
function parse(output) {
  const lines = String(output).split('\n'), result = { pass: null, fail: null, tests: null, files: null, failed: [], engine: [] };
  let end = -1;
  for (let i = lines.length - 1; i >= 0 && end < 0; i--) {
    const ran = lines[i].match(/^Ran (\d+) tests? across (\d+) files?\b/);
    if (ran) { result.tests = Number(ran[1]); result.files = Number(ran[2]); end = i; }
  }
  for (let i = end - 1; i >= 0; i--) {
    const count = lines[i].match(/^\s*(\d+) (\S+)/);
    if (!count) break;
    if (count[2] === 'pass' || count[2] === 'fail') result[count[2]] = Number(count[1]);
  }
  for (let i = 0; i < lines.length; i++) {
    const failed = lines[i].match(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/);
    if (failed && result.failed.length < 60) result.failed.push(failed[1].slice(0, 200));
    if (!/^\s+the engine reported:\s*$/.test(lines[i])) continue;
    const said = (lines[i + 1] || '').trim().slice(0, 300);
    if (said && !result.engine.includes(said) && result.engine.length < 10) result.engine.push(said);
  }
  return result;
}

function profile(work) {
  const quoted = value => JSON.stringify(value);
  return ['(version 1)', '(allow default)', '(deny network*)',
    '(deny mach-lookup (global-name "com.apple.securityd"))', '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
    `(deny file-write* (subpath ${quoted(fs.realpathSync(os.homedir()))}))`, `(allow file-write* (subpath ${quoted(work)}))`].join('');
}
// One process in its own group; the whole group is ended at the time limit or when NAW closes.
function execute(file, args, { env, cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('NAW is closing')); return; }
    const child = spawn(file, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, stopped = false;
    const end = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
    const stop = () => { stopped = true; end(); };
    signal?.addEventListener('abort', stop, { once: true });
    const take = chunk => { if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8').slice(0, OUTPUT_LIMIT - output.length); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const finish = fn => { clearTimeout(timer); signal?.removeEventListener('abort', stop); fn(); };
    child.on('error', error => finish(() => reject(error)));
    child.on('close', (code, by) => finish(() => stopped ? reject(Error('NAW is closing')) : resolve({ code, signal: by, timedOut, output })));
  });
}

// Runs the mod's tests with one Claude program. Always returns a record: { version, mod, at } and
// either what the run reported ({ seconds, exit, pass, fail, tests, files, failed, engine }, with
// note when no summary was printed and timedOut at the limit) or { reason } when it did not run.
async function run({ binary, version, privateDir, dir = __dirname, timeoutMs = 60000, sandbox = SANDBOX, signal }) {
  const at = new Date().toISOString(), started = Date.now();
  let mod = null, work;
  try {
    const files = sources(dir); mod = modHash(files);
    work = fs.realpathSync(fs.mkdtempSync(path.join(privateDir, 'claude-mod-check-')));
    const copy = path.join(work, 'mod'), home = path.join(work, 'home'), config = path.join(work, 'config'), temp = path.join(work, 'tmp');
    for (const folder of [copy, home, config, temp]) fs.mkdirSync(folder, { mode: 0o700 });
    for (const { name, file } of files) { const target = path.join(copy, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(file, target); }
    // Nothing of this process's environment is passed on: no credentials, proxies or session identity.
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temp, LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const done = await execute(sandbox, ['-p', profile(work), binary, 'plugin', 'test', copy], { env, cwd: work, timeoutMs, signal });
    const output = done.output.split(work).join(''), counted = parse(output);
    return { version, mod, at, seconds: Math.round((Date.now() - started) / 100) / 10, exit: done.code, ...(done.signal ? { signal: done.signal } : {}), ...(done.timedOut && done.code === null ? { timedOut: true } : {}),
      ...counted, ...(counted.tests === null ? { note: output.trim().slice(0, 400) } : {}) };
  } catch (error) {
    return { version, mod, at, reason: String(error?.message).split(work || '\0').join('').slice(0, 200) };
  } finally { if (work) fs.rmSync(work, { recursive: true, force: true }); }
}
// The run reached its own end for this mod (a run stopped at the limit has no exit code); anything else
// is tried again after the next NAW start.
const complete = (record, mod) => Boolean(record) && record.mod === mod && Number.isInteger(record.exit);
const passed = record => Boolean(record) && record.exit === 0 && record.fail === 0 && record.pass > 0 && record.pass === record.tests;
function describe(record) {
  if (!record) return 'no record';
  if (record.reason) return `not run (${record.reason})`;
  if (record.timedOut) return 'stopped at the time limit';
  if (record.tests === null) return `no test summary, exit ${record.exit}${record.note ? ': ' + record.note.split('\n')[0].slice(0, 160) : ''}`;
  const first = record.failed[0] ? `; first failure: ${record.failed[0]}` : '', engine = record.engine[0] ? `; engine: ${record.engine[0]}` : '';
  return `${record.pass} pass / ${record.fail} fail of ${record.tests} in ${record.files} files, exit ${record.exit}${first}${engine}`;
}

function load(file) {
  try { const stored = JSON.parse(fs.readFileSync(file, 'utf8')); return stored?.version === 1 && stored.checks && typeof stored.checks === 'object' && !Array.isArray(stored.checks) ? stored.checks : {}; }
  catch { return {}; }
}
// One record per Claude version, the newest few kept. An unreadable file is replaced.
function save(file, record) {
  const checks = { ...load(file), [record.version]: record };
  const kept = Object.fromEntries(Object.entries(checks).sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at))).slice(0, KEEP));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, checks: kept }, null, 1), { mode: 0o600 }); fs.renameSync(temp, file);
}
// Runs the check unless a completed result for this version and this mod is already stored.
// Resolves with the new record, or null when the stored one stands.
async function checkOnce({ file, ...options }) {
  let mod = null;
  try { mod = modHash(sources(options.dir)); } catch { /* run() records why */ }
  if (mod && complete(load(file)[options.version], mod)) return null;
  const record = await run(options);
  if (options.signal?.aborted) return null;
  save(file, record);
  return record;
}

module.exports = { PLUGIN, TESTS, SANDBOX, sources, modHash, parse, run, complete, passed, describe, load, save, checkOnce };
