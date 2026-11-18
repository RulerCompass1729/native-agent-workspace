const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const cp = require('node:child_process'), vm = require('node:vm');

for (const env of [
  { TZ: 'UTC', LC_ALL: 'C', LC_TIME: 'C' },
  { TZ: 'America/Los_Angeles', LC_ALL: 'en_US.UTF-8', LC_TIME: 'en_US.UTF-8' },
  { TZ: 'UTC', LC_ALL: 'zh_CN.UTF-8', LC_TIME: 'zh_CN.UTF-8' },
  { TZ: 'America/Los_Angeles', LC_ALL: 'zh_CN.UTF-8', LC_TIME: 'zh_CN.UTF-8' },
]) test(`real qualification reaches --version across parent/worker timezone and locale: ${env.TZ}/${env.LC_ALL}`, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-qualification-identity-'));
  try {
    const binary = path.join(directory, 'version-only'), marker = path.join(directory, 'reached.json');
    fs.writeFileSync(binary, '#!' + process.execPath + '\n' +
      'const fs=require("node:fs"),assert=require("node:assert/strict");assert.deepEqual(process.argv.slice(2),["--version"]);' +
      'fs.writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({home:process.env.HOME,TZ:process.env.TZ??null,LC_ALL:process.env.LC_ALL??null}));console.log("2.1.329 (Synthetic CLI)");\n', { mode: 0o700 });
    const script = `
      const fs=require('node:fs'),assert=require('node:assert/strict');
      const [source,binary,marker]=process.argv.slice(1);
      (async()=>{
        const result=await require(source).nativeJourneys({binary,version:'2.1.328',privateDir:require('node:path').dirname(binary),timeoutMs:3000});
        assert.equal(fs.existsSync(marker),true,'An owned process must reach --version despite a different parent environment');
        const observed=JSON.parse(fs.readFileSync(marker,'utf8'));
        assert.equal(observed.TZ,null);assert.equal(observed.LC_ALL,null);
        assert.equal(result.passed,false);assert.equal(result.reason,'native-startup');
        assert.equal(fs.existsSync(observed.home),false);
        console.log(JSON.stringify({reached:true,result,worker:observed,parent:{TZ:process.env.TZ,LC_ALL:process.env.LC_ALL}}));
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `;
    const run = cp.spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '../claude-qualification.cjs'), binary, marker],
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).reached, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('qualification identity fixes both timezone and all locale categories without changing the legacy reader', () => {
  const source = path.resolve(__dirname, '../platform.cjs'), box = { exports: {} }, calls = [];
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module: box, exports: box.exports, process,
    require: name => name === 'node:child_process' ? { execFileSync: (file, args, options) => {
      calls.push({ file, args, options }); return 'Wed Nov 18 00:00:00 2026\n';
    } } : name.startsWith('.') ? require(path.resolve(path.dirname(source), name)) : require(name),
  });
  assert.equal(box.exports.processIdentity(424242).started, 'Wed Nov 18 00:00:00 2026');
  assert.equal(calls[0].options.env, undefined, 'Existing persisted identities retain their original reader');
  assert.equal(box.exports.processIdentityUTC(424242).started, 'Wed Nov 18 00:00:00 2026');
  assert.equal(calls[1].file, '/bin/ps');
  assert.equal(JSON.stringify(calls[1].args), JSON.stringify(['-p', '424242', '-o', 'lstart=']));
  assert.equal(calls[1].options.env.TZ, 'UTC');
  assert.equal(calls[1].options.env.LC_ALL, 'C');
  assert.equal(calls[1].options.env.LC_TIME, 'C');
  assert.equal(calls[1].options.env.LANG, 'C');
  for (const pid of [null, 0, 1, -1, 2.5, '424242']) assert.equal(box.exports.processIdentityUTC(pid), null);
  assert.equal(calls.length, 2, 'Invalid identities must not query or signal a process');
});
