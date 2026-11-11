const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const helper = require('../../scripts/fixtures/synthetic-source-boot.cjs');
const source = fs.readFileSync(require.resolve('../../scripts/fixtures/synthetic-source-boot.cjs'), 'utf8');

function fakeBoot(overrides = {}) {
  const effects = [], cp = { spawn: (...args) => effects.push(['spawn', ...args]), fork: (...args) => effects.push(['fork', ...args]) };
  const config = { profile: '/synthetic/profile', code: '/synthetic/code', fixturePid: 1234, endpoint: '/synthetic/service/desktop.sock' };
  const record = { protocol: 1, pid: config.fixturePid, endpoint: config.endpoint, ...overrides.record };
  const fakeProcess = { versions: { electron: 'test' }, env: { NAW_DATA_DIR: config.profile }, kill: pid => {
    assert.equal(pid, config.fixturePid); if (overrides.dead) throw Object.assign(Error('Synthetic fixture exited'), { code: 'ESRCH' });
  } };
  const context = vm.createContext({ module: { exports: {} }, __filename: '/synthetic/helper.cjs', process: fakeProcess, require: name => {
    if (name === 'node:fs') return { readFileSync: () => JSON.stringify(record), realpathSync: value => value };
    if (name === 'node:path') return path;
    if (name === 'node:assert/strict') return assert;
    if (name === 'node:child_process') return cp;
    if (name === 'electron') return { app: { setAppPath: value => effects.push(['appPath', value]) } };
    if (name === '/synthetic/code/app/main.cjs') { effects.push(['main']); return overrides.start ? overrides.start(cp) : {}; }
    throw Error('Unexpected test module ' + name);
  } });
  vm.runInContext(source, context);
  return { boot: () => context.module.exports.boot(config), cp, effects, config };
}

test('the private entry carries the exact source version and fixture identity', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-source-boot-unit-'));
  try {
    const code = path.join(folder, 'code'), profile = path.join(folder, 'profile'); fs.mkdirSync(code); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }));
    fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify({ protocol: 1, pid: process.pid, endpoint: '/synthetic/desktop.sock' }));
    const entry = helper.createSourceEntry({ profile, code, fixturePid: process.pid });
    assert.equal(JSON.parse(fs.readFileSync(path.join(entry, 'package.json'))).version, '0.1.0-alpha.1');
    assert.match(fs.readFileSync(path.join(entry, 'entry.cjs'), 'utf8'), /\.boot\(/);
    assert.equal(fs.statSync(entry).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(entry, 'entry.cjs')).mode & 0o777, 0o600);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a changed fixture PID is refused before application code runs', () => {
  const f = fakeBoot({ record: { pid: 5678 } }); assert.throws(f.boot, /PID changed/); assert.deepEqual(f.effects, []);
});
test('a changed fixture endpoint is refused before application code runs', () => {
  const f = fakeBoot({ record: { endpoint: '/synthetic/other/desktop.sock' } }); assert.throws(f.boot, /endpoint changed/); assert.deepEqual(f.effects, []);
});
test('an already exited fixture is refused before application code runs', () => {
  const f = fakeBoot({ dead: true }); assert.throws(f.boot, /fixture exited/); assert.deepEqual(f.effects, []);
});
test('a replacement daemon spawn is rejected before the spawn function is called', () => {
  const f = fakeBoot(); f.boot(); assert.throws(() => f.cp.spawn('/synthetic/electron', ['--disable-sigusr1', '/synthetic/runtime/daemon.cjs']), /refuses a replacement/);
  assert.equal(f.effects.some(effect => effect[0] === 'spawn'), false);
});
test('a replacement daemon fork is rejected before the fork function is called', () => {
  const f = fakeBoot(); f.boot(); assert.throws(() => f.cp.fork('/synthetic/runtime/daemon.cjs', []), /refuses a replacement/);
  assert.equal(f.effects.some(effect => effect[0] === 'fork'), false);
});
test('the existing interface host may still start after the guard is installed', () => {
  const f = fakeBoot(); f.boot(); f.cp.spawn('/synthetic/electron', ['/synthetic/code/app/dsh-server.mjs']);
  assert.deepEqual(f.effects.map(effect => effect[0]), ['appPath', 'main', 'spawn']);
});

function failedFallback(spawn) {
  const transport = fs.readFileSync(require.resolve('../service-client.cjs'), 'utf8');
  const functionSource = transport.slice(transport.indexOf('async function ensureServiceAt('), transport.indexOf('function emptyService('));
  const fakeFs = {
    existsSync: name => name.endsWith('service.lock'), readFileSync: name => name.endsWith('service.lock') ? '9876' : Buffer.from('synthetic code'),
    rmSync() {}, mkdirSync() {}, copyFileSync() {}, cpSync() {},
    lstatSync() { throw Object.assign(Error('No optional locations'), { code: 'ENOENT' }); },
  };
  const context = vm.createContext({ fs: fakeFs, path, crypto: require('node:crypto'), connectService: async () => { throw Error('Synthetic connection failed'); },
    uiError: message => Error(message), process: { env: {}, kill() { throw Object.assign(Error('Fixture exited'), { code: 'ESRCH' }); } },
    readLock: () => ({ pid: 9876 }), ownerMayBeAlive: () => false, releaseLock: () => true,
    serviceBinding: { readBinding: () => null, assertBinding() {} },
    processMayBeAlive: () => false, spawn, __dirname: '/synthetic/code/app', require: { resolve: name => '/synthetic/node_modules/' + name },
  });
  vm.runInContext(functionSource + ';globalThis.ensureServiceAt = ensureServiceAt;', context);
  return context.ensureServiceAt('/synthetic/profile', '/synthetic/electron', '/synthetic/workspace');
}

test('the actual unguarded failed-connect fallback reaches a replacement allocation', async () => {
  const calls = [];
  await assert.rejects(failedFallback((command, args) => { calls.push({ command, args }); throw Error('Synthetic unguarded allocation reached'); }), /unguarded allocation reached/);
  assert.equal(calls.length, 1); assert.equal(path.basename(calls[0].args[1]), 'daemon.cjs');
});

test('the actual failed-connect service fallback is blocked before its spawn effect', async () => {
  let startup;
  const f = fakeBoot({ start: cp => { startup = failedFallback(cp.spawn); return {}; } });
  f.boot(); await assert.rejects(startup, /refuses a replacement/); assert.equal(f.effects.some(effect => effect[0] === 'spawn'), false);
});
