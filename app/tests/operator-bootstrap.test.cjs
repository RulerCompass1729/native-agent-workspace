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
// Turning a slot off revokes its creation grants (operator-control settings). "Off" may be only a new slot's default,
// so activating a slot the person already uses never writes it.
const DOMAIN = 'retained-grant';
const reusedStore = (root, key, state) => {
  const dir = path.join(root, key), sessions = [{ id: 'reused', nativeId: 'synthetic-reused', provider: 'claude', state, name: 'Synthetic reused', messages: [] }];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ sessions, room: { messages: [] }, drafts: {} }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'operator-records.json'), JSON.stringify({ version: 1, sequence: 1, enabled: true, sessions: { reused: { enabled: true, nativeId: 'synthetic-reused', enabledAt: 1 } },
    domains: { [DOMAIN]: { id: DOMAIN, initiators: [{ id: 'reused', nativeId: 'synthetic-reused' }], providers: ['claude'], directories: [root], permission: 'default', model: null, daily: 1, concurrent: 1, expiresAt: Date.now() + 3600000, createdAt: 1 } },
    requests: {}, dispatches: {}, actions: {}, reports: {}, calls: {}, audit: [] }), { mode: 0o600 });
};
async function policyOf(root, key) {
  const client = await connectService(path.join(root, key), 'test');
  try { return (await client.call('initial')).operatorPolicy; } finally { client.close(); }
}
async function enable(root, key, enabled) {
  const client = await connectService(path.join(root, key), 'test');
  try { await client.call('operatorAction', null, 'enabled', enabled); } finally { client.close(); }
}
const unchanged = policy => {
  assert.equal(policy.error, null); assert.equal(policy.enabled, true); assert.equal(policy.sessions.reused.enabled, true);
  assert.equal(policy.domains.length, 1); assert.equal(policy.domains[0].id, DOMAIN); assert.equal(policy.domains[0].revokedAt, undefined);
};
test('an ordinary update that reuses an ended slot keeps its choice and its grant while the active backend is off by default', async t => {
  const root = await fixture(t), key = 'backends/' + '1'.repeat(20);
  reusedStore(root, key, 'ended');
  require('../service-layout.cjs').writeLayout(root, { ...readLayout(root), entries: ['.', key] });
  process.env.NAW_APP_VERSION = 'synthetic-old'; await ensureService(root, process.execPath);
  assert.equal(readLayout(root).active, '.'); unchanged(await policyOf(root, key));
  assert.equal((await policyOf(root, '.')).enabled, false);
  process.env.NAW_APP_VERSION = 'synthetic-next'; await ensureService(root, process.execPath);
  assert.equal(readLayout(root).active, key, 'the update reuses the ended slot');
  unchanged(await policyOf(root, key)); assert.equal((await policyOf(root, '.')).enabled, false);
});
for (const others of [[false, false], [true, false], [true, true]]) test('an older app that reuses its own slot changes nothing in it, others ' + others.join('/'), async t => {
  const root = await fixture(t), write = key => require('../service-layout.cjs').writeLayout(root, { ...readLayout(root), pending: key });
  const reused = 'backends/' + '1'.repeat(20), third = 'backends/' + '2'.repeat(20);
  reusedStore(root, reused, 'working'); write(reused);
  process.env.NAW_APP_VERSION = 'synthetic-next'; await ensureService(root, process.execPath);
  assert.equal(readLayout(root).active, reused);
  const dir = path.join(root, third); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ sessions: [{ id: 'third', nativeId: 'synthetic-third', provider: 'claude', state: 'working', name: 'Synthetic third', messages: [] }], room: { messages: [] }, drafts: {} }), { mode: 0o600 });
  write(third); process.env.NAW_APP_VERSION = 'synthetic-third'; await ensureService(root, process.execPath);
  assert.equal(readLayout(root).active, third);
  await enable(root, reused, true); await enable(root, '.', others[0]); await enable(root, third, others[1]);
  process.env.NAW_APP_VERSION = 'synthetic-next'; await ensureService(root, process.execPath);
  assert.equal(readLayout(root).active, reused, 'the older app reuses its own slot');
  assert.equal((await policyOf(root, reused)).enabled, true);
  assert.deepEqual([(await policyOf(root, '.')).enabled, (await policyOf(root, third)).enabled], others);
});
for (const second of [true, false]) test('a pending slot left on by a failed activation is on only while every other backend is, second ' + second, async t => {
  const root = await fixture(t), other = 'backends/' + '1'.repeat(20), key = 'backends/' + '2'.repeat(20);
  await enable(root, '.', true);
  reusedStore(root, other, 'working');
  require('../service-layout.cjs').writeLayout(root, { ...readLayout(root), entries: ['.', other] });
  await ensureService(root, process.execPath); await enable(root, other, second);
  fs.mkdirSync(path.join(root, key), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, key, 'operator-records.json'), JSON.stringify({ version: 1, sequence: 1, enabled: true, sessions: {}, domains: {}, requests: {}, dispatches: {}, actions: {}, reports: {}, calls: {}, audit: [] }), { mode: 0o600 });
  require('../service-layout.cjs').writeLayout(root, { ...readLayout(root), pending: key });
  process.env.NAW_APP_VERSION = 'synthetic-next'; await ensureService(root, process.execPath);
  assert.equal(readLayout(root).active, key); assert.equal((await policyOf(root, key)).enabled, second);
  assert.equal((await policyOf(root, '.')).enabled, true); assert.equal((await policyOf(root, other)).enabled, second);
});
