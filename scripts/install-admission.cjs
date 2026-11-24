#!/usr/bin/env node
'use strict';
// Memory and disk admission before packaging or a cold check during a daily install.
// Stop thresholds follow two recorded failures on the maintainer machine: an out-of-memory stop with swap 96.6%
// used and 14 GB of disk left (swap could not grow), and a kernel panic with the compressor at 100% of its
// segment limit. Warn pressure asks the person; their consent covers one version and commit for two hours.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GiB = 2 ** 30;
const LIMITS = {
  minFreeBytes: 8 * GiB,
  segmentStop: 0.85,
  swapFullRatio: 0.9,
  swapNoRoomFreeBytes: 16 * GiB,
  consentMaxMs: 2 * 3600e3,
};
const EXIT = { go: 0, stop: 75, ask: 76 };

const gib = bytes => (bytes / GiB).toFixed(1);
const percent = ratio => `${Math.round(ratio * 100)}%`;

function segmentRatio(reading) {
  if (!(reading.segmentLimit > 0) || !Number.isFinite(reading.segments)) {
    return null;
  }
  return reading.segments / reading.segmentLimit;
}

function describe(reading) {
  const parts = [`内存压力 ${reading.pressure} 级`];
  if (reading.swapTotal > 0) {
    parts.push(`swap 用了 ${gib(reading.swapUsed)}/${gib(reading.swapTotal)} GiB`);
  }
  const ratio = segmentRatio(reading);
  if (ratio !== null) {
    parts.push(`压缩段用到上限的 ${percent(ratio)}`);
  }
  if (Number.isFinite(reading.freeBytes)) {
    parts.push(`磁盘剩 ${gib(reading.freeBytes)} GiB`);
  }
  return parts.join('，');
}

function stopReasons(reading, estimate) {
  const reasons = [];
  const amounts = [reading.freeBytes, reading.swapUsed, reading.swapTotal, reading.segments, reading.segmentLimit];
  if (!Number.isInteger(reading.pressure) || !amounts.every(Number.isFinite)) {
    reasons.push({ code: 'unreadable', text: '读不全内存压力、swap、压缩段或磁盘余量，不冒险装' });
    return reasons;
  }
  if (reading.pressure >= 4) {
    reasons.push({ code: 'pressure-critical', text: '内存压力 4 级（critical），这时打包可能让机器死机' });
  }
  const ratio = segmentRatio(reading);
  const added = estimate && Number.isFinite(estimate.segmentGrowth) ? estimate.segmentGrowth : 0;
  if (ratio !== null && ratio + added >= LIMITS.segmentStop) {
    const projected = added ? `，加上打包预计到 ${percent(ratio + added)}` : '';
    reasons.push({ code: 'compressor-near-limit', text: `压缩段已用到上限的 ${percent(ratio)}${projected}（11-10 那次死机时是 100%）` });
  }
  const swapRatio = reading.swapTotal > 0 ? reading.swapUsed / reading.swapTotal : 0;
  if (swapRatio >= LIMITS.swapFullRatio && reading.freeBytes < LIMITS.swapNoRoomFreeBytes) {
    reasons.push({ code: 'swap-cannot-grow', text: `swap 用了 ${percent(swapRatio)}，磁盘只剩 ${gib(reading.freeBytes)} GiB，swap 长不出来（11-09 那次内存耗尽时是 97%、剩 14 GB）` });
  }
  if (reading.freeBytes < LIMITS.minFreeBytes) {
    reasons.push({ code: 'disk-low', text: `磁盘只剩 ${gib(reading.freeBytes)} GiB，不到 8 GiB` });
  }
  return reasons;
}

function consentHolds(consent, { version, commit, now }) {
  if (!consent || consent.answer !== '照装') {
    return false;
  }
  if (consent.version !== version || consent.commit !== commit) {
    return false;
  }
  const at = Date.parse(consent.at);
  return Number.isFinite(at) && at <= now && now - at <= LIMITS.consentMaxMs;
}

function estimateText(estimate) {
  if (!estimate || !Number.isFinite(estimate.swapGrowthBytes)) {
    return '打包要用多少内存：还没量过（这次起记下打包时 swap 和压缩段最多涨多少）';
  }
  const from = estimate.from ? `（${estimate.from}）` : '';
  const segments = Number.isFinite(estimate.segmentGrowth) ? `、压缩段涨 ${percent(estimate.segmentGrowth)}` : '';
  return `打包要用多少内存：上次${from}打包 swap 最多涨 ${gib(estimate.swapGrowthBytes)} GiB${segments}`;
}

