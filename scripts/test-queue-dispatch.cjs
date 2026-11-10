// Isolated desktop regression for space task queues (board top 2026-11-08 16:12) and
// session rotation (2026-11-08): the real desktop, main-process dispatcher and
// workspace service, with a synthetic provider transport. No native process, no model.
const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');

const root = path.resolve(__dirname, '..');
const code = process.env.NAW_TEST_APP_ROOT || root;
// This script now measures real layout, which needs the shared single-GUI slot every other
// desktop script takes (scripts/test-dialog-lifecycle.cjs): a second interface would move windows.
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock');
const token = randomUUID();
let slotOwned = false;
try {
  fs.mkdirSync(slot);
} catch (error) {
  if (error.code !== 'EEXIST') {
    throw error;
  }
  console.error('GUI slot occupied; nothing started.');
  process.exit(75);
}
slotOwned = true;
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'queue-dispatch-test', task: 'queue outcomes and decision notifications', token, pid: process.pid, time: new Date().toISOString() }));
function releaseSlot() {
  if (!slotOwned) return;
  try {
    if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token === token) {
      fs.rmSync(slot, { recursive: true }); slotOwned = false;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// A failed Electron close must not strand our lease after scratch cleanup exits.
process.once('exit', releaseSlot);
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-queue-dispatch-'));
const version = require(path.join(code, 'package.json')).version;
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/queue-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
// The acceptance from the board: the next item arrives within one minute.
const DISPATCH_LIMIT_MS = 60000;
let app;
let page;
let client;
let sequence = 0;
const errors = [];
const passed = [];
const timings = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, limit = 30000) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (await check()) {
      return Date.now() - started;
    }
    await delay(200);
  }
  throw Error(label);
}

function fixture(method, session = null, reply = '') {
  sequence += 1;
  const id = sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', listener);
      reject(Error('Fixture timeout'));
    }, 5000);
    const listener = message => {
      if (message.requestId === id) {
        clearTimeout(timer);
        child.off('message', listener);
        resolve(message);
      }
    };
    child.on('message', listener);
    child.send({ id, method, session, reply });
  });
}

async function sends() {
  return (await fixture('stats')).sends;
}

async function release(session, reply) {
  const result = await fixture('release', session, reply);
  assert.equal(result.released, true, `release ${reply}`);
}

const snapshot = () => page.evaluate(() => workspace.initial());

async function queue() {
  const state = await snapshot();
  const room = (state.rooms || [state.room]).find(r => r.id === 'shared');
  return room.queue || [];
}

async function events() {
  const state = await snapshot();
  const room = (state.rooms || [state.room]).find(r => r.id === 'shared');
  const texts = [];
  for (const event of room.events || []) {
    texts.push(event.text);
  }
  return texts;
}

async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR) {
    return;
  }
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png'), timeout: 5000 });
}

async function launch(extraEnv = {}) {
  assert.ok(!app, 'One test UI at a time');
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: '3000', ...extraEnv };
  let executablePath = require('electron');
  let args = [root];
  if (process.env.NAW_TEST_DECISION_NOTICE === '1') {
    assert.ok(!process.env.NAW_APP_EXECUTABLE, 'Decision notification fixture is source-only');
    const source = path.join(profile, 'source-app'); fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'naw-decision-test', version, main: 'entry.cjs' }));
    fs.writeFileSync(path.join(source, 'entry.cjs'), `require(${JSON.stringify(path.join(__dirname, 'fixtures/decision-notification.cjs'))});\nrequire(${JSON.stringify(path.join(code, 'app/main.cjs'))});\n`);
    args = [source];
  }
  if (process.env.NAW_APP_EXECUTABLE) {
    executablePath = process.env.NAW_APP_EXECUTABLE;
    args = [];
  }
  app = await _electron.launch({ executablePath, args, env, timeout: 70000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.NAW_TEST_DECISION_NOTICE === '1') {
    page.on('console', message => { if (message.type() === 'error') console.error('Renderer:', message.text()); });
    page.on('requestfailed', request => console.error('Request failed:', new URL(request.url()).pathname, request.failure()?.errorText));
  }
  await page.locator('#new-session').waitFor({ timeout: 60000 });
}

async function relaunch(extraEnv) {
  await app.close();
  app = null;
  await launch(extraEnv);
}

