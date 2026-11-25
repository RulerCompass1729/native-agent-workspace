'use strict';
// Real commands/files/processes; fault injection is confined to an owned synthetic bundle.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const { createPlatform } = require('../install-platform.cjs');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function createFaultPlatform(c) {
  assert.match(c.bundleId, /^test\.naw\.installer\./);
  for (const file of [c.app, c.candidate, c.data, c.resultDir]) assert.ok(file.startsWith(c.testRoot + path.sep));
  assert.ok(!c.testRoot.startsWith('/Applications')); assert.equal(fs.realpathSync(c.testRoot), c.testRoot);
  const platform = createPlatform(c), run = platform.run;
  let corrupted = false;
  if (c.testFault === 'bundled-backend') {
    const unused = platform.assertUnused;
    platform.assertUnused = app => {
      const observed = cp.spawnSync('/usr/sbin/lsof', ['-nP', '-F', 'pfn', '+D', app], { encoding: 'utf8', timeout: 10000 });
      fs.writeFileSync(path.join(c.testRoot, 'bundle-use.json'), JSON.stringify({ app, status: observed.status, stdout: observed.stdout, stderr: observed.stderr, error: observed.error?.message }));
      return unused(app);
    };
  }
  const version = () => JSON.parse(fs.readFileSync(path.join(c.app, 'Contents/Resources/app/package.json'))).version;
  platform.run = (file, args) => {
    if (['pre-launch', 'old-reopen-fails'].includes(c.testFault) && !corrupted && file === '/usr/bin/codesign' && args.includes('--verify') && args.includes(c.app) && version() === c.newVersion) {
      fs.appendFileSync(c.executable, 'synthetic invalid signature'); corrupted = true;
    }
    if (c.testFault === 'archive-fails' && file === '/usr/bin/ditto') fs.mkdirSync(args.at(-1));
    return run(file, args);
  };
  platform.open = () => {
    const isNew = version() === c.newVersion;
    if (!isNew && c.testFault === 'old-reopen-fails') fs.renameSync(c.executable, c.executable + '.disabled');
    cp.execFileSync('/usr/bin/open', ['-g', '-j', '-a', c.app], { timeout: 10000 });
    if (isNew && !['active-timeout', 'dsh-slow'].includes(c.testFault)) {
      let ready = false;
      for (let i = 0; i < 200; i++) {
        try { ready = JSON.parse(fs.readFileSync(path.join(c.data, 'fixture-started.json'))).version === c.newVersion; } catch {}
        if (ready) break; sleep(50);
      }
      assert.ok(ready, 'Synthetic app reached real backend startup');
    }
    if (isNew && c.testFault === 'new-crash') {
      const rows = platform.bundleApps(); assert.equal(rows.length, 1);
      for (const row of rows) { assert.equal(row.executable, c.executable); process.kill(row.pid, 'SIGTERM'); }
      for (let i = 0; i < 100 && platform.bundleApps().length; i++) sleep(50);
      assert.equal(platform.bundleApps().length, 0);
    }
  };
  return platform;
}
module.exports = { createPlatform: createFaultPlatform };
