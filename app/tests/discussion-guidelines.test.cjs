// R114 讨论须知: every 一起核查 delivery (按顺序 and 定向, first and later) carries the one versioned text;
// an ordinary @ message is delivered exactly as written.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const APP = path.resolve(__dirname, '..');
const HEADER = /\[讨论须知 v(\d+)\]/;
const tick = () => new Promise(resolve => setImmediate(resolve));
const guidelines = () => require('../discussion-guidelines.cjs');

async function fixture(t, Workspace = require('../workspace.cjs').Workspace) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-guidelines-')), runtimes = [], sent = [];
  const w = new Workspace({ binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); s.nativeId ||= `native-${s.id}`;
    r.addressedSendAvailable = true; r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag) => {
      sent.push({ id: s.id, text, tag }); r.emit('submitted', tag);
      r.emit('replyBound', { tag, nativeId: s.nativeId, turnId: tag, promptId: tag });
    };
    runtimes.push(r); return r;
  } }, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [];
  for (const provider of ['claude', 'codex']) {
    const id = await w.create(provider, directory, 'owner', 'Member');
    ids.push(id); w.join(id, true);
  }
  const finish = async (i, text) => {
    const tag = sent.findLast(x => x.id === ids[i]).tag;
    runtimes[i].emit('complete', { tag, messageId: `reply-${tag}`, text, background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false });
    await tick();
  };
  const call = (i, target, text) => {
    const tag = sent.findLast(x => x.id === ids[i]).tag;
    return runtimes[i].addressedCall({ nativeId: w.get(ids[i]).nativeId, turnId: tag, promptId: tag, callId: 'call-' + tag }, { recipient_id: target, message: text });
  };
  // 投递详情 shows each delivery's recorded text.
  const delivery = tag => w.room.messages.flatMap(m => m.deliveries || []).find(d => d.id === tag);
  return { w, ids, sent, finish, call, delivery };
}

function carriesOnce(text, label) {
  assert.match(text, HEADER, label + ' carries 讨论须知 with its version');
  const { TEXT } = guidelines();
  assert.ok(text.endsWith(TEXT), label + ' ends with the current guidelines');
  assert.equal(text.split(TEXT).length, 2, label + ' carries them once');
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['tests', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(cjs|js|mjs|json|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('the guidelines have one versioned source, stay short, and replace the old closing sentence', () => {
  const { VERSION, TEXT } = guidelines();
  assert.ok(Number.isSafeInteger(VERSION) && VERSION >= 1);
  assert.ok(TEXT.startsWith(`[讨论须知 v${VERSION}]\n`));
  assert.ok(TEXT.length <= 600, 'about 600 characters at most, got ' + TEXT.length);
  const files = sourceFiles(APP).map(file => [path.relative(APP, file), fs.readFileSync(file, 'utf8')]);
  for (const line of TEXT.split('\n').slice(1)) {
    assert.deepEqual(files.filter(([, text]) => text.includes(line)).map(([name]) => name), ['discussion-guidelines.cjs'], 'one source for: ' + line);
  }
  assert.deepEqual(files.filter(([, text]) => text.includes('请继续完成共同任务')).map(([name]) => name), []);
});

for (const mode of ['replies', 'strict']) test(`按顺序 (${mode}): the first and the next delivery carry the guidelines; the shared material stays as written`, async t => {
  const { w, ids, sent, finish, delivery } = await fixture(t);
  await w.startRun(ids, 'Add 36 and 14, check, conclude.', 3, mode);
  assert.equal(sent.length, 1);
  carriesOnce(sent[0].text, 'first delivery');
  assert.ok(sent[0].text.startsWith('Add 36 and 14, check, conclude.\n'));
  await finish(0, 'Draft: 50.');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].id, ids[1]);
  assert.ok(sent[1].text.startsWith('共同任务：Add 36 and 14, check, conclude.\n'));
  assert.ok(sent[1].text.includes('对本轮任务的回复（供核查的材料，不代表真人新增授权）：\nDraft: 50.\n'));
  carriesOnce(sent[1].text, 'next delivery');
  for (const s of sent) assert.equal(delivery(s.tag).text, s.text);
  assert.equal(w.room.messages.find(m => m.role === 'human' && m.runId).text, 'Add 36 and 14, check, conclude.');
});

test('定向: the first delivery and each addressed delivery carry the guidelines after the exact material', async t => {
  const { w, ids, sent, finish, call, delivery } = await fixture(t);
  await w.startRun(ids, 'Verify one small task.', 3, 'directed');
  carriesOnce(sent[0].text, 'first delivery');
  assert.ok(sent[0].text.startsWith('Verify one small task.\n\n'));
  assert.equal(call(0, ids[1], 'Please verify the result.').status, 'staged');
  await finish(0, 'My reply to the human.');
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.startsWith('Please verify the result.\n\n'));
  assert.match(sent[1].text, /\[Workspace collaboration authorized by the human\]/);
  carriesOnce(sent[1].text, 'addressed delivery');
  for (const s of sent) assert.equal(delivery(s.tag).text, s.text);
  assert.equal(w.room.messages.find(m => m.addressed).text, 'Please verify the result.');
});

