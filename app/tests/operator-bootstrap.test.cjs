for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ensureService, connect, connectService } = require('../service-client.cjs');
const { readLayout } = require('../service-layout.cjs');
const { createLock, releaseLock, readLock, ownerMayBeAlive } = require('../service-lock.cjs');
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-b-operator-')));
  fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ sessions: [{ id: 'retained', nativeId: 'synthetic-native', provider: 'claude', state: 'working', name: 'Synthetic retained', messages: [] }], room: { messages: [] }, drafts: {} }), { mode: 0o600 });
  t.after(async () => {
    delete process.env.NAW_APP_VERSION;
    for (const key of readLayout(root).entries) {
      const dir = path.join(root, key), owner = readLock(path.join(dir, 'service.lock'));
      if (!owner) continue;
      assert.equal(owner.directory, fs.realpathSync(dir));
      if (ownerMayBeAlive(owner, dir, 'service')) process.kill(owner.pid, 'SIGTERM');
      for (let i=0; i<80 && ownerMayBeAlive(owner, dir, 'service'); i++) await new Promise(r=>setTimeout(r,50));
      assert.equal(ownerMayBeAlive(owner, dir, 'service'), false, 'owned synthetic service exited before cleanup');
    }
    fs.rmSync(root, { recursive:true });
  });
  process.env.NAW_APP_VERSION = 'synthetic-old'; await ensureService(root, process.execPath);
  return root;
}
for (const enabled of [true, false]) test('new backend retains the existing global choice '+enabled+' without copying per-session grants', async t => {
  const root=await fixture(t), old=await connectService(root,'test');
  try { await old.call('operatorAction',null,'enabled',enabled); await old.call('operatorAction','retained','enabled',true); }
  finally { old.close(); }
  process.env.NAW_APP_VERSION='synthetic-next'; await ensureService(root,process.execPath);
  const layout=readLayout(root); assert.notEqual(layout.active,'.');
  const next=await connectService(path.join(root,layout.active),'test');
  try { const state=await next.call('initial'); assert.equal(state.operatorPolicy.enabled,enabled); assert.deepEqual(state.operatorPolicy.sessions,{}); assert.deepEqual(state.operatorPolicy.domains,[]); }
  finally { next.close(); }
  const client=await connect(root,'test');
  try {
    const before=client.snapshot().sessions.find(s=>s.id==='retained'); assert.equal(before.nativeId,'synthetic-native'); assert.equal(before.operatorEnabled,true);
    await client.call('operatorAction',null,'enabled',false);
  } finally {client.close();}
  process.env.NAW_APP_VERSION='synthetic-third'; await ensureService(root,process.execPath);
  const latest=await connect(root,'test');
  try {assert.equal(latest.snapshot().operatorPolicy.enabled,false); assert.equal(latest.snapshot().sessions.find(s=>s.id==='retained').nativeId,'synthetic-native');}
  finally {latest.close();}
});
test('a global toggle cannot race the services startup lock and the lock is never stolen',async t=>{
 const root=await fixture(t),client=await connect(root,'test'),file=path.join(root,'services.lock'),held=createLock(file,'startup',root);let released=false;
 t.after(()=>{client.close();if(!released)releaseLock(file,held);});
 await assert.rejects(client.call('operatorAction',null,'enabled',true));
 assert.equal(readLock(file).token,held.token);assert.equal(client.snapshot().operatorPolicy.enabled,false);
 assert.equal(releaseLock(file,held),true);released=true;
 assert.equal(await client.call('operatorAction',null,'enabled',true),true);assert.equal(client.snapshot().operatorPolicy.enabled,true);assert.equal(fs.existsSync(file),false);
});
for (const enabled of [false, true]) test('a stale backend list refuses global '+enabled+' before writing any backend', async t => {
  const root = await fixture(t), old = await connectService(root, 'test');
  try { await old.call('operatorAction', null, 'enabled', true); } finally { old.close(); }
  const stale = await connect(root, 'stale'); t.after(() => stale.close());
  process.env.NAW_APP_VERSION = 'synthetic-next'; await ensureService(root, process.execPath);
  let writes = 0;
  for (const entry of stale.entries) {
    const call = entry.client.call.bind(entry.client);
    entry.client.call = (...args) => { if (args[0] === 'operatorAction') writes++; return call(...args); };
  }
  await assert.rejects(stale.call('operatorAction', null, 'enabled', enabled), error => error.uiMessage?.key === 'error.client.operatorBackendListChanged');
  assert.equal(writes, 0); assert.equal(fs.existsSync(path.join(root, 'services.lock')), false);
  const fresh = await connect(root, 'fresh');
  try {
    assert.equal(fresh.snapshot().operatorPolicy.backends.length, 2);
    assert.ok(fresh.snapshot().operatorPolicy.backends.every(row => row.enabled), 'a rejected stale call changes neither backend');
    assert.equal(await fresh.call('operatorAction', null, 'enabled', false), true);
    assert.ok(fresh.snapshot().operatorPolicy.backends.every(row => !row.enabled && row.available), 'a fresh confirmed disable covers both backends');
  } finally { fresh.close(); }
});
test('pending backend activation refuses global changes before the first write', async t => {
  const root = await fixture(t), client = await connect(root, 'test'); t.after(() => client.close());
  const pending = 'backends/' + '1'.repeat(20);
  fs.mkdirSync(path.join(root, pending), { recursive: true, mode: 0o700 });
  require('../service-layout.cjs').writeLayout(root, { ...readLayout(root), pending });
  let writes = 0;
  for (const entry of client.entries) {
    const call = entry.client.call.bind(entry.client);
    entry.client.call = (...args) => { if (args[0] === 'operatorAction') writes++; return call(...args); };
  }
  await assert.rejects(client.call('operatorAction', null, 'enabled', true), error => error.uiMessage?.key === 'error.client.operatorBackendListChanged');
  assert.equal(writes, 0); assert.equal(client.snapshot().operatorPolicy.enabled, false);
  assert.equal(fs.existsSync(path.join(root, 'services.lock')), false);
});
// Turning a slot off revokes its creation grants (operator-control settings), so reuse must not do it without a confirmed choice.
async function reuse(t, others) {
  const root = await fixture(t);
  const set = async (key, enabled) => { const c = await connectService(path.join(root, key), 'test'); try { await c.call('operatorAction', null, 'enabled', enabled); } finally { c.close(); } };
  // A slot that holds a session is kept on its own version; an empty one would be upgraded in place.
  const slot = async (digit, version) => {
    const key = 'backends/' + digit.repeat(20), dir = path.join(root, key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ sessions: [{ id: 'retained-' + digit, nativeId: 'synthetic-' + digit, provider: 'claude', state: 'working', name: 'Synthetic ' + digit, messages: [] }], room: { messages: [] }, drafts: {} }), { mode: 0o600 });
    require('../service-layout.cjs').writeLayout(root, { ...readLayout(root), pending: key });
    process.env.NAW_APP_VERSION = version; await ensureService(root, process.execPath);
    assert.equal(readLayout(root).active, key); return key;
  };
  const reused = await slot('1', 'synthetic-next'), third = await slot('2', 'synthetic-third');
  await set(reused, true); await set('.', others[0]); await set(third, others[1]);
  process.env.NAW_APP_VERSION = 'synthetic-next'; await ensureService(root, process.execPath);
  assert.equal(readLayout(root).active, reused, 'the older app reuses its own slot');
  const client = await connectService(path.join(root, reused), 'test');
  try { return (await client.call('initial')).operatorPolicy.enabled; } finally { client.close(); }
}
test('a reused backend keeps its setting while the others disagree', async t => { assert.equal(await reuse(t, [true, false]), true); });
test('a reused backend follows a choice every other backend confirms as off', async t => { assert.equal(await reuse(t, [false, false]), false); });
