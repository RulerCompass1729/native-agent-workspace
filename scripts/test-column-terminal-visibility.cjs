// T135/T166: a live member terminal remains visible while its input route is chat.
// Real source GUI/service, existing synthetic provider; no real native engine/model.
if (process.argv[2] !== '--run' || !process.env.NAW_EVIDENCE_DIR) {
  console.error('Supply --run and an external NAW_EVIDENCE_DIR; nothing started.'); process.exit(64);
}
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR), token = randomUUID();
const common = require('node:child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock');
const sha = file => createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex');
const sourcePins = Object.fromEntries(['app/renderer/renderer.js', 'app/dsh/client.js'].map(file => [file, sha(file)]));
assert.ok(fs.readFileSync(path.join(code, 'app/dsh/client.js'), 'utf8').includes(fs.readFileSync(path.join(code, 'app/renderer/renderer.js'), 'utf8')), 'Build the exact renderer first');
const result = { at: new Date().toISOString(), token, checks: [], errors: [], sourcePins, realNativeEngines: 0, productModels: 0, realProviders: 0 };
let scratch, daemon, client, app, guiChild, page, parent, profile, identity, admitted = false, started, request = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = name => fs.writeFileSync(path.join(evidence, name), JSON.stringify(result, null, 2) + '\n');
async function op(fn, limit = 10000) {
  const left = 180000 - (Date.now() - started); assert.ok(left > 0, '180 second active limit');
  let timer;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bounded operation timed out')), Math.min(left, limit)); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, label) {
  for (let i = 0; i < 120; i++) { if (await op(fn)) return; await delay(50); }
  throw Error(label);
}
function fixture(method, target, value) {
  return op(() => new Promise((resolve, reject) => {
    const id = ++request;
    const done = reply => { if (reply.requestId !== id) return; clearTimeout(timer); daemon.off('message', done); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { daemon.off('message', done); reject(Error('Owned fixture timed out')); }, 5000);
    daemon.on('message', done); daemon.send({ id, method, target, value });
  }));
}
const snapshot = () => op(() => page.evaluate(() => workspace.initial()));
const reader = id => page.locator(`.collaboration-member-reader[data-member-id="${id}"]`);
const field = id => reader(id).locator('form[data-composer-session] textarea');
const terminal = id => page.locator(`[data-terminal-id="${id}"]`);
const note = text => { result.checks.push(text); write('progress.json'); };
async function capture(label, id) {
  result[label] = await op(() => page.evaluate(id => window.__liveColumn.read(id), id));
  await op(() => page.screenshot({ path: path.join(evidence, label + '.png') })); write('progress.json');
}
const identities = value => value.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner, cwd: s.cwd, draft: s.liveDraft }));

