const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClaudeSessions, describe, runningRows, typedText, clean, PAGE } = require('../claude-session-list.cjs');

// Rows in the shapes Claude 2.1.327 wrote in a synthetic probe on 2026-11-18; all values are made up.
const A = '0a1b2c3d-1111-4aaa-8bbb-000000000001';
const B = '0a1b2c3d-2222-4aaa-8bbb-000000000002';
const C = '0a1b2c3d-3333-4aaa-8bbb-000000000003';
const QUALIFIED_VERSION = '2.1.327';

function user(id, cwd, content, extra = {}) {
  return { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content }, uuid: 'u-' + id.slice(-4), timestamp: '2026-11-18T10:00:00.000Z', userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: QUALIFIED_VERSION, ...extra };
}
function assistant(id, cwd, text) {
  return { parentUuid: 'u-' + id.slice(-4), isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, cwd, sessionId: id, version: QUALIFIED_VERSION };
}
function write(file, rows, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime, mtime);
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'projects');
  const launcher = path.join(dir, 'claude');
  fs.writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o700 });
  return { dir, root, launcher };
}
function sessions({ root, launcher }, { version = QUALIFIED_VERSION, agents = '[]', calls = [] } = {}) {
  const runCommand = async (file, args) => {
    calls.push(args.join(' '));
    if (args[0] === '--version') return `${version} (Claude Code)\n`;
    if (args[0] === 'agents') {
      if (agents instanceof Error) throw agents;
      return agents;
    }
    throw Error('unexpected command');
  };
  return new ClaudeSessions({ launcher: () => launcher, root, runCommand });
}

test('title is the newest rename, else the generated title, else the first typed message', t => {
  const { root } = fixture(t);
  const cwd = '/work/alpha';
  const file = path.join(root, '-work-alpha', A + '.jsonl');
  const typed = [
    user(A, cwd, '<command-name>/model</command-name>'),
    user(A, cwd, 'Caveat: meta row', { isMeta: true }),
    user(A, cwd, [{ type: 'tool_result', content: 'not typed' }]),
    user(A, cwd, '  Plan the synthetic\nweekend   budget for three people with a long tail of words beyond sixty characters  '),
    assistant(A, cwd, 'Synthetic reply'),
  ];
  write(file, typed);
  assert.deepEqual(describe(file, A, fs.statSync(file).size), { cwd, name: 'Plan the synthetic weekend budget for three people with a lo' });
  write(file, [...typed, { type: 'ai-title', aiTitle: 'Generated synthetic title', sessionId: A }]);
  assert.equal(describe(file, A, fs.statSync(file).size).name, 'Generated synthetic title');
  write(file, [{ type: 'custom-title', customTitle: 'Old name', sessionId: A }, ...typed, { type: 'ai-title', aiTitle: 'Generated synthetic title', sessionId: A }, { type: 'custom-title', customTitle: 'Renamed\u0007 budget', sessionId: A }]);
  assert.equal(describe(file, A, fs.statSync(file).size).name, 'Renamed budget');
});

test('a rename written after a large head is read from the tail; a torn line proves nothing', t => {
  const { root } = fixture(t);
  const cwd = '/work/big';
  const file = path.join(root, '-work-big', A + '.jsonl');
  const filler = { type: 'attachment', attachment: { type: 'synthetic', body: 'x'.repeat(150 * 1024) }, cwd, sessionId: A };
  write(file, [user(A, cwd, 'First synthetic task'), filler, { type: 'custom-title', customTitle: 'Late rename', sessionId: A }]);
  assert.deepEqual(describe(file, A, fs.statSync(file).size), { cwd, name: 'Late rename' });
  fs.appendFileSync(file, '{"type":"custom-title","customTitle":"torn');
  assert.equal(describe(file, A, fs.statSync(file).size).name, 'Late rename');
});

