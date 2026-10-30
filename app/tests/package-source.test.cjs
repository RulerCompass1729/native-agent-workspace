const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceRevision } = require('../../scripts/package-mac.cjs');
const { localSigningIdentity, verifyLocalSigning, localSigningOptions } = require('../../scripts/package-mac.cjs');

test('packaging identifies a clean commit and refuses staged, unstaged and untracked source', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-package-source-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  // Synthetic local repository only; never run the person's global Git hooks.
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(folder, 'no-hooks'), ...args], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@users.noreply.github.com');
  fs.writeFileSync(path.join(folder, '.gitignore'), 'generated.js\n');
  fs.writeFileSync(path.join(folder, 'source.js'), 'original\n');
  git('add', '.'); git('commit', '-m', 'Synthetic packaging source');
  const revision = git('rev-parse', 'HEAD');
  assert.equal(sourceRevision(folder), revision);
  fs.writeFileSync(path.join(folder, 'generated.js'), 'stale generated output');
  assert.equal(sourceRevision(folder), revision, 'The builder regenerates ignored output from committed inputs');
  fs.appendFileSync(path.join(folder, 'source.js'), 'dirty\n');
  assert.throws(() => sourceRevision(folder), /Commit source changes/);
  git('add', 'source.js'); assert.throws(() => sourceRevision(folder), /Commit source changes/);
  git('restore', '--staged', 'source.js'); git('restore', 'source.js');
  fs.writeFileSync(path.join(folder, 'untracked.js'), 'uncommitted input');
  assert.throws(() => sourceRevision(folder), /Commit source changes/);
  fs.unlinkSync(path.join(folder, 'untracked.js')); assert.equal(sourceRevision(folder), revision);
});

test('local packaging selects the unique named keychain identity without requiring system trust', () => {
  const digest = 'A'.repeat(40), calls = [];
  const query = (bin, args, options) => {
    calls.push({ bin, args }); assert.ok(options.timeout > 0 && options.timeout <= 10000);
    return `Matching identities\n  1) ${digest} "NAW Local Code Signing" (CSSMERR_TP_NOT_TRUSTED)\n  0 valid identities found\n`;
  };
  assert.equal(localSigningIdentity(query), digest);
  assert.deepEqual(calls, [{ bin: '/usr/bin/security', args: ['find-identity', '-p', 'codesigning'] }]);
});

test('local packaging refuses missing, ambiguous, expired or unreadable identities', () => {
  const a = 'A'.repeat(40), b = 'B'.repeat(40);
  for (const output of ['', `1) ${a} "Other identity"`, `1) ${a} "NAW Local Code Signing"\n2) ${b} "NAW Local Code Signing"`, `1) ${a} "NAW Local Code Signing" (CSSMERR_TP_CERT_EXPIRED)`]) {
    assert.throws(() => localSigningIdentity(() => output), /NAW Local Code Signing/);
  }
  assert.throws(() => localSigningIdentity(() => { throw Error('Locked keychain'); }), /NAW Local Code Signing/);
  assert.equal(localSigningIdentity(() => `1) ${a} "NAW Local Code Signing"\n1) ${a} "NAW Local Code Signing"`), a);
});

test('signed payload readback requires the same certificate-bound identity, not an ad-hoc or broader requirement', () => {
  const digest = 'A'.repeat(40), bundle = 'io.github.rulercompass1729.native-agent-workspace';
  const good = `designated => identifier "${bundle}" and certificate leaf = H"${digest.toLowerCase()}"\n`;
  let called;
  assert.equal(verifyLocalSigning('/owned/fixture.app', digest, (bin, args) => { called = { bin, args }; return good; }), good.trim());
  assert.deepEqual(called, { bin: '/usr/bin/codesign', args: ['-d', '-r-', '/owned/fixture.app'] });
  for (const output of [`# designated => cdhash H"${digest}"`, good.replace(digest.toLowerCase(), 'b'.repeat(40)), good.replace(bundle, 'other.bundle'), good.trim() + ' or true']) {
    assert.throws(() => verifyLocalSigning('/owned/fixture.app', digest, () => output), /certificate-bound/);
  }
});

test('the actual signing library disables timestamp requests on every signing command', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-sign-arguments-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const bin = path.join(folder, 'bin'), app = path.join(folder, 'Fixture.app');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  // A Mach-O header makes the library visit the nested binary. Neither this
  // fixture nor a real signing/network/keychain executable is ever executed.
  fs.writeFileSync(path.join(app, 'Contents/MacOS/Fixture'), Buffer.from('cffaedfe00000000000000000000000000000000000000000000000000000000', 'hex'));
  const calls = path.join(folder, 'calls.jsonl');
  fs.writeFileSync(path.join(bin, 'codesign'), '#!' + process.execPath + '\nrequire("fs").appendFileSync(process.env.NAW_SIGN_ARGUMENTS, JSON.stringify(process.argv.slice(2)) + "\\n");\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  const originalPath = process.env.PATH, originalLog = process.env.NAW_SIGN_ARGUMENTS;
  try {
    process.env.PATH = bin + path.delimiter + originalPath; process.env.NAW_SIGN_ARGUMENTS = calls;
    const { sign } = await import('@electron/osx-sign');
    await sign({ app, platform: 'darwin', ...localSigningOptions('A'.repeat(40)) });
  } finally {
    process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.NAW_SIGN_ARGUMENTS; else process.env.NAW_SIGN_ARGUMENTS = originalLog;
  }
  const args = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  const signed = args.filter(a => a.includes('--sign')); assert.ok(signed.length >= 2);
  for (const call of signed) { assert.ok(call.includes('--timestamp=none')); assert.ok(!call.includes('--timestamp')); }
});
