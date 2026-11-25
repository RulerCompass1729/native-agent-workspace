const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const counting = require('../compaction-count.cjs');

const ID = '0f6c2a3e-5b7d-4c1e-9a8b-1234567890ab';
const OTHER = '9d1e2f3a-4b5c-4d6e-8f70-abcdef012345';
const THREAD = '019a7b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b';
const CWD = '/work/repo';

// A Claude compaction as the CLI writes it (key order and fields measured 2026-11-13; values made up).
function claudeCompaction(extra = {}) {
  return JSON.stringify({
    parentUuid: null, logicalParentUuid: 'p-1', isSidechain: false, type: 'system', subtype: 'compact_boundary',
    content: 'Conversation compacted', level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 219000, postTokens: 21000, durationMs: 90000 },
    uuid: 'u-1', timestamp: '2026-11-13T10:00:00.000Z', userType: 'external', entrypoint: 'cli', cwd: CWD,
    sessionId: ID, version: '2.1.0', gitBranch: 'main', slug: 'x', ...extra,
  });
}
function claudeTurn(text) {
  return JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'assistant', sessionId: ID, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
// A Codex compaction line (top-level keys timestamp, ordinal, type, payload, measured in 60 records).
function codexCompaction(ordinal = 7, history = []) {
  return JSON.stringify({ timestamp: '2026-11-13T10:00:00.000Z', ordinal, type: 'compacted', payload: { message: '', replacement_history: history } });
}
function codexTurn(text) {
  return JSON.stringify({ timestamp: '2026-11-13T10:00:01.000Z', ordinal: 8, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
}

function roots(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-compactions-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const claudeRoot = path.join(base, 'claude', 'projects');
  const codexRoot = path.join(base, 'codex', 'sessions');
  const claudeDir = path.join(claudeRoot, CWD.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  return { base, claudeRoot, codexRoot, claudeFile: path.join(claudeDir, `${ID}.jsonl`) };
}
const claude = (extra = {}) => ({ id: 's1', provider: 'claude', nativeId: ID, cwd: CWD, ...extra });
const codex = (extra = {}) => ({ id: 's2', provider: 'codex', nativeId: THREAD, cwd: CWD, ...extra });

test('a Claude record counts only its own main conversation\'s compactions, not a mention, a subagent\'s or another session\'s', async t => {
  const r = roots(t);
  fs.writeFileSync(r.claudeFile, [
    claudeTurn('starting'),
    claudeCompaction(),
    // Quoted in a reply: inside a string the quotes are escaped, so the marker does not match.
    claudeTurn('the record says {"type":"system","subtype":"compact_boundary"}'),
    claudeCompaction({ isSidechain: true }),
    claudeCompaction({ sessionId: OTHER }),
    claudeCompaction({ type: 'user' }),
    '{"subtype":"compact_boundary", not json',
    claudeCompaction({ compactMetadata: { trigger: 'manual', preTokens: 50000 } }),
    '',
  ].join('\n'));
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot });
  assert.deepEqual([...await counter.sample([claude()], 0)], [['s1', 2]], 'the automatic and the manual one');
});

test('appended compactions are counted on the next pass from where the last stopped; a line still being written waits', async t => {
  const r = roots(t);
  fs.writeFileSync(r.claudeFile, `${claudeTurn('one')}\n${claudeCompaction()}\n`);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 30000 });
  assert.equal((await counter.sample([claude()], 0)).get('s1'), 1);
  const line = claudeCompaction();
  fs.appendFileSync(r.claudeFile, line.slice(0, 40));
  assert.equal((await counter.sample([claude()], 10000)).get('s1'), 1, 'within the sample interval the last counts stand');
  assert.equal((await counter.sample([claude()], 30000)).get('s1'), 1, 'half a line is not a compaction yet');
  const offset = counter.states.get('s1').offset;
  assert.equal(offset, fs.statSync(r.claudeFile).size - 40, 'the half line is read again, not skipped');
  fs.appendFileSync(r.claudeFile, `${line.slice(40)}\n${claudeTurn('two')}\n${claudeCompaction()}\n`);
  assert.equal((await counter.sample([claude()], 60000)).get('s1'), 3);
  assert.equal(counter.states.get('s1').offset, fs.statSync(r.claudeFile).size);
});

