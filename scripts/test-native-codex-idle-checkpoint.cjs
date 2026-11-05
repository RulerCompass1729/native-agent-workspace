// Bounded native metadata observation. This never grants backend-retirement
// permission and never writes to a real author's thread, settings or input.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const cp = require('node:child_process'), readline = require('node:readline');
const assert = require('node:assert/strict'), { createHash, randomUUID } = require('node:crypto');

const plan = Object.freeze({ engines: 1, savedThreads: 1, metadataRPCs: 30, totalMs: 60000, observationMs: 45000, modelResponses: 0, paidInference: 0, GUI: 0, listeners: 0 });
const reads = new Set(['initialize', 'thread/loaded/list', 'thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list', 'thread/queue/list']);
const hash = data => createHash('sha256').update(data).digest('hex');
const has = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
function option(args, key) { const i = args.indexOf(key); assert.ok(i >= 0 && args[i + 1] && !args[i + 1].startsWith('--'), 'Required option ' + key); return args[i + 1]; }
function validateCall(method, params, state) {
  assert.ok(reads.has(method) || method === 'thread/resume', 'Metadata allowlist: ' + method);
  if (method === 'thread/resume') { assert.equal(state.resumes, 0, 'Only one owned resume'); assert.equal(params.path, state.saved); state.resumes++; }
  if (method.startsWith('thread/') && method !== 'thread/loaded/list') assert.equal(params.threadId, state.threadId, 'Only the copied synthetic thread');
  assert.ok(++state.calls <= plan.metadataRPCs, 'Metadata RPC budget');
}
function goalObservation(result) {
  // A missing property, unsupported method or error must never become null.
  if (!has(result, 'goal')) return { observation: 'unavailable', reason: 'goal property absent' };
  if (result.goal === null) return { observation: 'reported', value: null };
  if (!result.goal || typeof result.goal !== 'object' || typeof result.goal.status !== 'string') return { observation: 'unavailable', reason: 'goal shape unknown' };
  return { observation: 'reported', value: result.goal };
}
function completePage(result) {
  assert.ok(result && Array.isArray(result.data), 'Actual paginated data required');
  assert.ok(has(result, 'nextCursor'), 'Missing cursor is not a completed page');
  assert.ok(result.nextCursor === null || typeof result.nextCursor === 'string', 'Unknown cursor shape');
  return result.nextCursor;
}
function selfTest() {
  const state = () => ({ threadId: 'synthetic', saved: '/synthetic/saved', resumes: 0, calls: 0 });
  for (const method of ['turn/start', 'turn/steer', 'thread/goal/set', 'thread/goal/clear', 'thread/backgroundTerminals/clean']) assert.throws(() => validateCall(method, {}, state()), /allowlist/);
  assert.throws(() => validateCall('thread/read', { threadId: 'another' }, state()), /copied synthetic/);
  const bounded = state(); bounded.calls = 30; assert.throws(() => validateCall('thread/loaded/list', {}, bounded), /budget/);
  const once = state(); validateCall('thread/resume', { threadId: 'synthetic', path: '/synthetic/saved' }, once); assert.throws(() => validateCall('thread/resume', { threadId: 'synthetic', path: '/synthetic/saved' }, once), /one owned resume/);
  assert.equal(goalObservation({}).observation, 'unavailable'); assert.deepEqual(goalObservation({ goal: null }), { observation: 'reported', value: null });
  assert.throws(() => completePage({ data: [] }), /Missing cursor/); assert.equal(completePage({ data: [], nextCursor: null }), null);
  console.log('PASS metadata-only scope, thread identity, one-resume, RPC cap, absent-goal and pagination guards; no engine allocated');
}

