// Resume all sessions awaiting recovery (the person, 2026-11-23: 「有没有法子让我一键恢复所有会话」).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { eligible, create, LIMIT } = require('../renderer/resume-all.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only recoverable, unarchived sessions the single resume accepts are listed', () => {
  const sessions = [
    { id: 'a', state: 'recoverable' }, { id: 'b', state: 'recoverable', archived: true },
    { id: 'c', state: 'ended' }, { id: 'd', state: 'idle' }, { id: 'e', state: 'recoverable', blocked: true }, null,
  ];
  assert.deepEqual(eligible(sessions, s => !s.blocked).map(s => s.id), ['a']);
});

test('at most two resume at once, only the chosen ones, each once', async () => {
  const calls = [], holds = new Map();
  let inFlight = 0, most = 0;
  const all = create({ resumeOne: id => {
    calls.push(id); inFlight++; most = Math.max(most, inFlight);
    return new Promise(resolve => holds.set(id, () => { inFlight--; resolve(); }));
  } });
  const finished = all.add(['a', 'b', 'c', 'd', 'e']);
  for (let n = 0; n < 5; n++) await tick();
  assert.equal(LIMIT, 2);
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(all.ids().map(id => all.row(id).state), ['running', 'running', 'queued', 'queued', 'queued']);
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    while (!holds.has(id)) await tick();
    holds.get(id)();
    await tick();
  }
  assert.deepEqual(await finished, { total: 5, done: 5, failed: 0, pending: 0 });
  assert.equal(most, 2);
  all.add(['a', 'b']);
  await all.idle();
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'e'], 'A finished session is not resumed again');
});

test('one failure keeps its reason, the others finish, and retry resumes only that one', async () => {
  const calls = [];
  let fail = true;
  const reason = Error('error.workspace.originalDirectoryUnavailable');
  const all = create({ resumeOne: async id => { calls.push(id); if (id === 'b' && fail) throw reason; } });
  assert.deepEqual(await all.add(['a', 'b', 'c']), { total: 3, done: 2, failed: 1, pending: 0 });
  assert.equal(all.row('b').state, 'failed');
  assert.equal(all.row('b').error, reason);
  fail = false;
  assert.deepEqual(await all.retry('b'), { total: 3, done: 3, failed: 0, pending: 0 });
  assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
});

test('the module loads before renderer.js in the page and in the built bundle', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const build = fs.readFileSync(path.join(__dirname, '../../scripts/build-ui.cjs'), 'utf8');
  assert.ok(html.indexOf('src="resume-all.js"') > 0 && html.indexOf('src="resume-all.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(build.indexOf("'resume-all.js'") > 0 && build.indexOf("'resume-all.js'") < build.indexOf("'renderer.js'"));
});


// Reviewer finding (merge-check 288): a session that left `recoverable` or changed native session after listing is not resumed.
test('a listed session is resumed only while it is still the same recoverable native session', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('async function resumeAllOne('), end = source.indexOf('function settleResumeAll(');
  assert.ok(start > 0 && end > start);
  const calls = [];
  const context = vm.createContext({
    state: { sessions: [] }, calls,
    resumeAll: { nativeIds: new Map([['a', 'n1'], ['b', 'n2'], ['c', 'n3'], ['d', 'n4']]) },
    nativeUsable: s => s.state === 'idle', canResume: s => ['recoverable', 'ended', 'error'].includes(s.state),
    uiError: key => Object.assign(Error(key), { key }), api: { resume: async id => { calls.push(id); } },
  });
  vm.runInContext(source.slice(start, end), context);
  context.state.sessions = [
    { id: 'a', state: 'recoverable', nativeId: 'n1' }, { id: 'b', state: 'ended', nativeId: 'n2' },
    { id: 'c', state: 'recoverable', nativeId: 'other' }, { id: 'd', state: 'idle', nativeId: 'n5' },
  ];
  await context.resumeAllOne('a');
  for (const id of ['b', 'c']) await assert.rejects(context.resumeAllOne(id), { key: 'error.resumeAllChanged' });
  await context.resumeAllOne('d');
  assert.deepEqual(calls, ['a']);
});
