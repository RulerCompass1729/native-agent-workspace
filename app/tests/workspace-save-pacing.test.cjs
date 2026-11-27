const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Workspace } = require('../workspace.cjs');

// 2026-11-26: one backend rewrote its 15-18 MB store at every one-second checkpoint while its sessions streamed,
// 137 GB in 4.4 hours. From 1 MiB on, timed checkpoints write about 1 MiB a second; persist() is not spaced.

function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-save-pacing-'));
  const host = { binaries: {}, codexTargets: new Map(), close() {} };
  const w = new Workspace(host, directory);
  const realWrite = fs.promises.writeFile;
  const writes = [];
  fs.promises.writeFile = async (file, data, options) => {
    if (String(file).endsWith('workspace.json.later.tmp')) {
      writes.push(JSON.parse(String(data)).drafts.mark);
    }
    return realWrite(file, data, options);
  };
  t.after(() => {
    fs.promises.writeFile = realWrite;
    w.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const disk = () => {
    const file = path.join(directory, 'workspace.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).drafts.mark : null;
  };
  return { w, writes, disk };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function firstCheckpoint(w, writes, big = 'x'.repeat(3 * 1024 * 1024)) {
  w.drafts.set('big', big);
  w.drafts.set('mark', 'A');
  w.changed();
  for (let i = 0; i < 100 && !writes.length; i++) {
    await sleep(10);
  }
  assert.deepEqual(writes, ['A']);
}

test('a store over 1 MiB that keeps changing is checkpointed about once per MiB-second, and the last change still lands', async t => {
  const { w, writes, disk } = store(t);
  await firstCheckpoint(w, writes);
  const started = Date.now();
  for (let i = 0; Date.now() - started < 1500; i++) {
    w.drafts.set('mark', 'B' + i);
    w.changed();
    await sleep(50);
  }
  assert.deepEqual(writes, ['A'], 'Within 3 s of writing 3 MiB no other checkpoint is written');
  w.drafts.set('mark', 'last');
  w.changed();
  for (let i = 0; i < 500 && disk() !== 'last'; i++) {
    await sleep(10);
  }
  assert.equal(disk(), 'last');
  assert.equal(writes.length, 2);
});

test('persist() is not spaced: a record that must be on disk is written at once', async t => {
  const { w, writes, disk } = store(t);
  await firstCheckpoint(w, writes);
  w.drafts.set('mark', 'now');
  assert.equal(w.persist(), true);
  assert.equal(disk(), 'now');
});

test('a timed checkpoint after persist() is spaced from that write', async t => {
  const { w, writes, disk } = store(t);
  w.drafts.set('big', 'x'.repeat(3 * 1024 * 1024));
  w.drafts.set('mark', 'saved');
  assert.equal(w.persist(), true);
  w.drafts.set('mark', 'later');
  w.changed();
  await sleep(1300);
  assert.deepEqual(writes, [], 'persist() just wrote 3 MiB: no checkpoint within 3 s of it');
  for (let i = 0; i < 400 && disk() !== 'later'; i++) {
    await sleep(10);
  }
  assert.equal(disk(), 'later');
});

test('a store under 1 MiB keeps the one-second deadline', async t => {
  const { w, writes } = store(t);
  w.drafts.set('mark', 'A');
  w.changed();
  for (let i = 0; i < 100 && !writes.length; i++) {
    await sleep(10);
  }
  const started = Date.now();
  for (let i = 0; Date.now() - started < 1300; i++) {
    w.drafts.set('mark', 'B' + i);
    w.changed();
    await sleep(50);
  }
  assert.ok(writes.length >= 2, `A small store streaming for 1.3 s is checkpointed again (${writes.length} writes)`);
});

test('the size counts bytes: 700,000 Chinese characters (2.1 MB) are spaced although under a million characters', async t => {
  const { w, writes } = store(t);
  await firstCheckpoint(w, writes, '字'.repeat(700 * 1000));
  const started = Date.now();
  for (let i = 0; Date.now() - started < 1300; i++) {
    w.drafts.set('mark', 'B' + i);
    w.changed();
    await sleep(50);
  }
  assert.deepEqual(writes, ['A'], 'About 2 s of spacing for 2.1 MB, not the one-second deadline');
});

test('a clock set back an hour does not postpone the next checkpoint', async t => {
  const { w, writes, disk } = store(t);
  await firstCheckpoint(w, writes);
  const realNow = Date.now;
  Date.now = () => realNow() - 60 * 60 * 1000;
  t.after(() => {
    Date.now = realNow;
  });
  w.drafts.set('mark', 'after the clock change');
  w.changed();
  for (let i = 0; i < 500 && disk() !== 'after the clock change'; i++) {
    await sleep(10);
  }
  assert.equal(disk(), 'after the clock change');
});