test('rows of another session, or without an absolute folder, are not this session', t => {
  const { root } = fixture(t);
  const file = path.join(root, 'x', A + '.jsonl');
  write(file, [user(B, '/work/other', 'Someone else'), user(A, 'relative/path', 'No folder')]);
  assert.equal(describe(file, A, fs.statSync(file).size), null);
  assert.equal(typedText({ type: 'user', isSidechain: true, message: { role: 'user', content: 'side' } }), null);
  assert.equal(clean(' \n\t '), null);
  assert.equal(clean('一二三四五六七八九十'.repeat(7)).length, 60);
});

test('lists newest first with folder, time and running state from claude agents', async t => {
  const env = fixture(t);
  write(path.join(env.root, '-work-alpha', A + '.jsonl'), [{ type: 'custom-title', customTitle: 'Synthetic Alpha budget', sessionId: A }, user(A, '/work/alpha', 'Alpha task')], new Date('2026-11-18T09:00:00Z'));
  write(path.join(env.root, '-work-beta', B + '.jsonl'), [user(B, '/work/beta', 'Beta task')], new Date('2026-11-18T10:00:00Z'));
  // A subagent transcript and a link are not sessions to continue.
  write(path.join(env.root, '-work-beta', B, 'subagents', C + '.jsonl'), [user(C, '/work/beta', 'Subagent')]);
  fs.symlinkSync(path.join(env.root, '-work-beta', B + '.jsonl'), path.join(env.root, '-work-alpha', C + '.jsonl'));
  const agents = JSON.stringify([
    { pid: 101, cwd: '/work/beta', kind: 'interactive', startedAt: Date.parse('2026-11-18T09:30:00Z'), sessionId: B.toUpperCase(), name: 'beta-a9', status: 'idle' },
    { pid: 102, cwd: '/work/gamma', kind: 'interactive', startedAt: Date.parse('2026-11-18T11:00:00Z'), sessionId: C, name: 'Gamma just opened', status: 'idle' },
    { cwd: '/work/done', kind: 'background', startedAt: 1, sessionId: '0a1b2c3d-4444-4aaa-8bbb-000000000004', name: 'Finished job', state: 'completed' },
    { kind: 'unknown-kind', sessionId: A },
  ]);
  const calls = [];
  const result = await sessions(env, { agents, calls }).list({ search: '' });
  assert.deepEqual(result.data, [
    { nativeId: C, name: 'Gamma just opened', cwd: '/work/gamma', updatedAt: Date.parse('2026-11-18T11:00:00Z') / 1000, running: true },
    { nativeId: B, name: 'Beta task', cwd: '/work/beta', updatedAt: Date.parse('2026-11-18T10:00:00Z') / 1000, running: true },
    { nativeId: A, name: 'Synthetic Alpha budget', cwd: '/work/alpha', updatedAt: Date.parse('2026-11-18T09:00:00Z') / 1000, running: false },
  ]);
  assert.equal(result.nextCursor, null);
  assert.equal(result.skipped, 0);
  assert.equal(result.runningUnknown, undefined);
  assert.deepEqual(calls, ['--version', 'agents --json --all']);
});

test('search matches title or folder, case-insensitively; pages continue with the cursor', async t => {
  const env = fixture(t);
  for (let i = 0; i < PAGE + 5; i++) {
    const id = `0a1b2c3d-5555-4aaa-8bbb-${String(i).padStart(12, '0')}`;
    write(path.join(env.root, '-work-many', id + '.jsonl'), [user(id, i === 3 ? '/work/Special-Folder' : '/work/many', i === 7 ? 'Weekend BUDGET synthetic' : `Task ${i}`)], new Date(Date.UTC(2026, 10, 18, 0, i)));
  }
  const list = sessions(env);
  const first = await list.list({});
  assert.equal(first.data.length, PAGE);
  assert.equal(first.nextCursor, String(PAGE));
  const second = await list.list({ cursor: first.nextCursor });
  assert.equal(second.data.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.data, ...second.data].map(row => row.nativeId)).size, PAGE + 5);
  assert.deepEqual((await list.list({ search: 'budget' })).data.map(row => row.name), ['Weekend BUDGET synthetic']);
  assert.deepEqual((await list.list({ search: 'special-folder' })).data.map(row => row.cwd), ['/work/Special-Folder']);
  assert.deepEqual((await list.list({ search: 'nothing like this' })).data, []);
  for (const bad of [{ search: 7 }, { search: 'x'.repeat(101) }, { cursor: 'abc' }, { cursor: 5 }, [], 'text']) {
    await assert.rejects(list.list(bad), error => error.uiMessage?.key === 'error.history.invalidQuery');
  }
});