test('a record replaced or cut shorter is counted again from its start', async t => {
  const r = roots(t);
  fs.writeFileSync(r.claudeFile, `${claudeCompaction()}\n${claudeCompaction()}\n${claudeCompaction()}\n`);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0 });
  assert.equal((await counter.sample([claude()], 0)).get('s1'), 3);
  fs.writeFileSync(r.claudeFile, `${claudeCompaction()}\n`);
  assert.equal((await counter.sample([claude()], 1)).get('s1'), 1, 'shorter than where reading stopped');
  const replacement = `${r.claudeFile}.new`;
  fs.writeFileSync(replacement, `${claudeTurn('fresh conversation, longer than the old one '.repeat(20))}\n`);
  fs.renameSync(replacement, r.claudeFile);
  assert.equal((await counter.sample([claude()], 2)).get('s1'), 0, 'another file at the same path');
  // The session's native conversation changed (another native id): its own record is read instead.
  const next = path.join(path.dirname(r.claudeFile), `${OTHER}.jsonl`);
  fs.writeFileSync(next, `${claudeCompaction({ sessionId: OTHER })}\n`);
  assert.equal((await counter.sample([claude({ nativeId: OTHER })], 3)).get('s1'), 1);
});

test('a large first read is spread over passes under the byte budget and every session still advances', async t => {
  const r = roots(t);
  const filler = claudeTurn('x'.repeat(1000));
  const lines = [];
  for (let index = 0; index < 400; index += 1) lines.push(index % 100 === 99 ? claudeCompaction() : filler);
  fs.writeFileSync(r.claudeFile, `${lines.join('\n')}\n`);
  const size = fs.statSync(r.claudeFile).size;
  const second = path.join(r.claudeRoot, CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${OTHER}.jsonl`);
  fs.writeFileSync(second, `${claudeCompaction({ sessionId: OTHER })}\n`);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0,
    passBytes: 100 * 1024, readBytes: 100 * 1024, lineCap: 8 * 1024 });
  const sessions = [claude(), claude({ id: 's3', nativeId: OTHER })];
  const seen = [];
  for (let pass = 0; pass < 10 && (seen.at(-1)?.get('s1') ?? 0) < 4; pass += 1) {
    seen.push(await counter.sample(sessions, pass));
    assert.ok(counter.states.get('s1').offset <= size);
  }
  assert.ok(seen.length >= 4, `the 400 KB record took ${seen.length} passes of 100 KB`);
  assert.equal(seen[1].get('s3'), 1, 'the other session is read on the next pass, not once the large one is done');
  const counts = seen.map(map => map.get('s1'));
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), 'a count catching up only grows');
  assert.equal(counts.at(-1), 4);
  assert.equal(seen.at(-1).get('s3'), 1, 'the other session was read as well');
});

test('a line longer than the cap is skipped unread, and the lines after it are still counted', async t => {
  const r = roots(t);
  fs.writeFileSync(r.claudeFile, `${claudeCompaction()}\n${claudeTurn('y'.repeat(50 * 1024))}\n${claudeCompaction()}\n`);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0,
    passBytes: 20 * 1024, readBytes: 20 * 1024, lineCap: 16 * 1024 });
  let counts;
  for (let pass = 0; pass < 8; pass += 1) counts = await counter.sample([claude()], pass);
  assert.equal(counts.get('s1'), 2);
  assert.equal(counter.states.get('s1').offset, fs.statSync(r.claudeFile).size);
  assert.equal(counter.states.get('s1').skipping, false);
});

test('a Codex record is found by its thread id among the day folders and counts its top-level compactions', async t => {
  const r = roots(t);
  const day = path.join(r.codexRoot, '2026', '11', '13');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(path.join(r.codexRoot, '2026', '11', '12'), { recursive: true });
  fs.writeFileSync(path.join(r.codexRoot, '2026', '11', '12', `rollout-2026-11-12T09-00-00-${OTHER}.jsonl`), `${codexCompaction()}\n`);
  const file = path.join(day, `rollout-2026-11-13T08-30-00-${THREAD}.jsonl`);
  // A compaction's own history holds earlier items, some of them compactions: only the top-level line counts.
  const nested = [{ type: 'compacted', payload: {} }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '{"type":"compacted"}' }] }];
  // An event whose payload names a compaction is not one either.
  const event = JSON.stringify({ timestamp: '2026-11-13T10:00:03.000Z', ordinal: 4, type: 'event_msg', payload: { type: 'compacted', message: '' } });
  fs.writeFileSync(file, [codexTurn('hello'), codexCompaction(3, nested), codexTurn('"type":"compacted","payload":'), event,
    JSON.stringify({ timestamp: '2026-11-13T10:00:02.000Z', type: 'compacted', payload: {} }), ''].join('\n'));
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0 });
  assert.deepEqual([...await counter.sample([codex()], 0)], [['s2', 2]], 'with and without an ordinal');
  fs.appendFileSync(file, `${codexCompaction(9)}\n`);
  assert.equal((await counter.sample([codex()], 1)).get('s2'), 3);
});

test('a record not there yet gives no count and is looked for again later; a session that leaves is forgotten', async t => {
  const r = roots(t);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0, missingRetryMs: 600000 });
  assert.equal((await counter.sample([claude(), codex()], 0)).size, 0);
  const day = path.join(r.codexRoot, '2026', '11', '13');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-13T08-30-00-${THREAD}.jsonl`), `${codexCompaction()}\n`);
  fs.writeFileSync(r.claudeFile, `${claudeCompaction()}\n`);
  const soon = await counter.sample([claude(), codex()], 1000);
  assert.equal(soon.get('s1'), 1, 'a Claude record is at a known path');
  assert.equal(soon.has('s2'), false, 'the Codex folders are not walked again within ten minutes');
  assert.equal((await counter.sample([claude(), codex()], 600001)).get('s2'), 1);
  await counter.sample([codex()], 600002);
  assert.equal(counter.states.has('s1'), false);
  // Other providers and sessions without a native id are never read.
  const none = await counter.sample([{ id: 'x', provider: 'shell', nativeId: ID, cwd: CWD }, claude({ id: 'y', nativeId: '' })], 600003);
  assert.equal(none.size, 0);
});

