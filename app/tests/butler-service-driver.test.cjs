'use strict';
// Real isolated daemon/NativeHost transport; a local synthetic executable is
// the only provider program. No model request, user's profile or daily service.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ButlerBackend } = require('../butler-backend.cjs');
const { ButlerServiceDriver, credentialPresent } = require('../butler-service-driver.cjs');
const { NativeHost } = require('../adapters.cjs');
const { connectService, connect, ensureService, ensureServiceAt } = require('../service-client.cjs');
const binding = require('../service-binding.cjs');
const { readLayout } = require('../service-layout.cjs');
const keys = ['CODEX_HOME', 'DEEPSEEK_API_KEY', 'NAW_RUNTIME_CONFIG', 'NAW_APP_VERSION', 'NAW_WORKSPACE'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-driver-')), saved = {};
  for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; }
  const home = path.join(root, 'config'); fs.mkdirSync(home, { mode: 0o700 });
  process.env.CODEX_HOME = home; process.env.DEEPSEEK_API_KEY = 'SYNTHETIC_PRESENCE_SENTINEL';
  process.env.NAW_APP_VERSION = 'butler-fixture';
  const profile = path.join(home, 'deepseek-pro.config.toml'), base = path.join(home, 'config.toml');
  fs.writeFileSync(profile, 'model = "deepseek-v4-pro"\nmodel_provider = "deepseek"\n');
  fs.writeFileSync(base, '[model_providers.deepseek]\nenv_key = "DEEPSEEK_API_KEY"\n');
  const calls = path.join(root, 'calls'), binary = path.join(root, 'codex-fixture');
  fs.writeFileSync(binary, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), http = require('node:http');
