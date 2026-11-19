const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm'), crypto = require('node:crypto');
const entry = path.resolve(__dirname, '../../scripts/test-native-claude-session-list.cjs');
const helper = path.resolve(__dirname, '../../scripts/fixtures/test-scratch.cjs');
const platform = path.resolve(__dirname, '../platform.cjs');

for (const mode of ['clean', 'positive', 'stop-fails', 'snapshot-fails', 'fixture-fails', 'exit-unconfirmed']) {
  test('session-list evidence cleanup: ' + mode, t => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-session-list-cleanup-'));
    let proof;
    t.after(() => {
      if (proof?.alive === false && proof.baseExists === false) fs.rmSync(outer, { recursive: true, force: true });
    });
    for (const name of ['home', 'tmp', 'evidence']) fs.mkdirSync(path.join(outer, name));
    const body = `
      const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
      const source=fs.readFileSync(${JSON.stringify(entry)},'utf8'),evidence=process.env.NAW_EVIDENCE_DIR;
      const scratch=require(${JSON.stringify(helper)}),platform=require(${JSON.stringify(platform)}),mode=${JSON.stringify(mode)};
      const markerStart=source.indexOf('const A ='),markerEnd=source.indexOf('let fixture,',markerStart);
      const setup=vm.runInNewContext(source.slice(markerStart,markerEnd)+";({markers:SESSION_TEXT,redactSessionText:typeof redactSessionText==='function'?redactSessionText:null})",{crypto}),markers=setup.markers;
      const base=scratch.directory(path.join(process.env.TMPDIR,'naw-session-list-owned-')),config=path.join(base,'claude');
      fs.mkdirSync(config);fs.writeFileSync(path.join(config,'fixture.jsonl'),markers.join('\\n'));
      fs.writeFileSync(path.join(base,'failure.txt'),markers.join('\\n'));
      const child=scratch.childProcess.spawn(process.execPath,['-e',"console.log('READY');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
      (async()=>{
        await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Owned fixture exited before READY')));});
        const identity=platform.processIdentity(child.pid);if(!identity)throw Error('Missing owned identity');
        let removed=0,unsafeRemove=false;
        const scopedFS=new Proxy(fs,{get(target,key){if(key==='rmSync')return(file,options)=>{
          if(file===config){removed++;if(platform.processMayBeAlive(identity)){unsafeRemove=true;throw Error('Removed live native config');}}
          return fs.rmSync(file,options);
        };return target[key];}});
        const wrappedScratch={cleanup(fn){const release=scratch.cleanup(fn);return async()=>{
          await release();if(mode==='positive')fs.writeFileSync(path.join(evidence,'intentional-residue.txt'),markers.join('\\n'));
        };}};
        const sandbox={fs:scopedFS,path,process,console,evidence,base,config,SESSION_TEXT:markers,
          application:null,outside:null,outsideIdentity:null,nativeIdentities:[],redactSessionText:setup.redactSessionText,
          fixture:{async stop(){if(mode==='fixture-fails')throw Error('Synthetic fixture stop failure');}},
          processIdentity:platform.processIdentity,processMayBeAlive:platform.processMayBeAlive,
          snapshot:async()=>{if(mode==='snapshot-fails')throw Error('Synthetic snapshot failure');return{sessions:[{id:'synthetic',pid:child.pid}]};},
          client:{async call(method){if(method==='stop'){if(mode==='stop-fails')throw Error('Synthetic stop failure');if(mode!=='exit-unconfirmed')child.kill('SIGTERM');}},close(){}},
          until:async fn=>{if(mode==='exit-unconfirmed')throw Error('Native sessions exited is unconfirmed');for(let i=0;i<250;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Native sessions exited is unconfirmed');},
          testScratch:wrappedScratch};
        vm.createContext(sandbox);
        vm.runInContext(source.slice(0,source.indexOf("const testScratch = require(")),sandbox);
        const cleanupStart=source.indexOf('async function cleanup()');
        vm.runInContext(source.slice(cleanupStart,source.indexOf('(async () => {',cleanupStart)),sandbox);
        const finalizer=source.slice(source.indexOf('.finally(testScratch.cleanup(cleanup))'));
        try{await vm.runInContext('Promise.resolve()'+finalizer,sandbox);}catch(error){console.error(error.message);process.exitCode=1;}
        console.log(JSON.stringify({probe:true,removed,unsafeRemove,alive:platform.processMayBeAlive(identity),baseExists:fs.existsSync(base)}));
      })().catch(error=>{console.error(error.stack);process.exitCode=1;});
    `;
    const env = {
      PATH: process.env.PATH, HOME: path.join(outer, 'home'), TMPDIR: path.join(outer, 'tmp'),
      TMP: path.join(outer, 'tmp'), TEMP: path.join(outer, 'tmp'), LANG: 'C',
      NAW_TEMP_REGISTRY_DIR: path.join(outer, 'home', 'registry'), NAW_EVIDENCE_DIR: path.join(outer, 'evidence'),
    };
    const r = spawnSync(process.execPath, ['-e', body], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.status, mode === 'clean' ? 0 : 1, r.stderr);
    proof = r.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(row => row.probe);
    assert.ok(proof, r.stdout + r.stderr);
    assert.equal(proof.unsafeRemove, false);
    assert.equal(proof.alive, false, 'shared cleanup confirms the owned child exited');
    assert.equal(proof.baseExists, false, 'shared cleanup removes only the exited owned root');
    assert.equal(proof.removed, mode === 'clean' || mode === 'positive' ? 1 : 0);
    const leaked = [];
    const scan = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (item.isFile() && /Synthetic (Alpha|Beta) notes|SYNTHETIC_(ALPHA|BETA)_(PROMPT|REPLY)/.test(fs.readFileSync(file, 'utf8'))) leaked.push(path.relative(path.join(outer, 'evidence'), file));
    } };
    scan(path.join(outer, 'evidence'));
    if (mode === 'positive') {
      assert.deepEqual(leaked, ['intentional-residue.txt']);
      assert.match(r.stderr, /evidenceHoldsSessionText/);
    } else {
      assert.deepEqual(leaked, [], 'no transcript or raw failure text can enter evidence');
      assert.match(r.stdout, /"evidenceSessionTextScan":"clean"/, 'final scan also runs after cleanup failure');
    }
    if (mode === 'stop-fails') assert.match(r.stderr, /Synthetic stop failure/);
  });
}


