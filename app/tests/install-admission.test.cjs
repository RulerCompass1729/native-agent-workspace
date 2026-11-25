'use strict';
// Memory and disk admission for packaging during a daily install. It stops for the compressor near its segment limit
// (a kernel panic had it at 100%) and for less than 8 GiB of disk; critical pressure is waited for ten minutes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { admit, check, growth, LIMITS } = require('../../scripts/install-admission.cjs');

const GiB = 2 ** 30;
const NOW = Date.parse('2026-11-24T05:00:00Z');
const INSTALL = { version: '0.1.0-alpha.999', commit: 'abcdef1234567', now: NOW };

function reading(extra) {
  return { pressure: 1, swapUsed: 2 * GiB, swapTotal: 4 * GiB, segments: 100, segmentLimit: 1000, freeBytes: 40 * GiB, ...extra };
}
const codes = result => result.reasons.map(r => r.code);

test('normal pressure goes ahead', () => {
  const result = admit(reading(), INSTALL);
  assert.equal(result.decision, 'go');
  assert.deepEqual(codes(result), []);
});

for (const pressure of [2, 3]) {
  test(`pressure ${pressure} goes ahead without asking, and says so`, () => {
    const result = admit(reading({ pressure, swapUsed: 17 * GiB, swapTotal: 18 * GiB }), INSTALL);
    assert.equal(result.decision, 'go');
    assert.deepEqual(codes(result), ['pressure-warn']);
    assert.match(result.notice, new RegExp(`^照装：内存压力 ${pressure} 级，swap 用了 17\\.0/18\\.0 GiB`, 'u'));
    assert.equal('ask' in result, false);
  });
}

for (const [name, extra] of [
  ['swap almost full with 9 GiB of disk', { swapUsed: 22.9 * GiB, swapTotal: 23 * GiB, freeBytes: 9 * GiB }],
  ['swap almost full with 14 GiB of disk', { swapUsed: 36.6 * GiB, swapTotal: 37.9 * GiB, freeBytes: 14 * GiB }],
  ['swap almost full with room on disk', { swapUsed: 17 * GiB, swapTotal: 18 * GiB, freeBytes: 28 * GiB }],
]) {
  test(`${name} does not stop`, () => {
    assert.equal(admit(reading(extra), INSTALL).decision, 'go');
  });
}

for (const [name, extra] of [['swap use', { swapUsed: null }], ['swap size', { swapTotal: null }], ['swap', { swapUsed: undefined, swapTotal: undefined }]]) {
  test(`${name} that cannot be read does not stop, and is said to be unread`, () => {
    const result = admit(reading({ pressure: 2, ...extra }), INSTALL);
    assert.equal(result.decision, 'go');
    assert.match(result.notice, /，swap 没读到，压缩段用到上限的 10%/u);
    assert.doesNotMatch(result.notice, /NaN|null|undefined/u);
  });
}

const stops = [
  ['critical pressure', { pressure: 4 }, 'pressure-critical'],
  ['the compressor near its segment limit (the panic was at 100%)', { segments: 850, segmentLimit: 1000 }, 'compressor-near-limit'],
  ['less than 8 GiB of disk', { freeBytes: 7.9 * GiB }, 'disk-low'],
  ['an unreadable pressure level', { pressure: null }, 'unreadable'],
  ['unreadable compressor segments', { segments: null }, 'unreadable'],
  ['an unreadable segment limit', { segmentLimit: null }, 'unreadable'],
  ['a segment limit of zero', { segmentLimit: 0 }, 'unreadable'],
  ['unreadable free disk', { freeBytes: null }, 'unreadable'],
];
for (const [name, extra, code] of stops) {
  test(`${name} stops`, () => {
    const result = admit(reading({ pressure: 2, ...extra }), INSTALL);
    assert.equal(result.decision, 'stop');
    assert.deepEqual(codes(result), [code]);
    assert.match(result.notice, /^装机停下：/u);
  });
}

test('just inside both limits goes ahead', () => {
  assert.equal(admit(reading({ segments: 849, segmentLimit: 1000, freeBytes: 8 * GiB }), INSTALL).decision, 'go');
});

test('a measured packaging growth counts toward the segment limit', () => {
  const near = reading({ segments: 760, segmentLimit: 1000 });
  assert.equal(admit(near, INSTALL).decision, 'go');
  assert.equal(admit(near, { ...INSTALL, estimate: { segmentGrowth: 0.1 } }).decision, 'stop');
});

test('the growth over a packaging run is the peak above its start', () => {
  const start = reading({ swapUsed: 10 * GiB, segments: 400 });
  const samples = [reading({ swapUsed: 12 * GiB, segments: 500 }), reading({ swapUsed: 11 * GiB, segments: 600 })];
  assert.deepEqual(growth(start, samples), { swapGrowthBytes: 2 * GiB, segmentGrowth: 0.2, samples: 2 });
});