test('review note 4: a rollout found but not readable waits like one not found; a Codex session that leaves is forgotten', async t => {
  const r = roots(t);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0, missingRetryMs: 600000 });
  const day = path.join(r.codexRoot, '2026', '11', '13');
  fs.mkdirSync(day, { recursive: true });
  const first = path.join(day, `rollout-2026-11-13T08-30-00-${THREAD}.jsonl`);
  fs.writeFileSync(first, `${codexCompaction()}\n`);
  assert.equal((await counter.sample([codex()], 0)).get('s2'), 1);
  // The rollout goes away and the thread's record turns up on another day: not walked for again within ten minutes.
  fs.rmSync(first);
  const later = path.join(r.codexRoot, '2026', '11', '14');
  fs.mkdirSync(later, { recursive: true });
  fs.writeFileSync(path.join(later, `rollout-2026-11-14T08-30-00-${THREAD}.jsonl`), `${codexCompaction()}\n${codexCompaction()}\n`);
  assert.equal((await counter.sample([codex()], 1000)).has('s2'), false, 'the open failure');
  assert.equal((await counter.sample([codex()], 2000)).has('s2'), false, 'the next pass does not walk the folders');
  assert.equal((await counter.sample([codex()], 601001)).get('s2'), 2, 'after the wait it is found again');
  assert.equal(counter.codexFiles.size, 1);
  await counter.sample([claude()], 601002);
  assert.equal(counter.codexFiles.size, 0, 'a Codex session no longer listed is forgotten');
});

test('the default record folders follow the CLIs\' own settings', () => {
  const counter = new counting.CompactionCounter({ env: { CLAUDE_CONFIG_DIR: '/work/claude-config', CODEX_HOME: '/work/codex-home' } });
  assert.equal(counter.claudeRoot, '/work/claude-config/projects');
  assert.equal(counter.codexRoot, '/work/codex-home/sessions');
  const plain = new counting.CompactionCounter({ env: {} });
  assert.equal(plain.claudeRoot, path.join(os.homedir(), '.claude', 'projects'));
  assert.equal(plain.codexRoot, path.join(os.homedir(), '.codex', 'sessions'));
});

