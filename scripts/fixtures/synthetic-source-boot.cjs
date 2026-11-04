// Test-only source entry. Never imported by the desktop application itself.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');

function fixtureIdentity({ profile, fixturePid, endpoint }) {
  const record = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'));
  assert.equal(record.protocol, 1, 'Expected the owned synthetic transport');
  assert.ok(Number.isSafeInteger(fixturePid) && fixturePid > 1);
  assert.equal(record.pid, fixturePid, 'Synthetic fixture PID changed');
  assert.equal(path.basename(record.endpoint || ''), 'desktop.sock');
  if (endpoint !== undefined) assert.equal(record.endpoint, endpoint, 'Synthetic fixture endpoint changed');
  process.kill(fixturePid, 0); // Liveness read only; never signal or replace a service here.
  return record.endpoint;
}

function createSourceEntry({ profile, code, fixturePid }) {
  profile = fs.realpathSync(profile); code = fs.realpathSync(code);
  const config = { profile, code, fixturePid };
  config.endpoint = fixtureIdentity(config);
  const version = JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8')).version;
  assert.equal(typeof version, 'string'); assert.ok(version.length);
  const entry = path.join(profile, 'synthetic-source-entry'); fs.mkdirSync(entry, { mode: 0o700 });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-synthetic-source-test', version, main: 'entry.cjs' }), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(entry, 'entry.cjs'), `require(${JSON.stringify(__filename)}).boot(${JSON.stringify(config)});\n`, { mode: 0o600, flag: 'wx' });
  return entry;
}

function boot(config) {
  assert.ok(process.versions.electron, 'Synthetic source boot requires Electron');
  assert.equal(fs.realpathSync(process.env.NAW_DATA_DIR), config.profile, 'Unexpected synthetic test profile');
  fixtureIdentity(config);
  const cp = require('node:child_process'), spawn = cp.spawn, fork = cp.fork;
  const rejectReplacement = args => {
    if (Array.isArray(args) && args.some(arg => typeof arg === 'string' && path.basename(arg) === 'daemon.cjs')) throw Error('Synthetic source test refuses a replacement backend');
  };
  cp.spawn = function (command, args = [], ...rest) { rejectReplacement(args); return spawn.call(this, command, args, ...rest); };
  cp.fork = function (modulePath, ...rest) { rejectReplacement([modulePath]); return fork.call(this, modulePath, ...rest); };
  // The entry's package has the exact source version, avoiding an empty fixture
  // being retired just because Electron reads a test package's default version.
  require('electron').app.setAppPath(config.code);
  return require(path.join(config.code, 'app/main.cjs'));
}

module.exports = { createSourceEntry, boot };