async function main() {
  try {
    try { fs.mkdirSync(slot, { mode: 0o700 }); identity = fs.lstatSync(slot); admitted = true; }
    catch (error) { if (error.code === 'EEXIST') { console.error('GUI slot occupied; zero allocations.'); process.exitCode = 75; return; } throw error; }
    fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T135/T166 live chat-view column terminal', token, pid: process.pid, at: result.at }));
    started = Date.now(); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
    assert.ok(!fs.existsSync(path.join(evidence, 'admitted.json')), 'One attempt per evidence folder');
    fs.writeFileSync(path.join(evidence, 'admitted.json'), JSON.stringify({ at: result.at, token, pid: process.pid }));
    scratch = require(path.join(code, 'scripts/fixtures/test-scratch.cjs'));
    parent = scratch.directory(path.join(os.tmpdir(), 'naw-live-column-')); profile = path.join(parent, 'profile');
    const cwd = path.join(parent, 'workspace'); fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(cwd, { mode: 0o700 });
    Object.assign(result, { parent, profile });
    daemon = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
      execArgv: ['--require', path.join(code, 'scripts/fixtures/column-input.cjs')],
      env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    result.daemonPid = daemon.pid; daemon.stderr.pipe(fs.createWriteStream(path.join(evidence, 'daemon.log')));
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic backend ready');
    client = await op(() => require(path.join(code, 'app/service-client.cjs')).connectService(profile, 'live-column-setup'));
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const id = await op(() => client.call('create', { provider: i ? 'claude' : 'codex', name: i ? 'Synthetic peer' : 'Synthetic Main', view: 'chat', cwd }));
      ids.push(id); await op(() => client.call('join', id, true)); await op(() => client.call('draft', id, 'POSITIVE_PRIVATE_DRAFT_' + i));
      await fixture('history', id, [{ id: 'original-' + i, type: 'agentMessage', turnId: 'original-turn-' + i, text: 'Original conversation remains above the same native terminal.' }]);
      await fixture('output', id, { cols: 80, rows: 24, data: '\x1bcORIGINAL_NATIVE_' + i + '\r\nSecond original line\x1b[4;7H' });
    }
    const [target, peer] = ids; result.ids = ids; result.target = target;
    const before = await op(() => client.call('initial')); result.beforeGUI = identities(before);
    const entry = require(path.join(code, 'scripts/fixtures/synthetic-source-boot.cjs')).createSourceEntry({ profile, code, fixturePid: daemon.pid });
    const { _electron } = scratch.playwright(require(path.join(root, 'node_modules/playwright')));
    app = await op(() => _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: [entry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 }), 65000);
    guiChild = app.process(); result.guiPid = guiChild.pid; page = await op(() => app.firstWindow()); page.setDefaultTimeout(7000);
    page.on('pageerror', error => result.errors.push(error.message)); await op(() => page.locator('#new-space').waitFor());
    await op(() => page.context().addInitScript(() => {
      const terms = new Map(), serials = new Map(); let constructor;
      Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => {
        constructor = value; const open = value.prototype.open;
        value.prototype.open = function(element, ...args) {
          const id = element.closest('[data-terminal-id]')?.dataset.terminalId;
          if (id) { terms.set(id, this); serials.set(id, (serials.get(id) || 0) + 1); }
          return open.call(this, element, ...args);
        };
      } });
      window.__liveColumn = { read(id) {
        const term = terms.get(id); if (!term) throw Error('Original public terminal was not observed');
        const node = term.element.closest('[data-terminal-id]'), host = node.closest('.column-native-host'), b = term.buffer.active;
        return { id, serial: serials.get(id), column: Boolean(host), visible: node.checkVisibility(), hostHeight: host?.getBoundingClientRect().height,
          cols: term.cols, rows: term.rows, cursor: [b.cursorX, b.cursorY], disableStdin: term.options.disableStdin,
          lines: Array.from({ length: b.length }, (_, n) => b.getLine(n).translateToString()) };
      } };
    }));
    await op(() => page.reload()); await op(() => page.locator('#new-space').waitFor());
    const win = await op(() => app.browserWindow(page));
    result.window = await op(() => win.evaluate(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
    assert.deepEqual(result.window, { visible: false, focusable: false });
    await op(() => win.evaluate(w => w.setContentSize(1240, 850)));
    await op(() => page.locator('#room-nav').click()); await op(() => page.getByRole('button', { name: '网格', exact: true }).click());
    for (const id of ids) {
      await op(() => reader(id).locator('.column-native-host').waitFor({ state: 'visible' }));
      await op(() => terminal(id).locator('.terminal-surface').waitFor({ state: 'visible' }));
      await until(() => page.evaluate(id => window.__liveColumn.read(id).lines.some(line => line.includes('ORIGINAL_NATIVE_')), id), 'Original native screen content');
    }
    const passive = await snapshot(); assert.deepEqual(identities(passive), result.beforeGUI);
    assert.ok(passive.sessions.every(s => s.view === 'chat' && s.terminalState.alive === true));
    result.passiveStats = await fixture('stats');
    assert.equal(result.passiveStats.overviewCalls.claim, 0, 'A visible native screen does not claim a view');
    assert.equal(result.passiveStats.stats.inputs, 0); assert.equal(result.passiveStats.stats.resizes, 0);
    await capture('01-live-chat-columns', target);
    note('Both live chat-view member terminals show original content without changing native identity, owner, drafts, view, input or canonical size');

    await op(() => page.evaluate(id => workspace.claim(id, 'chat'), target));
    await until(() => field(target).evaluate(el => !el.readOnly && !el.disabled), 'Explicit chat claim enables only the private chat composer');
    await op(() => field(target).fill('PRIVATE_DRAFT_WITH_CARET'));
    await until(async () => (await snapshot()).sessions.find(s => s.id === target).liveDraft === 'PRIVATE_DRAFT_WITH_CARET', 'Positive private draft saved');
    await op(() => field(target).evaluate(el => { el.setSelectionRange(3, 11); window.__originalPrivateField = el; }));
    await op(() => page.locator('#shared-input').fill('POSITIVE_SHARED_UNSENT_DRAFT'));
    const owned = await snapshot(), stable = identities(owned), stats = await fixture('stats');
    const screen = await op(() => page.evaluate(id => window.__liveColumn.read(id), target));
    assert.equal(screen.disableStdin, true, 'Chat-owned terminal is still read only');
    await op(() => terminal(target).locator('.xterm-helper-textarea').focus());
    await op(() => terminal(target).locator('.xterm-helper-textarea').press('x'));
    await delay(100); assert.equal((await fixture('stats')).stats.inputs, stats.stats.inputs, 'Keys in the read-only column do not reach native');
    note('An explicit chat claim retains terminal visibility; the native input gate still rejects a typed key');

    await op(() => page.locator('#room-record').click());
    await op(() => page.locator('#room-overview').click());
    await op(() => reader(target).locator('.column-native-host').waitFor({ state: 'visible' }));
    assert.deepEqual(identities(await snapshot()), stable);
    const returned = await op(() => page.evaluate(id => window.__liveColumn.read(id), target));
    assert.equal(returned.serial, screen.serial); assert.deepEqual(returned.cursor, screen.cursor); assert.deepEqual(returned.lines, screen.lines);
    assert.equal(await field(target).inputValue(), 'PRIVATE_DRAFT_WITH_CARET');
    assert.deepEqual(await op(() => field(target).evaluate(el => ({ same: el === window.__originalPrivateField, start: el.selectionStart, end: el.selectionEnd }))), { same: true, start: 3, end: 11 });
    assert.equal(await page.locator('#shared-input').inputValue(), 'POSITIVE_SHARED_UNSENT_DRAFT');
    const returnedStats = await fixture('stats');
    assert.equal(returnedStats.overviewCalls.claim, stats.overviewCalls.claim); assert.equal(returnedStats.stats.resizes, stats.stats.resizes);
    note('Shared records and overview return keep the same terminal instance/cursor, private field/caret, positive shared draft and input owner');

    await op(() => page.locator(`.collaboration-member-status[data-member-id="${target}"] .collaboration-member-name`).click());
    await op(() => page.locator('#chat-tab').click());
    assert.equal(await page.locator('#message-input').inputValue(), 'PRIVATE_DRAFT_WITH_CARET');
    const solo = await op(() => page.evaluate(id => window.__liveColumn.read(id), target)); assert.equal(solo.column, false); assert.equal(solo.serial, screen.serial);
    await op(() => page.locator('#room-overview').click());
    await op(() => reader(target).locator('.column-native-host').waitFor({ state: 'visible' }));
    assert.deepEqual(identities(await snapshot()), stable);
    await capture('02-after-solo-return', target);
    note('The complete member chat view and its existing overview return reuse the same native instance and private draft');

    await op(() => win.evaluate(w => w.setContentSize(850, 600)));
    for (const id of ids) {
      const geometry = await op(() => reader(id).evaluate(el => {
        const r = el.getBoundingClientRect(), host = el.querySelector('.column-native-host').getBoundingClientRect(), form = el.querySelector('form[data-composer-session]').getBoundingClientRect();
        return { paneBottom: r.bottom, terminalHeight: host.height, formBottom: form.bottom };
      }));
      assert.ok(geometry.terminalHeight >= 64 && geometry.formBottom <= geometry.paneBottom + 1);
    }
    await capture('03-narrow-live-chat', target);
    note('Narrow columns retain a visible terminal and whole private input without taking control');

    await op(() => reader(target).locator('.session-native-button').click());
    await until(async () => (await snapshot()).sessions.find(s => s.id === target).view === 'terminal', 'Explicit native button establishes the terminal input view');
    await until(() => page.evaluate(id => !window.__liveColumn.read(id).disableStdin, target), 'Only the explicit native action enables terminal input');
    const beforeInput = await fixture('stats');
    await op(() => terminal(target).locator('.xterm-helper-textarea').focus()); await op(() => terminal(target).locator('.xterm-helper-textarea').press('Escape'));
    await until(() => fixture('stats').then(r => r.stats.inputs === beforeInput.stats.inputs + 1), 'Positive known fake input witness');
    const afterInput = await fixture('stats');
    assert.equal(afterInput.columnInputs.at(-1).id, target); assert.equal(afterInput.columnInputs.at(-1).data, '\x1b');
    assert.deepEqual(identities(await snapshot()), stable);
    assert.equal((await snapshot()).sessions.find(s => s.id === peer).view, 'chat');
    assert.equal(afterInput.stats.inputs, 1); assert.equal(afterInput.stats.sends, 0);
    for (const key of ['send', 'queue', 'steer', 'forward', 'approve', 'answer', 'run', 'resume']) assert.equal(afterInput.overviewCalls[key], 0, key);
    assert.equal(afterInput.overviewCalls.pause, beforeInput.overviewCalls.pause + 1, 'The one explicit native key retains the existing human-input pause');
    result.finalStats = afterInput; result.finalState = await snapshot();
    assert.deepEqual(result.errors, []); assert.deepEqual(Object.fromEntries(Object.keys(sourcePins).map(file => [file, sha(file)])), sourcePins);
    await capture('04-explicit-native-control', target);
    note('Only the explicit native button plus one Escape reaches the original synthetic target; no message/model/provider call or peer input');
    result.outcome = 'PASS_LIVE_CHAT_COLUMN_TERMINAL_USER_JOURNEY';
  } catch (error) {
    result.failure = error.stack; result.outcome = 'INCOMPLETE_NOT_PASS'; process.exitCode = 1;
    if (page && !page.isClosed()) await op(() => page.screenshot({ path: path.join(evidence, 'failure.png') })).catch(() => {});
  } finally {
    if (admitted) {
      result.activeSeconds = (Date.now() - started) / 1000; write('result.json'); const t = Date.now();
      try {
        if (scratch) {
          scratch.cleanup(async () => { if (app) await app.close(); if (client) { await client.call('shutdown').catch(() => {}); client.close(); } });
          await scratch.release();
        }
        result.cleanup = { seconds: (Date.now() - t) / 1000, parentGone: !parent || !fs.existsSync(parent),
          daemonExited: !daemon || daemon.exitCode !== null || daemon.signalCode !== null, guiExited: !guiChild || guiChild.exitCode !== null || guiChild.signalCode !== null };
        assert.ok(result.cleanup.parentGone && result.cleanup.daemonExited && result.cleanup.guiExited && result.cleanup.seconds <= 90);
        const current = fs.lstatSync(slot); assert.ok(current.ino === identity.ino && current.dev === identity.dev && !current.isSymbolicLink());
        assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
        fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); result.releasedAt = new Date().toISOString(); write('released.json'); write('result.json');
      } catch (error) { result.cleanupError = error.stack; write('cleanup-unconfirmed.json'); process.exitCode = 1; }
      console.log(JSON.stringify({ outcome: result.outcome, checks: result.checks, failure: result.failure, cleanup: result.cleanup, releasedAt: result.releasedAt }));
    }
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