test('a Claude record is found where the CLI reported it, or under the folder as resolved, as claude-pin looks', async t => {
  const r = roots(t);
  // The session's folder as stored is a link; the CLI names the record folder after the resolved one.
  const real = path.join(r.base, 'real-repo'), link = path.join(r.base, 'linked-repo');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const resolvedDir = path.join(r.claudeRoot, fs.realpathSync(real).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(resolvedDir, { recursive: true });
  fs.writeFileSync(path.join(resolvedDir, `${ID}.jsonl`), `${claudeCompaction()}\n`);
  assert.deepEqual([...(await new counting.CompactionCounter({ claudeRoot: r.claudeRoot }).sample([claude({ cwd: link })], 0))], [['s1', 1]]);
  // A record the CLI reported elsewhere (a folder name too long is shortened by the CLI) is read there.
  const reportedDir = path.join(r.claudeRoot, 'shortened-1a2b3c');
  fs.mkdirSync(reportedDir);
  const reported = path.join(reportedDir, `${ID}.jsonl`);
  fs.writeFileSync(reported, `${claudeCompaction()}\n${claudeCompaction()}\n`);
  assert.deepEqual([...(await new counting.CompactionCounter({ claudeRoot: r.claudeRoot }).sample([claude({ cwd: link, nativeTranscript: reported })], 0))], [['s1', 2]]);
  // A reported path that is not this session's record, or not absolute, is not used.
  fs.writeFileSync(path.join(reportedDir, `${OTHER}.jsonl`), `${claudeCompaction()}\n${claudeCompaction()}\n${claudeCompaction()}\n`);
  for (const nativeTranscript of [path.join(reportedDir, `${OTHER}.jsonl`), `shortened-1a2b3c/${ID}.jsonl`]) {
    assert.deepEqual([...(await new counting.CompactionCounter({ claudeRoot: r.claudeRoot }).sample([claude({ cwd: link, nativeTranscript })], 0))], [['s1', 1]]);
  }
  assert.deepEqual(await counting.claudeFiles(r.claudeRoot, claude({ cwd: link, nativeTranscript: reported })),
    [reported, path.join(r.claudeRoot, link.replace(/[^a-zA-Z0-9]/g, '-'), `${ID}.jsonl`), path.join(resolvedDir, `${ID}.jsonl`)]);
});

// A Claude request's usage as the CLI writes it on each assistant line (fields measured 2026-11-24; values made up).
function claudeUsage({ read = 0, write1h = 0, write5m = 0, input = 2, at = '2026-11-24T10:00:00.000Z', ...extra } = {}) {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: false, type: 'assistant', sessionId: ID, timestamp: at,
    message: {
      role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: input, cache_creation_input_tokens: write1h + write5m, cache_read_input_tokens: read, output_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write5m } },
    },
    ...extra,
  });
}
const AT = Date.parse('2026-11-24T10:00:00.000Z');
async function contextOf(t, lines) {
  const r = roots(t);
  fs.writeFileSync(r.claudeFile, [...lines, ''].join('\n'));
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0 });
  await counter.sample([claude()], 0);
  return { counter, file: r.claudeFile, context: () => counter.contexts.get('s1') };
}

test('the context size, time and cache lifetime come from the session\'s own last request', async t => {
  const { counter, file, context } = await contextOf(t, [
    claudeUsage({ read: 100000, write1h: 500 }),
    claudeUsage({ read: 181000, write1h: 900, input: 3 }),
  ]);
  assert.deepEqual(context(), { tokens: 181903, at: AT, ttlMs: 60 * 60000 });
  fs.appendFileSync(file, `${claudeUsage({ read: 190000, write5m: 100, at: '2026-11-24T10:05:00.000Z' })}\n`);
  await counter.sample([claude()], 1);
  assert.deepEqual(context(), { tokens: 190102, at: AT + 5 * 60000, ttlMs: 5 * 60000 }, 'a five-minute write (over the plan, or a changed policy)');
  fs.appendFileSync(file, `${claudeUsage({ read: 190200, at: '2026-11-24T10:06:00.000Z' })}\n`);
  await counter.sample([claude()], 2);
  assert.deepEqual(context(), { tokens: 190202, at: AT + 6 * 60000, ttlMs: 5 * 60000 }, 'a request that wrote nothing keeps the lifetime last seen');
});