test('an unqualified Claude version reads no transcript and asks for the pasted ID', async t => {
  const env = fixture(t);
  write(path.join(env.root, '-work-alpha', A + '.jsonl'), [user(A, '/work/alpha', 'Alpha task')]);
  const calls = [];
  const result = await sessions(env, { version: '9.9.9', calls }).list({});
  assert.deepEqual(result, { data: [], nextCursor: null, unavailable: { reason: 'version', version: '9.9.9' } });
  assert.deepEqual(calls, ['--version'], 'neither claude agents nor a transcript is read');
  const missing = new ClaudeSessions({ launcher: () => null, root: env.root, runCommand: async () => { throw Error('no'); } });
  assert.deepEqual(await missing.list({}), { data: [], nextCursor: null, unavailable: { reason: 'version', version: '' } });
});

test('transcripts that are all unrecognized fall back to the pasted ID with the count', async t => {
  const env = fixture(t);
  write(path.join(env.root, '-work-alpha', A + '.jsonl'), [{ kind: 'future-format', id: A }]);
  write(path.join(env.root, '-work-beta', B + '.jsonl'), [{ type: 'user', session: B }]);
  assert.deepEqual(await sessions(env).list({}), { data: [], nextCursor: null, unavailable: { reason: 'format', count: 2 } });
  write(path.join(env.root, '-work-gamma', C + '.jsonl'), [user(C, '/work/gamma', 'Readable')]);
  const mixed = await sessions(env).list({});
  assert.deepEqual(mixed.data.map(row => row.nativeId), [C]);
  assert.equal(mixed.skipped, 2);
});

test('claude agents failing leaves the list usable and says running state is unknown', async t => {
  const env = fixture(t);
  write(path.join(env.root, '-work-alpha', A + '.jsonl'), [user(A, '/work/alpha', 'Alpha task')]);
  for (const agents of [Error('agents failed'), 'not json', '{"rows":[]}']) {
    const result = await sessions(env, { agents }).list({});
    assert.deepEqual(result.data.map(row => [row.nativeId, row.running]), [[A, false]]);
    assert.equal(result.runningUnknown, true);
  }
  const map = runningRows(JSON.stringify([{ kind: 'background', sessionId: A, cwd: '/w', state: 'running' }, { kind: 'background', sessionId: A, cwd: '/w', state: 'completed' }]));
  assert.equal(map.get(A).running, true, 'a live row for the same ID wins');
});

test('a changed transcript is read again; titles are never written to the console', async t => {
  const env = fixture(t);
  const file = path.join(env.root, '-work-alpha', A + '.jsonl');
  write(file, [user(A, '/work/alpha', 'Private synthetic first message')], new Date('2026-11-18T09:00:00Z'));
  const printed = [];
  for (const name of ['log', 'error', 'warn', 'info', 'debug']) t.mock.method(console, name, (...args) => printed.push(args.join(' ')));
  const list = sessions(env);
  assert.equal((await list.list({})).data[0].name, 'Private synthetic first message');
  write(file, [user(A, '/work/alpha', 'Private synthetic first message'), { type: 'custom-title', customTitle: 'Private rename', sessionId: A }], new Date('2026-11-18T09:05:00Z'));
  assert.equal((await list.list({})).data[0].name, 'Private rename');
  fs.rmSync(file);
  assert.deepEqual((await list.list({})).data, []);
  assert.equal(list.cache.size, 0, 'removed files leave the cache');
  assert.deepEqual(printed, []);
});
