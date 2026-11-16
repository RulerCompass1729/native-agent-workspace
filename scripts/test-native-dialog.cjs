// Isolated NAW service and real PTY; no native provider or model. Optional old source root.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const scratch = require('./fixtures/test-scratch.cjs');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { connect } = require(path.join(root, 'app/service-client.cjs'));
const { RoomState } = require(path.join(root, 'app/room-state.cjs'));
const { QueueDispatcher } = require(path.join(root, 'app/queue-dispatch.cjs'));
const { ButlerIngress } = require(path.join(root, 'app/butler-ingress.cjs'));
const directory = scratch.directory(path.join(os.tmpdir(), 'naw-dialog-service-'));
const evidence = process.env.NAW_EVIDENCE_DIR; assert.ok(evidence);
const logRoot = path.join(directory, 'logs'); fs.mkdirSync(logRoot);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { const end = Date.now() + 15000; while (Date.now() < end) { if (await check()) return; await delay(50); } throw Error(label); }
let child, client, dispatcher;
(async () => {
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [directory], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-dialog.cjs')], env: { ...process.env, NAW_WORKSPACE: directory, NAW_TEST_APP_ROOT: root, NAW_DIALOG_LOG_ROOT: logRoot }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(directory, 'connection.json')), 'service');
  client = await connect(directory, 'fixture-person');
  const id = await client.call('create', { provider: 'claude', cwd: directory, name: 'Fixture choice' });
  const target = typeof id === 'string' ? id : id.id;
  await client.call('join', target, true);
  await until(async () => (await client.call('terminalSnapshot', target)).buffer.includes('Enter'), 'TUI dialog');
  const state = await client.call('initial');
  const roomState = new RoomState(directory), ingress = new ButlerIngress(directory, { roomState });
  client.on('state', state => ingress.observeTerminalDialogs?.(state.sessions));
  ingress.observeTerminalDialogs?.(state.sessions);
  const item = roomState.queueAdd('SYNTHETIC_TASK', target);
  dispatcher = new QueueDispatcher({ dataDir: directory, roomState, clients: () => client, connect: async () => client, broadcast: async () => {}, settleMs: 20, humanQuietMs: 0, tickMs: 50, sampleProcesses: async () => '', samplePressure: async () => '0', contentCounts: async () => ({}) });
  const race = process.env.NAW_DIALOG_RACE;
  if (race) await client.call('input', target, '\x1b');
  await dispatcher.start();
  const old = process.env.NAW_DIALOG_EXPECT_OLD === '1';
  if (old) await until(() => roomState.queueFind('shared', item).status === 'sent', 'old dispatcher sends into the dialog');
  else {
    if (race) {
      await until(() => ['queued', 'failed'].includes(roomState.queueFind('shared', item).status) && fs.existsSync(path.join(logRoot, target + '.jsonl')) && fs.readFileSync(path.join(logRoot, target + '.jsonl'), 'utf8').includes('opened'), 'race refusal settles');
      await delay(300);
    }
    await delay(600);
    assert.equal(roomState.queueFind('shared', item).status, 'queued');
    if (!race) assert.equal(fs.existsSync(path.join(logRoot, target + '.jsonl')), false, 'zero bytes while dialog is up');
    else assert.ok(!fs.readFileSync(path.join(logRoot, target + '.jsonl'), 'utf8').includes('editor-paste'), 'race sent no task bytes');
    await client.call('input', target, '\x1b');
    await until(() => roomState.queueFind('shared', item).status === 'sent', 'dispatch resumes after Esc');
  }
  await until(() => fs.existsSync(path.join(logRoot, target + '.jsonl')), 'known raw input receipt');
  await delay(200);
  const effects = fs.readFileSync(path.join(logRoot, target + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (old) { assert.ok(effects.some(e => e.effect === 'confirmed')); assert.ok(!effects.some(e => e.effect === 'submitted')); }
  else { assert.ok(!effects.some(e => e.effect === 'confirmed')); assert.match(effects.find(e => e.effect === 'submitted')?.text || '', /^【NAW 派活】.*\n\nSYNTHETIC_TASK\n/); }
  const report = { old, stateBefore: { state: state.sessions[0].state, terminalInputPending: state.sessions[0].terminalInputPending, nativeTerminalDialog: state.sessions[0].nativeTerminalDialog }, effects, events: ingress.ledger.eventsAfter(null) };
  fs.writeFileSync(path.join(evidence, race ? 'fixture-race-' + race + '.json' : old ? 'fixture-old.json' : 'fixture-new.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ old, stateBefore: report.stateBefore, effects: effects.filter(e => e.effect).map(({ effect, option, label }) => ({ effect, option, label })), events: report.events.events.map(e => e.kind) }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  dispatcher?.close();
  if (client) { for (const s of client.snapshot().sessions) await client.call('stop', s.id).catch(() => {}); await client.call('shutdown').catch(() => {}); client.close(); }
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
});
