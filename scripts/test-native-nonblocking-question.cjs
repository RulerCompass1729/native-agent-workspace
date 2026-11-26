const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual Electron + Codex 0.168 with the fixed loopback model, isolated credentials/config, hidden test window.
// One question that does not block its turn (request_user_input_async, isBlocking false) reaches 「等你」, the
// session view, the phone projection and the butler's record; answering it from 「等你」 reaches native, and the
// question then leaves each of them (11-15, the person: 「agent 需要问的问题我根本可能看不见」).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const loopback = require('./fixtures/loopback-model.cjs');
const boardWaiting = require('./fixtures/board-waiting.cjs'), locale = require('../app/ui-locale.js');
const assert = require('node:assert/strict'), { execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { connect } = require('../app/service-client.cjs');
const { MobileWorkspace } = require('../app/mobile-workspace.cjs');
const root = path.resolve(__dirname, '..'), temporary = testScratch.directory(path.join(os.tmpdir(), 'naw-native-nonblocking-'));
const base = process.env.NAW_EVIDENCE_DIR ? path.resolve(process.env.NAW_EVIDENCE_DIR, 'fixture', path.basename(temporary)) : temporary;
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const profile = path.join(temporary, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex'), userHome = path.join(base, 'home');
for (const p of [profile, cwd, home, userHome]) fs.mkdirSync(p, { mode: 0o700 });
const nativeVersion = '0.168.0', binary = executable('codex');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'codex-cli ' + nativeVersion);
const QUESTION = 'Which synthetic way should the check take?', FIRST = 'First synthetic way', SECOND = 'Second synthetic way';
let app, page, calls = 0, titles = 0, seq = 0, budgetError; const errors = [], checks = [], requests = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (budgetError) throw budgetError; if (await fn()) return; await sleep(80); } throw Error(label); }
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); assert.ok(ok, name + ' ' + JSON.stringify(detail ?? '')); };
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++seq, ...body })}\n\n`); }
// Codex 0.168 lists its tools in input items, inside namespaces (functions.request_user_input_async).
const toolNames = (tools, prefix = '') => (tools || []).flatMap(t => { const name = prefix + (t.name || t.type); return [name, ...toolNames(t.tools, name + '.')]; });
function send(res, response, item) {
  event(res, 'response.output_item.added', { output_index: 0, item: { ...item, ...(item.type === 'message' ? { status: 'in_progress', content: [] } : item.type === 'function_call' ? { arguments: '', status: 'in_progress' } : { input: '', status: 'in_progress' }) } });
  if (item.type === 'message') event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
  if (item.type === 'function_call') { event(res, 'response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: item.arguments }); event(res, 'response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments }); }
  event(res, 'response.output_item.done', { output_index: 0, item }); event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
}
// At most two task responses and one title: the question, then the reply after the answer.
const fixture = loopback.create({ directory: temporary, provider: 'codex', respond: async (req, res, body) => {
  if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  const input = JSON.parse(body), title = input.input?.some(m => m.role === 'user' && m.content?.some(p => p.text?.startsWith('Generate a concise, single-line task title')));
  const n = title ? 0 : ++calls; if (title) titles++;
  if (calls > 2 || titles > 1) { budgetError = Error('Native question task/title budget exceeded'); res.writeHead(400); res.end(budgetError.message); return; }
  fs.writeFileSync(path.join(base, `request-${title ? 'title-' + titles : n}.json`), JSON.stringify(input, null, 2));
  const offered = toolNames((input.input || []).flatMap(item => item.tools || []));
  requests.push({ n, title, offered: offered.filter(name => /user_input/.test(name)) });
  const response = { id: 'nb_' + seq, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' }); event(res, 'response.created', { response });
  if (n === 1) {
    // Default mode with default_mode_request_user_input: the optional question native sends with isBlocking false.
    // (request_user_input_async is another tool: its question is an ordinary transcript item, answered by a message.)
    if (!offered.includes('functions.request_user_input')) { budgetError = Error('Codex did not offer request_user_input: ' + offered.join(', ')); res.end(); return; }
    const args = { questions: [{ id: 'way', header: 'Way', question: QUESTION, options: [{ label: FIRST, description: 'Synthetic option one' }, { label: SECOND, description: 'Synthetic option two' }] }] };
    send(res, response, { id: 'nb_question', type: 'function_call', call_id: 'nb_question_call', namespace: 'functions', name: 'request_user_input', arguments: JSON.stringify(args), status: 'completed' });
    return;
  }
  const text = title ? JSON.stringify({ title: 'Synthetic question check' }) : 'NB_ANSWER_SEEN';
  send(res, response, { id: 'answer_' + seq, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
} });
const snapshot = () => page.evaluate(() => workspace.initial());
async function service(method, ...args) { const c = await connect(profile, 'native-nonblocking-read'); try { return await c.call(method, ...args); } finally { c.close(); } }
// The phone's projection of the service's own session, as mobile-workspace.cjs builds it for a paired phone.
async function phone() {
  const sessions = (await service('initial')).sessions, s = sessions[0];
  const view = await new MobileWorkspace({ snapshot: () => ({ sessions, rooms: [] }), roomState: {}, records: { status: () => null, acknowledge: () => {} } })
    .read({ refresh: async () => {}, route: () => ({ key: '.' }) }, { roomIds: [], records: false }, [{ serviceKey: '.', sessionId: s.id, nativeId: s.nativeId, actions: ['read'] }]);
  return view.sessions[0];
}
function ledger() {
  const file = path.join(profile, 'butler-ledger.jsonl'); if (!fs.existsSync(file)) return [];
  // Read-only: the event records butler-ledger.cjs appends, one JSON record per line.
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.type === 'event').map(r => r.data)
    .filter(e => /^native-question/.test(e.payload?.reason || ''));
}
(async () => {
  await fixture.start(); await fixture.preflight();
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\ncli_auth_credentials_store = "file"\n[features]\ndaemon_auto_start = false\ndefault_mode_request_user_input = true\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "${fixture.endpoint}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const shim = path.join(base, 'codex-local'); fixture.wrapper(binary, { file: shim, env: { CODEX_HOME: home, HOME: userHome } });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ codex: shim }), { mode: 0o600 });
  execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 70000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1240, height: 820 }).catch(() => {});
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill('Native question');
  const chosenFolder = await page.locator('#chosen-folder').innerText();
  assert.ok(path.isAbsolute(chosenFolder) && chosenFolder.startsWith(base + path.sep), 'Native test folder belongs to the owned fixture');
  fs.appendFileSync(path.join(home, 'config.toml'), `\n[projects.${JSON.stringify(chosenFolder)}]\ntrust_level = "trusted"\n`);
  await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native ready', 60000);
  // What waits for the person is on the task board (R250): a count on its button, a row per item that opens in place.
  const board = boardWaiting(page);
  check('nothing waits before the question', await board.need().isHidden());
  await page.locator('#message-input').fill('Ask me one synthetic question, then finish.'); await page.locator('#send-button').click();
  await until(async () => (await snapshot()).sessions[0].approval, 'Actual native question reaches NAW', 60000);
  const asked = await snapshot(), s = asked.sessions[0]; fs.writeFileSync(path.join(base, 'asked.json'), JSON.stringify(asked, null, 2));
  check('native sends item/tool/requestUserInput with isBlocking false', s.approval.method === 'item/tool/requestUserInput' && s.approval.params.isBlocking === false && s.approval.params.questions?.[0]?.question === QUESTION, s.approval);
  // Native's own status says its turn waits on this question (waitingOnUserInput): NAW lists it once, as the question.
  checks.push({ name: 'native turn status while the question is open', ok: true, detail: s.state });
  await board.need().waitFor();
  const need = await board.need().innerText();
  check('等你 +1', need === locale.format('zh', 'taskBoard.needOne', { count: 1 }), need);
  const viewForm = page.locator('#approval .question-form');
  check('the session view form is answerable', await viewForm.count() === 1 && await viewForm.locator('input[type=radio]').first().isEnabled());
  check('the phone home row says it needs you', (await phone()).question === true);
  check('the butler record has the open question once', JSON.stringify(ledger().map(e => [e.kind, e.payload.reason, e.payload.text])) === JSON.stringify([['blocked', 'native-question', QUESTION]]), ledger());
  if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-window-asked.png') });
  const row = await board.expand(`question:${s.id}:${s.approval.requestId}`), line = await row.locator('.task-board-entry').innerText();
  check('the 等你 row names the question and its session', line.includes(QUESTION) && line.includes('Native question'), line);
  check('the 等你 row is marked as not blocking', (await row.locator('.task-board-sub').innerText()) === '问题 · 不阻塞本轮');
  if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-board-asked.png') });
  const form = row.locator('.question-form'); await form.locator(`input[type=radio][value="${SECOND}"]`).check(); await form.locator(':scope > button').click();
  // Native resolves its own request only after it has the reply; the answer then reaches the model as the tool output.
  await until(async () => !(await snapshot()).sessions[0].approval, 'Native resolves the question after NAW answers', 30000);
  await until(async () => calls === 2, 'The answer reaches native and its next model input', 30000).catch(() => {});
  const second = fs.existsSync(path.join(base, 'request-2.json')) ? JSON.parse(fs.readFileSync(path.join(base, 'request-2.json'), 'utf8')) : null;
  const output = second?.input?.find(i => i.type === 'function_call_output' && i.call_id === 'nb_question_call')?.output || '';
  check('native received the chosen answer', output.includes(SECOND) && !output.includes(FIRST), { calls, output });
  await until(async () => board.need().isHidden(), '等你 clears');
  check('等你 -1', await board.need().isHidden());
  await board.close();
  check('the session view has no open question', await page.locator('#approval .question-form:visible').count() === 0);
  check('the phone row no longer needs you', (await phone()).question === false);
  await until(async () => ledger().length === 2, 'Butler record of the end');
  check('the butler record has the end once', JSON.stringify(ledger().map(e => e.payload.reason)) === JSON.stringify(['native-question', 'native-question-ended']), ledger());
  await until(async () => (await snapshot()).sessions[0].state === 'idle', 'Answer turn ends', 30000);
  if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-window-answered.png') });
  fs.writeFileSync(path.join(base, 'answered.json'), JSON.stringify(await snapshot(), null, 2));
  check('no page errors', errors.length === 0, errors);
  fixture.assertClean();
})().catch(async e => {
  console.error(e.stack, '\nEvidence:', base);
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ nativeVersion, checks, requests, calls, titles, paidModelCalls: 0, errors }, null, 2));
  console.log(JSON.stringify({ nativeVersion, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).map(c => c.name), localResponses: calls, nativeTitleResponses: titles, paidModelCalls: 0, evidence: base }));
  if (app) await app.close().catch(() => {});
  try { const c = await connect(profile, 'native-nonblocking-cleanup'); try { for (const s of (await c.call('initial')).sessions) await c.call('stop', s.id); const owned = c.entries.map(e => processIdentity(e.state.servicePid)); for (const p of owned) { assert.ok(p && processMayBeAlive(p)); process.kill(p.pid, 'SIGTERM'); } await until(() => owned.every(p => !processMayBeAlive(p)), 'Owned service exit', 15000); } finally { c.close(); } } catch (e) { console.error('Cleanup:', e.message); process.exitCode = 1; }
  await fixture.stop();
}));
