const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { Workspace } = require('../workspace.cjs'), { Claude, Codex } = require('../adapters.cjs'), { LegacyShared } = require('../legacy-shared.cjs');
const locale = require('../ui-locale.js'), { nativeApprovalPolicy } = require('../approval-policy.js');
function fixture(t, provider) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-notice-locale-'));
  const host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: { connected: true, reply() {}, call: async () => { throw Error('Unexpected native dispatch'); } } }, w = new Workspace(host, directory);
  const record = { id: 'synthetic', nativeId: '11111111-1111-4111-8111-111111111111', provider, name: 'RAW NAME 中文', owner: 'original-owner', cwd: directory, state: 'idle', messages: [], fleet: [] };
  const runtime = provider === 'claude' ? new Claude(record, host, { attachOnly: true }) : new Codex(record, host);
  w.sessions.set(record.id, record); w.runtimes.set(record.id, runtime); w.bind(record, runtime); w.drafts.set(record.id, 'UNSENT 中文');
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return { directory, host, w, record, runtime };
}
test('actual Codex question and terminal-answer titles translate without changing question, option or submitted answer text', t => {
  const { runtime: r, record: s } = fixture(t, 'codex'), rpc = r.terminalRpc = { connected: true, reply() {} };
  const p = { threadId: s.nativeId, turnId: 'turn', itemId: 'call', questions: [{ id: 'q', header: 'RAW header 中文', question: 'RAW question 中文?', options: [{ label: 'RAW choice 中文', description: 'RAW detail 中文' }] }] };
  r.event({ method: 'turn/started', params: { threadId: s.nativeId, turn: { id: 'turn' } } }, rpc);
  r.event({ id: 1, method: 'item/tool/requestUserInput', params: p }, rpc);
  const row = s.messages.find(m => m.title === '原生问题'); assert.ok(row); const raw = row.text;
  assert.equal(locale.displayText('en', row.title, row.uiTitleMessage), 'Native question'); assert.equal(raw, 'RAW header 中文\nRAW question 中文?\nRAW choice 中文 — RAW detail 中文');
  r.observeTerminalContext({ kind: 'reply', id: 1, rpc, result: { answers: { q: { answers: ['RAW answer 中文'] } } } });
  const answer = s.messages.find(m => m.title === '原生终端提交的回答'); assert.equal(answer.text, 'RAW answer 中文'); assert.equal(locale.displayText('en', answer.title, answer.uiTitleMessage), 'Answer submitted in the native terminal');
  r.event({ method: 'serverRequest/resolved', params: { threadId: s.nativeId, requestId: 1 } }, rpc);
  assert.equal(row.text, raw); assert.equal(locale.displayText('en', row.title, row.uiTitleMessage), 'Native question · Handled');
});
test('only the adapter-owned ambiguous approval reason is labeled; raw native reasons and decision policy stay unchanged', t => {
  const { runtime: r, record: s, host } = fixture(t, 'codex'); const p = { threadId: s.nativeId, command: 'RAW command 中文', cwd: '/synthetic' };
  r.event({ id: 7, method: 'item/commandExecution/requestApproval', params: p }, host.rpc);
  r.event({ id: 7, method: 'item/commandExecution/requestApproval', params: { ...p, command: 'RAW changed command 中文' } }, host.rpc);
  assert.equal(s.approval.method, 'native/requestAmbiguous'); const policy = nativeApprovalPolicy(s.approval), raw = s.approval.params.reason;
  assert.equal(locale.displayText('en', policy.reason, policy.reasonUiMessage), 'A native confirmation ID was reused with different content. Check the native terminal.'); assert.deepEqual(policy.decisions, []); assert.equal(policy.nativeRequired, true);
  const native = nativeApprovalPolicy({ method: 'item/commandExecution/requestApproval', params: { ...p, reason: raw, reasonUiMessage: s.approval.params.reasonUiMessage } });
  assert.equal(locale.displayText('en', native.reason, native.reasonUiMessage), raw, 'A native reason equal to an owned label remains native'); assert.deepEqual(native.decisions, ['accept', 'decline']);
});
test('actual old Claude progress keeps the exact native body while only its titles and non-text wrapper receive metadata', t => {
  const { runtime: r, w, record } = fixture(t, 'claude'); r.validRootBinding = () => true; r.observationEpoch = 'synthetic-epoch';
  const raw = 'RAW native body 中文 <tag>{key}\n', id = '22222222-2222-4222-8222-222222222222';
  r.observeRoot({ id, epoch: r.observationEpoch, lease: 'synthetic', sequence: 1, kind: 'tool-output', title: 'RAW tool 中文', text: raw, nonText: true });
  const observed = w.progress.get(record.id).snapshot().items[0]; assert.equal(observed.text, raw + '\n含非文本结果，请在原生终端查看。');
  assert.equal(locale.displayText('en', observed.title, observed.uiTitleMessage), 'RAW tool 中文 · Native output');
  assert.equal(locale.displayText('en', observed.text, observed.uiMessage), raw + '\nIncludes non-text results. View them in the native terminal.');
  const row = record.messages.find(m => m.id.endsWith('observation:claude-row-' + id)); assert.equal(row.text, observed.text); assert.deepEqual(row.uiMessage, observed.uiMessage);
  r.observeRoot({ id, epoch: r.observationEpoch, lease: 'synthetic', sequence: 2, kind: 'response', text: raw });
  const next = w.progress.get(record.id).snapshot().items[0]; assert.equal(next.text, raw); assert.equal(next.uiMessage, undefined); assert.equal(locale.displayText('en', next.title, next.uiTitleMessage), 'Native reply');
  r.observeRootGap({ epoch: r.observationEpoch }); const gap = w.progress.get(record.id).snapshot().items.find(item => item.kind === 'gap'); assert.ok(gap); assert.notEqual(locale.displayText('en', gap.text, gap.uiMessage), gap.text);
});
test('LegacyShared close forwards the existing optional descriptor and restored notices keep raw shared content', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-shared-notice-locale-')), shared = new LegacyShared(directory, () => {});
  t.after(() => { shared.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const own = locale.createNotice('notice.sharing.gap'), row = { id: 'shared-row', role: 'assistant', text: 'RAW shared 中文', status: 'streaming' };
  shared.workspace.room.messages.push(row); shared.grants.set('tag', { tag: 'tag', rows: new Map([[row.id, row]]) });
  shared.close('tag', own.text, own.uiMessage); assert.equal(locale.displayText('en', row.sharingStopped, row.sharingStoppedUiMessage), 'Some content is not synchronized. Check the original session'); assert.equal(row.text, 'RAW shared 中文');
  shared.workspace.room.messages.push({ id: 'restore', role: 'assistant', text: 'RAW retained 中文', status: 'streaming' }); shared.save();
  const restored = new LegacyShared(directory, () => {}); t.after(() => restored.dispose()); const retained = restored.snapshot().find(row => row.id === 'restore');
  assert.equal(retained.text, 'RAW retained 中文'); assert.equal(retained.status, 'unconfirmed'); assert.notEqual(locale.displayText('en', retained.sharingStopped, retained.sharingStoppedUiMessage), retained.sharingStopped);
});
test('actual explicit daemon pause branches and addressed-failure body keep old control arguments and add paired labels', async () => {
  const daemon = fs.readFileSync(require.resolve('../daemon.cjs'), 'utf8'), a = daemon.indexOf("      case 'pause':"), b = daemon.indexOf("      case 'forward':", a); assert.ok(a > 0 && b > a);
  for (const scoped of [false, true]) {
    const calls = [], context = vm.createContext({ uiNotice: locale.createNotice, peerRunner: { run: { roomId: 'shared' }, pause: async () => calls.push('peerPause') }, workspace: { pause: (...args) => calls.push(['pause', ...args]), pauseRoom: (...args) => calls.push(['pauseRoom', ...args]) }, args: [], scoped, roomId: 'shared' });
    await vm.runInContext('(async()=>{' + daemon.slice(a, b).replace("case 'pause':", '') + '})()', context);
    const call = calls.at(-1), reason = call[scoped ? 2 : 1], metadata = call[scoped ? 3 : 4]; assert.ok(reason); assert.notEqual(locale.displayText('en', reason, metadata), reason); assert.equal(calls[0], 'peerPause');
  }
  const source = fs.readFileSync(require.resolve('../addressed-handoffs.cjs'), 'utf8'), start = source.indexOf('function failed('), end = source.indexOf('function accept(', start); const run = { pendingHandoff: { private: true } }; let changed = 0;
  const context = vm.createContext({ uiNotice: locale.createNotice, authorized: () => ({ run }), run }); vm.runInContext(source.slice(start, end), context);
  assert.equal(context.failed({ changed() { changed++; } }, {}, {}, {}).status, 'not-sent'); assert.equal(run.pendingHandoff, null); assert.equal(changed, 1); assert.notEqual(locale.displayText('en', run.stopAfterReply, run.stopAfterReplyUiMessage), run.stopAfterReply);
});


test('actual Claude and Codex fleet source fallbacks are labeled while an identical native name stays literal', t => {
  for (const provider of ['claude', 'codex']) {
    const { runtime: r, record: s } = fixture(t, provider), fleet = []; r.on('fleet', e => fleet.push(e));
    if (provider === 'claude') {
      r.hook({ session_id: s.nativeId, hook_event_name: 'SubagentStart' });
      r.hook({ session_id: s.nativeId, hook_event_name: 'SubagentStart', teammate_name: '原生团队活动' });
    } else {
      r.event({ method: 'item/started', params: { threadId: s.nativeId, item: { id: 'child', type: 'subAgentActivity' } } });
      r.event({ method: 'item/started', params: { threadId: s.nativeId, item: { id: 'child2', type: 'subAgentActivity', agentPath: 'Codex 原生子 agent' } } });
    }
    assert.equal(fleet.length, 2); assert.notEqual(locale.displayText('en', fleet[0].name, fleet[0].nameUiMessage), fleet[0].name); assert.equal(locale.displayText('en', fleet[1].name, fleet[1].nameUiMessage), fleet[1].name); assert.equal(fleet[1].nameUiMessage, null);
  }
});


test('native block and progress boundaries clear stale own legacy-body metadata and reject a tagged native lookalike', () => {
  const { applyNativeBlock } = require('../native-blocks.cjs'), { ProgressJournal } = require('../observation.cjs');
  const own = locale.createNotice('notice.legacy.nonText', { text: 'RAW body 中文' }), session = { nativeId: 'native-synthetic', messages: [] }, base = { id: 'tool:own', nativeId: session.nativeId, kind: 'tool', text: own.text, uiMessage: own.uiMessage, source: 'claude-native-message' };
  applyNativeBlock(session, base); const row = session.messages[0]; assert.deepEqual(row.uiMessage, own.uiMessage);
  applyNativeBlock(session, { ...base, source: 'codex-native' }); assert.equal(row.uiMessage, undefined); assert.equal(row.text, own.text);
  applyNativeBlock(session, base); applyNativeBlock(session, { id: base.id, nativeId: base.nativeId, kind: 'tool', delta: '\nRAW appended 中文' }); assert.equal(row.uiMessage, undefined); assert.equal(row.text, own.text + '\nRAW appended 中文');
  const journal = new ProgressJournal(); journal.update({ id: 'same', text: own.text, uiMessage: own.uiMessage }); const status = journal.update({ id: 'same', status: 'completed' }).item; assert.deepEqual(status.uiMessage, own.uiMessage);
  assert.equal(journal.update({ id: 'same', text: own.text }).item.uiMessage, undefined);
  journal.update({ id: 'same', text: own.text, uiMessage: own.uiMessage }); assert.equal(journal.update({ id: 'same', delta: '\nRAW appended' }).item.uiMessage, undefined);
});
