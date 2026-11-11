const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { uiError } = require('../ui-errors.cjs');
const locale = require('../ui-locale.js');
const rules = require('../queue-dispatch.cjs');
const backgroundOperation = require('../background-operation.cjs');
const { IntegrationHandoffs, FILE } = require('../integrator-handoff.cjs');
const { IntegrationRepository, FILE: REPOSITORY_FILE } = require('../integrator-repository.cjs');
const integratorGit = require('../integrator-git.cjs');
const { RoomState } = require('../room-state.cjs');
const { roomId: validRoomId, roomIds } = require('../collaboration-spaces.cjs');
const { execFileSync } = require('node:child_process');

// The person's own actions on an integration handoff (B6 E2b, checkpoint H7a): the real `register`
// wrapper, the real `handoff` entry and the real overview from main.cjs, on a real record.
// Synthetic deliveries; nothing is sent.
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const NOW = 1_800_000_000_000, MAIN = 'a'.repeat(40), HEAD2 = 'b'.repeat(40);
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
const commitOf = name => (name.charCodeAt(0).toString(16).padStart(2, '0')).repeat(20);
const key = name => `ready:shared:${name}`;
const ready = name => ({ key: key(name), roomId: 'shared', itemId: name, branch: `lane/${name}`, commit: commitOf(name), memberName: `Member ${name}`, text: `Task ${name}` });
const integratorSession = (extra = {}) => ({ id: 'integrator', nativeId: 'native-integrator', provider: 'claude', state: 'idle', background: 0, scheduled: 0, backgroundStale: false,
  chatAvailable: true, liveDraft: '', controlRevision: 0, serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra });
function slice(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a > 0 && b > a, start); return source.slice(a, b); }
function fixture(t, enabled = true, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-actions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handoffs = new IntegrationHandoffs(directory);
  const handlers = new Map(), f = { directory, file: path.join(directory, FILE), handoffs, handlers, broadcasts: 0, schedules: 0 };
  // The dispatcher as the entry sees it: its schedule, and the engine fault it kept (none unless a test sets one).
  f.dispatcher = { schedule() { f.schedules += 1; }, integrationError: null };
  // The repository choice as the engine's builder makes it in main.cjs, on a real record and the real git reader.
  f.repository = new IntegrationRepository(directory); f.unblocked = 0;
  f.dialog = async () => { throw Error('No dialog was expected'); };
  // The spaces' own record, in a folder of its own, and the sessions the backend lists.
  fs.mkdirSync(path.join(directory, 'room'));
  f.room = new RoomState(path.join(directory, 'room')); f.sessions = [];
  const context = vm.createContext({ applicationHandlers: handlers, backgroundOperation, uiError, ipcMain: { handle() {} }, integrationHandoffs: enabled ? handoffs : null, integrationFault: null, Date,
    integrationRepository: null, repository: f.repository, integratorGit, handoffs, engine: { unblock() { f.unblocked += 1; } },
    roomState: f.room, roomIds, validRoomId, queueRules: rules, displayText: (name, params) => locale.format('en', name, params),
    // The system's folder dialog, as a test stands in for the person; and the one module the entry loads when it is needed.
    showDialog: async (c, kind, options) => f.dialog(c, kind, options), require: name => { assert.equal(name, './integrator-words.cjs'); return require('../integrator-words.cjs'); },
    broadcastRoom: async () => { f.broadcasts += 1; }, queueDispatcher: options.noDispatcher ? null : f.dispatcher });
  vm.runInContext(slice('function register(name, handler) {', 'async function replaceBackendSockets'), context);
  vm.runInContext(slice('function handoffOverview(handoffs) {', '\n// One notice for one reason of the integration handoff'), context);
  vm.runInContext(slice('function chooseRepositoryFolder(c) {', '\n}\n') + '\n}', context);
  vm.runInContext(slice("  register('handoff', async (c, action, value, choice) => {", "  register('rename',"), context);
  if (enabled) vm.runInContext(slice('  integrationRepository = {', '\n  return engine;\n}'), context);
  const client = f.client = { call: async () => ({ sessions: f.sessions }), entries: [{ state: { sessions: [{ id: 'old' }], capabilities: [] } }], refresh: async () => {}, snapshot: () => ({ wakePolicy: { enabled: true }, sessions: [{ id: 'old' }, ...f.sessions] }) };
  f.person = (...args) => handlers.get('handoff')({ client }, ...args);
  f.agent = (...args) => {
    const actor = { id: 'integrator', nativeId: 'native-integrator', name: 'Integrator', provider: 'claude', turnId: 'turn', callId: 'call', operationId: 'op' };
    const c = { background: true, actor, client, view: { selected: actor.id }, win: { destroy() {} }, checkActor: async () => {} };
    return backgroundOperation.run(actor, () => handlers.get('handoff')(c, ...args), { context: c, valid: async () => {} });
  };
  f.context = context;
  f.states = () => Object.fromEntries(handoffs.snapshot().ready.map(entry => [entry.itemId, entry.state + (entry.reason ? ':' + entry.reason : '')]));
  f.bytes = () => fs.readFileSync(f.file, 'utf8');
  // Deliver the names, hand them out and let the handoff wait without a reply.
  f.waiting = names => {
    for (const name of names) handoffs.noteReady(ready(name), NOW);
    const view = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW, idleSince: new Map([['integrator', NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN };
    const opened = handoffs.advance(view, NOW);
    handoffs.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
    const silent = { integrator: INTEGRATOR, complete: true, now: NOW + 60000, idleSince: new Map([['integrator', NOW + 60000 - rules.IDLE_SETTLE_MS]]),
      session: integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }] }) };
    handoffs.settle(handoffs.plan(silent), {}, NOW + 60000);
    return opened.handoffId;
  };
  return f;
}
const refused = name => error => error.uiMessage?.key === name;

