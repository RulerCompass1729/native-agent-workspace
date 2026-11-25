#!/usr/bin/env node
'use strict';
// Memory and disk admission before packaging a daily install. Two things stop it at once: the compressor near its
// segment limit (a recorded kernel panic had it at 100%) and too little disk for what packaging and an install were
// measured to take. Critical pressure is waited for, at most ten minutes. Any other pressure, and how full swap is,
// goes ahead and is recorded.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GiB = 2 ** 30;
const LIMITS = {
  minFreeBytes: 8 * GiB,
  segmentStop: 0.85,
  criticalWaitMs: 10 * 60e3,
};
const EXIT = { go: 0, stop: 75 };

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
  if (!Number.isFinite(reading.swapUsed) || !Number.isFinite(reading.swapTotal)) {
    parts.push('swap 没读到');
  } else if (reading.swapTotal > 0) {
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
  const amounts = [reading.freeBytes, reading.segments, reading.segmentLimit];
  if (!Number.isInteger(reading.pressure) || !amounts.every(Number.isFinite) || !(reading.segmentLimit > 0)) {
    reasons.push({ code: 'unreadable', text: '读不全内存压力、压缩段或磁盘余量，不冒险装' });
    return reasons;
  }
  const ratio = segmentRatio(reading);
  const added = estimate && Number.isFinite(estimate.segmentGrowth) ? estimate.segmentGrowth : 0;
  if (ratio + added >= LIMITS.segmentStop) {
    const projected = added ? `，加上打包预计到 ${percent(ratio + added)}` : '';
    reasons.push({ code: 'compressor-near-limit', text: `压缩段已用到上限的 ${percent(ratio)}${projected}（11-10 那次死机时是 100%）` });
  }
  if (reading.freeBytes < LIMITS.minFreeBytes) {
    reasons.push({ code: 'disk-low', text: `磁盘只剩 ${gib(reading.freeBytes)} GiB，不到 8 GiB` });
  }
  if (reading.pressure >= 4) {
    reasons.push({ code: 'pressure-critical', text: '内存压力 4 级（critical）' });
  }
  return reasons;
}

function admit(reading, { estimate = null, version, commit, now = Date.now() } = {}) {
  const reasons = stopReasons(reading, estimate);
  const base = { at: new Date(now).toISOString(), version, commit, reading, estimate, limits: LIMITS };
  if (reasons.length) {
    const notice = `装机停下：${reasons.map(r => r.text).join('；')}。现在${describe(reading)}。你能做的：关掉占内存的程序或腾出磁盘后再叫我装`;
    return { ...base, decision: 'stop', reasons, notice };
  }
  if (reading.pressure >= 2) {
    const reason = { code: 'pressure-warn', text: `内存压力 ${reading.pressure} 级（warn）` };
    return { ...base, decision: 'go', reasons: [reason], notice: `照装：${describe(reading)}` };
  }
  return { ...base, decision: 'go', reasons: [], notice: `可以装：${describe(reading)}` };
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

const onlyCritical = result => result.decision === 'stop' && result.reasons.every(r => r.code === 'pressure-critical');

// Critical pressure alone is read again every 30 s for at most ten minutes, with a record of what it waits for.
async function check(o, read = readMachine) {
  const directory = o.disk || process.cwd();
  const settings = { version: o.version, commit: o.commit, estimate: readJson(o.estimate) };
  const everyMs = Number(o['every-seconds'] || 30) * 1000;
  const started = Date.now();
  const since = new Date(started).toISOString();
  const deadline = started + LIMITS.criticalWaitMs;
  let result = admit(read(directory), settings);
  let waited = false;
  while (onlyCritical(result) && Date.now() + everyMs <= deadline) {
    const waiting = { ...result, waitingFor: '内存压力降到 4 级以下', since, until: new Date(deadline).toISOString(), purpose: o.purpose || null };
    if (o.out) {
      writePrivate(o.out, waiting);
    }
    if (!waited) {
      const untilPT = new Date(deadline).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
      console.log(`NOTICE 装机在等：${waiting.waitingFor}；现在${describe(result.reading)}；最多等到 ${untilPT} PT`);
    }
    waited = true;
    await sleep(everyMs);
    result = admit(read(directory), settings);
  }
  if (waited && onlyCritical(result)) {
    result.notice += '（等了 10 分钟，内存压力还是 4 级）';
  }
  result = { ...result, purpose: o.purpose || null, waitedSince: waited ? since : null };
  if (o.out) {
    writePrivate(o.out, result);
  }
  console.log(JSON.stringify(result));
  console.log(`${result.decision === 'go' ? 'GO' : 'NOTICE'} ${result.notice}`);
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
  if (command === 'watch') {
    return watch(o);
  }
  throw Error('Usage: install-admission.cjs check|watch --name value ...');
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}

module.exports = { admit, check, growth, readMachine, LIMITS, EXIT };
