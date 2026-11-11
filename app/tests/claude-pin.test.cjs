// B3 fallback: an unqualified Claude version is temporarily replaced by the newest
// qualified one still installed. Fake programs only; no Claude, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const pin = require('../claude-pin.cjs');

// A vendor-style install: <dir>/versions/<version> programs and a launcher link.
function install(t, versions, current) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-pin-')), ran = path.join(dir, 'ran.txt');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'versions')); fs.mkdirSync(path.join(dir, 'bin'));
  for (const v of versions) fs.writeFileSync(path.join(dir, 'versions', v), `#!/bin/sh\nprintf '%s\\n' '${v}' "$@" > '${ran}'\n`, { mode: 0o700 });
  const launcher = path.join(dir, 'bin', 'claude');
  if (current) fs.symlinkSync(path.join(dir, 'versions', current), launcher);
  return { dir, launcher, ran, stateFile: path.join(dir, 'claude-pin.json'), file: v => path.join(fs.realpathSync(dir), 'versions', v) };
}
const T0 = Date.parse('2026-11-10T00:00:00Z');

test('the host list equals the managed native-blocks list in the mod', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'claude-bridge', 'hooks', 'register.js'), 'utf8');
  const managed = source.match(/nativeBlocks = legacyOnly \? \[[^\]]*\]\.includes\(nativeVersion\)\s*: \[([^\]]*)\]\.includes\(nativeVersion\);/);
  assert.ok(managed, 'The managed nativeBlocks list is where this test expects it');
  assert.deepEqual([...pin.QUALIFIED], managed[1].split(',').map(s => s.trim().replace(/'/g, '')));
});

test('a new session under an unqualified version starts with the newest qualified one, and says so', t => {
  const i = install(t, ['2.1.321', '2.1.322', '2.1.999'], '2.1.999');
  const r = pin.choose({ launcher: i.launcher, fresh: true, stateFile: i.stateFile, now: T0 });
  assert.equal(r.binary, i.file('2.1.322')); assert.equal(r.version, '2.1.322');
  assert.deepEqual(r.pin, { requested: '2.1.999', pinned: '2.1.322', since: '2026-11-10T00:00:00.000Z', until: '2026-11-17T00:00:00.000Z' });
  assert.equal(fs.statSync(i.stateFile).mode & 0o777, 0o600);
});

test('a qualified version, another layout or an exact file the person chose is never replaced', t => {
  const ok = install(t, ['2.1.321', '2.1.322'], '2.1.322');
  assert.deepEqual(pin.choose({ launcher: ok.launcher, fresh: true, stateFile: ok.stateFile, now: T0 }), { binary: ok.launcher, version: '2.1.322', pin: null });
  assert.equal(fs.existsSync(ok.stateFile), false);
  const exact = install(t, ['2.1.322', '2.1.999']);
  assert.deepEqual(pin.choose({ launcher: exact.file('2.1.999'), fresh: true, stateFile: exact.stateFile, now: T0 }), { binary: exact.file('2.1.999'), version: null, pin: null });
  const other = install(t, ['2.1.322']); fs.mkdirSync(path.join(other.dir, 'Cellar'));
  fs.writeFileSync(path.join(other.dir, 'Cellar', 'claude'), '#!/bin/sh\n', { mode: 0o700 }); fs.symlinkSync(path.join(other.dir, 'Cellar', 'claude'), other.launcher);
  assert.deepEqual(pin.choose({ launcher: other.launcher, fresh: true, stateFile: other.stateFile, now: T0 }), { binary: other.launcher, version: null, pin: null });
  assert.deepEqual(pin.choose({ launcher: path.join(other.dir, 'missing'), fresh: true, stateFile: other.stateFile, now: T0 }), { binary: path.join(other.dir, 'missing'), version: null, pin: null });
});

test('a session is never reopened by an older version than the one that last ran it', t => {
  const i = install(t, ['2.1.322', '2.1.999'], '2.1.999');
  const resume = lastVersion => pin.choose({ launcher: i.launcher, fresh: false, lastVersion, stateFile: i.stateFile, now: T0 });
  for (const unknown of [undefined, null, '', '2.1', '2.1.322-beta']) assert.deepEqual(resume(unknown), { binary: i.launcher, version: '2.1.999', pin: null }, String(unknown));
  assert.deepEqual(resume('2.1.999'), { binary: i.launcher, version: '2.1.999', pin: null });
  assert.equal(resume('2.1.323').pin, null);
  assert.equal(resume('2.1.322').binary, i.file('2.1.322'));
  assert.equal(resume('2.1.321').binary, i.file('2.1.322'), 'An older session may move up to the fallback version');
});

test('the fallback only goes to an older, installed, regular, executable qualified version', t => {
  const none = install(t, ['2.1.999'], '2.1.999');
  assert.equal(pin.choose({ launcher: none.launcher, fresh: true, stateFile: none.stateFile, now: T0 }).pin, null);
  const forward = install(t, ['2.1.300', '2.1.322'], '2.1.300');
  assert.deepEqual(pin.choose({ launcher: forward.launcher, fresh: true, stateFile: forward.stateFile, now: T0 }), { binary: forward.launcher, version: '2.1.300', pin: null });
  const odd = install(t, ['2.1.321', '2.1.999'], '2.1.999');
  fs.symlinkSync(odd.file('2.1.999'), path.join(odd.dir, 'versions', '2.1.322')); // a link named like a qualified version
  assert.equal(pin.choose({ launcher: odd.launcher, fresh: true, stateFile: odd.stateFile, now: T0 }).binary, odd.file('2.1.321'));
  fs.chmodSync(odd.file('2.1.321'), 0o600);
  assert.equal(pin.choose({ launcher: odd.launcher, fresh: true, stateFile: odd.stateFile, now: T0 }).pin, null);
  const unwritable = install(t, ['2.1.322', '2.1.999'], '2.1.999');
  assert.equal(pin.choose({ launcher: unwritable.launcher, fresh: true, stateFile: path.join(unwritable.dir, 'missing', 'state.json'), now: T0 }).pin, null, 'No fallback without its recorded start');
});

test('the fallback lasts seven days per fallback version, then the launcher is used again and the session says so', t => {
  const i = install(t, ['2.1.321', '2.1.322', '2.1.998', '2.1.999'], '2.1.998');
  const at = now => pin.choose({ launcher: i.launcher, fresh: true, stateFile: i.stateFile, now });
  assert.equal(at(T0).binary, i.file('2.1.322'));
  // A still newer unqualified version does not restart the clock.
  fs.rmSync(i.launcher); fs.symlinkSync(path.join(i.dir, 'versions', '2.1.999'), i.launcher);
  const later = at(T0 + pin.LIMIT_MS - 1);
  assert.equal(later.binary, i.file('2.1.322')); assert.equal(later.pin.requested, '2.1.999'); assert.equal(later.pin.since, '2026-11-10T00:00:00.000Z');
  const expired = at(T0 + pin.LIMIT_MS);
  assert.equal(expired.binary, i.launcher); assert.equal(expired.version, '2.1.999');
  assert.deepEqual(expired.pin, { requested: '2.1.999', pinned: '2.1.322', since: '2026-11-10T00:00:00.000Z', until: '2026-11-17T00:00:00.000Z', expired: true });
  // When the vendor removes that version, the next older qualified one starts its own period.
  fs.rmSync(i.file('2.1.322'));
  const next = at(T0 + pin.LIMIT_MS + 1000);
  assert.equal(next.binary, i.file('2.1.321')); assert.equal(next.pin.expired, undefined); assert.equal(next.pin.pinned, '2.1.321');
});

test('NAW starts a new Claude session with the fallback program and records it; a resume of unknown origin keeps the launcher', async t => {
  const { Claude } = require('../adapters.cjs');
  const i = install(t, ['2.1.322', '2.1.999'], '2.1.999');
  const host = { binaries: { claude: i.launcher }, privateDir: i.dir, hookTargets: new Map(), hookSocket: path.join(i.dir, 'hook.sock'), submitSocket: path.join(i.dir, 'submit.sock') };
  const start = async record => { const r = new Claude(record, host); await new Promise(resolve => r.terminal.once('closed', resolve)); r.submission.close(); return fs.readFileSync(i.ran, 'utf8').trim().split('\n'); };
  const fresh = { id: randomUUID(), nativeId: randomUUID(), name: 'New', cwd: i.dir };
  let argv = await start(fresh);
  assert.equal(argv[0], '2.1.322'); assert.ok(argv.includes('--session-id'));
  assert.equal(fresh.nativeLaunchVersion, '2.1.322'); assert.equal(fresh.nativePin.requested, '2.1.999'); assert.equal(fresh.nativePin.pinned, '2.1.322');
  // The same session resumed later stays on the fallback version.
  argv = await start({ ...fresh, recovering: true });
  assert.equal(argv[0], '2.1.322'); assert.ok(argv.includes('--resume'));
  // A session NAW has no launch version for (taken over, or started before this existed) is not moved down.
  const taken = { id: randomUUID(), nativeId: randomUUID(), name: 'Taken over', cwd: i.dir, recovering: true };
  argv = await start(taken);
  assert.equal(argv[0], '2.1.999'); assert.equal(taken.nativePin, undefined); assert.equal(taken.nativeLaunchVersion, '2.1.999');
  // A fork of a session the person picks in the native picker is not moved down either.
  const fork = { id: randomUUID(), nativeId: randomUUID(), name: 'Fork', cwd: i.dir, forkPicker: true };
  argv = await start(fork);
  assert.equal(argv[0], '2.1.999'); assert.equal(fork.nativePin, undefined);
});

test('the session status names the fallback version, the new version and the last day, in both languages', () => {
  const vm = require('node:vm'), locale = require('../ui-locale.js');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const source = renderer.slice(renderer.indexOf('function claudePinText('), renderer.indexOf('function nativeVersionText('));
  assert.match(renderer, /\$\{claudePinText\(s\)\}\$\{s\.activity \?/, 'The status line includes the fallback notice');
  assert.match(renderer, /if \(s\?\.provider === 'claude'\) return claudePinText\(s, true\);/, 'The hover text explains it');
  const text = (language, s, detail) => vm.runInNewContext(source + '; claudePinText(s, detail)', { s, detail,
    uiText: (key, params) => locale.format(language, key, params), ui: { language: { getSnapshot: () => ({ active: language }) } } });
  const pin = { requested: '2.1.999', pinned: '2.1.322', since: '2026-11-10T12:00:00.000Z', until: '2026-11-17T12:00:00.000Z' };
  const s = { provider: 'claude', nativePin: pin };
  assert.match(text('zh', s), /^ · 暂用 Claude 2\.1\.322（新版 2\.1\.999 待核验，最迟到 11\/17）$/);
  assert.match(text('en', s), /^ · Using Claude 2\.1\.322 for now \(2\.1\.999 not yet verified; until 11\/17 at the latest\)$/);
  assert.match(text('zh', s, true), /拿不到新版的功能和修复.*新版核验后，或最迟 11\/17 之后/);
  assert.match(text('zh', { provider: 'claude', nativePin: { ...pin, expired: true } }), /^ · Claude 2\.1\.999 尚未核验，暂用 2\.1\.322 的期限已到$/);
  assert.equal(text('zh', { provider: 'claude' }), ''); assert.equal(text('zh', { provider: 'codex', nativePin: pin }), '');
});