test('the person retries one delivery or a whole reason, deals with a waiting handoff, and answers a question', async t => {
  const f = fixture(t);
  for (const name of ['a', 'b', 'c']) f.handoffs.noteReady(ready(name), NOW);
  f.handoffs.hold(key('a'), 'review-off', NOW); f.handoffs.hold(key('b'), 'merge-unverified', NOW); f.handoffs.hold(key('c'), 'merge-unverified', NOW);
  // One delivery; then everything under one reason.
  assert.deepEqual(await f.person('retryDelivery', key('a')), { released: [key('a')] });
  assert.deepEqual(await f.person('retryReason', 'merge-unverified'), { released: [key('b'), key('c')] });
  assert.deepEqual(f.states(), { a: 'deliverable', b: 'deliverable', c: 'deliverable' });
  assert.deepEqual([f.broadcasts, f.schedules], [2, 2], 'Every window is told and the dispatcher looks again after each change');
  // A handoff that waits: dealt with, with a retry.
  const g = fixture(t);
  const first = g.waiting(['a', 'b']);
  assert.deepEqual(await g.person('resolve', first, true), { released: [key('a'), key('b')], held: [] });
  assert.equal(g.handoffs.snapshot().handoff, null);
  // Dealt with, without a retry: what was inside stays on hold, and the person can retry the reason later.
  const h = fixture(t);
  const second = h.waiting(['a']);
  assert.deepEqual(await h.person('resolve', second), { released: [], held: [key('a')] });
  assert.deepEqual(h.states(), { a: 'held:no-reply' });
  assert.deepEqual(await h.person('retryReason', 'no-reply'), { released: [key('a')] });
  // The retry on the reason a handoff waits on is the same as "dealt with, retry".
  const i = fixture(t);
  i.waiting(['a']);
  assert.deepEqual(await i.person('retryReason', 'no-reply'), { released: [key('a')] });
  assert.equal(i.handoffs.snapshot().handoff, null);
  // A question (a main commit that may be installed) ends with the person's answer.
  const q = fixture(t);
  const id = q.waiting(['a']);
  q.handoffs.resolveHandoff(id, { retry: true }, NOW);
  const view = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW + 70000, idleSince: new Map([['integrator', NOW + 70000 - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN };
  const again = q.handoffs.advance(view, NOW + 70000);
  q.handoffs.confirmSent(again.handoffId, { tag: 'tag-2', control: 0 }, NOW + 70000);
  const answered = { integrator: INTEGRATOR, complete: true, now: NOW + 130000, idleSince: new Map([['integrator', NOW + 130000 - rules.IDLE_SETTLE_MS]]),
    session: integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: `MERGED ${commitOf('a')} as ${HEAD2} tests 3/3`, time: NOW + 1 }] }) };
  q.handoffs.settle(q.handoffs.plan(answered), { handoffId: again.handoffId, mainHead: HEAD2, verified: { [key('a')]: { verified: true, as: HEAD2 } } }, NOW + 130000);
  assert.deepEqual(await q.person('answer', `installable:${HEAD2}`), { answered: true });
  assert.deepEqual(await q.person('answer', `installable:${HEAD2}`), { answered: false });
});

test('the overview shows what is on hold and why, the handoff that waits with its question, and the open reasons; looking changes nothing', async t => {
  const f = fixture(t);
  for (const name of ['a', 'b', 'c', 'd']) f.handoffs.noteReady(ready(name), NOW);
  f.handoffs.hold(key('c'), 'review-off', NOW); f.handoffs.hold(key('d'), 'review-off', NOW);
  const view = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW, idleSince: new Map([['integrator', NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN };
  const opened = f.handoffs.advance(view, NOW);
  f.handoffs.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
  // A handoff that only awaits the integrator's answer is not shown as waiting for the person.
  const sent = await f.person('list');
  assert.deepEqual([sent.waiting, sent.summary.handoff.status, sent.summary.handed], [null, 'sent', 2]);
  const asking = { integrator: INTEGRATOR, complete: true, now: NOW + 60000, idleSince: new Map([['integrator', NOW + 60000 - rules.IDLE_SETTLE_MS]]),
    session: integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: '需要你决定：a 和 b 改了同一处', time: NOW + 1 }] }) };
  f.handoffs.settle(f.handoffs.plan(asking), {}, NOW + 60000);
  const before = f.bytes();
  const seen = JSON.parse(JSON.stringify(await f.person('list')));
  assert.deepEqual(seen.summary, { deliverable: 0, held: 2, handed: 2, since: null, handoff: { id: opened.handoffId, status: 'waiting', confirmed: true, sentAt: NOW, integrator: INTEGRATOR } });
  assert.deepEqual(seen.held, [{ reason: 'review-off', count: 2, entries: ['c', 'd'].map(name => ({ key: key(name), roomId: 'shared', itemId: name, branch: `lane/${name}`, commit: commitOf(name), text: `Task ${name}`, memberName: `Member ${name}` })) }]);
  assert.deepEqual([seen.waiting.handoffId, seen.waiting.reason, seen.waiting.question, seen.waiting.sessionId, seen.waiting.entries.map(entry => entry.itemId)],
    [opened.handoffId, `conflict:${opened.handoffId}`, 'a 和 b 改了同一处', 'integrator', ['a', 'b']]);
  assert.deepEqual(seen.reasons.map(reason => [reason.reason, reason.notice]), [['review-off', 'pending'], [`conflict:${opened.handoffId}`, 'pending']]);
  assert.deepEqual(seen.unknownNotices, []);
  assert.equal(f.bytes(), before); assert.deepEqual([f.broadcasts, f.schedules], [0, 0], 'Looking announces nothing');
});