test('session-list direct failure evidence is scrubbed before writing or logging', async () => {
  const source = fs.readFileSync(entry, 'utf8'), writes = [], logs = [];
  const declarations = source.slice(source.indexOf('const A ='), source.indexOf('let fixture,'));
  const markers = vm.runInNewContext(declarations + ';SESSION_TEXT', { crypto });
  const start = source.indexOf('.catch(async error => {'), end = source.indexOf('}).finally(testScratch.cleanup(cleanup))', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start + '.catch(async error => {'.length, end);
  const context = { crypto, path, evidence: '/synthetic-evidence', process: {},
    fs: { writeFileSync(file, text) { writes.push({ file, text }); } },
    page: { isClosed: () => false, locator: () => ({ innerText: async () => markers.join(' ') }) },
    shot: async () => {}, console: { error(text) { logs.push(String(text)); } }, error: Error(markers.join(' ')),
  };
  vm.createContext(context);
  await vm.runInContext(declarations + ';(async()=>{' + body + '})()', context);
  assert.equal(writes.length, 1);
  assert.equal(path.basename(writes[0].file), 'failure-status.txt');
  assert.equal(logs.length, 1);
  for (const text of [...writes.map(write => write.text), ...logs]) {
    assert.equal(markers.some(marker => text.includes(marker)), false, 'session text must be scrubbed before the output sink');
    assert.ok(text.includes('[synthetic session text]'));
  }
  assert.equal(context.process.exitCode, 1);
});