function admit(reading, { consent = null, estimate = null, version, commit, now = Date.now() } = {}) {
  const reasons = stopReasons(reading, estimate);
  const base = { at: new Date(now).toISOString(), version, commit, reading, estimate, limits: LIMITS };
  if (reasons.length) {
    const notice = `装机停下：${reasons.map(r => r.text).join('；')}。现在${describe(reading)}。你能做的：关掉占内存的程序或腾出磁盘后再叫我装；这种情况不问照装，因为可能让机器崩溃`;
    return { ...base, decision: 'stop', reasons, consented: false, ask: null, notice };
  }
  if (reading.pressure >= 2) {
    const reason = { code: 'pressure-warn', text: `内存压力 ${reading.pressure} 级（warn）` };
    if (consentHolds(consent, { version, commit, now })) {
      return { ...base, decision: 'go', reasons: [reason], consented: true, ask: null, notice: `照你的同意装：${describe(reading)}` };
    }
    const ask = [
      `需要你决定：现在${describe(reading)}，要不要照装 ${version}？`,
      `${estimateText(estimate)}。`,
      '风险：打包时机器会更卡，别的程序可能被换到 swap；到 critical 或压缩段逼近上限我会自己停，不会硬装。',
      `回「照装」就装，只对 ${version} 这一次装机有效；回「等等」我就等压力降到 1 级再装，等的时候写明在等什么。（硬门，不按默认）`,
    ].join('');
    return { ...base, decision: 'ask', reasons: [reason], consented: false, ask, notice: `装机在等你决定：${describe(reading)}` };
  }
  return { ...base, decision: 'go', reasons: [], consented: false, ask: null, notice: `可以装：${describe(reading)}` };
}

function growth(start, samples) {
  let swapPeak = start.swapUsed;
  let segmentPeak = start.segments;
  for (const sample of samples) {
    swapPeak = Math.max(swapPeak, sample.swapUsed);
    segmentPeak = Math.max(segmentPeak, sample.segments);
  }
  const segmentGrowth = start.segmentLimit > 0 ? Math.round(((segmentPeak - start.segments) / start.segmentLimit) * 1000) / 1000 : null;
  return { swapGrowthBytes: swapPeak - start.swapUsed, segmentGrowth, samples: samples.length };
}

function sysctl(name) {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-n', name], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function megabytes(text, label) {
  const match = new RegExp(`${label} = ([0-9.]+)M`).exec(text || '');
  return match ? Math.round(Number(match[1]) * 2 ** 20) : null;
}

function readMachine(directory = process.cwd()) {
  const number = name => {
    const value = Number.parseInt(sysctl(name), 10);
    return Number.isFinite(value) ? value : null;
  };
  const swap = sysctl('vm.swapusage');
  let freeBytes = null;
  try {
    const stats = fs.statfsSync(directory);
    freeBytes = stats.bavail * stats.bsize;
  } catch {
    freeBytes = null;
  }
  return {
    at: new Date().toISOString(),
    pressure: number('kern.memorystatus_vm_pressure_level'),
    swapUsed: megabytes(swap, 'used'),
    swapTotal: megabytes(swap, 'total'),
    segments: number('vm.compressor.segment.total'),
    segmentLimit: number('vm.compressor.segment.limit'),
    freeBytes,
  };
}

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw Error(`Expected --name value pairs, got ${argv[i]}`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// "等等" waits here, bounded, and keeps its record saying what it waits for.
async function check(o, read = readMachine) {
  const directory = o.disk || process.cwd();
  const settings = { version: o.version, commit: o.commit, consent: readJson(o.consent), estimate: readJson(o.estimate) };
  const waitMs = Number(o['wait-minutes'] || 0) * 60e3;
  const everyMs = Number(o['every-seconds'] || 30) * 1000;
  const since = new Date().toISOString();
  const deadline = Date.now() + waitMs;
  let result = admit(read(directory), settings);
  let told = null;
  while (result.decision !== 'go' && Date.now() + everyMs <= deadline) {
    const waiting = { ...result, waitingFor: '内存压力降到 1 级、压缩段和磁盘回到安全线', since, until: new Date(deadline).toISOString(), purpose: o.purpose || null };
    if (o.out) {
      writePrivate(o.out, waiting);
    }
    const untilPT = new Date(deadline).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
    if (told !== result.reading.pressure) {
      console.log(`NOTICE 装机在等：${waiting.waitingFor}；现在${describe(result.reading)}；最多等到 ${untilPT} PT`);
      told = result.reading.pressure;
    }
    await sleep(everyMs);
    result = admit(read(directory), settings);
  }
  result = { ...result, purpose: o.purpose || null, waitedSince: waitMs ? since : null };
  if (o.out) {
    writePrivate(o.out, result);
  }
  console.log(JSON.stringify(result));
  console.log(result.decision === 'go' ? `GO ${result.notice}` : `NOTICE ${result.notice}`);
  if (result.ask) {
    console.log(`ASK ${result.ask}`);
  }
  return EXIT[result.decision];
}

async function watch(o) {
  const directory = o.disk || process.cwd();
  const start = readMachine(directory);
  const samples = [];
  const everyMs = Number(o['every-seconds'] || 5) * 1000;
  let stopping = false;
  const save = () => writePrivate(o.out, { from: o.label || null, start, last: samples[samples.length - 1] || null, ...growth(start, samples) });
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping) {
    await sleep(everyMs);
    samples.push(readMachine(directory));
    save();
  }
  save();
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const o = options(rest);
  if (command === 'check') {
    return check(o);
  }
  if (command === 'consent') {
    writePrivate(o.file, { answer: '照装', version: o.version, commit: o.commit, by: o.by, at: new Date().toISOString() });
    return 0;
  }
  if (command === 'watch') {
    return watch(o);
  }
  throw Error('Usage: install-admission.cjs check|consent|watch --name value ...');
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}

module.exports = { admit, check, growth, readMachine, LIMITS, EXIT };