test('an agent can do none of this, whatever it names; without an originating operation its call does not reach the entry', async t => {
  const f = fixture(t);
  const id = f.waiting(['a']);
  f.handoffs.noteReady(ready('b'), NOW); f.handoffs.hold(key('b'), 'review-off', NOW);
  const before = f.bytes();
  for (const args of [['list'], ['retryDelivery', key('b')], ['retryReason', 'review-off'], ['retryReason', 'no-reply'], ['resolve', id, true], ['resolve', id], ['answer', `installable:${HEAD2}`], ['space', 'shared'], ['redo', key('b')], ['chooseRepository'], ['made-up'], []]) {
    await assert.rejects(f.agent(...args), refused('error.handoff.personOnly'), JSON.stringify(args));
  }
  assert.equal(f.bytes(), before); assert.deepEqual([f.broadcasts, f.schedules], [0, 0]);
  // The refusal is the entry's own: the general background gate has no row for this method.
  assert.equal(backgroundOperation.deliveryTargets('handoff', ['resolve', id, true]), null);
  await assert.rejects(f.handlers.get('handoff')({ background: true, client: {} }, 'resolve', id, true), /originating operation/);
  assert.equal(f.bytes(), before);
  // Also with the switch closed an agent is told it is the person's, not whether the feature exists.
  const closed = fixture(t, false);
  await assert.rejects(closed.agent('list'), refused('error.handoff.personOnly'));
});

test('with the switch closed the person is told handoffs are not enabled, and nothing is created', async t => {
  const f = fixture(t, false);
  for (const args of [['list'], ['retryDelivery', key('a')], ['retryReason', 'review-off'], ['resolve', 'H1-00000000', true], ['answer', `installable:${HEAD2}`], ['space', 'shared'], ['redo', key('a')], ['chooseRepository']]) {
    await assert.rejects(f.person(...args), refused('error.handoff.unavailable'), JSON.stringify(args));
  }
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual([f.broadcasts, f.schedules], [0, 0]);
});

test('a fault the dispatcher kept for the engine is shown to the person, also when the engine never started', async t => {
  // The engine runs and one of its passes failed: the overview carries the fault, as a copy.
  const f = fixture(t);
  assert.deepEqual([(await f.person('list')).started, (await f.person('list')).engineFault], [true, null]);
  f.dispatcher.integrationError = { message: 'Synthetic pass fault', at: NOW, count: 3 };
  const seen = await f.person('list');
  // (What the entry returns was made in the entry's own context: compared by content.)
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(seen.engineFault), { message: 'Synthetic pass fault', at: NOW, count: 3 });
  seen.engineFault.message = 'changed by the caller';
  assert.equal(f.dispatcher.integrationError.message, 'Synthetic pass fault');
  assert.deepEqual([f.broadcasts, f.schedules], [0, 0], 'Looking changes and announces nothing');
  // The switch is open but the engine could not be built: there is no record. Looking says why;
  // every action is refused as "did not start", not as "not enabled"; nothing is created.
  const g = fixture(t, false);
  g.dispatcher.integrationError = { message: 'Synthetic build fault', at: NOW, count: 1 };
  const unstarted = await g.person('list');
  assert.deepEqual(plain(unstarted), { started: false, engineFault: { message: 'Synthetic build fault', at: NOW, count: 1 } });
  unstarted.engineFault.message = 'changed by the caller';
  assert.equal(g.dispatcher.integrationError.message, 'Synthetic build fault', 'A copy here too');
  for (const args of [['retryDelivery', key('a')], ['retryReason', 'review-off'], ['resolve', 'H1-00000000', true], ['answer', `installable:${HEAD2}`], ['redo', key('a')], ['chooseRepository'], ['made-up']]) {
    await assert.rejects(g.person(...args), refused('error.handoff.notStarted'), JSON.stringify(args));
  }
  // The queue panel looks through 'space': it is told the same, and what it draws from that says why, not "cannot be read".
  const panel = plain(await g.person('space', 'shared'));
  assert.deepEqual(panel, { started: false, engineFault: { message: 'Synthetic build fault', at: NOW, count: 1 } });
  assert.deepEqual(plain(require('../renderer/handoff-queue.js').model({ view: panel }).block.faults), [{ key: 'queue.handoff.fault.notStarted', params: { message: 'Synthetic build fault' } }]);
  assert.equal(fs.existsSync(g.file), false); assert.deepEqual([g.broadcasts, g.schedules], [0, 0]);
  // An agent is refused first, whatever the state.
  await assert.rejects(g.agent('list'), refused('error.handoff.personOnly'));
  // No dispatcher at all (it could not start): as with the switch closed.
  const h = fixture(t, false, { noDispatcher: true });
  for (const args of [['list'], ['retryDelivery', key('a')]]) await assert.rejects(h.person(...args), refused('error.handoff.unavailable'), JSON.stringify(args));
});