async function run(args) {
  assert.ok(args.includes('--run'), 'Use --plan or --self-test; native execution requires --run');
  assert.ok(!process.env.NAW_EVIDENCE_DIR, 'No ambient test-scratch export destination');
  const binary = fs.realpathSync(option(args, '--binary')), fixture = fs.realpathSync(option(args, '--fixture'));
  const evidence = path.resolve(option(args, '--evidence'));
  const expectedBinary = option(args, '--binary-sha256'), expectedFixture = option(args, '--fixture-sha256');
  assert.match(expectedBinary, /^[a-f0-9]{64}$/); assert.match(expectedFixture, /^[a-f0-9]{64}$/);
  assert.equal(hash(fs.readFileSync(binary)), expectedBinary, 'Exact previously qualified native binary');
  const fixtureBytes = fs.readFileSync(fixture); assert.equal(hash(fixtureBytes), expectedFixture, 'Existing owned synthetic saved thread');
  const metadata = fixtureBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'session_meta');
  assert.equal(metadata.length, 1); assert.equal(metadata[0].payload.cli_version, '0.164.0');
  const threadId = metadata[0].payload.id; assert.match(threadId, /^[a-f0-9-]{36}$/);
  assert.notEqual(threadId, option(args, '--original-thread'), 'Never target the original author');
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs');
  const common = cp.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
  try { fs.mkdirSync(slot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('Shared fixture slot occupied; no native engine or profile allocated'); process.exitCode = 75; return; }
  const lease = fs.lstatSync(slot); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T122 metadata-only native idle checkpoint', token, pid: process.pid, at: new Date().toISOString(), plan }));
  let profile, engine, exited = false, timer, fatal, sequence = 0, wireMessages = 0;
  const pending = new Map(), events = [], calls = { threadId, saved: '', calls: 0, resumes: 0 };
  const result = { at: new Date().toISOString(), plan, binarySHA256: expectedBinary, fixtureSHA256: expectedFixture, threadId, snapshots: [], engineAllocations: 0, modelResponsesSupplied: 0, originalAuthorMutationsRequested: 0, listenersOpened: 0 };
  const started = Date.now(), append = (file, value) => fs.appendFileSync(path.join(evidence, file), JSON.stringify(value) + '\n');
  const stop = error => { fatal ||= error; for (const request of pending.values()) request.reject(fatal); pending.clear(); engine?.stdin.end(); };
  const guard = () => { if (fatal) throw fatal; assert.ok(Date.now() - started < plan.observationMs, 'Observation budget'); };
  function rpc(method, params = {}) {
    guard(); validateCall(method, params, calls); assert.ok(++wireMessages <= 30, 'All outbound JSON messages capped');
    const id = ++sequence; append('rpc.jsonl', { at: new Date().toISOString(), id, method, params });
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { pending.delete(id); reject(Error('Metadata RPC timeout: ' + method)); }, 4000);
      pending.set(id, { resolve: value => { clearTimeout(deadline); resolve(value); }, reject: error => { clearTimeout(deadline); reject(error); } });
      engine.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function pages(method) {
    const rows = [], seen = new Set(); let cursor = null;
    do {
      const response = await rpc(method, { threadId, limit: 20, ...(cursor === null ? {} : { cursor }) });
      cursor = completePage(response); rows.push(...response.data);
      if (cursor !== null) { assert.ok(!seen.has(cursor), 'Repeated pagination cursor'); seen.add(cursor); }
    } while (cursor !== null);
    return { rows, paginationComplete: true };
  }
  async function observe(label) {
    const begin = new Date().toISOString(), thread = await rpc('thread/read', { threadId, includeTurns: false });
    assert.equal(thread.thread?.id, threadId); assert.ok(thread.thread.status && typeof thread.thread.status.type === 'string', 'Native status must be present');
    const goal = goalObservation(await rpc('thread/goal/get', { threadId })); assert.equal(goal.observation, 'reported', 'Goal must be positively reported');
    const background = await pages('thread/backgroundTerminals/list'), queue = await pages('thread/queue/list');
    result.snapshots.push({ label, begin, end: new Date().toISOString(), thread, goal, background, queue, atomic: false });
  }
  const clean = scratch.cleanup(async () => { engine?.stdin.end(); });
  try {
    fs.writeFileSync(path.join(evidence, 'admitted.json'), JSON.stringify({ at: result.at, token, parentPid: process.pid, plan }), { flag: 'wx', mode: 0o600 });
    profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-native-idle-')));
    const fixtureHome = path.join(profile, 'home'), nativeConfig = path.join(profile, 'codex');
    for (const directory of [fixtureHome, nativeConfig]) fs.mkdirSync(directory, { mode: 0o700 });
    // Provider-standard home variables are confined to this owned child. The
    // calling author process and global/native configuration are unchanged.
    const env = { PATH: '/usr/bin:/bin', HOME: fixtureHome, CODEX_HOME: nativeConfig, TMPDIR: profile, LANG: 'en_US.UTF-8', RUST_LOG: 'error' };
    const policy = '(version 1)(allow default)(deny network*)(deny mach-lookup (global-name "com.apple.securityd"))(deny file-write*)(allow file-write* (subpath ' + JSON.stringify(profile) + '))(allow file-write* (literal "/dev/null"))';
    result.isolation = { policy, privateEnvironmentKeys: Object.keys(env), credentialFilesCopied: 0, stdioOnly: true };
    const forbidden = path.join(evidence, 'outside-profile-sentinel'); assert.ok(!fs.existsSync(forbidden));
    const healthCode = "const fs=require('fs');try{fs.writeFileSync(process.argv[1],'unexpected');process.exit(3)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e}fs.writeFileSync(process.argv[2],'owned-write-ok');";
    const health = cp.spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '-e', healthCode, forbidden, path.join(profile, 'sandbox-write-ok')], { cwd: profile, env, encoding: 'utf8', timeout: 5000 });
    result.sandboxPreflight = { status: health.status, signal: health.signal, error: health.error?.message, stderr: health.stderr };
    assert.equal(health.status, 0, 'OS policy denies outside-profile writes before native allocation'); assert.ok(!fs.existsSync(forbidden));
    fs.writeFileSync(path.join(nativeConfig, 'config.toml'), 'model="gpt-6-luna"\nmodel_provider="local_fixture"\nmodel_reasoning_effort="low"\ncli_auth_credentials_store="file"\n[features]\ndaemon_auto_start=false\n[model_providers.local_fixture]\nname="Metadata only; no model responder"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n', { flag: 'wx', mode: 0o600 });
    calls.saved = path.join(nativeConfig, 'sessions', '2026', '10', '27', path.basename(fixture)); fs.mkdirSync(path.dirname(calls.saved), { recursive: true, mode: 0o700 });
    fs.copyFileSync(fixture, calls.saved, fs.constants.COPYFILE_EXCL); assert.equal(hash(fs.readFileSync(calls.saved)), expectedFixture);
    timer = setTimeout(() => stop(Error('45-second observation bound; reserve cleanup inside 60 seconds')), Math.max(1, plan.observationMs - (Date.now() - started)));
    engine = scratch.childProcess.spawn('/usr/bin/sandbox-exec', ['-p', policy, binary, '-c', 'model_provider="local_fixture"', '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false', 'app-server', '--listen', 'stdio://'], { cwd: profile, env, stdio: ['pipe', 'pipe', 'pipe'] });
    result.engineAllocations++; result.enginePid = engine.pid;
    fs.writeFileSync(path.join(evidence, 'engine-launch.json'), JSON.stringify({ at: new Date().toISOString(), pid: engine.pid, binary, argv: engine.spawnargs, profile, environmentKeys: Object.keys(env) }, null, 2));
    engine.stderr.on('data', bytes => fs.appendFileSync(path.join(evidence, 'engine-stderr.log'), bytes));
    engine.on('error', stop); engine.on('exit', () => { exited = true; for (const request of pending.values()) request.reject(Error('Owned engine exited')); pending.clear(); });
    readline.createInterface({ input: engine.stdout }).on('line', line => {
      try {
        assert.ok(Buffer.byteLength(line) <= 1024 * 1024, 'Metadata response bound'); const packet = JSON.parse(line); append('native-wire.jsonl', packet);
        if (packet.id !== undefined && pending.has(packet.id)) { const request = pending.get(packet.id); pending.delete(packet.id); packet.error ? request.reject(Error(JSON.stringify(packet.error))) : request.resolve(packet.result); }
        else if (packet.method) {
          events.push(packet);
          if (packet.id !== undefined || /^(error|turn\/(started|completed)|item\/started|item\/completed|item\/.*\/delta)$/.test(packet.method)) stop(Error('Unexpected native work/request: ' + packet.method));
        }
      } catch (error) { stop(error); }
    });
    const initialized = await rpc('initialize', { clientInfo: { name: 'naw_native_idle_checkpoint', version: '1' }, capabilities: { experimentalApi: true } });
    assert.ok(initialized.userAgent.includes('/0.164.0'), 'Exact owned native164 engine'); assert.ok(++wireMessages <= 30); engine.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    result.resume = await rpc('thread/resume', { threadId, path: calls.saved, cwd: profile, excludeTurns: true, model: 'gpt-6-luna', modelProvider: 'local_fixture', approvalPolicy: 'never', sandbox: 'read-only', config: { model_reasoning_effort: 'low' } });
    assert.equal(result.resume.thread.id, threadId); assert.equal(result.resume.modelProvider, 'local_fixture');
    result.loaded = await rpc('thread/loaded/list', {}); assert.deepEqual(result.loaded.data, [threadId], 'Exactly the copied thread is loaded');
    await observe('first'); await observe('second'); guard();
    assert.equal(hash(fs.readFileSync(fixture)), expectedFixture, 'Original archive unchanged');
    result.outcome = 'OWNED_NATIVE_METADATA_OBSERVED_NOT_RETIREMENT_QUALIFICATION';
    result.unproven = ['TUI draft text, attachments and pending paste', 'coverage of every in-memory/background task', 'atomic input-safe checkpoint', 'original author adoption, complete settings or actual backend replacement'];
  } catch (error) { result.outcome = 'NATIVE_METADATA_OBSERVATION_INCOMPLETE'; result.failure = error.stack; process.exitCode = 1; }
  finally {
    clearTimeout(timer); engine?.stdin.end(); const cleanupAt = Date.now();
    try {
      await clean(); assert.ok(!profile || !fs.existsSync(profile)); assert.ok(!engine || exited || engine.exitCode !== null || engine.signalCode !== null);
      assert.ok(Date.now() - started <= plan.totalMs, 'Complete native trial including cleanup stays within 60 seconds');
      const current = fs.lstatSync(slot); assert.equal(current.ino, lease.ino); assert.equal(current.dev, lease.dev); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
      fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      result.cleanup = { seconds: (Date.now() - cleanupAt) / 1000, profileGone: true, engineGone: true, exactLeaseReleased: true, token };
    } catch (error) { result.cleanupFailure = error.stack; process.exitCode = 1; }
    // stdout can deliver a final work/error event while owned cleanup is pending.
    // Such a late event must invalidate the observation, including after guard().
    if (fatal) { result.outcome = 'NATIVE_METADATA_OBSERVATION_INCOMPLETE'; result.failure = fatal.stack; process.exitCode = 1; }
    result.metadataRPCs = calls.calls; result.outboundMessages = wireMessages; result.events = events; result.totalSeconds = (Date.now() - started) / 1000; result.endedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ outcome: result.outcome, metadataRPCs: calls.calls, engineAllocations: result.engineAllocations, totalSeconds: result.totalSeconds, failure: result.failure, cleanup: result.cleanup, cleanupFailure: result.cleanupFailure }));
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--plan')) console.log(JSON.stringify(plan, null, 2));
  else if (args.includes('--self-test')) selfTest();
  else run(args).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { plan, validateCall, goalObservation, completePage };
