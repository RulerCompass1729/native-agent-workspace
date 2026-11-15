// One disposable scope for a complete test command. Managed directories are
// cleaned by their creating workers, then checked again by this parent. The
// residue check happens BEFORE fallback removal, so cleanup cannot mask a leak.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { guards, identity, inside, mayExist, readRecords, removeOwned } = require('./fixtures/test-temp.cjs');
const root = path.resolve(__dirname, '..');
async function run(args = process.argv.slice(2)) {
  // Keep Unix socket paths short. This exact owned directory is the only tree
  // the parent removes wholesale; existing system temporary files stay outside.
  const temporary = fs.realpathSync(fs.mkdtempSync('/tmp/nt-suite-'));
  const owned = { path: temporary, ...identity(temporary) };
  // A nested invocation can inherit a parent preload. Its own failure policy
  // still owns this scope; the inherited exit hook must not override retention.
  globalThis[Symbol.for('naw.testTemp.delegate')]?.(temporary);
  const journal = path.join(temporary, 'owners'); fs.mkdirSync(journal, { mode: 0o700 });
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, NAW_TEST_TEMP_JOURNAL: journal };
  const preload = path.join(__dirname, 'fixtures/test-temp.cjs');
  env.NODE_OPTIONS = [env.NODE_OPTIONS, '--require ' + JSON.stringify(preload)].filter(Boolean).join(' ');
  const files = args.some(arg => !arg.startsWith('-') && arg.endsWith('.cjs')) ? [] : fs.readdirSync(path.join(root, 'app/tests')).filter(name => name.endsWith('.test.cjs')).map(name => path.join(root, 'app/tests', name));
  let child, signal;
  const forward = name => { signal ||= name; if (child && child.exitCode === null && child.signalCode === null) child.kill(name); };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  let result, report, retain = false;
  try {
    result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, ['--test', ...args, ...files], { cwd: root, env, stdio: 'inherit' });
      child.once('error', reject); child.once('close', (code, stopped) => resolve({ code, signal: stopped }));
    });
    const records = readRecords(journal), errors = [], guard = guards(records), kept = [];
    // A worker killed before its exit handler gets the same identity-checked
    // cleanup here. Records outside this suite are only exact mkdtemp receipts.
    // A directory on the path of a delegated profile that may still exist is
    // kept and reported, never removed with it.
    for (const record of [...records].reverse()) if (!record.delegated) {
      const by = guard(record);
      if (by) kept.push({ path: record.path, by });
      else try { removeOwned(record); } catch (error) { errors.push(error.message); }
    }
    const leftovers = fs.readdirSync(temporary, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('naw-')).map(entry => path.join(temporary, entry.name));
    const registered = records.filter(record => mayExist(record.path));
    const extra = [...new Set([...leftovers, ...registered.map(record => record.path)])];
    retain = kept.length > 0 || registered.some(record => record.delegated && inside(temporary, record.path)) || errors.length > 0;
    report = { scope: owned, retained: retain, created: records.length, before: 0, after: extra.length, errors, protected: kept, leftovers: extra.map(file => ({
      prefix: path.basename(file).replace(/-[^-]+$/, ''),
      source: records.find(record => record.path === file)?.source || 'unregistered temporary directory',
      path: file,
    })) };
    if (env.NAW_TEST_TEMP_REPORT) fs.writeFileSync(env.NAW_TEST_TEMP_REPORT, JSON.stringify({ ...report, records }, null, 2));
    console.log(`TEMP GUARD: ${extra.length || errors.length ? 'FAIL' : 'PASS'} before=0 after=${extra.length} created=${records.length}`);
    for (const item of report.leftovers) console.error(`TEMP LEAK: ${item.prefix} | ${item.source} | ${item.path}`);
    for (const item of kept) console.error(`TEMP PROTECTED: ${item.path} | kept for ${item.by}`);
    for (const error of errors) console.error('TEMP CLEANUP: ' + error);
    if (retain) console.error('TEMP RETAINED: protected or uncertain cleanup; inspect ' + temporary);
    return result.code || (result.signal || signal ? 1 : 0) || (extra.length || errors.length ? 1 : 0);
  } catch (error) {
    retain = true; // Missing/corrupt ownership evidence cannot authorize a sweep.
    console.error('TEMP RETAINED: inspection failed; inspect ' + temporary);
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (!retain) removeOwned(owned);
  }
}
module.exports = { run };
if (require.main === module) run().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
