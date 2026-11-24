'use strict';
// Memory and disk admission for packaging during a daily install. The stop thresholds follow two recorded failures
// on the maintainer machine: an out-of-memory stop with swap 96.6% used and 14 GB of disk left, and a kernel panic
// with the compressor at 100% of its segment limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { admit, check, growth } = require('../../scripts/install-admission.cjs');

const GiB = 2 ** 30;
const NOW = Date.parse('2026-11-24T05:00:00Z');
const INSTALL = { version: '0.1.0-alpha.999', commit: 'abcdef1234567', now: NOW };

function reading(extra) {
  return { pressure: 1, swapUsed: 2 * GiB, swapTotal: 4 * GiB, segments: 100, segmentLimit: 1000, freeBytes: 40 * GiB, ...extra };
}
function consent(extra) {
  return { answer: '照装', version: INSTALL.version, commit: INSTALL.commit, at: new Date(NOW - 60e3).toISOString(), ...extra };
}
const codes = result => result.reasons.map(r => r.code);

test('normal pressure goes ahead', () => {
  const result = admit(reading(), INSTALL);
  assert.equal(result.decision, 'go');
  assert.deepEqual(codes(result), []);
});

test('warn pressure asks the person with the reading, the packaging estimate and the risk', () => {
  const result = admit(reading({ pressure: 2, swapUsed: 17 * GiB, swapTotal: 18 * GiB }), INSTALL);
  assert.equal(result.decision, 'ask');
  assert.deepEqual(codes(result), ['pressure-warn']);
  assert.match(result.ask, /^需要你决定：/u);
  assert.match(result.ask, /内存压力 2 级/u);
  assert.match(result.ask, /swap 用了 17\.0\/18\.0 GiB/u);
  assert.match(result.ask, /打包要用多少内存：还没量过/u);
  assert.match(result.ask, /风险：/u);
  assert.match(result.ask, /照装/u);
  assert.match(result.ask, /等等/u);
  assert.match(result.ask, /只对 0\.1\.0-alpha\.999 这一次装机有效/u);
  assert.match(result.ask, /（硬门，不按默认）$/u);
});

test('a measured packaging growth is told in the question', () => {
  const estimate = { swapGrowthBytes: 3 * GiB, segmentGrowth: 0.12, from: '0.1.0-alpha.998' };
  const result = admit(reading({ pressure: 2 }), { ...INSTALL, estimate });
  assert.match(result.ask, /上次（0\.1\.0-alpha\.998）打包 swap 最多涨 3\.0 GiB、压缩段涨 12%/u);
});

test('consent for this version and commit lets warn pressure go ahead', () => {
  const result = admit(reading({ pressure: 2 }), { ...INSTALL, consent: consent() });
  assert.equal(result.decision, 'go');
  assert.equal(result.consented, true);
});

const stale = [
  ['another version', { version: '0.1.0-alpha.998' }],
  ['another commit', { commit: '1234567abcdef' }],
  ['an answer to wait', { answer: '等等' }],
  ['an answer older than two hours', { at: new Date(NOW - 2 * 3600e3 - 1).toISOString() }],
  ['an unreadable time', { at: 'soon' }],
];
for (const [name, extra] of stale) {
  test(`consent with ${name} still asks`, () => {
    assert.equal(admit(reading({ pressure: 2 }), { ...INSTALL, consent: consent(extra) }).decision, 'ask');
  });
}

const stops = [
  ['critical pressure', { pressure: 4 }, 'pressure-critical'],
  ['the compressor near its segment limit (the panic was at 100%)', { segments: 850, segmentLimit: 1000 }, 'compressor-near-limit'],
  ['swap almost full with too little disk to grow (the out-of-memory stop: 96.6%, 14 GB)', { swapUsed: 36.6 * GiB, swapTotal: 37.9 * GiB, freeBytes: 14 * GiB }, 'swap-cannot-grow'],
  ['less than 8 GiB of disk', { freeBytes: 7.9 * GiB }, 'disk-low'],
  ['an unreadable pressure level', { pressure: null }, 'unreadable'],
  ['unreadable compressor segments', { segments: null }, 'unreadable'],
  ['an unreadable segment limit', { segmentLimit: null }, 'unreadable'],
  ['unreadable swap use', { swapUsed: null }, 'unreadable'],
  ['an unreadable swap size', { swapTotal: null }, 'unreadable'],
];
for (const [name, extra, code] of stops) {
  test(`${name} stops without asking, even with consent`, () => {
    const result = admit(reading({ pressure: 2, ...extra }), { ...INSTALL, consent: consent() });
    assert.equal(result.decision, 'stop');
    assert.ok(codes(result).includes(code), codes(result).join(','));
    assert.equal(result.ask, null);
    assert.match(result.notice, /^装机停下：/u);
  });
}