test('a subagent\'s, another session\'s, a synthetic or a malformed line is not the session\'s context', async t => {
  const own = claudeUsage({ read: 150000, write1h: 10 });
  const { context } = await contextOf(t, [
    own,
    claudeUsage({ read: 900000, write1h: 10, isSidechain: true }),
    claudeUsage({ read: 900000, write1h: 10, sessionId: OTHER }),
    claudeUsage({ read: 900000, write1h: 10, type: 'user' }),
    claudeUsage({ read: 900000, write1h: 10, message: { model: '<synthetic>', usage: { cache_read_input_tokens: 900000, input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    claudeUsage({ read: 900000, write1h: 10, at: 'not a time' }),
    claudeUsage({ read: -1, write1h: 10 }),
    claudeUsage({ read: 0, input: 0 }),
    claudeTurn('quoting "cache_read_input_tokens":900000 in a reply'),
    '{"cache_read_input_tokens" not json',
  ]);
  assert.deepEqual(context(), { tokens: 150012, at: AT, ttlMs: 60 * 60000 });
});

test('a compaction forgets the size before it; a record replaced is read again; a lifetime never seen stays unknown', async t => {
  const { counter, file, context } = await contextOf(t, [claudeUsage({ read: 200000, write1h: 10 }), claudeCompaction()]);
  assert.equal(context(), undefined, 'nothing was requested since the compaction');
  fs.appendFileSync(file, `${claudeUsage({ read: 20000, write1h: 60000 })}\n`);
  await counter.sample([claude()], 1);
  assert.equal(context().tokens, 80002);
  fs.appendFileSync(file, `${claudeUsage({ read: 90000, write1h: 10 })}\n${claudeCompaction()}\n${claudeUsage({ read: 21000, write1h: 10 })}\n`);
  await counter.sample([claude()], 2);
  assert.equal(context().tokens, 21012, 'the last request after the compaction in one read');
  fs.writeFileSync(file, `${claudeUsage({ read: 5000 })}\n`);
  await counter.sample([claude()], 3);
  assert.deepEqual(context(), { tokens: 5002, at: AT, ttlMs: null });
  await counter.sample([], 4);
  assert.equal(counter.contexts.size, 0, 'a session that leaves is forgotten');
});

test('the lifetime is the last one written at, the shorter when a request wrote both, also when one read holds several requests', async t => {
  const { counter, file, context } = await contextOf(t, [claudeUsage({ read: 1000, write1h: 10 })]);
  fs.appendFileSync(file, `${claudeUsage({ read: 2000, write5m: 10 })}\n${claudeUsage({ read: 3000 })}\n${claudeUsage({ read: 4000 })}\n`);
  await counter.sample([claude()], 1);
  assert.deepEqual(context(), { tokens: 4002, at: AT, ttlMs: 5 * 60000 }, 'not the hour of the read before');
  fs.appendFileSync(file, `${claudeUsage({ read: 5000, write1h: 900, write5m: 10 })}\n`);
  await counter.sample([claude()], 2);
  assert.equal(context().ttlMs, 5 * 60000);
  fs.appendFileSync(file, `${claudeUsage({ read: 6000, write1h: 10 })}\n`);
  await counter.sample([claude()], 3);
  assert.equal(context().ttlMs, 60 * 60000);
});

test('a compaction read on its own forgets the size from the read before', async t => {
  const { counter, file, context } = await contextOf(t, [claudeUsage({ read: 200000, write1h: 10 })]);
  assert.equal(context().tokens, 200012);
  fs.appendFileSync(file, `${claudeCompaction()}\n`);
  await counter.sample([claude()], 1);
  assert.equal(context(), undefined);
});

test('a Codex record gives no context size: what its rotation saves is not measured', async t => {
  const r = roots(t);
  const day = path.join(r.codexRoot, '2026', '11', '24');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-24T10-00-00-${THREAD}.jsonl`),
    `${codexCompaction()}\n${JSON.stringify({ timestamp: '2026-11-24T10:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 300000, cached_input_tokens: 1 } } } })}\n`);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot });
  assert.equal((await counter.sample([codex()], 0)).get('s2'), 1);
  assert.equal(counter.contexts.has('s2'), false);
});

// One record's lines read whole, and again a piece at a time, each piece a pass.
async function pieces(t, lines, cuts) {
  const r = roots(t), contents = `${lines.join('\n')}\n`;
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0 });
  let from = 0, pass = 0;
  for (const to of [...cuts, contents.length]) {
    fs.appendFileSync(r.claudeFile, contents.slice(from, to));
    from = to;
    await counter.sample([claude()], pass += 1);
  }
  return counter.contexts.get('s1');
}

test('a size is given only by a pass that reads to the end of the record: not one from before a compaction further on', async t => {
  const r = roots(t);
  fs.writeFileSync(r.claudeFile, [
    claudeUsage({ read: 189500, write1h: 500, input: 0 }),
    claudeTurn('padding'.repeat(400)),
    claudeCompaction(),
    claudeUsage({ input: 20000 }), '',
  ].join('\n'));
  const size = fs.statSync(r.claudeFile).size;
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0, readBytes: 1024, lineCap: 768, passBytes: 1024 });
  let passes = 0;
  for (; passes < 20; passes += 1) {
    await counter.sample([claude()], passes);
    if (counter.states.get('s1').offset === size) break;
    assert.equal(counter.contexts.has('s1'), false, `pass ${passes} stopped before the end`);
  }
  assert.ok(passes > 1 && passes < 20);
  assert.equal(counter.contexts.get('s1').tokens, 20000);
  assert.equal(counter.last.counts.get('s1'), 1);
});

test('a record the pass had no budget left to read gives no size, though its size was known; its count stays', async t => {
  const r = roots(t);
  const other = path.join(path.dirname(r.claudeFile), `${OTHER}.jsonl`);
  fs.writeFileSync(r.claudeFile, `${claudeCompaction()}\n${claudeUsage({ read: 189500, write1h: 500, input: 0 })}\n`);
  fs.writeFileSync(other, '');
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0, readBytes: 1024, lineCap: 768, passBytes: 1024 });
  const sessions = [claude(), claude({ id: 's3', nativeId: OTHER })];
  await counter.sample(sessions, 0);
  await counter.sample(sessions, 1);
  assert.equal(counter.contexts.get('s1').tokens, 190000);
  fs.appendFileSync(other, `${claudeTurn('padding'.repeat(60))}\n`.repeat(8));
  fs.appendFileSync(r.claudeFile, `${claudeCompaction()}\n${claudeUsage({ input: 20000 })}\n`);
  counter.turn = 1;
  const counts = await counter.sample(sessions, 2);
  assert.equal(counter.states.get('s1').offset < fs.statSync(r.claudeFile).size, true, 'the other record spent this pass');
  assert.equal(counter.contexts.has('s1'), false);
  assert.equal(counts.get('s1'), 1);
  for (let pass = 3; pass < 20; pass += 1) await counter.sample(sessions, pass);
  assert.equal(counter.contexts.get('s1').tokens, 20000);
  assert.equal(counter.last.counts.get('s1'), 2);
});

test('a line still being written at the end gives no size until it is whole', async t => {
  const { counter, file, context } = await contextOf(t, [claudeUsage({ read: 189500, write1h: 500, input: 0 })]);
  assert.equal(context().tokens, 190000);
  const line = claudeCompaction();
  fs.appendFileSync(file, line.slice(0, 200));
  await counter.sample([claude()], 1);
  assert.equal(context(), undefined);
  await counter.sample([claude()], 2);
  assert.equal(context(), undefined, 'nothing new was written');
  fs.appendFileSync(file, line.slice(200));
  await counter.sample([claude()], 3);
  assert.equal(context(), undefined, 'whole but for its newline');
  fs.appendFileSync(file, `\n${claudeUsage({ input: 20000 })}\n`);
  await counter.sample([claude()], 4);
  assert.equal(context().tokens, 20000);
  assert.equal(counter.last.counts.get('s1'), 1);
});

test('a line longer than the cap gives no size while it is being skipped', async t => {
  const r = roots(t);
  fs.writeFileSync(r.claudeFile, `${claudeUsage({ read: 189500, write1h: 500, input: 0 })}\n`);
  const counter = new counting.CompactionCounter({ claudeRoot: r.claudeRoot, codexRoot: r.codexRoot, sampleMs: 0, readBytes: 4096, lineCap: 2048, passBytes: 4096 });
  await counter.sample([claude()], 0);
  assert.equal(counter.contexts.get('s1').tokens, 190000);
  fs.appendFileSync(r.claudeFile, 'y'.repeat(3000));
  await counter.sample([claude()], 1);
  const state = counter.states.get('s1');
  assert.equal(state.skipping, true);
  assert.equal(state.offset, fs.statSync(r.claudeFile).size);
  assert.equal(counter.contexts.has('s1'), false, 'every byte is read, its last line is not whole');
  await counter.sample([claude()], 2);
  assert.equal(counter.contexts.has('s1'), false);
  fs.appendFileSync(r.claudeFile, '\n');
  await counter.sample([claude()], 3);
  assert.equal(counter.contexts.get('s1').tokens, 190000);
});

test('a request that neither read nor wrote the cache has no lifetime: none from before it is kept or looked for', async t => {
  const hour = claudeUsage({ write1h: 190000, input: 0, at: '2026-11-24T08:00:00.000Z' });
  const uncached = claudeUsage({ input: 190000 });
  const { counter, file, context } = await contextOf(t, [hour]);
  assert.equal(context().ttlMs, 60 * 60000);
  fs.appendFileSync(file, `${uncached}\n`);
  await counter.sample([claude()], 1);
  assert.deepEqual(context(), { tokens: 190000, at: AT, ttlMs: null }, 'in the next read');
  assert.deepEqual((await contextOf(t, [hour, uncached])).context(), { tokens: 190000, at: AT, ttlMs: null }, 'both in one read');
  // A cache read after it does not bring the lifetime before it back; the next write sets one.
  fs.appendFileSync(file, `${claudeUsage({ read: 190000 })}\n`);
  await counter.sample([claude()], 2);
  assert.equal(context().ttlMs, null);
  assert.equal((await contextOf(t, [hour, uncached, claudeUsage({ read: 190000 })])).context().ttlMs, null);
  fs.appendFileSync(file, `${claudeUsage({ read: 190000, write5m: 10 })}\n`);
  await counter.sample([claude()], 3);
  assert.equal(context().ttlMs, 5 * 60000);
  // A write whose lifetime the record does not say is no uncached request.
  const unsaid = JSON.parse(claudeUsage({ write1h: 190000, input: 0 }));
  delete unsaid.message.usage.cache_creation;
  assert.equal((await contextOf(t, [hour, JSON.stringify(unsaid)])).context().ttlMs, 60 * 60000);
  // A request that only read still keeps it: the read shows that the cache was there.
  assert.equal((await contextOf(t, [hour, claudeUsage({ read: 190000 }), claudeUsage({ read: 190000 })])).context().ttlMs, 60 * 60000);
});

test('a record read whole and one read a piece at a time give the same size and lifetime, those of its last request', async t => {
  // Each line and what it makes of the context before it.
  const kinds = [
    [claudeUsage({ read: 150000, write1h: 10 }), () => ({ tokens: 150012, at: AT, ttlMs: 60 * 60000 })],
    [claudeUsage({ read: 160000, write5m: 10 }), () => ({ tokens: 160012, at: AT, ttlMs: 5 * 60000 })],
    [claudeUsage({ read: 170000 }), before => ({ tokens: 170002, at: AT, ttlMs: before ? before.ttlMs : null })],
    [claudeUsage({ input: 180000 }), () => ({ tokens: 180000, at: AT, ttlMs: null })],
    [claudeCompaction(), () => undefined],
    [claudeTurn('text'), before => before],
    [claudeUsage({ read: 900000, write1h: 10, isSidechain: true }), before => before],
  ];
  let seed = 7;
  const random = limit => (seed = (seed * 1103515245 + 12345) % 2147483648) % limit;
  let uncached = 0;
  for (let round = 0; round < 60; round += 1) {
    const chosen = Array.from({ length: 2 + random(7) }, () => kinds[random(kinds.length)]);
    const lines = chosen.map(([line]) => line);
    const expected = chosen.reduce((before, [, after]) => after(before), undefined);
    const length = `${lines.join('\n')}\n`.length;
    const cuts = [...new Set(Array.from({ length: 1 + random(4) }, () => 1 + random(length - 1)))].sort((a, b) => a - b);
    if (expected && expected.ttlMs === null) uncached += 1;
    assert.deepEqual(await pieces(t, lines, []), expected, JSON.stringify({ round }));
    assert.deepEqual(await pieces(t, lines, cuts), expected, JSON.stringify({ round, cuts }));
  }
  assert.ok(uncached > 5, `${uncached} of the records end without a lifetime`);
});