test('the person chooses the main repository, sees it and clears it; an agent can do neither, and a folder that will not do is refused', async t => {
  const f = fixture(t);
  const plain = value => JSON.parse(JSON.stringify(value));
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-actions-repo-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const make = (name, branch) => { const folder = path.join(base, name); fs.mkdirSync(folder); git(folder, 'init', '--quiet', `--initial-branch=${branch}`);
    fs.writeFileSync(path.join(folder, 'synthetic.txt'), 'base\n'); git(folder, 'add', '--', 'synthetic.txt'); git(folder, 'commit', '--quiet', '-m', 'Synthetic base'); return folder; };
  const repo = make('repository', 'main'), trunk = make('trunk-only', 'trunk');
  // Nothing chosen: the person sees that, also in the overview.
  assert.deepEqual(plain(await f.person('repository')), { root: null, problem: null });
  assert.deepEqual(plain((await f.person('list')).repository), { root: null, problem: null });
  assert.deepEqual([f.broadcasts, f.schedules], [0, 0], 'Looking changes and announces nothing');
  // A folder that will not do is refused in this feature's own words, and nothing is recorded.
  await assert.rejects(f.person('setRepository', trunk), refused('error.handoff.repositoryNoMain'));
  fs.mkdirSync(path.join(repo, 'inside'));
  for (const inside of [path.join(repo, 'inside'), path.join(repo, '.git')]) await assert.rejects(f.person('setRepository', inside), refused('error.handoff.repositoryNotMain'), inside.slice(base.length));
  await assert.rejects(f.person('setRepository', base), refused('error.handoff.repositoryUnsafe'), 'A folder that is in no repository');
  for (const bad of [7, {}, 'relative', '']) await assert.rejects(f.person('setRepository', bad), refused('error.handoff.repositoryUnsafe'), JSON.stringify(bad));
  assert.deepEqual([fs.existsSync(path.join(f.directory, REPOSITORY_FILE)), f.broadcasts, f.schedules], [false, 0, 0]);
  // The person had been asked about the missing repository.
  f.handoffs.noteReady(ready('a'), NOW);
  const asking = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW, idleSince: new Map([['integrator', NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN, repository: null };
  assert.equal(f.handoffs.advance(asking, NOW).reason, 'repository-unset');
  assert.equal(f.handoffs.snapshot().reasons['repository-unset'].open, true);
  // The person's choice is recorded; the question is over, what waited for it is tried at once, every window is told and the dispatcher looks again.
  assert.deepEqual(plain(await f.person('setRepository', repo)), { root: repo });
  assert.deepEqual([f.broadcasts, f.schedules, f.unblocked, f.handoffs.snapshot().reasons['repository-unset'].open], [1, 1, 1, false]);
  // Only an explicit null clears the choice: a call without a folder is refused and changes nothing.
  await assert.rejects(f.person('setRepository'), refused('error.handoff.repositoryUnsafe'));
  assert.deepEqual([new IntegrationRepository(f.directory).chosen(), f.broadcasts, f.unblocked], [repo, 1, 1]);
  assert.deepEqual(plain(await f.person('repository')), { root: repo, problem: null });
  assert.deepEqual(plain((await f.person('list')).repository), { root: repo, problem: null });
  assert.equal(new IntegrationRepository(f.directory).chosen(), repo);
  // The repository changes afterwards: the choice is shown with why it cannot be read now.
  fs.appendFileSync(path.join(repo, '.git/config'), '[include]\n\tpath = /synthetic/elsewhere\n');
  assert.deepEqual(plain(await f.person('repository')), { root: repo, problem: 'error.handoff.repositoryUnsafe' });
  // Cleared with null (or nothing): none.
  assert.deepEqual(plain(await f.person('setRepository', null)), { root: null });
  assert.deepEqual(plain(await f.person('repository')), { root: null, problem: null });
  assert.deepEqual([f.broadcasts, f.schedules, f.unblocked], [2, 2, 1], 'Clearing unblocks nothing: there is nothing to try');
  // Chosen in the system's own folder dialog, which the main process opens for the person's window: the page names no path.
  const asked = [];
  f.dialog = async (c, kind, options) => { asked.push([c.client === f.client, kind, options]); return { canceled: true, filePaths: [] }; };
  assert.deepEqual(plain(await f.person('chooseRepository', repo)), { canceled: true }, 'A value from the page is not a folder');
  assert.deepEqual(plain(asked), [[true, 'open', { title: 'Choose the project folder: the top folder of the project the integrator merges into', properties: ['openDirectory'] }]]);
  for (const answer of [{ canceled: false, filePaths: [] }, { canceled: true, filePaths: [repo] }, { canceled: false }]) {
    f.dialog = async () => answer;
    assert.deepEqual(plain(await f.person('chooseRepository')), { canceled: true }, JSON.stringify(answer));
  }
  assert.deepEqual([new IntegrationRepository(f.directory).chosen(), f.broadcasts, f.schedules, f.unblocked], [null, 2, 2, 1], 'Closing the dialog changes and announces nothing');
  // A folder goes through the same checks as one that is named; a good one is recorded and announced.
  f.dialog = async () => ({ canceled: false, filePaths: [trunk] });
  await assert.rejects(f.person('chooseRepository', repo), refused('error.handoff.repositoryNoMain'), 'The dialog\'s folder is the one that is checked, whatever the page names');
  fs.writeFileSync(path.join(repo, '.git/config'), fs.readFileSync(path.join(repo, '.git/config'), 'utf8').replace('[include]\n\tpath = /synthetic/elsewhere\n', ''));
  f.dialog = async () => ({ canceled: false, filePaths: [repo, trunk] });
  assert.deepEqual(plain(await f.person('chooseRepository')), { root: repo });
  assert.deepEqual([new IntegrationRepository(f.directory).chosen(), f.broadcasts, f.schedules, f.unblocked], [repo, 3, 3, 2]);
  assert.deepEqual(plain(await f.person('setRepository', null)), { root: null });
  // An agent can neither look nor choose, whatever it names; no dialog is opened for it.
  f.dialog = async () => { throw Error('No dialog for an agent'); };
  for (const args of [['repository'], ['setRepository', repo], ['setRepository', null], ['chooseRepository']]) await assert.rejects(f.agent(...args), refused('error.handoff.personOnly'), JSON.stringify(args));
  assert.equal(new IntegrationRepository(f.directory).chosen(), null);
  // With the switch closed there is nothing to choose for.
  const closed = fixture(t, false);
  for (const args of [['repository'], ['setRepository', repo]]) await assert.rejects(closed.person(...args), refused('error.handoff.unavailable'), JSON.stringify(args));
  assert.equal(fs.existsSync(path.join(closed.directory, REPOSITORY_FILE)), false);
});

test('an action that does not fit the record\'s state is refused in words, and nothing changes', async t => {
  const f = fixture(t);
  const id = f.waiting(['a']);
  f.handoffs.noteReady(ready('b'), NOW);
  const before = f.bytes();
  const stale = [['retryDelivery', key('a')], ['retryDelivery', key('b')], ['retryDelivery', key('zz')], ['retryDelivery', undefined], ['retryReason', 'made-up'], ['retryReason', undefined],
    ['resolve', 'H9-other', true], ['resolve', undefined], ['answer', 'review-off'], ['answer', 'installable:'], ['answer', 7], ['made-up', id], [undefined], ['constructor'], ['__proto__'],
    // Only a returned delivery is given back: not one that is handed, waits, or is unknown.
    ['redo', key('a')], ['redo', key('b')], ['redo', key('zz')], ['redo', undefined], ['redo', 7], ['space', undefined], ['space', 7], ['space', ''], ['space', 'a/b'], ['space', ['shared']], ['space', { id: 'shared' }]];
  for (const args of stale) await assert.rejects(f.person(...args), refused('error.handoff.invalid'), JSON.stringify(args));
  assert.equal(f.bytes(), before); assert.deepEqual([f.broadcasts, f.schedules], [0, 0]);
  // A handoff that was already dealt with (from another window, say) cannot be dealt with twice.
  await f.person('resolve', id, true);
  await assert.rejects(f.person('resolve', id, true), refused('error.handoff.invalid'));
  // A retry that is true only when it is exactly true: anything else leaves the deliveries on hold.
  const g = fixture(t);
  const other = g.waiting(['a']);
  assert.deepEqual(await g.person('resolve', other, 'yes'), { released: [], held: [key('a')] });
  // A record that cannot be read is an error of its own, not "cannot be done now".
  const h = fixture(t);
  h.waiting(['a']);
  fs.chmodSync(h.directory, 0o500);
  try { await assert.rejects(h.person('retryReason', 'no-reply'), refused('error.handoff.record')); }
  finally { fs.chmodSync(h.directory, 0o700); }
  await assert.rejects(h.person('list'), refused('error.handoff.record'), 'Until the record is read again, nothing is shown from it');
  assert.deepEqual([h.broadcasts, h.schedules], [0, 0]);
  // A refusal of the record that is not about the action fitting (the next state would be invalid, or too
  // large to save) is a fault of the record: said as that, never as "look again and retry", and kept.
  const k = fixture(t);
  k.handoffs.noteReady(ready('a'), NOW); k.handoffs.hold(key('a'), 'review-off', NOW);
  const real = k.handoffs.retryReady.bind(k.handoffs);
  k.handoffs.retryReady = () => { throw Object.assign(Error('The handoff record would be too large; nothing was changed'), { code: 'HANDOFF_STATE' }); };
  await assert.rejects(k.person('retryDelivery', key('a')), refused('error.handoff.record'));
  assert.deepEqual([k.broadcasts, k.schedules, k.states()], [0, 0, { a: 'held:review-off' }]);
  const fault = (await k.person('list')).fault;
  assert.equal(fault.message, 'The handoff record would be too large; nothing was changed'); assert.ok(Number.isFinite(fault.at));
  // The record marks its own "does not fit" refusals; nothing else counts as stale.
  k.handoffs.retryReady = real;
  for (const call of [() => k.handoffs.retryReady(key('zz')), () => k.handoffs.retryReason('made-up'), () => k.handoffs.resolveHandoff('H9-other', {}), () => k.handoffs.answer('review-off')]) {
    assert.throws(call, error => error.code === 'HANDOFF_STATE' && error.stale === true);
  }
  assert.throws(() => k.handoffs.hold(key('zz'), 'review-off', NOW), error => error.code === 'HANDOFF_STATE' && error.stale === undefined);
});

// Deliver, hand out, and let the integrator answer with these result lines.
const PERSON = { kind: 'person', name: 'You', sessionId: null };
function settled(f, deliveries, reply, verified = {}) {
  for (const delivery of deliveries) f.handoffs.noteReady(delivery, NOW);
  const view = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW, idleSince: new Map([['integrator', NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN };
  const opened = f.handoffs.advance(view, NOW);
  f.handoffs.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
  const answered = { integrator: INTEGRATOR, complete: true, now: NOW + 60000, idleSince: new Map([['integrator', NOW + 60000 - rules.IDLE_SETTLE_MS]]),
    session: integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: reply, time: NOW + 1 }] }) };
  f.handoffs.settle(f.handoffs.plan(answered), { handoffId: opened.handoffId, mainHead: HEAD2, verified }, NOW + 60000);
}
// One returned delivery of member-b. `queued`: the task is still in the space's queue as the person wrote it.
const FULL = 'Fix the synthetic page.\nA second line, which the delivery\'s short label does not carry.';
function returned(f, { queued = true, member = { roomIds: ['shared'] }, delivery = {}, reason = ' needs a rebase' } = {}) {
  const itemId = queued ? f.room.queueAdd(typeof queued === 'string' ? queued : FULL, null, 'shared', PERSON) : 'b';
  if (member) f.sessions.push({ id: 'member-b', nativeId: 'native-b', name: 'Member b', state: 'idle', ...member });
  const fact = { ...ready('b'), key: `ready:shared:${itemId}`, itemId, memberId: 'member-b', ...delivery };
  for (const [name, value] of Object.entries(fact)) if (value === undefined) delete fact[name];
  settled(f, [fact], `RETURNED ${commitOf('b')}${reason}`);
  return { key: fact.key, itemId, last: () => f.room.queueItems('shared').at(-1), open: () => f.room.queueItems('shared').filter(item => item.status === 'queued').length };
}
const SAID = ' (the integrator returned branch lane/b: needs a rebase)';

