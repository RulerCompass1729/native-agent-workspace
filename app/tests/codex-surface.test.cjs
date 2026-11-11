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
  assert.equal(d.records.length, 1); assert.equal(d.records[0].kind, 'capability-held'); assert.equal(d.records[0].capability, 'steer');
  // The record says where the change is, so a person need not rerun the check.
  assert.equal(d.records[0].entries[0].entry, 'ClientRequest:turn/steer');
  assert.ok(d.records[0].entries[0].changes.some(c => /TurnSteerParams/.test(c.at) && /expectedTurnId|required/.test(c.at + c.change)), JSON.stringify(d.records[0].entries[0].changes));

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

test('fields named like annotations, changed defaults and new variants of filtered unions are all seen', () => {
  // A real field called description/title (as in requestUserInput options) is contract, not annotation.
  const withField = newVersion(s => { s.entries['ClientRequest:turn/steer'].definitions.TurnSteerParams.properties.description = { type: 'string' }; }, '0.167.0');
  const changedField = newVersion(s => { s.entries['ClientRequest:turn/steer'].definitions.TurnSteerParams.properties.description = { type: 'integer' }; });
  assert.deepEqual(surface.decide(withField, changedField).capabilities, { ...allOpen, steer: false });
  // A changed default changes what the server does with what NAW leaves out.
  const withDefault = newVersion(s => { s.entries['ClientRequest:turn/steer'].definitions.TurnSteerParams.properties.futureMode = { type: 'string', default: 'a' }; }, '0.167.0');
  const changedDefault = newVersion(s => { s.entries['ClientRequest:turn/steer'].definitions.TurnSteerParams.properties.futureMode = { type: 'string', default: 'b' }; });
  assert.deepEqual(surface.decide(withDefault, changedDefault).capabilities, { ...allOpen, steer: false });
  // A brand-new UserInput variant is invisible after filtering unless its tag is remembered: readers are touched.
  const newInput = newVersion(s => { for (const e of Object.values(s.entries)) for (const part of [e, e.response]) { const u = part?.definitions?.UserInput; if (u) u.nawVariantTags = [...u.nawVariantTags, 'futureInput'].sort(); } });
  const d = surface.decide(baseline(), newInput);
  assert.equal(d.capabilities.steer, false, 'live items carry user input that NAW reads');
  assert.equal(d.capabilities.addressedTool, true);
});

test('extract reads a raw schema bundle, filters unused variants and ignores unused methods', t => {
  // Rebuild a raw bundle (the generator's file layout) from the stored baseline, then change only unused parts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-codex-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stored = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex-surface', '0.167.0.json'), 'utf8'));
  const defs = names => Object.fromEntries(names.map(n => [n, structuredClone(stored.definitions[n])]));
  const files = { ClientRequest: { oneOf: [], definitions: {} }, ServerNotification: { oneOf: [], definitions: {} }, ServerRequest: { oneOf: [], definitions: {} } };
  fs.mkdirSync(path.join(dir, 'v2'));
  for (const [key, e] of Object.entries(stored.entries)) {
    const [schema] = key.split(':');
    files[schema].oneOf.push(structuredClone(e.root)); Object.assign(files[schema].definitions, defs(e.definitions));
    if (e.response) {
      const params = e.root.properties.params.$ref.split('/').pop();
      fs.writeFileSync(path.join(dir, 'v2', params.replace(/Params$/, 'Response') + '.json'), JSON.stringify({ ...e.response.root, definitions: defs(e.response.definitions) }));
    }
  }
  for (const name of stored.serverRequests) if (!files.ServerRequest.oneOf.some(a => a.properties.method.enum[0] === name)) files.ServerRequest.oneOf.push({ properties: { method: { enum: [name] } } });
  const restoreFiltered = def => { if (def?.nawVariantTags) { const tags = def.nawVariantTags; delete def.nawVariantTags; for (const t of tags) if (!(def.oneOf || def.anyOf).some(a => a.properties?.type?.enum?.[0] === t)) (def.oneOf || def.anyOf).push({ type: 'object', properties: { type: { enum: [t], type: 'string' } } }); } };
  for (const f of Object.values(files)) Object.values(f.definitions).forEach(restoreFiltered);
  for (const name of fs.readdirSync(path.join(dir, 'v2'))) { const file = path.join(dir, 'v2', name), doc = JSON.parse(fs.readFileSync(file, 'utf8')); Object.values(doc.definitions).forEach(restoreFiltered); fs.writeFileSync(file, JSON.stringify(doc)); }
  // Unused changes: the audio variant NAW never sends or reads, and a method NAW never calls.
  const audio = (files.ClientRequest.definitions.UserInput.oneOf || files.ClientRequest.definitions.UserInput.anyOf).find(a => a.properties.type.enum[0] === 'audio');
  audio.properties.fileId = { type: 'string' };
  files.ClientRequest.oneOf.push({ properties: { method: { enum: ['future/unused'] }, params: { type: 'object' } }, title: 'Future/unusedRequest' });
  for (const [name, doc] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(doc));
  const candidate = surface.extract(dir, '0.999.0');
  const d = surface.decide(baseline(), candidate);
  assert.deepEqual(d.capabilities, allOpen); assert.deepEqual(d.records, []);
});