async function createMember(name) {
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name);
  await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name), `Created ${name}`);
  if (process.env.NAW_TEST_UI_LANGUAGE === 'en') {
    await page.locator('#session-header-more').click();
    await page.getByRole('menuitem', { name: 'Join this space', exact: true }).click();
    await page.locator('#header-actions').getByRole('button', { name: 'Leave this space', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    await page.locator('#toast-close').click();
  } else await joinSpace(page);
  return (await snapshot()).sessions.find(s => s.name === name).id;
}

async function openSpace() {
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
}

async function addItem(text, assignee = '') {
  if (!(await page.locator('#queue-dialog').isVisible())) {
    await page.locator('#room-queue').click();
    await page.locator('#queue-dialog').waitFor();
  }
  await page.locator('#queue-text').fill(text);
  await page.locator('#queue-assignee').selectOption(assignee);
  await page.locator('#add-queue').click();
  await until(async () => (await queue()).some(item => item.text === text), `Queued ${text}`);
}

async function itemByText(text) {
  return (await queue()).find(item => item.text === text);
}

// The next send must reach this member with this text, within the board's one minute.
async function expectSend(count, session, pattern, label) {
  const elapsed = await until(async () => (await sends()).length >= count, label, DISPATCH_LIMIT_MS);
  const all = await sends();
  assert.equal(all.length, count, `${label}: exactly one new send`);
  const last = all[count - 1];
  assert.equal(last.id, session, `${label}: recipient`);
  assert.match(last.text, pattern, `${label}: text`);
  timings.push({ label, ms: elapsed });
  return elapsed;
}

async function expectQuiet(count, label, ms = 14000) {
  await delay(ms);
  assert.equal((await sends()).length, count, label);
}

// Every box and glyph the open queue dialog paints, measured once. Glyph rectangles, not element
// boxes: the overlap the person reported was text leaving its own box (scripts/test-space-files-density.cjs
// measures filenames the same way).
function queueLayout() {
  return page.evaluate(() => {
    const dialog = document.getElementById('queue-dialog');
    const outer = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    const innerRight = outer.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const label = element => element.id || element.className || element.tagName;
    const glyphs = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = [];
      for (const rect of range.getClientRects()) {
        rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
      return rects;
    };
    const rows = [];
    for (const row of dialog.querySelectorAll('.queue-row')) {
      const parts = [];
      for (const part of row.children) {
        parts.push({ label: label(part), box: part.getBoundingClientRect().toJSON(), title: part.title || '', glyphs: glyphs(part) });
      }
      rows.push({ item: row.dataset.queueItem, status: row.dataset.status, text: row.innerText, parts });
    }
    const past = [];
    for (const element of dialog.querySelectorAll('*')) {
      const box = element.getBoundingClientRect();
      if (!box.width && !box.height) {
        continue;
      }
      let over = box.right - innerRight;
      for (const glyph of glyphs(element)) {
        over = Math.max(over, glyph.right - innerRight);
      }
      if (over > 1) {
        past.push({ label: label(element), over: Math.round(over) });
      }
    }
    const chain = [];
    for (const link of dialog.querySelectorAll('#queue-rotation-list .rotation-chain li')) {
      const tops = new Set();
      for (const rect of glyphs(link)) {
        tops.add(Math.round(rect.top));
      }
      chain.push({ text: link.innerText, title: link.title, lines: tops.size });
    }
    return { innerRight, rows, past, chain, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, viewport: [innerWidth, innerHeight] };
  });
}

function overlapping(one, two) {
  return one.left < two.right - 0.5 && two.left < one.right - 0.5 && one.top < two.bottom - 0.5 && two.top < one.bottom - 0.5;
}

function rowCollisions(rows) {
  const found = [];
  for (const row of rows) {
    for (let i = 0; i < row.parts.length; i += 1) {
      for (let j = i + 1; j < row.parts.length; j += 1) {
        for (const one of row.parts[i].glyphs) {
          for (const two of row.parts[j].glyphs) {
            if (overlapping(one, two)) {
              found.push(`${row.item}: ${row.parts[i].label} painted over ${row.parts[j].label}`);
            }
          }
        }
      }
    }
  }
  return [...new Set(found)];
}

// Independent verification added 2026-11-09. Element boxes, not only glyphs: what was asked was
// whether the status box and the task text box overlap at all, which short text can hide.
function rowBoxCollisions(rows) {
  const found = [];
  for (const row of rows) {
    for (let i = 0; i < row.parts.length; i += 1) {
      for (let j = i + 1; j < row.parts.length; j += 1) {
        if (overlapping(row.parts[i].box, row.parts[j].box)) {
          found.push(`${row.status} ${row.item}: ${row.parts[i].label} box over ${row.parts[j].label} box`);
        }
      }
    }
  }
  return [...new Set(found)];
}

// Whether one line of the dialog is really on screen and on top: its own box is what the viewer's
// click would hit at its centre, and that centre is inside both the dialog and the window.
function visibleFact(selector) {
  return page.evaluate(target => {
    const element = document.querySelector(target);
    if (!element) {
      return { found: false };
    }
    element.scrollIntoView({ block: 'nearest' });
    const box = element.getBoundingClientRect();
    const port = document.getElementById('queue-dialog').getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    let hitsSelf = false;
    if (hit) {
      hitsSelf = hit === element || element.contains(hit);
    }
    let hitLabel = 'nothing';
    if (hit) {
      hitLabel = hit.id || hit.className || hit.tagName;
    }
    const insideDialog = x >= port.left && x <= port.right && y >= port.top && y <= port.bottom;
    const insideWindow = x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight;
    return {
      found: true,
      text: element.innerText,
      width: Math.round(box.width),
      height: Math.round(box.height),
      centre: [Math.round(x), Math.round(y)],
      hitsSelf,
      hitLabel,
      insideDialog,
      insideWindow,
    };
  }, selector);
}

// A name longer than the product's own 60-character limit cannot be stored (app/session-labels.cjs
// validateName), and this evaluate world cannot reach the renderer's state, so the over-limit case
// is written into the status lines and the member option of the render being measured. It runs as
// the last measurement: the next render replaces those nodes.
async function stretchQueueText(long) {
  const touched = await page.evaluate(text => {
    let count = 0;
    for (const status of document.querySelectorAll('#queue-list .queue-status')) {
      const head = status.textContent.split(' · ')[0];
      status.textContent = head + ' · ' + text;
      count += 1;
    }
    for (const option of document.querySelectorAll('#queue-assignee option')) {
      if (option.value) {
        option.textContent = text;
      }
    }
    return count;
  }, long);
  assert.ok(touched > 0, 'the over-limit name reached the rows that were measured');
}

// What the product does with a name past its limit, measured rather than assumed.
function renameOutcome(id, name) {
  return page.evaluate(async ([session, value]) => {
    try {
      await workspace.rename(session, value);
      return 'accepted';
    } catch (error) {
      let message = String(error);
      if (error && error.message) {
        message = error.message;
      }
      return 'refused: ' + message;
    }
  }, [id, name]);
}

// How the dialog fits the window, now that every settled row carries a third line.
function dialogFit() {
  return page.evaluate(() => {
    const dialog = document.getElementById('queue-dialog');
    const box = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    const form = document.getElementById('queue-form').getBoundingClientRect();
    return {
      overflowY: style.overflowY,
      scrollHeight: dialog.scrollHeight,
      clientHeight: dialog.clientHeight,
      dialogTop: Math.round(box.top),
      dialogBottom: Math.round(box.bottom),
      formHeight: Math.round(form.height),
      viewport: [innerWidth, innerHeight],
    };
  });
}

function assertRowLayout(layout, label) {
  assert.deepEqual(rowCollisions(layout.rows), [], `${label}: two pieces of text in one queue row are painted over each other`);
  assert.deepEqual(rowBoxCollisions(layout.rows), [], `${label}: two boxes in one queue row overlap`);
  assert.deepEqual(layout.past, [], `${label}: something in the queue dialog reaches past its right edge`);
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${label}: the dialog scrolls sideways, ${layout.scrollWidth} vs ${layout.clientWidth}`);
}

function assertReadable(fact, label) {
  assert.equal(fact.found, true, `${label}: the line is not in the dialog`);
  assert.ok(fact.width > 0 && fact.height > 0, `${label}: the line has no box`);
  assert.ok(fact.hitsSelf, `${label}: its centre hits ${fact.hitLabel} instead`);
  assert.ok(fact.insideDialog, `${label}: its centre is outside the dialog`);
  assert.ok(fact.insideWindow, `${label}: its centre is outside the window`);
}

async function decisionNoticeScenario(a, b) {
  const english = process.env.NAW_TEST_UI_LANGUAGE === 'en';
  const title = english ? 'NAW · Needs your decision' : 'NAW · 需要你决定';
  const question = english ? 'Merge the branch?' : '要不要合并分支？';
  const notices = () => app.evaluate(() => globalThis.decisionNotifications.map(n => n.options));
  const clipboardCount = () => execFileSync('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); String($.NSPasteboard.generalPasteboard.changeCount)"], { encoding: 'utf8' }).trim();
  const beforeClipboard = clipboardCount();
  await addItem('Decision task', a);
  await expectSend(1, a, /Decision task/, 'decision task dispatched');
  await release(a, (english ? 'Needs your decision: ' : '需要你决定：') + question + '\nPRIVATE second line');
  await until(async () => (await itemByText('Decision task')).status === 'waiting', 'Decision settled');
  const decision = (await snapshot()).rooms.find(r => r.id === 'shared').events.findLast(e => e.uiMessage?.key === 'notice.queue.waiting');
  assert.ok(decision?.id);
  await until(async () => (await notices()).length === 1, 'One decision notification', 5000);
  assert.deepEqual((await notices())[0], { title, body: english ? `队员甲 · Shared work: ${question}` : `队员甲 · 共同工作：${question}` });
  await page.locator('#close-queue').click();
  await page.locator(`#session-list .session-link[data-session-id="${b}"]`).click();
  // Preserve a real user draft while the notification navigates away.
  if (await page.locator('#chat-tab').isVisible()) await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill('Unsent B1 draft');
  await page.reload(); await page.locator('#new-session').waitFor(); await delay(3500);
  assert.equal((await notices()).length, 1, 'No repeat after refresh and another dispatcher tick');
  await app.evaluate(() => globalThis.decisionNotifications[0].emit('click'));
  await page.waitForFunction(id => {
    const row = document.querySelector('[data-search-target="true"]');
    return row?.dataset.messageId === id && document.activeElement === row;
  }, decision.id);
  await capture('decision-record-' + (english ? 'en' : 'zh'));
  await page.locator(`#session-list .session-link[data-session-id="${b}"]`).click();
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent B1 draft');
  await page.locator('#message-input').fill('');
  await openSpace();
  await fixture('fail-next-send', b);
  await addItem('Failure task', b);
  await until(async () => (await itemByText('Failure task')).status === 'failed', 'Synthetic send error settles failed');
  await until(async () => (await notices()).length === 2, 'One failure notification', 5000);
  const failure = (await notices())[1];
  assert.equal(failure.title, english ? 'NAW · Task not delivered' : 'NAW · 派活没有完成');
  assert.ok(failure.body.includes('Failure task')); assert.ok(!failure.body.includes('Synthetic send failure'));
  assert.equal(clipboardCount(), beforeClipboard, 'Clipboard change count unchanged');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ decisionNotification: (await notices())[0], failure, eventId: decision.id, dedup: true, exactRowFocused: true, draftPreserved: true, clipboardUnchanged: true, nativeProviderProcessesByConstruction: 0, modelCallsByConstruction: 0, timings }));
}

