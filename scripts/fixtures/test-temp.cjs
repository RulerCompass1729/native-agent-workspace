// Test-only ownership of directories created by this run. Never discover owners
// from a filename, and never delete a directory whose identity has changed.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const identity = file => {
  const stat = fs.lstatSync(file);
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
};
function removeOwned(record) {
  let stat;
  try { stat = fs.lstatSync(record.path); } catch (error) {
    if (error.code === 'ENOENT') { require('../../app/temp-ownership.cjs').forgetMissing(record); return; }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== record.dev || stat.ino !== record.ino ||
      stat.uid !== record.uid || fs.realpathSync(record.path) !== record.path) throw Error('Temporary directory identity changed: ' + record.path);
  fs.rmSync(record.path, { recursive: true });
  require('../../app/temp-ownership.cjs').forgetMissing(record);
}
// A delegated directory belongs to test-scratch's process-aware cleanup. While
// it may still exist, nothing on its path is removed here: neither a directory
// holding it nor one inside it. A failed lstat counts as still existing.
const mayExist = file => { try { fs.lstatSync(file); return true; } catch (error) { return error.code !== 'ENOENT'; } };
function guards(records) {
  const kept = records.filter(record => record.delegated && mayExist(record.path)).map(record => record.path);
  return record => kept.find(file => inside(record.path, file) || inside(file, record.path));
}
function registry(journal, roots) {
  const owned = [];
  const track = directory => {
    const file = fs.realpathSync(directory);
    if (!roots.some(root => inside(root, file))) return;
    const record = { path: file, ...identity(file), pid: process.pid, source: process.argv[1] || '',
      stack: new Error().stack.split('\n').slice(3, 8) };
    // The suite journal is disposable. This separate creation receipt survives
    // a killed suite and is readable by the daily app without filename guessing.
    record.reminderReceipt = require('../../app/temp-ownership.cjs').register(file);
    fs.appendFileSync(journal, JSON.stringify(record) + '\n', { mode: 0o600 });
    owned.push(record);
  };
  const cleanup = () => {
    const errors = [], removable = owned.filter(record => !record.delegated).reverse();
    if (!removable.length) return errors;
    let guard;
    // Another process may have delegated a directory inside one of ours.
    // Unreadable receipts leave every directory to the suite parent.
    try { guard = guards([...owned, ...readRecords(path.dirname(journal))]); } catch { return errors; }
    for (const record of removable) if (!guard(record)) try { removeOwned(record); } catch (error) { errors.push(error.message); }
    return errors;
  };
  const delegate = directory => {
    const file = fs.realpathSync(directory), record = owned.findLast(value => value.path === file);
    if (!record) return;
    record.delegated = true;
    fs.appendFileSync(journal, JSON.stringify(record) + '\n');
  };
  return { track, cleanup, delegate };
}
function readRecords(directory) {
  const records = new Map();
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      records.set(JSON.stringify([record.pid, record.path, record.dev, record.ino]), record);
    }
  }
  return [...records.values()];
}
function install(directory) {
  const journal = path.join(directory, process.pid + '-' + randomUUID() + '.jsonl');
  const roots = [...new Set([os.tmpdir(), '/tmp'].map(root => fs.realpathSync(root)))];
  const owner = registry(journal, roots);
  globalThis[Symbol.for('naw.testTemp.delegate')] = owner.delegate;
  const sync = fs.mkdtempSync, callback = fs.mkdtemp, promises = fs.promises.mkdtemp;
  fs.mkdtempSync = function (...args) { const value = sync.apply(this, args); owner.track(value); return value; };
  fs.mkdtemp = function (...args) {
    const done = args.pop();
    return callback.call(this, ...args, (error, value) => {
      if (!error) try { owner.track(value); } catch (failure) { done(failure); return; }
      done(error, value);
    });
  };
  fs.promises.mkdtemp = async function (...args) { const value = await promises.apply(this, args); owner.track(value); return value; };
  require('node:module').syncBuiltinESMExports();
  process.once('exit', () => {
    const errors = owner.cleanup();
    if (errors.length) { console.error(errors.join('\n')); process.exitCode ||= 1; }
  });
}
module.exports = { identity, inside, guards, mayExist, registry, removeOwned, readRecords };
if (process.env.NAW_TEST_TEMP_JOURNAL) install(process.env.NAW_TEST_TEMP_JOURNAL);
