const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const functions = source.slice(source.indexOf('const legacyProgress ='), source.indexOf('const inputRecoveries ='));
const tick = () => new Promise(resolve => setImmediate(resolve));
test('legacy bridge needs no observe capability; a new generation rejects old snapshot and lower revision journal is accepted', async () => {
  const pending = [], context = { state: { capabilities: [] }, disconnected: false, mode: 'chat', activeSessionId: () => 's', render() {},
    api: { observe: () => new Promise(resolve => pending.push(resolve)) } };
  vm.createContext(context); vm.runInContext(functions + ';globalThis.read = readLegacyProgress; globalThis.rows = sessionMessages; globalThis.update = updateLegacyProgress;', context);
  const old = { id: 's', nativeId: 'old', connectionRevision: 1, legacyProgress: true, serviceCapabilities: [], messages: [] };
  context.state.sessions = [old]; context.read(old); assert.equal(pending.length, 1);
  context.update({ id: 's', revision: 100, item: { id: 'old', text: 'OLD' } });
  const next = { ...old, nativeId: 'new', connectionRevision: 2 }; context.state.sessions = [next]; context.read(next); assert.equal(pending.length, 2);
  pending[0]({ progress: { revision: 101, items: [{ id: 'late', text: 'OLD LATE' }] } }); await tick();
  context.update({ id: 's', revision: 1, item: { id: 'new', text: 'NEW LIVE' } });
  pending[1]({ progress: { revision: 0, items: [] } }); await tick();
  assert.equal(context.rows(next).length, 1); assert.equal(context.rows(next)[0].text, 'NEW LIVE');
});
test('an in-flight journal snapshot merges earlier rows with newer live output and reports sequence gaps', async () => {
  let release; const s = { id: 's', nativeId: 'root', legacyProgress: true, messages: [] };
  const context = { state: { capabilities: [], sessions: [s] }, disconnected: false, mode: 'chat', activeSessionId: () => 's', render() {}, api: { observe: () => new Promise(resolve => { release = resolve; }) } };
  vm.createContext(context); vm.runInContext(functions + ';globalThis.read = readLegacyProgress; globalThis.rows = sessionMessages; globalThis.update = updateLegacyProgress;', context);
  context.read(s); context.update({ id: 's', revision: 11, item: { id: 'live', text: 'live' } });
  release({ progress: { revision: 10, items: Array.from({ length: 10 }, (_, i) => ({ id: 'old' + i, text: 'old ' + i })) } }); await tick();
  assert.equal(context.rows(s).length, 11); assert.equal(context.rows(s)[0].text, 'old 0'); assert.equal(context.rows(s).at(-1).text, 'live');
  context.update({ id: 's', revision: 13, item: { id: 'jump', text: 'gap tail' } });
  assert.equal(context.rows(s).at(-1).id, 'legacy-observation-gap');
});

test('legacy disconnect freezes last records, rejects late snapshot/live and re-observes on reconnection', async () => {
  for (const failure of ['global', 'transportDisconnected', 'backendUnavailable', 'state', 'legacyProgress']) {
    const pending = [], s = { id: 's', nativeId: 'root', legacyProgress: true, state: 'working', messages: [] };
    const context = { state: { sessions: [s] }, disconnected: false, mode: 'chat', activeSessionId: () => 's', render() {}, api: { observe: () => new Promise(resolve => pending.push(resolve)) } };
    vm.createContext(context); vm.runInContext(functions + ';globalThis.read = readLegacyProgress; globalThis.rows = sessionMessages; globalThis.update = updateLegacyProgress;', context);
    context.read(s);
    const original = { id: 'tool', text: 'before disconnect', status: 'running' };
    context.update({ id: 's', revision: 1, item: original });
    if (failure === 'global') context.disconnected = true;
    else s[failure] = failure === 'state' ? 'disconnected' : failure !== 'legacyProgress';
    assert.equal(context.rows(s)[0].status, 'unconfirmed'); assert.equal(original.status, 'running');
    context.update({ id: 's', revision: 2, item: { ...original, text: 'late live' } });
    pending[0]({ progress: { revision: 3, items: [{ ...original, text: 'late snapshot' }] } }); await tick();
    assert.equal(context.rows(s)[0].text, 'before disconnect');
    if (failure === 'global') context.disconnected = false;
    else s[failure] = failure === 'state' ? 'working' : failure === 'legacyProgress';
    context.read(s); assert.equal(pending.length, 2); assert.equal(context.rows(s)[0].status, 'unconfirmed');
    pending[1]({ progress: { revision: 0, items: [{ ...original, text: 'fresh snapshot' }] } }); await tick();
    assert.equal(context.rows(s)[0].text, 'fresh snapshot'); assert.equal(context.rows(s)[0].status, 'running');
  }
});