test('the person sees where each delivery of one space stands, and gives a returned task back to its member once', async t => {
  const f = fixture(t), plain = value => JSON.parse(JSON.stringify(value));
  const itemId = f.room.queueAdd(FULL, null, 'shared', PERSON), b = `ready:shared:${itemId}`;
  f.sessions.push({ id: 'member-b', nativeId: 'native-b', name: 'Member b', state: 'idle', roomIds: ['shared'] });
  settled(f, [ready('a'), { ...ready('b'), key: b, itemId, memberId: 'member-b' }, ready('c')],
    `MERGED ${commitOf('a')} as ${HEAD2} tests 3/3\nRETURNED ${commitOf('b')} needs a rebase\nRETURNED ${commitOf('c')}`, { [key('a')]: { verified: true, as: HEAD2 } });
  // Two more on hold: one for a cause with a sentence of its own, one for another cause in the integrator's words.
  for (const [name, reason] of [['d', 'review-off'], ['e', 'held-other']]) { f.handoffs.noteReady({ ...ready(name), ...(name === 'e' ? { branch: 'lane/e' } : {}) }, NOW + 70000); f.handoffs.hold(key(name), reason, NOW + 70000); }
  const before = f.bytes(), room = fs.readFileSync(f.room.file, 'utf8');
  const seen = plain(await f.person('space', 'shared'));
  assert.deepEqual([seen.items.d, seen.items.e], [
    { key: key('d'), state: 'held', branch: 'lane/d', commit: commitOf('d'), text: 'Task d', memberName: 'Member d', reason: 'review-off', why: { key: 'queue.handoff.why.reviewOff', params: {} } },
    { key: key('e'), state: 'held', branch: 'lane/e', commit: commitOf('e'), text: 'Task e', memberName: 'Member e', reason: 'held-other', why: { key: 'queue.handoff.why.unknown', params: {} } }]);
  delete seen.items.d; delete seen.items.e;
  assert.ok(Object.values(seen.items).every(item => item.why === undefined), 'Only a delivery on hold carries a cause');
  assert.deepEqual(seen.items, {
    a: { key: key('a'), state: 'merged', branch: 'lane/a', commit: commitOf('a'), text: 'Task a', memberName: 'Member a', mergedAs: HEAD2, tests: { passed: 3, total: 3 } },
    [itemId]: { key: b, state: 'returned', branch: 'lane/b', commit: commitOf('b'), text: 'Task b', memberId: 'member-b', memberName: 'Member b', note: 'needs a rebase' },
    // A line without a reason: nothing is shown as the integrator's words.
    c: { key: key('c'), state: 'returned', branch: 'lane/c', commit: commitOf('c'), text: 'Task c', memberName: 'Member c' } });
  assert.deepEqual(Object.keys(seen).sort(), [...Object.keys(plain(await f.person('list'))), 'items'].sort(), 'The overview, and the items of this space');
  assert.equal(seen.started, true);
  assert.deepEqual(plain((await f.person('space', '00000000-0000-4000-8000-000000000000')).items), {}, 'Another space sees none of them');
  assert.deepEqual([f.bytes(), fs.readFileSync(f.room.file, 'utf8'), f.broadcasts, f.schedules], [before, room, 0, 0], 'Looking changes and announces nothing');
  // Given back: the whole task as it was written, the branch and the integrator's words, for the member who did it.
  const done = plain(await f.person('redo', b)), added = f.room.queueItems('shared').at(-1);
  assert.deepEqual(done, { redone: true, itemId: added.id, assignee: 'member-b' });
  assert.deepEqual([added.text, added.assignee, added.status, added.creator], [FULL + SAID, 'member-b', 'queued', PERSON]);
  assert.notEqual(added.id, itemId);
  assert.equal(plain(await f.person('space', 'shared')).items[itemId].redone, true);
  assert.deepEqual([f.broadcasts, f.schedules], [1, 1], 'Every window is told and the dispatcher looks again');
  // Once: a second press, here or in another window, is refused and adds nothing.
  await assert.rejects(f.person('redo', b), refused('error.handoff.invalid'));
  assert.deepEqual([f.room.queueItems('shared').length, f.broadcasts, f.schedules], [2, 1, 1]);
  // Without a reason the task says so, and with no task left in the queue it is named by the delivery's label.
  await f.person('redo', key('c'));
  assert.deepEqual([f.room.queueItems('shared').at(-1).text, f.room.queueItems('shared').at(-1).assignee], ['Task c (the integrator returned branch lane/c; please redo it)', null]);
  // Two presses at once add one task.
  const g = fixture(t), twice = returned(g);
  const results = await Promise.allSettled([g.person('redo', twice.key), g.person('redo', twice.key)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(refused('error.handoff.invalid')(results.find(result => result.status === 'rejected').reason));
  assert.deepEqual([g.room.queueItems('shared').length, twice.open(), g.broadcasts], [2, 2, 1]);
});

test('a task given back goes to the member who did it only while that member can take it, and is cut to fit', async t => {
  // Who gets it.
  const cases = [
    ['still in the space', {}, 'member-b'],
    ['left the space', { member: { roomIds: [] } }, null],
    ['ended', { member: { roomIds: ['shared'], state: 'ended' } }, null],
    ['a membership record that cannot be read', { member: { roomIds: 'shared' } }, null],
    ['no longer listed', { member: null }, null],
    ['a delivery that does not say who did it', { delivery: { memberId: undefined } }, null],
  ];
  for (const [name, options, assignee] of cases) {
    const f = fixture(t), one = returned(f, options);
    assert.equal((await f.person('redo', one.key)).assignee, assignee, name);
    assert.deepEqual([one.last().assignee, one.last().text], [assignee, FULL + SAID], name);
  }
  // A member the person archived (while outside every space) that the backend lists in the space again: not served by the queue, so not named.
  const a = fixture(t), archived = returned(a, { member: { roomIds: [] } });
  await a.room.archiveSession(a.client, 'member-b', 'Member b');
  assert.deepEqual(a.room.value.archivedSessions, ['member-b']);
  a.sessions.find(session => session.id === 'member-b').roomIds = ['shared'];
  assert.equal((await a.person('redo', archived.key)).assignee, null);
  // The task is no longer in the queue: the delivery's short label; without a label, the branch.
  const b = fixture(t), label = returned(b, { queued: false });
  await b.person('redo', label.key);
  assert.equal(label.last().text, 'Task b' + SAID);
  const c = fixture(t), bare = returned(c, { queued: false, delivery: { text: undefined } });
  await c.person('redo', bare.key);
  assert.equal(bare.last().text, 'lane/b' + SAID);
  // A task as long as a task may be: cut so that the integrator's words still fit, never inside a character.
  const room = rules.ITEM_TEXT_LIMIT - SAID.length;
  for (const [name, long, kept] of [['plain', 'x'.repeat(rules.ITEM_TEXT_LIMIT), 'x'.repeat(room - 1) + '…'], ['exactly fits', 'x'.repeat(room), 'x'.repeat(room)],
    ['a pair at the cut', 'x'.repeat(room - 2) + '😀' + 'y'.repeat(9), 'x'.repeat(room - 2) + '…']]) {
    const d = fixture(t), cut = returned(d, { queued: long });
    await d.person('redo', cut.key);
    assert.equal(cut.last().text, kept + SAID, name);
    assert.ok(cut.last().text.length <= rules.ITEM_TEXT_LIMIT, name);
  }
});

test('a task that cannot be added is not marked as given back, and a mark that cannot be kept takes the task out again', async t => {
  // The queue is full: refused in the queue's own words; the delivery can be given back once there is room.
  const f = fixture(t), one = returned(f);
  // (Filled in one write of the space's record, with items as the queue itself makes them.)
  f.room.update({ queue: [...f.room.queueItems('shared'), ...Array.from({ length: rules.QUEUE_LIMIT - one.open() }, (_, index) => rules.newItem(`Synthetic task ${index}`, null, NOW, PERSON))] }, undefined, 'shared');
  const before = f.bytes();
  await assert.rejects(f.person('redo', one.key), refused('error.queue.full'));
  assert.deepEqual([f.bytes(), one.open(), f.broadcasts, f.schedules], [before, rules.QUEUE_LIMIT, 0, 0]);
  f.room.queueCancel(one.last().id, 'shared');
  assert.equal((await f.person('redo', one.key)).redone, true);
  assert.equal(one.open(), rules.QUEUE_LIMIT);
  // A space that is gone: refused, and nothing is marked.
  const g = fixture(t), gone = '00000000-0000-4000-8000-000000000000';
  settled(g, [{ ...ready('b'), key: `ready:${gone}:b`, roomId: gone }], `RETURNED ${commitOf('b')} needs a rebase`);
  const kept = g.bytes();
  await assert.rejects(g.person('redo', `ready:${gone}:b`), refused('error.room.missing'));
  assert.deepEqual([g.bytes(), g.broadcasts], [kept, 0]);
  // The sessions cannot be read: nothing is added or marked.
  const h = fixture(t), unread = returned(h);
  h.client.call = async () => { throw Error('Synthetic backend failure'); };
  await assert.rejects(h.person('redo', unread.key), /Synthetic backend failure/);
  assert.deepEqual([unread.open(), h.handoffs.spaceView('shared')[unread.itemId].redone, h.broadcasts], [1, undefined, 0]);
  // The record cannot be saved: the task that was just added is cancelled, the fault is said, and the delivery stays to be given back.
  const k = fixture(t), unsaved = returned(k);
  fs.chmodSync(k.directory, 0o500);
  try { await assert.rejects(k.person('redo', unsaved.key), refused('error.handoff.record')); }
  finally { fs.chmodSync(k.directory, 0o700); }
  // (The windows are told, since the space's record changed; the dispatcher is not asked to look again.)
  assert.deepEqual([unsaved.last().text, unsaved.last().status, unsaved.open(), k.broadcasts, k.schedules], [FULL + SAID, 'cancelled', 1, 1, 0]);
  assert.equal(new IntegrationHandoffs(k.directory).spaceView('shared')[unsaved.itemId].redone, undefined);
  assert.match(k.context.integrationFault.message, /./);
  // And the task cannot be taken out again either: the person is told that it is in the queue, and the record's fault is kept.
  const m = fixture(t), both = returned(m);
  m.room.queueCancel = () => { throw Error('Synthetic cancel failure'); };
  fs.chmodSync(m.directory, 0o500);
  try { await assert.rejects(m.person('redo', both.key), refused('error.handoff.redoKept')); }
  finally { fs.chmodSync(m.directory, 0o700); }
  assert.deepEqual([both.last().text, both.last().status, both.open(), m.broadcasts, m.schedules], [FULL + SAID, 'queued', 2, 1, 0]);
  assert.match(m.context.integrationFault.message, /./); assert.ok(Number.isFinite(m.context.integrationFault.at));
  assert.equal(new IntegrationHandoffs(m.directory).spaceView('shared')[both.itemId].redone, undefined);
});

test('the entry is wired for the person\'s window, and its words exist in both languages', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.match(preload, /for \(const name of \['queueSecretary', 'integrator', 'handoff', /);
  assert.match(source, /const localQueue = name === 'queueSecretary' \|\| name === 'integrator' \|\| name === 'handoff' \|\| /);
  // The record the entry acts on is the one the engine was built with, and is set nowhere else.
  assert.equal(source.match(/integrationHandoffs = /g).length, 2, 'Its declaration as null and the one assignment');
  assert.match(source, /let integrationHandoffs = null;/);
  const builder = source.indexOf('function integrationEngine(dispatcher) {'), next = source.indexOf('\nfunction ', builder + 10), assigned = source.indexOf('  integrationHandoffs = handoffs;');
  assert.ok(assigned > builder && assigned < next);
  for (const name of ['error.handoff.personOnly', 'error.handoff.unavailable', 'error.handoff.notStarted', 'error.handoff.invalid', 'error.handoff.record', 'error.handoff.redoKept']) {
    const zh = locale.format('zh', name), en = locale.format('en', name);
    assert.ok(zh && en && zh !== en && zh !== name && en !== name, name);
  }
  // The window's state says that handoffs are enabled only where they are, or where they could not start; elsewhere it is as it always was.
  const flag = slice('  const handoffEnabled = ', '\n');
  // (It reads the dispatcher only, which the state function already reads: other tests evaluate that function on its own.)
  const told = dispatcher => JSON.parse(JSON.stringify(vm.runInNewContext(`${flag}\nhandoffEnabled`, { queueDispatcher: dispatcher })));
  assert.deepEqual([told(null), told(undefined), told({ integration: null, integrationError: null }), told({ integration: {}, integrationError: null }), told({ integration: null, integrationError: { message: 'Synthetic build fault' } })],
    [{}, {}, {}, { handoffEnabled: true }, { handoffEnabled: true }]);
  assert.ok(!/integrationHandoffs/.test(slice('function displayState(snapshot, context, read = null) {', '\nfunction reportViewStorage(')), 'The state function names nothing new');
  assert.match(source, /const result = \{ \.\.\.display, queueSecretary: secretary, integrator, \.\.\.handoffEnabled, /);
  // The task given back names the task, the branch and (when there are any) the integrator's words, in both languages.
  for (const language of ['zh', 'en']) {
    const said = locale.format(language, 'queue.redo.text', { text: 'TASK', branch: 'BRANCH', note: 'NOTE' }), bare = locale.format(language, 'queue.redo.plain', { text: 'TASK', branch: 'BRANCH' });
    assert.ok(said.startsWith('TASK') && said.includes('BRANCH') && said.includes('NOTE') && !said.includes('{'), language);
    assert.ok(bare.startsWith('TASK') && bare.includes('BRANCH') && !bare.includes('{') && bare !== said, language);
  }
});