test('a measured packaging growth counts toward the segment limit', () => {
  const near = reading({ segments: 760, segmentLimit: 1000 });
  assert.equal(admit(near, INSTALL).decision, 'go');
  assert.equal(admit(near, { ...INSTALL, estimate: { segmentGrowth: 0.1 } }).decision, 'stop');
});

test('swap nearly full with room on disk to grow does not stop by itself', () => {
  const result = admit(reading({ swapUsed: 17 * GiB, swapTotal: 18 * GiB, freeBytes: 28 * GiB }), INSTALL);
  assert.equal(result.decision, 'go');
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
  const run = spawnSync(process.execPath, [script, 'check', '--version', INSTALL.version, '--commit', INSTALL.commit, '--out', out], { encoding: 'utf8' });
  const record = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(run.status, { go: 0, stop: 75, ask: 76 }[record.decision], run.stderr);
  for (const field of ['pressure', 'freeBytes', 'swapUsed', 'swapTotal', 'segments', 'segmentLimit']) {
    assert.equal(typeof record.reading[field], 'number', field);
  }
  assert.ok(run.stdout.split('\n').some(line => line.startsWith('NOTICE ') || line.startsWith('GO ')), run.stdout);

  const consentFile = path.join(dir, 'consent.json');
  execFileSync(process.execPath, [script, 'consent', '--version', INSTALL.version, '--commit', INSTALL.commit, '--file', consentFile, '--by', 'synthetic person reply']);
  const written = JSON.parse(fs.readFileSync(consentFile, 'utf8'));
  assert.deepEqual([written.answer, written.version, written.commit, written.by], ['照装', INSTALL.version, INSTALL.commit, 'synthetic person reply']);
  assert.equal(fs.statSync(consentFile).mode & 0o777, 0o600);
});

test('waiting (等等) is bounded, says what it waits for and until when, and goes once pressure drops', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-admission-wait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'admission.json');
  const readings = [reading({ pressure: 2 }), reading({ pressure: 2 }), reading({ pressure: 1 })];
  const seen = [];
  const lines = [];
  const log = console.log;
  console.log = line => lines.push(String(line));
  t.after(() => { console.log = log; });
  const read = () => {
    const next = readings.shift();
    if (readings.length === 1) {
      seen.push(JSON.parse(fs.readFileSync(out, 'utf8')));
    }
    return next;
  };
  const code = await check({ version: INSTALL.version, commit: INSTALL.commit, out, 'wait-minutes': '1', 'every-seconds': '0.01' }, read);
  console.log = log;
  assert.equal(code, 0);
  assert.equal(seen[0].decision, 'ask');
  assert.match(seen[0].waitingFor, /内存压力降到 1 级/u);
  assert.ok(Date.parse(seen[0].until) - Date.parse(seen[0].since) === 60e3, JSON.stringify(seen[0]));
  assert.equal(lines.filter(line => line.startsWith('NOTICE 装机在等：')).length, 1, lines.join('\n'));
  assert.match(lines.find(line => line.startsWith('NOTICE 装机在等：')), /最多等到 \d\d:\d\d PT/u);
  const record = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(record.decision, 'go');
  assert.ok(record.waitedSince);
  assert.ok(lines.some(line => line.startsWith('GO ')), lines.join('\n'));
});

test('waiting ends at its deadline with the question still open', async t => {
  const lines = [];
  const log = console.log;
  console.log = line => lines.push(String(line));
  t.after(() => { console.log = log; });
  const code = await check({ version: INSTALL.version, commit: INSTALL.commit, 'wait-minutes': '0.001', 'every-seconds': '0.01' }, () => reading({ pressure: 2 }));
  console.log = log;
  assert.equal(code, 76);
  assert.ok(lines.some(line => line.startsWith('ASK 需要你决定：')), lines.join('\n'));
});
