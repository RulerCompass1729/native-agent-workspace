// Real isolated GUI and service with a synthetic provider; no model runs.
// Shows in an actual window that the bound engages: once the page is ready the main process sends
// numbered snapshots, the page's acknowledgements flow back (otherwise no second numbered snapshot would
// ever be sent), a page that is slow is sent fewer snapshots than were produced, and the last state
// arrives. That at most one snapshot is unacknowledged at a time is proven by the unit tests of the gate;
// this script observes its effect, the reduced number of sends, not the acknowledgement times.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scratch = require('./fixtures/test-scratch.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs');

const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock');
const token = randomUUID();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let app;
let page;
let child;
let profile;
let requestNumber = 0;
const errors = [];

async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return;
    }
    await delay(50);
  }
  throw Error(label);
}

function fixture(method, target, value) {
  requestNumber += 1;
  const id = requestNumber;
  return new Promise((resolve, reject) => {
    const callback = reply => {
      if (reply.requestId !== id) {
        return;
      }
      clearTimeout(timer);
      child.off('message', callback);
      resolve(reply);
    };
    const timer = setTimeout(() => {
      child.off('message', callback);
      reject(Error('Synthetic fixture timed out'));
    }, 12000);
    child.on('message', callback);
    child.send({ id, method, target, value });
  });
}

// What the main process sent on the full-state channel, in order: the sequence of each send.
function recordedSequences() {
  return app.evaluate(() => globalThis.stateSendSequences.slice());
}

async function run() {
  // One canonical GUI slot. Do not interfere with another runner's lease.
  try {
    fs.mkdirSync(slot);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    console.error('GUI slot occupied; nothing launched.');
    process.exitCode = 75;
    return;
  }
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 终端', task: 'state push bound', token, pid: process.pid, time: new Date().toISOString() }));
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-state-push-'));
  const cwd = path.join(profile, 'workspace');
  fs.mkdirSync(cwd);
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service ready');
  app = await _electron.launch({
    executablePath: require('electron'),
    args: [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' },
    timeout: 70000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));

  // Record every full-state send of every window from here on.
  await app.evaluate(({ webContents }) => {
    globalThis.stateSendSequences = [];
    for (const contents of webContents.getAllWebContents()) {
      const original = contents.send.bind(contents);
      contents.send = (channel, ...data) => {
        if (channel === 'workspace:state') {
          globalThis.stateSendSequences.push(data[1]);
        }
        return original(channel, ...data);
      };
    }
  });

  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('Synthetic push history');
  await createIn(page, 'chat');
  const id = await page.evaluate(async () => (await workspace.initial()).sessions.find(session => session.name === 'Synthetic push history').id);
  const text = 'Synthetic original body. '.repeat(84);
  const history = Array.from({ length: 400 }, (_, index) => ({ id: 'push-' + index, type: 'agentMessage', turnId: 'push-turn-' + index, text: index + ': ' + text }));
  await fixture('history', id, history);
  await page.locator('#messages [data-message-id="push-399"] .message-body p').first().waitFor();
  await fixture('release', id);

  // Phase 1: an ordinary page. Each change is rendered before the next one is produced.
  for (let index = 0; index < 12; index += 1) {
    const messageId = 'push-live-' + index;
    await fixture('delta', id, { id: messageId, text: 'New synthetic row ' + index });
    await page.locator('#messages [data-message-id="' + messageId + '"] .message-body p').first().waitFor();
  }
  const ordinary = await recordedSequences();
  const numbered = ordinary.filter(sequence => sequence > 0);
  assert.ok(numbered.length >= 12, 'The ready page receives numbered snapshots: the bound is armed (' + JSON.stringify(ordinary.slice(-20)) + ')');
  numbered.forEach((sequence, index) => {
    assert.equal(sequence, numbered[0] + index, 'Numbered snapshots are consecutive from the first one');
  });
  const firstNumbered = ordinary.indexOf(numbered[0]);
  assert.ok(ordinary.slice(firstNumbered).every(sequence => sequence > 0), 'After the bound is armed no snapshot bypasses it');

  // Phase 2: a slow page. Every state now costs the page a fixed time, and changes are produced without
  // waiting for the page.
  await page.evaluate(() => {
    globalThis.slowStateCount = 0;
    workspace.onState(() => {
      globalThis.slowStateCount += 1;
      const until = performance.now() + 120;
      while (performance.now() < until) {}
    });
  });
  const before = (await recordedSequences()).length;
  const produced = 80;
  for (let index = 0; index < produced; index += 1) {
    await fixture('delta', id, { id: 'push-flood-' + index, text: 'Flood synthetic row ' + index });
    await delay(40);
  }
  const lastId = 'push-flood-' + (produced - 1);
  await page.locator('#messages [data-message-id="' + lastId + '"] .message-body p').first().waitFor({ timeout: 30000 });
  await delay(500);
  const after = await recordedSequences();
  const flood = after.slice(before);
  const handled = await page.evaluate(() => globalThis.slowStateCount);
  console.log(JSON.stringify({ produced, sentDuringFlood: flood.length, handledByPage: handled, lastSequence: after.at(-1) }));
  assert.ok(flood.every(sequence => sequence > 0), 'Every snapshot of the flood went through the bound');
  flood.forEach((sequence, index) => {
    assert.equal(sequence, flood[0] + index, 'Flood snapshots are consecutive as well');
  });
  assert.ok(flood.length < produced, 'A slow page is sent fewer snapshots than were produced (' + flood.length + ' of ' + produced + ')');
  // Holds with or without the bound once a backlog has drained; kept as a sanity check of the recording.
  assert.ok(handled >= flood.length - 1 && handled <= flood.length, 'Every sent snapshot but possibly the one in transit was handled by the page');
  const final = await page.evaluate(async sessionId => {
    const session = (await workspace.initial()).sessions.find(candidate => candidate.id === sessionId);
    return session.messages.filter(message => String(message.id).startsWith('push-flood-')).length;
  }, id);
  assert.equal(final, produced, 'No change was lost in the service');
  assert.equal(await page.locator('#messages [data-message-id="' + lastId + '"]').count(), 1, 'The last state reached the page');
  assert.deepEqual(errors, []);
  console.log('PASS: numbered snapshots one at a time; slow page sent fewer than produced; last state rendered; zero model calls');
}

let deadline;
Promise.race([
  run(),
  new Promise((_, reject) => {
    deadline = setTimeout(() => reject(Error('State push GUI exceeded three minutes')), 180000);
  }),
]).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(deadline);
  if (!profile) {
    return;
  }
  try {
    await scratch.release();
    assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
    fs.unlinkSync(path.join(slot, 'owner.json'));
    fs.rmdirSync(slot);
    console.log('Owned fixture cleaned; GUI slot released.');
  } catch (error) {
    console.error('Cleanup incomplete; owned lease retained:', error.stack);
    process.exitCode = 1;
  }
});
