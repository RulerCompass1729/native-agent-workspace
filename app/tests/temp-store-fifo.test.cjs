const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const ownership = require('../temp-ownership.cjs');
const root = path.resolve(__dirname, '../..');

function fixture(t, uppercase) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-receipt-fifo-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home };
  for (const name of ['NAW_DATA_DIR', 'NAW_TEMP_REGISTRY_DIR', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NAW_TEST_TEMP_JOURNAL', 'NAW_TEST_TEMP_REPORT']) delete env[name];
  const store = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : ['.local', 'share']), 'Native Agent Workspace', 'temp-ownership');
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const candidate = path.join(base, 'candidate'); fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, 'data'), 'synthetic content retained');
  const id = ownership.register(candidate, { registryDir: store });
  const receipt = path.join(store, id + '.json'), before = fs.readFileSync(receipt, 'utf8');
  const fifo = path.join(store, (uppercase ? 'A' : 'a').repeat(64) + '.json');
  const made = spawnSync('mkfifo', ['-m', '600', fifo], { env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(made.status, 0, made.stderr || String(made.error));
  const retained = () => {
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
    assert.equal(fs.readFileSync(receipt, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(candidate, 'data'), 'utf8'), 'synthetic content retained');
  };
  return { base, env, store, retained };
}

for (const uppercase of [false, true]) {
  const casing = uppercase ? 'uppercase' : 'lowercase';
  test(`${casing} receipt FIFO promptly fails closed in read, batches, pruning and reminder scanning`, t => {
    const f = fixture(t, uppercase), dataDir = path.join(f.base, 'profile'); fs.mkdirSync(dataDir, { mode: 0o700 });
    // A synchronous FIFO open defeats an in-process timer. Bound the actual
    // readers in a separate process so the old failure cannot hang the suite.
    const script = `
      const assert = require('node:assert/strict'), path = require('node:path');
      const [root, store, dataDir] = process.argv.slice(1);
      const own = require(path.join(root, 'app/temp-ownership.cjs'));
      const { TempReminders } = require(path.join(root, 'app/temp-reminders.cjs'));
      (async () => {
        assert.throws(() => own.read(store), /Unsafe temporary ownership entry/);
        await assert.rejects(async () => { for await (const _ of own.batches(store)) {} }, /Unsafe temporary ownership entry/);
        await assert.rejects(own.pruneMissing(store), /Unsafe temporary ownership entry/);
        const manager = new TempReminders({ dataDir, registryDir: store, roots: [path.dirname(store)],
          isPerson: () => true, isAlive: () => false, inspect: async () => ({ opened: [], mounted: [] }) });
        const status = await manager.status();
        assert.equal(status.anomaly, 'inspection-unavailable'); assert.equal(status.directories, 0);
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const result = spawnSync(process.execPath, ['-e', script, root, f.store, dataDir], {
      env: f.env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || result.signal || ''));
    f.retained();
  });
  for (const passing of [true, false]) test(`${casing} receipt FIFO preserves the ${passing ? 'passing' : 'failing'} mini suite exit without hanging`, t => {
    const f = fixture(t, uppercase), file = path.join(f.base, 'mini-suite.cjs');
    fs.writeFileSync(file, `require('node:test')('synthetic test',()=>{${passing ? '' : "throw Error('Expected synthetic failure');"}});`);
    const result = spawnSync(process.execPath, ['scripts/test.cjs', file], {
      cwd: root, env: f.env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    });
    assert.equal(result.status, passing ? 0 : 1, result.stdout + result.stderr + String(result.error || result.signal || ''));
    assert.match(result.stdout, /TEMP GUARD: PASS/);
    const notices = result.stderr.split('\n').filter(line => line.startsWith('TEMP RECEIPTS: sweep skipped'));
    assert.equal(notices.length, 1); assert.ok(notices[0].includes(f.store));
    f.retained();
  });
}
