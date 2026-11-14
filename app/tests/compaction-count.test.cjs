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
