// B3 acceptance (b3-spec.md section 4): automatic Codex qualification by comparing the
// part of the app-server schema NAW uses. Stored snapshots only; no model, no provider.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const surface = require('../codex-surface.cjs'), q = require('../codex-qualification.cjs');
const baseline = () => surface.unpack(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex-surface', '0.167.0.json'), 'utf8')));
const fixture166 = () => surface.unpack(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-surface-0.166.0.json'), 'utf8')));
const allOpen = Object.fromEntries(Object.keys(surface.MANIFEST).map(c => [c, true]));
const newVersion = (mutate, version = '0.999.0') => { const s = baseline(); s.version = version; mutate(s); return s; };

test('1. the real 0.166 -> 0.167 change opens every capability and records only the approval change', () => {
  const d = surface.decide(fixture166(), baseline());
  assert.deepEqual(d.capabilities, allOpen);
  // 0.167 added the humanCommand approval kind (opt-in via requiredHumanApproval); NAW relays approvals, so a person looks.
  assert.deepEqual(d.records, [{ kind: 'permission-surface-changed', entry: 'ServerRequest:item/commandExecution/requestApproval' }]);
});

test('2. a version that changes only what NAW does not depend on is opened with no record', () => {
  const s = newVersion(s => {
    const steer = s.entries['ClientRequest:turn/steer'];
    steer.definitions.TurnSteerParams.properties.futureOption = { type: ['boolean', 'null'] }; // new optional field NAW never sends
    steer.definitions.TurnSteerParams.title = 'Renamed title'; // titles and descriptions are not contract
    s.entries['ClientRequest:thread/items/list'].response.root.properties.futureCount = { type: 'integer' }; // new optional field NAW never reads
  });
  const d = surface.decide(baseline(), s);
  assert.deepEqual(d.capabilities, allOpen); assert.deepEqual(d.records, []);
});

test('3. a version that changes a field NAW uses closes only the capabilities that use it and records why', () => {
  const steer = newVersion(s => {
    const params = s.entries['ClientRequest:turn/steer'].definitions.TurnSteerParams;
    delete params.properties.expectedTurnId; params.required = params.required.filter(r => r !== 'expectedTurnId');
  });
  let d = surface.decide(baseline(), steer);
  assert.deepEqual(d.capabilities, { ...allOpen, steer: false });
  assert.deepEqual(d.records, [{ kind: 'capability-held', capability: 'steer', entries: ['ClientRequest:turn/steer'] }]);

  const history = newVersion(s => { s.entries['ClientRequest:thread/items/list'].response.root.properties.nextCursor = { type: 'integer' }; });
  d = surface.decide(baseline(), history);
  assert.deepEqual(d.capabilities, { ...allOpen, history: false });
  assert.equal(d.records.length, 1); assert.equal(d.records[0].capability, 'history');

  // A new kind of thread item is a new variant of one shared type, so it reaches every capability
  // that reads items (history, live turns, thread start/resume, capacity); only the message tool is untouched.
  // Until a test proves a reader ignores unknown item types, a new variant counts as touched (b3-spec 1.4).
  const items = newVersion(s => {
    const union = s.entries['ServerNotification:item/started'].definitions.ThreadItem;
    (union.oneOf || union.anyOf).push({ type: 'object', title: 'FutureItem', properties: { type: { enum: ['futureItem'], type: 'string' } } });
  });
  d = surface.decide(baseline(), items);
  assert.deepEqual(d.capabilities, { history: false, steer: false, terminalBridge: false, spaceImages: false, addressedTool: true, capacity: false });
  assert.deepEqual(d.records.map(r => r.capability).sort(), ['capacity', 'history', 'spaceImages', 'steer', 'terminalBridge']);
});

test('a new server request type is a permission record, never a closed gate', () => {
  const s = newVersion(s => { s.serverRequests = [...s.serverRequests, 'item/future/requestApproval'].sort(); });
  const d = surface.decide(baseline(), s);
  assert.deepEqual(d.capabilities, allOpen);
  assert.deepEqual(d.records, [{ kind: 'permission-surface-changed', entry: 'ServerRequest:item/future/requestApproval', added: true }]);
});

test('4. an undecidable version keeps its gates closed and is retried on the next start', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-codex-qualify-'));
  t.after(() => { q.setAutomatic({}); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'codex-qualification.json');
  const failing = path.join(dir, 'codex'); fs.writeFileSync(failing, '#!/bin/sh\nexit 3\n', { mode: 0o700 });
  q.setAutomatic({});
  const d = await q.qualify({ binary: failing, version: '0.998.0', privateDir: dir, timeoutMs: 5000 });
  assert.deepEqual(d.capabilities, {}); assert.equal(d.records[0].kind, 'undecidable');
  q.record(file, d);
  assert.equal(fs.existsSync(file), false, 'An undecidable result is not persisted');
  for (const capability of q.CAPABILITIES) assert.equal(q.allows(capability, '0.998.0'), false);
  // A binary whose own version differs from the running server's is not judged.
  const other = path.join(dir, 'codex-other'); fs.writeFileSync(other, '#!/bin/sh\necho codex-cli 0.997.1\n', { mode: 0o700 });
  q.setAutomatic({});
  const mismatch = await q.qualify({ binary: other, version: '0.997.0', privateDir: dir, timeoutMs: 5000 });
  assert.match(mismatch.records[0].reason, /binary reports 0\.997\.1, running server reports 0\.997\.0/);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('codex-qualify-')), [], 'Its private work directories are removed');
});