const { WebSocketServer } = require(${JSON.stringify(require.resolve('ws'))});
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),present:Boolean(process.env.DEEPSEEK_API_KEY)})+'\\n');
const server = http.createServer(), wss = new WebSocketServer({server});
wss.on('connection', ws => ws.on('message', raw => {
  const m = JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method:m.method})+'\\n');
  if (m.method === 'initialize') ws.send(JSON.stringify({id:m.id,result:{userAgent:'codex/0.167.1'}}));
  else if (m.id) { ws.send(JSON.stringify({id:m.id,error:{code:-1,message:'No inference allowed in fixture'}})); }
}));
server.listen(process.argv.at(-1).slice(7));
`, { mode: 0o700 });
  const runtimeConfig = path.join(root, 'runtime.json');
  fs.writeFileSync(runtimeConfig, JSON.stringify({ codex: binary }), { mode: 0o600 });
  process.env.NAW_RUNTIME_CONFIG = runtimeConfig;
  const directory = path.join(root, 'butler'), backend = new ButlerBackend(directory, { runtimeVersion: 'butler-fixture',
    configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } });
  backend.prepare();
  const proof = JSON.parse(fs.readFileSync(backend.file)).binding;
  t.after(() => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, base, profile, binary, backend, proof, calls,
    rows: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
async function stop(directory) {
  const c = await connectService(directory, 'fixture-cleanup');
  try { await c.call('shutdown'); await new Promise(resolve => c.socket.once('close', resolve)); }
  finally { c.close(); }
  for (let i = 0; i < 100 && fs.existsSync(path.join(directory, 'service.lock')); i++) await new Promise(r => setTimeout(r, 20));
}
test('dedicated recovery and startup tolerate disappearing locks but keep invalid records protected', async t => {
  const f = fixture(t), driver = new ButlerServiceDriver(f.backend.directory);
  binding.reserveBinding(f.backend.store, f.proof);
  for (const name of ['service.lock', 'services.lock']) {
    const file = path.join(f.backend.store, name), original = fs.lstatSync;
    fs.writeFileSync(file, '{invalid');
    await assert.rejects(driver.recover(f.proof), /owner-unconfirmed/);
    if (name === 'services.lock') await assert.rejects(driver.start(f.proof), /owner-unconfirmed/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
    let removed = false;
    const mock = t.mock.method(fs, 'lstatSync', function (target, ...args) {
      if (target === file && !removed) { fs.unlinkSync(file); removed = true; }
      return original.call(this, target, ...args);
    });
    try { assert.deepEqual(await driver.recover(f.proof), { status: 'absent' }); assert.equal(removed, true); }
    finally { mock.mock.restore(); }
  }
  assert.deepEqual(f.rows(), [], 'Recovery never launches a provider');
  const file = path.join(f.backend.store, 'services.lock'), original = fs.readFileSync;
  fs.writeFileSync(file, String(process.pid)); let removed = false;
  const mock = t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (target === file && !removed) { fs.unlinkSync(file); removed = true; }
    return original.call(this, target, ...args);
  });
  try {
    assert.deepEqual(await driver.start(f.proof), { status: 'present', binding: f.proof });
    assert.equal(removed, true); assert.equal(f.rows().filter(row => row.args).length, 1);
    assert.deepEqual(f.rows().filter(row => row.method).map(row => row.method), ['initialize', 'initialized']);
  } finally {
    mock.mock.restore();
    if (fs.existsSync(path.join(f.backend.store, 'connection.json'))) await stop(f.backend.store);
  }
});
test('dedicated cold boot and recovery bind the same runner; normal same-version service stays separate', async t => {
  const f = fixture(t), driver = new ButlerServiceDriver(f.backend.directory);
  const ordinary = path.join(f.root, 'ordinary');
  await ensureService(ordinary, process.execPath);
  let started = false;
  try {
    const c = await connectService(ordinary, 'before'); const before = await c.call('initial'); c.close();
    const layout = readLayout(ordinary);
    assert.deepEqual(await driver.recover(f.proof), { status: 'absent' });
    assert.deepEqual(await driver.start(f.proof), { status: 'present', binding: f.proof }); started = true;
    assert.deepEqual(await new ButlerServiceDriver(f.backend.directory).recover(f.proof), { status: 'present', binding: f.proof });
    assert.equal(f.rows().filter(row => row.args).length, 1);
    assert.deepEqual(f.rows().filter(row => row.method).map(row => row.method), ['initialize', 'initialized']);
    const args = f.rows()[0].args;
    assert.deepEqual(args.slice(0, 2), ['--profile', 'deepseek-pro']);
    assert.ok(args.includes('model_provider="deepseek"')); assert.ok(args.includes('model="deepseek-v4-pro"'));
    assert.equal(f.rows()[0].present, true);
    assert.ok(!JSON.stringify(f.rows()).includes('SYNTHETIC_PRESENCE_SENTINEL'));
    await assert.rejects(ensureService(f.backend.store, process.execPath), /binding-mismatch/);
    await assert.rejects(connect(f.backend.store, 'ordinary'), /binding-mismatch/);
    const own = await connectService(f.backend.store, 'guard');
    try { await assert.rejects(own.call('create', 'codex'), /butler-qualification-required/); } finally { own.close(); }
    const after = await connectService(ordinary, 'after');
    try { assert.equal((await after.call('initial')).servicePid, before.servicePid); } finally { after.close(); }
    assert.deepEqual(readLayout(ordinary), layout);
    for (const key of ['runnerRef', 'backendRef', 'startNonce']) {
      await assert.rejects(driver.recover({ ...f.proof, [key]: f.proof[key] + '-other' }), /binding-mismatch/);
    }
    fs.unlinkSync(f.profile);
    await assert.rejects(driver.recover(f.proof));
    assert.equal(f.rows().filter(row => row.args).length, 1, 'A changed profile never starts a replacement or uses the default');
  } finally { if (started) await stop(f.backend.store); else { try { await stop(f.backend.store); } catch {} } await stop(ordinary); }
});
test('name-only preflight blocks missing key/profile and provider/model mismatch without starting Codex', async t => {
  const f = fixture(t);
  for (const reason of ['credential-missing', 'profile-missing', 'profile-binding-mismatch', 'provider-binding-mismatch']) {
    fs.writeFileSync(f.profile, 'model = "deepseek-v4-pro"\nmodel_provider = "deepseek"\n');
    fs.writeFileSync(f.base, '[model_providers.deepseek]\nenv_key = "DEEPSEEK_API_KEY"\n');
    process.env.DEEPSEEK_API_KEY = 'SYNTHETIC_PRESENCE_SENTINEL';
    if (reason === 'credential-missing') delete process.env.DEEPSEEK_API_KEY;
    if (reason === 'profile-missing') fs.unlinkSync(f.profile);
    if (reason === 'profile-binding-mismatch') fs.writeFileSync(f.profile, 'model = "default"\nmodel_provider = "openai"\n');
    if (reason === 'provider-binding-mismatch') fs.writeFileSync(f.base, '[model_providers.deepseek]\nenv_key = "OTHER_NAME"\n');
    assert.equal(credentialPresent(), false);
    const dir = path.join(f.root, reason); fs.mkdirSync(dir, { mode: 0o700 });
    const host = new NativeHost(dir, dir, f.proof); host.binaries.codex = f.binary;
    try { await assert.rejects(host.startCodex(), new RegExp(reason)); }
    finally { host.close(); }
    assert.deepEqual(f.rows(), []);
  }
});
test('preflight emits only a boolean and fixed reason; malformed or ambiguous metadata never falls back', t => {
  const f = fixture(t);
  const run = () => spawnSync('python3', [path.join(__dirname, '../butler-runner.py'), '--check'], { encoding: 'utf8' });
  assert.equal(credentialPresent(), true);
  assert.deepEqual(JSON.parse(run().stdout), { credentialPresent: true, ok: true, reason: null });
  fs.appendFileSync(f.profile, 'model = "different"\n');
  assert.equal(credentialPresent(), false);
  assert.equal(JSON.parse(run().stdout).reason, 'profile-layout-unsupported');
  assert.ok(!run().stdout.includes('SYNTHETIC_PRESENCE_SENTINEL'));
  for (const declaration of ['model_providers.deepseek.env_key = "OTHER_NAME"',
    'model_providers = { deepseek = { env_key = "OTHER_NAME" } }',
    '[model_providers]\ndeepseek = { env_key = "OTHER_NAME" }']) {
    fs.writeFileSync(f.profile, 'model = "deepseek-v4-pro"\nmodel_provider = "deepseek"\n' + declaration + '\n');
    assert.equal(JSON.parse(run().stdout).reason, 'profile-layout-unsupported');
  }
});
test('a positive caller precheck cannot substitute for the daemon and native child environment', async t => {
  const f = fixture(t), driver = new ButlerServiceDriver(f.backend.directory);
  binding.reserveBinding(f.backend.store, f.proof);
  delete process.env.DEEPSEEK_API_KEY;
  await ensureServiceAt(f.backend.store, process.execPath, path.join(f.backend.store, 'workspace'), false, f.proof);
  try {
    process.env.DEEPSEEK_API_KEY = 'SYNTHETIC_PRESENCE_SENTINEL';
    assert.equal(credentialPresent(), true, 'Only the caller has the synthetic credential');
    await assert.rejects(driver.recover(f.proof));
    assert.deepEqual(f.rows(), [], 'No native binary runs using a missing daemon credential');
  } finally { await stop(f.backend.store); }
});
test('unknown prior launch and a live old native process block replacement, even when the daemon is gone', async t => {
  const f = fixture(t), driver = new ButlerServiceDriver(f.backend.directory);
  binding.reserveBinding(f.backend.store, f.proof);
  binding.beginRunner(f.backend.store);
  await assert.rejects(driver.recover(f.proof), /runner-exit-unconfirmed/);
  await assert.rejects(driver.start(f.proof), /runner-exit-unconfirmed/);
  binding.confirmRunner(f.backend.store, process.pid);
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    await assert.rejects(driver.recover(f.proof), /runner-exit-unconfirmed/);
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
  assert.deepEqual(f.rows(), []);
});
test('an occupied ordinary store, unsafe binding, and runtime mismatch cannot be adopted', async t => {
  const f = fixture(t), driver = new ButlerServiceDriver(f.backend.directory);
  fs.writeFileSync(path.join(f.backend.store, 'workspace.json'), '{}');
  await assert.rejects(driver.recover(f.proof), /binding-mismatch/);
  await assert.rejects(driver.start(f.proof), /store-not-empty/);
  fs.unlinkSync(path.join(f.backend.store, 'workspace.json'));
  fs.writeFileSync(path.join(f.backend.store, 'service-binding.json'), 'null', { mode: 0o600 });
  await assert.rejects(driver.recover(f.proof), /binding-mismatch/);
  fs.unlinkSync(path.join(f.backend.store, 'service-binding.json'));
  binding.reserveBinding(f.backend.store, f.proof);
  await assert.rejects(driver.start({ ...f.proof, runtimeVersion: 'other-version' }), /binding-mismatch/);
  fs.chmodSync(path.join(f.backend.store, 'service-binding.json'), 0o644);
  await assert.rejects(driver.start(f.proof), /binding-mismatch/);
  assert.deepEqual(f.rows(), []);
});
test('a dedicated binding cannot label the running source with an arbitrary app version', async t => {
  const f = fixture(t), driver = new ButlerServiceDriver(f.backend.directory);
  await assert.rejects(driver.start({ ...f.proof, runtimeVersion: 'invented-runtime' }), /binding-mismatch/);
  assert.equal(fs.existsSync(path.join(f.backend.store, 'service.lock')), false);
  assert.deepEqual(f.rows(), []);
});