test('the command reads this machine, writes its record and exits by the decision', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-admission-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.resolve(__dirname, '../../scripts/install-admission.cjs');
  const out = path.join(dir, 'admission.json');
  // Longer than the whole wait: this machine may itself be at critical pressure, and the test does not wait for it.
  const run = spawnSync(process.execPath, [script, 'check', '--version', INSTALL.version, '--commit', INSTALL.commit, '--out', out, '--every-seconds', '700'], { encoding: 'utf8' });
  const record = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(run.status, { go: 0, stop: 75 }[record.decision], run.stderr);
  for (const field of ['pressure', 'freeBytes', 'swapUsed', 'swapTotal', 'segments', 'segmentLimit']) {
    assert.equal(typeof record.reading[field], 'number', field);
  }
  assert.ok(run.stdout.split('\n').some(line => line.startsWith('NOTICE ') || line.startsWith('GO ')), run.stdout);
});

// One check whose machine gives these readings in turn, with the clock moved by each wait.
async function waits(t, readings, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-admission-wait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'admission.json');
  const lines = [], records = [], log = console.log, began = Date.now();
  let now = began, reads = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (run, ms) => { now += ms; setImmediate(run); });
  console.log = line => lines.push(String(line));
  t.after(() => { console.log = log; });
  const read = () => {
    if (reads) {
      records.push(JSON.parse(fs.readFileSync(out, 'utf8')));
    }
    return reading(readings[Math.min(reads++, readings.length - 1)]);
  };
  const code = await check({ version: INSTALL.version, commit: INSTALL.commit, out, ...o }, read);
  console.log = log;
  return { code, reads, minutes: (now - began) / 60e3, lines, records, last: JSON.parse(fs.readFileSync(out, 'utf8')) };
}
const notices = run => run.lines.filter(line => line.startsWith('NOTICE 装机在等：'));

test('critical pressure is read again every 30 s, and packaging starts when it is over', async t => {
  const run = await waits(t, [{ pressure: 4 }, { pressure: 4 }, { pressure: 2 }]);
  assert.deepEqual([run.code, run.reads, run.minutes], [0, 3, 1]);
  assert.deepEqual([run.records[0].decision, run.records[0].waitingFor], ['stop', '内存压力降到 4 级以下']);
  assert.equal(Date.parse(run.records[0].until) - Date.parse(run.records[0].since), 600e3);
  assert.equal(notices(run).length, 1, run.lines.join('\n'));
  assert.match(notices(run)[0], /最多等到 \d\d:\d\d PT/u);
  assert.deepEqual([run.last.decision, typeof run.last.waitedSince], ['go', 'string']);
  assert.ok(run.lines.some(line => line.startsWith('GO 照装：内存压力 2 级，')), run.lines.join('\n'));
});

test('critical pressure that stays ten minutes stops, and says it stayed', async t => {
  const run = await waits(t, [{ pressure: 4 }]);
  assert.deepEqual([run.code, run.reads, run.minutes], [75, 21, 10]);
  assert.deepEqual([run.last.decision, codes(run.last)], ['stop', ['pressure-critical']]);
  assert.ok(run.lines.some(line => line.startsWith('NOTICE 装机停下：') && line.endsWith('（等了 10 分钟，内存压力还是 4 级）')), run.lines.join('\n'));
});

for (const [name, first, code] of [
  ['the compressor near its limit', { segments: 850 }, 'compressor-near-limit'],
  ['7.9 GiB of disk', { freeBytes: 7.9 * GiB }, 'disk-low'],
  ['7.9 GiB of disk and critical pressure', { freeBytes: 7.9 * GiB, pressure: 4 }, 'disk-low'],
  ['an unreadable pressure', { pressure: null }, 'unreadable'],
]) {
  test(`${name} stops at the first reading, however long the wait`, async t => {
    const run = await waits(t, [first, {}], { 'wait-minutes': '15' });
    assert.deepEqual([run.code, run.reads, run.minutes, run.last.waitedSince], [75, 1, 0, null]);
    assert.equal(codes(run.last)[0], code);
  });
}

test('a limit reached while it waits for critical pressure stops it then', async t => {
  const run = await waits(t, [{ pressure: 4 }, { pressure: 4, freeBytes: 7 * GiB }, {}]);
  assert.deepEqual([run.code, run.reads], [75, 2]);
  assert.ok(!run.last.notice.includes('等了 10 分钟'), run.last.notice);
});

for (const pressure of [1, 2]) {
  test(`pressure ${pressure} is not waited for, even when told to wait`, async t => {
    const run = await waits(t, [{ pressure }], { 'wait-minutes': '15' });
    assert.deepEqual([run.code, run.reads], [0, 1]);
  });
}

test('a stop that did not wait does not say it did', async t => {
  const run = await waits(t, [{ pressure: 4 }], { 'every-seconds': '700' });
  assert.deepEqual([run.code, run.reads, run.last.notice.includes('等了 10 分钟')], [75, 1, false]);
});

test('the record holds the limits that were used', () => {
  assert.deepEqual(admit(reading(), INSTALL).limits, LIMITS);
  assert.deepEqual(LIMITS, { minFreeBytes: 8 * GiB, segmentStop: 0.85, criticalWaitMs: 600e3 });
});