test('a decided version is persisted for its basis and opens only its own capabilities', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-codex-qualify-'));
  t.after(() => { q.setAutomatic({}); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'codex-qualification.json');
  q.setAutomatic({});
  q.record(file, { version: '0.999.0', basis: '0.167.0', capabilities: { ...allOpen, steer: false }, records: [] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  q.setAutomatic({}); q.load(file);
  assert.equal(q.allows('history', '0.999.0'), true); assert.equal(q.allows('steer', '0.999.0'), false);
  // A stored decision made against another baseline or manifest is ignored.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.basisSha = 'other'; fs.writeFileSync(file, JSON.stringify(doc));
  q.setAutomatic({}); q.load(file);
  assert.equal(q.allows('history', '0.999.0'), false);
});

test('only exact versions newer than the baseline are checked automatically', () => {
  q.setAutomatic({});
  for (const v of ['0.168.0', '0.170.2', '1.0.0']) assert.equal(q.needsCheck(v), true, v);
  for (const v of ['0.167.0', '0.166.0', '0.163.0', '0.168.0-rc.1', '0.168', '', null]) assert.equal(q.needsCheck(v), false, String(v));
});

test('5. every Codex method NAW calls is either in the manifest or knowingly ungated', () => {
  // Calls that no version-gated capability depends on; adding a new call means classifying it here.
  const ungated = ['account/rateLimits/read', 'config/mcpServer/reload', 'config/value/write', 'mcpServerStatus/list', 'thread/goal/get',
    'thread/loaded/list', 'thread/unsubscribe', 'turn/interrupt'];
  const manifest = new Set(Object.values(surface.MANIFEST).flat().map(i => i.method));
  const app = path.join(__dirname, '..'), calls = new Set();
  for (const name of fs.readdirSync(app).filter(n => n.endsWith('.cjs'))) {
    for (const m of fs.readFileSync(path.join(app, name), 'utf8').matchAll(/\.call\('([a-zA-Z]+(?:\/[a-zA-Z]+)*)'/g)) if (m[1].includes('/') || m[1] === 'initialize') calls.add(m[1]);
  }
  for (const method of calls) assert.ok(manifest.has(method) || ungated.includes(method), `${method} is neither in the manifest nor knowingly ungated`);
  // Server requests are relayed by pattern, so the permission list must cover the user-input suffix too.
  assert.match(fs.readFileSync(path.join(app, 'adapters.cjs'), 'utf8'), /message\.method\.endsWith\('\/requestUserInput'\)/);
  assert.ok(surface.PERMISSION.includes('item/tool/requestUserInput'));
  for (const method of baseline().serverRequests) assert.ok(surface.PERMISSION.includes(method) || surface.MANIFEST.addressedTool.some(i => i.method === method) || ['account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read'].includes(method), `${method} is not classified`);
});

test('the stored baseline records its provenance', () => {
  const stored = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex-surface', '0.167.0.json'), 'utf8'));
  assert.equal(stored.provenance.license, 'Apache-2.0'); assert.equal(stored.provenance.upstream, 'https://github.com/openai/codex');
  assert.equal(stored.provenance.version, '0.167.0'); assert.match(stored.provenance.binarySha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.version, q.BASELINE);
});