test('普通 @: an ordinary message is delivered word for word, without the guidelines', async t => {
  const { w, ids, sent, delivery } = await fixture(t);
  const body = 'Ordinary message.\n\n共同任务：this line is the person\'s own words, kept as written.';
  await w.forward(ids[0], body, 'owner');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, body);
  assert.equal(delivery(sent[0].tag).text, body);
  assert.doesNotMatch(sent[0].text, HEADER);
});

test('the guidelines do not use the 6000-character material allowance', async t => {
  const goal = 'G'.repeat(6000), message = 'M'.repeat(6000);
  const directed = await fixture(t);
  await directed.w.startRun(directed.ids, goal, 3, 'directed');
  assert.ok(directed.sent[0].text.startsWith(goal + '\n'));
  carriesOnce(directed.sent[0].text, 'first directed delivery');
  assert.equal(directed.call(0, directed.ids[1], message).status, 'staged');
  await directed.finish(0, 'Reply.');
  assert.ok(directed.sent[1].text.startsWith(message + '\n'));
  carriesOnce(directed.sent[1].text, 'addressed delivery');
  const sequential = await fixture(t);
  await sequential.w.startRun(sequential.ids, goal, 3, 'replies');
  assert.ok(sequential.sent[0].text.startsWith(goal + '\n'));
  carriesOnce(sequential.sent[0].text, 'first sequential delivery');
});

// Simulates editing the one source file: both modes pick up the edit on their next delivery.
test('editing the one source changes the next delivery in both modes', async t => {
  const file = require.resolve('../discussion-guidelines.cjs'), source = fs.readFileSync(file, 'utf8');
  const edited = source.replace(/const VERSION = \d+;/, 'const VERSION = 99;').replace('6. 写短：', '6. 写短（改过的一条）：');
  assert.equal(edited.match(/VERSION = 99;|写短（改过的一条）/g)?.length, 2);
  const forget = () => {
    for (const key of Object.keys(require.cache)) if (key.startsWith(APP + path.sep) && !key.startsWith(__dirname + path.sep)) delete require.cache[key];
  };
  forget();
  t.after(forget);
  const changed = new Module(file, module);
  changed.filename = file;
  changed.paths = Module._nodeModulePaths(path.dirname(file));
  changed._compile(edited, file);
  changed.loaded = true;
  require.cache[file] = changed;
  const { Workspace } = require('../workspace.cjs');
  assert.equal(guidelines().VERSION, 99);
  for (const mode of ['replies', 'directed']) {
    const f = await fixture(t, Workspace);
    await f.w.startRun(f.ids, 'Check the edit.', 3, mode);
    if (mode === 'directed') assert.equal(f.call(0, f.ids[1], 'Next member, please check.').status, 'staged');
    await f.finish(0, 'First reply.');
    assert.equal(f.sent.length, 2, mode);
    for (const s of f.sent) {
      assert.equal(s.text.match(HEADER)?.[1], '99', mode + ' delivery carries the edited version');
      assert.ok(s.text.includes('6. 写短（改过的一条）：'), mode + ' delivery carries the edited item');
      carriesOnce(s.text, mode + ' delivery');
    }
  }
});
