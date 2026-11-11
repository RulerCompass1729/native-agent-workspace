'use strict';
const cp = require('node:child_process'), fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
function createPlatform(config) {
  const run = (file, args) => cp.execFileSync(file, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const helper = action => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(config.swift.path)).digest('hex');
    if (digest !== config.swift.sha256) throw Object.assign(Error('Swift helper changed'), { code: 'helper-pin-mismatch' });
    return JSON.parse(run('/usr/bin/swift', [config.swift.path, action, config.bundleId, config.executable]));
  };
  return {
    run,
    checkRelease: c => {
      assert.equal(run('/usr/bin/git', ['-C', c.release, 'status', '--porcelain']).trim(), '', 'Release must be clean');
      assert.equal(run('/usr/bin/git', ['-C', c.release, 'rev-parse', 'HEAD']).trim(), c.commit, 'Release commit changed');
    },
    assertOrdinaryLaunch: pid => {
      assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Invalid GUI PID');
      assert.equal(run('/bin/ps', ['-p', String(pid), '-o', 'command=']).trim(), config.executable, 'Unexpected profile/debug arguments or changed GUI process');
    },
    assertUnused: app => {
      const r = cp.spawnSync('/usr/sbin/lsof', ['-nP', '-F', 'pn', '+D', app], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
      const output = r.stdout || '', diagnostic = r.stderr || '';
      // macOS can return 1 while still reporting mapped files under +D. Those
      // positive records prove use; an exit status alone does not prove absence.
      const used = !r.error && [0, 1].includes(r.status) && /^p[1-9][0-9]*$/m.test(output) &&
        output.split('\n').some(line => line.startsWith('n' + app + '/'));
      if (used) throw Object.assign(Error('Old bundle is still in use'), { code: 'bundle-in-use' });
      if (r.error || r.status !== 1 || output.trim() || diagnostic.trim())
        throw Object.assign(Error('Old bundle use could not be determined'), { code: 'bundle-use-unconfirmed' });
    },
    signature: app => {
      const r = cp.spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', '-r-', app], { encoding: 'utf8', timeout: 60000 });
      assert.equal(r.status, 0, 'Unable to read signature');
      const text = r.stdout + '\n' + r.stderr;
      const cdhash = /^CDHash=([a-f0-9]+)$/m.exec(text)?.[1];
      const requirement = /^designated => (.+)$/m.exec(text)?.[1];
      assert.ok(cdhash && requirement, 'Signature and designated requirement required');
      return { cdhash, requirement };
    },
    bundleApps: () => helper('list').sort((a, b) => a.pid - b.pid),
    quit: () => helper('quit'),
    open: () => {
      const env = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']) if (Object.hasOwn(process.env, key)) env[key] = process.env[key];
      cp.execFileSync('/usr/bin/open', ['-a', config.app], { env, timeout: 60000 });
    },
  };
}
module.exports = { createPlatform };