test('the stored baseline has every manifest entry and the reply of every request NAW sends', () => {
  const b = baseline();
  for (const items of Object.values(surface.MANIFEST)) for (const i of items) assert.ok(b.entries[`${i.schema}:${i.method}`], `${i.schema}:${i.method}`);
  for (const method of surface.PERMISSION) assert.ok(b.entries[`ServerRequest:${method}`], method);
  for (const [key, e] of Object.entries(b.entries)) if (key.startsWith('ClientRequest:')) assert.ok(e.response, `${key} has its reply`);
  assert.equal(b.serverRequests.length, 11);
});

test('a held capability turns the version status to unverified and travels with it', () => {
  const { codexVersionInfo } = require('../native-history.cjs');
  q.setAutomatic({ '0.999.0': { basis: '0.167.0', capabilities: { ...allOpen, steer: false }, records: [{ kind: 'capability-held' }] } });
  try {
    const info = codexVersionInfo({ nativeVersion: '0.999.0', ws: { readyState: 1 } });
    assert.equal(info.nativeVersionStatus, 'unverified'); assert.deepEqual(info.nativeVersionCheck, { basis: '0.167.0', held: ['steer'], records: 1 });
    q.setAutomatic({ '0.999.0': { basis: '0.167.0', capabilities: allOpen, records: [] } });
    assert.equal(codexVersionInfo({ nativeVersion: '0.999.0', ws: { readyState: 1 } }).nativeVersionStatus, 'verified');
    assert.equal(codexVersionInfo({ nativeVersion: '0.167.0', ws: { readyState: 1 } }).nativeVersionCheck, undefined);
  } finally { q.setAutomatic({}); }
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
  for (const method of baseline().serverRequests) assert.ok(surface.PERMISSION.includes(method) || surface.MANIFEST.addressedTool.some(i => i.method === method), `${method} is not classified`);
  // Every Codex notification NAW names anywhere in its source, in any form (===, case, array),
  // either feeds a gated capability (manifest) or is knowingly display or status only.
  const displayOnly = ['account/rateLimits/updated', 'account/updated', 'error', 'warning', 'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated',
    'item/mcpToolCall/progress', 'item/plan/delta', 'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'serverRequest/resolved',
    'thread/closed', 'thread/goal/cleared', 'thread/goal/updated', 'thread/name/updated', 'thread/settings/updated', 'thread/tokenUsage/updated'];
  const sources = fs.readdirSync(app).filter(n => n.endsWith('.cjs') && n !== 'codex-surface.cjs').map(n => fs.readFileSync(path.join(app, n), 'utf8')).join('\n');
  const names = baseline().serverNotifications; assert.ok(names.length > 50);
  const handled = names.filter(n => sources.includes(`'${n}'`));
  assert.ok(handled.length >= 20, 'The scan finds the notifications NAW handles');
  for (const method of handled) assert.ok(manifest.has(method) || displayOnly.includes(method), `${method} is handled but neither gated nor knowingly display-only`);
  for (const method of displayOnly) assert.ok(handled.includes(method), `${method} is listed as display-only but no longer handled`);
});

test('the stored baseline records its provenance', () => {
  const stored = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex-surface', '0.167.0.json'), 'utf8'));
  assert.equal(stored.provenance.license, 'Apache-2.0'); assert.equal(stored.provenance.upstream, 'https://github.com/openai/codex');
  assert.equal(stored.provenance.version, '0.167.0'); assert.match(stored.provenance.binarySha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.version, q.BASELINE);
});