async function run() {
  console.log('Fixture profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  client = await connect(profile, 'queue-test');
  await launch();
  await revealDefaultSpace(page);
  const a = await createMember('队员甲');
  const b = await createMember('队员乙');
  await openSpace();
  if (process.env.NAW_TEST_DECISION_NOTICE === '1') return decisionNoticeScenario(a, b);

  // 1) Two idle members each get exactly one item; NAW, not the person, sends them.
  await addItem('任务一');
  await expectSend(1, a, /【NAW 派活】[\s\S]*任务一/, 'first item to the first idle member');
  await addItem('任务二');
  await expectSend(2, b, /【NAW 派活】[\s\S]*任务二/, 'second item to the other idle member');
  assert.equal((await itemByText('任务一')).status, 'sent');
  assert.ok((await events()).includes('NAW 派活：任务一 → 队员甲'), 'dispatch record in the space');
  await capture('two-dispatched');
  passed.push('Each idle member received exactly one queued item, recorded in the space');

  // 2) Busy members get nothing more; finishing one item brings the next within one minute.
  await addItem('任务三');
  await expectQuiet(2, 'No item while both members work');
  await release(a, '任务一完成');
  await expectSend(3, a, /任务三/, 'next item after the member finished');
  assert.equal((await itemByText('任务一')).status, 'done');
  passed.push('A member that finished got the next item within one minute; nothing was sent while members worked');

  // 3) A paused member is skipped until the person turns automatic messages back on.
  await page.evaluate(id => workspace.wakePolicy(id, false), b);
  await release(b, '任务二完成');
  await addItem('任务四', b);
  await expectQuiet(3, 'Paused member receives nothing');
  assert.equal((await itemByText('任务四')).status, 'queued');
  await page.evaluate(id => workspace.wakePolicy(id, true), b);
  await expectSend(4, b, /任务四/, 'item after the member was unpaused');
  passed.push('A paused member was not sent its item until unpaused');

  // 4) A reply that asks for a decision stops that member until the person marks it handled.
  await release(a, '需要你决定：要不要合并分支？');
  await until(async () => (await itemByText('任务三')).status === 'waiting', 'Waiting for decision');
  assert.ok((await events()).includes('队员甲 需要你决定：任务三'), 'decision record in the space');
  await addItem('任务五', a);
  await expectQuiet(4, 'No new item while a decision is pending');
  const waitingId = (await itemByText('任务三')).id;
  await page.locator(`#queue-list [data-queue-item="${waitingId}"]`).getByRole('button', { name: '已处理', exact: true }).click();
  await expectSend(5, a, /任务五/, 'item after the person handled the decision');
  await capture('decision-handled');
  passed.push('A decision request paused that member until the person marked it handled');

  // 5) A cancelled item is never sent.
  await addItem('任务六', b);
  const cancelId = (await itemByText('任务六')).id;
  await page.locator(`#queue-list [data-queue-item="${cancelId}"]`).getByRole('button', { name: '取消', exact: true }).click();
  await until(async () => (await itemByText('任务六')).status === 'cancelled', 'Cancelled');
  await release(b, '任务四完成');
  await expectQuiet(5, 'A cancelled item is not sent');
  passed.push('A cancelled item was not sent');

  // 5b) A member whose chat view the person has open and leaves alone still receives work.
  if (await page.locator('#queue-dialog').isVisible()) {
    await page.locator('#close-queue').click();
    await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  }
  await page.locator(`#session-list .session-link[data-session-id="${b}"]`).click();
  if (await page.locator('#chat-tab').isVisible()) {
    await page.locator('#chat-tab').click();
  }
  await page.evaluate(([id, text]) => workspace.spaceAction('shared', 'queueAdd', [text, id]), [b, '任务九']);
  await expectSend(6, b, /任务九/, 'item to a member whose view is open and idle');
  passed.push('A member whose view the person had open, but left alone, still received its item');

  // 6) Session rotation: an old member writes a handoff, a new member continues, the old one ends.
  await release(a, '任务五完成');
  await relaunch({ NAW_TEST_QUEUE_CONTENT_LIMIT: '2' });
  await openSpace();
  await addItem('任务七', a);
  await expectSend(7, a, /【NAW 换会话】[\s\S]*只写交接/, 'handoff request to the old member');
  assert.equal((await itemByText('任务七')).status, 'queued', 'The old member does not get new work');
  await release(a, '交接：在 feature-x 分支，下一步跑全量测试。');
  await until(async () => (await snapshot()).sessions.some(s => s.name === '队员甲 · 续'), 'New member created', DISPATCH_LIMIT_MS);
  const fresh = (await snapshot()).sessions.find(s => s.name === '队员甲 · 续').id;
  await expectSend(8, fresh, /你接手「队员甲」[\s\S]*feature-x 分支/, 'handoff to the new member');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).state === 'ended', 'Old member ended');
  assert.equal((await itemByText('任务七')).assignee, fresh, 'The queue follows the new member');
  const rotated = (await events()).some(text => /^NAW 换会话：「队员甲（[0-9a-f]{6}）」的工作已交给「队员甲 · 续（[0-9a-f]{6}）」/.test(text));
  assert.ok(rotated, 'rotation record in the space names both sessions with their ids');
  // The queue dialog lists the sessions behind this conversation, oldest first, with full ids.
  if (!(await page.locator('#queue-dialog').isVisible())) {
    await page.locator('#room-queue').click();
  }
  await page.locator('#queue-rotations').waitFor();
  await page.locator('#queue-rotations summary').click();
  const chain = await page.locator('#queue-rotation-list .rotation-chain li').allInnerTexts();
  assert.equal(chain.length, 2);
  const chainTitles = await page.locator('#queue-rotation-list .rotation-chain li').evaluateAll(links => links.map(link => link.title));
  assert.ok(chainTitles[0].includes(a) && chainTitles[1].includes(fresh), 'old then new session ids, in full, on each link');
  await capture('rotation-chain');
  await release(fresh, '已核对交接。');
  await expectSend(9, fresh, /任务七/, 'queued item to the new member');
  await capture('rotated');
  passed.push('An old member wrote a handoff; a new member took over its queue; the old process ended');

  // 7) The dialog the person reads. A member auto-named from its first request can be a whole
  // 60-character sentence (app/workspace.cjs), which is what painted over the task text and pushed
  // the form past the dialog edge on 2026-11-09.
  await page.locator('#close-queue').click();
  await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  const LONG_NAME = 'Codex · 你现在是这个协作空间的秘书,原来的秘书不称职,你接替它的位置赶快开始干活不要再问我任何问题谢谢配合不胜感';
  assert.equal([...LONG_NAME].length, 60, 'the worst case is the product limit, not an arbitrary length');
  await page.evaluate(([id, name]) => workspace.rename(id, name), [fresh, LONG_NAME]);
  await until(async () => (await snapshot()).sessions.find(s => s.id === fresh).name === LONG_NAME, 'The member carries a 60-character name');

  // V1) Independent verification: what the person photographed was an item still in progress
  // (「进行中 · <60-character name>」). The author measured only after that item had settled, and
  // with 「谁空闲谁做」 selected, which is the narrowest the form's select ever is.
  await page.locator('#room-queue').click();
  await page.locator('#queue-dialog').waitFor();
  await page.locator('#queue-assignee').selectOption(fresh);
  const sentId = (await itemByText('任务七')).id;
  assert.equal((await itemByText('任务七')).status, 'sent', 'the measured item is still in progress');
  const sentLayout = await queueLayout();
  console.log(JSON.stringify({ verifierSentRowAt60: sentLayout }));
  await capture('verifier-sent-60');
  assertRowLayout(sentLayout, 'in progress at a 60-character name');
  const sentRow = sentLayout.rows.find(row => row.item === sentId);
  assert.ok(sentRow.text.includes(LONG_NAME), `the in-progress row names its recipient: ${sentRow.text}`);
  const sentStatus = await visibleFact(`#queue-list [data-queue-item="${sentId}"] .queue-status`);
  console.log(JSON.stringify({ verifierSentStatus: sentStatus }));
  assertReadable(sentStatus, 'the in-progress status line');
  assert.ok(sentStatus.text.includes(LONG_NAME), 'the recipient is in the status line itself, not only in the row');
  passed.push('An item still in progress names its recipient readably at the 60-character limit, with that member selected in the form');
  await page.locator('#close-queue').click();
  await page.locator('#queue-dialog').waitFor({ state: 'hidden' });

  await release(fresh, '收到');
  await until(async () => (await itemByText('任务七')).status === 'done', '任务七 finished', DISPATCH_LIMIT_MS);
  assert.equal((await sends()).length, 9, 'settling the last item sends nothing new');
  assert.equal((await itemByText('任务七')).reply, '收到', 'the reply is kept on the item');
  await page.locator('#room-queue').click();
  await page.locator('#queue-dialog').waitFor();
  await page.locator('#queue-rotations').evaluate(element => { element.open = true; });
  await page.locator('#queue-rotation-list .rotation-chain li').first().waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layout = await queueLayout();
  console.log(JSON.stringify({ queueLayout: layout }));
  await capture('queue-layout');
  assert.deepEqual(rowCollisions(layout.rows), [], 'two pieces of text in one queue row are painted over each other');
  assert.deepEqual(layout.past, [], 'something in the queue dialog reaches past its right edge');
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `the dialog scrolls sideways: ${layout.scrollWidth} vs ${layout.clientWidth}`);
  const done = layout.rows.find(row => row.status === 'done' && row.text.includes('任务七'));
  assert.ok(done, 'the finished item is listed');
  assert.ok(done.text.includes(LONG_NAME), 'the finished row names the member that received it');
  assert.ok(done.text.includes('收到'), 'the finished row shows what came back');
  assert.equal(layout.chain.length, 2);
  for (const link of layout.chain) {
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(link.text), false, `a rotation link still prints a whole id: ${link.text}`);
  }
  assert.equal(layout.chain[0].text.includes(a), false, 'the old link shows a short id');
  assert.ok(layout.chain[0].text.includes(a.slice(0, 6)), `the old link shows the sidebar's short id: ${layout.chain[0].text}`);
  assert.ok(layout.chain[0].lines <= 2, `a short-named rotation link wraps over ${layout.chain[0].lines} lines: ${layout.chain[0].text}`);
  assert.ok(layout.chain[0].title.includes(a) && layout.chain[1].title.includes(fresh), 'the whole ids stay reachable on each link');
  passed.push('At a 60-character member name no queue row overlaps, nothing leaves the dialog, the finished row names its member and its reply, and rotation links are short with full ids reachable');

  // 7b) The person could not find the queue: its button was only in the 「记录」 tab's tools.
  await page.locator('#close-queue').click();
  await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  await page.locator('#room-overview').click();
  await until(async () => await page.locator('#room-overview').getAttribute('aria-pressed') === 'true', 'The space is on its overview tab');
  assert.equal(await page.locator('.timeline-tools').isVisible(), false, 'the record tools stay hidden on the overview tab');
  await page.locator('#room-tabs').getByRole('button', { name: '队列', exact: true }).click();
  await page.locator('#queue-dialog').waitFor();
  await capture('queue-from-overview');
  const nativeWindow = await app.browserWindow(page);
  const bounds = await nativeWindow.evaluate(win => win.getBounds());
  try {
    await nativeWindow.evaluate(win => win.setSize(850, 600));
    await until(async () => (await page.evaluate(() => innerWidth)) <= 860, 'The window narrowed to the supported minimum');
    const tabs = await page.evaluate(() => {
      const buttons = [];
      for (const button of document.querySelectorAll('#room-tabs button')) {
        if (button.hidden) {
          continue;
        }
        const box = button.getBoundingClientRect();
        buttons.push({ id: button.id || button.className, right: Math.round(box.right), bottom: Math.round(box.bottom) });
      }
      return { viewport: [innerWidth, innerHeight], buttons };
    });
    console.log(JSON.stringify({ roomTabsAtMinimumWindow: tabs }));
    assert.ok(tabs.buttons.some(button => button.id === 'room-queue'), 'the queue button is one of the space tabs');
    for (const button of tabs.buttons) {
      assert.ok(button.right <= tabs.viewport[0] + 1 && button.bottom <= tabs.viewport[1] + 1, `${button.id} leaves the minimum window`);
    }
  } finally {
    await nativeWindow.evaluate((win, size) => win.setBounds(size), bounds);
  }
  passed.push('The queue button is reachable from the overview tab and the whole tab bar still fits the minimum window');

  // V2) Independent verification of what a settled row is read for: who received the item and what
  // came back, each measured as its own visible line rather than as a substring of the row text.
  const doneId = (await itemByText('任务七')).id;
  const doneStatus = await visibleFact(`#queue-list [data-queue-item="${doneId}"] .queue-status`);
  const doneOutcome = await visibleFact(`#queue-list [data-queue-item="${doneId}"] .queue-outcome`);
  console.log(JSON.stringify({ verifierDoneStatus: doneStatus, verifierDoneOutcome: doneOutcome }));
  assertReadable(doneStatus, 'the finished status line');
  assertReadable(doneOutcome, 'the finished outcome line');
  assert.ok(doneStatus.text.includes(LONG_NAME), 'the finished status line names the member that received the item');
  assert.equal(doneOutcome.text.trim(), '收到', `the finished outcome line is the reply: ${doneOutcome.text}`);

  // An item held for the person is the only row that carries both buttons beside its text, and the
  // hardest name is one unbroken token: the 60-character sentence above may wrap anywhere.
  const UNBROKEN_NAME = 'Codex-' + 'B'.repeat(54);
  assert.equal(UNBROKEN_NAME.length, 60, 'the unbroken name is the product limit too');
  await page.evaluate(([id, name]) => workspace.rename(id, name), [b, UNBROKEN_NAME]);
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).name === UNBROKEN_NAME, 'The other member carries an unbroken 60-character name');
  await release(b, '需要你决定：这条还要继续吗？');
  await until(async () => (await itemByText('任务九')).status === 'waiting', '任务九 waits for the person', DISPATCH_LIMIT_MS);
  assert.equal((await sends()).length, 9, 'holding an item for the person sends nothing new');
  const heldId = (await itemByText('任务九')).id;
  await page.locator('#queue-assignee').selectOption(b);
  const heldLayout = await queueLayout();
  console.log(JSON.stringify({ verifierHeldAt60Unbroken: heldLayout }));
  await capture('verifier-held-60-unbroken');
  assertRowLayout(heldLayout, 'a held row at an unbroken 60-character name');
  const heldRow = heldLayout.rows.find(row => row.item === heldId);
  assert.equal(heldRow.status, 'waiting', 'the held item is listed as waiting');
  assert.ok(heldRow.text.includes(UNBROKEN_NAME), `the held row names its recipient: ${heldRow.text}`);
  const heldButtons = heldRow.parts.find(part => part.label === 'queue-actions');
  assert.ok(heldButtons.box.width > 0, 'the held row carries its buttons');
  const heldOutcome = await visibleFact(`#queue-list [data-queue-item="${heldId}"] .queue-outcome`);
  console.log(JSON.stringify({ verifierHeldOutcome: heldOutcome }));
  assertReadable(heldOutcome, 'the held outcome line');
  assert.ok(heldOutcome.text.includes('这条还要继续吗'), `the held row shows what the member asked: ${heldOutcome.text}`);

  // How tall the dialog is now, at this window and at the supported minimum.
  const fitWide = await dialogFit();
  const smallWindow = await app.browserWindow(page);
  const wideBounds = await smallWindow.evaluate(win => win.getBounds());
  let fitNarrow;
  let narrowStatus;
  let narrowOutcome;
  let narrowAdd;
  try {
    await smallWindow.evaluate(win => win.setSize(850, 600));
    await until(async () => (await page.evaluate(() => innerWidth)) <= 860, 'The window narrowed to the supported minimum');
    fitNarrow = await dialogFit();
    narrowStatus = await visibleFact(`#queue-list [data-queue-item="${doneId}"] .queue-status`);
    narrowOutcome = await visibleFact(`#queue-list [data-queue-item="${doneId}"] .queue-outcome`);
    narrowAdd = await visibleFact('#add-queue');
    await capture('verifier-850x600');
  } finally {
    await smallWindow.evaluate((win, size) => win.setBounds(size), wideBounds);
  }
  console.log(JSON.stringify({ verifierDialogFit: { wide: fitWide, narrow: fitNarrow }, narrowStatus, narrowOutcome, narrowAdd }));
  assertReadable(narrowStatus, 'the finished status line at the minimum window');
  assertReadable(narrowOutcome, 'the finished outcome line at the minimum window');
  assertReadable(narrowAdd, 'the add button at the minimum window');
  for (const fit of [fitWide, fitNarrow]) {
    assert.ok(fit.dialogBottom <= fit.viewport[1] + 1 && fit.dialogTop >= -1, `the dialog hangs outside the window: ${JSON.stringify(fit)}`);
    assert.ok(fit.scrollHeight <= fit.clientHeight + 1 || fit.overflowY === 'auto' || fit.overflowY === 'scroll', `the dialog is taller than its box and does not scroll: ${JSON.stringify(fit)}`);
  }
  passed.push('A finished row shows its recipient and its reply as visible lines, a held row keeps both buttons beside an unbroken 60-character name, and both stay readable in a 850x600 window');

  // V3) Past the product's own limit, as one unbroken token. The product refuses to store such a
  // name, so it is written into the rows and the member option for this last measurement only.
  const OVER_LIMIT = 'Codex-' + 'A'.repeat(120);
  const refusal = await renameOutcome(b, OVER_LIMIT);
  console.log(JSON.stringify({ productNameLimit: { length: OVER_LIMIT.length, refusal } }));
  assert.notEqual(refusal, 'accepted', 'the product stored a name past its own limit; measure that stored name instead');
  await stretchQueueText(OVER_LIMIT);
  const overLayout = await queueLayout();
  console.log(JSON.stringify({ verifierRowsAt126: overLayout }));
  await capture('verifier-rows-126');
  assert.ok(overLayout.rows.every(row => row.text.includes(OVER_LIMIT)), 'the measured rows are the stretched ones');
  assertRowLayout(overLayout, 'every row at a 126-character name');
  passed.push('At a 126-character name, past what the product accepts, no row overlaps and nothing leaves the dialog');

  assert.deepEqual(errors, []);
  assert.equal(app.windows().length, 1);
  console.log(JSON.stringify({ passed, timings, errors, syntheticDispatches: (await sends()).length, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}

run().catch(async error => {
  console.error(error.stack);
  if (page) {
    await capture('failed').catch(failure => console.error('Screenshot:', failure.message));
  }
  process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  if (app) {
    await app.close();
  }
  if (client) {
    const state = await client.call('initial');
    for (const session of state.sessions) {
      if (session.state !== 'ended') {
        await client.call('stop', session.id);
      }
    }
    await client.call('shutdown');
    client.close();
  }
  if (child.connected) {
    child.disconnect();
  }
  releaseSlot();
}));
