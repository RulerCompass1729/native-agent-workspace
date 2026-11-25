'use strict';
// Copies the DSH runtime to a new backend in a process of its own, so a busy window process cannot slow it. The start
// waits for it at most WAIT_MS; a slower copy goes on in the background, and a failed one is tried again later.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readLayout, writeLayout } = require('./service-layout.cjs');
const { readLock, createLock, releaseLock, ownerMayBeAlive } = require('./service-lock.cjs');

// The installer's wait for the new backend has to outlast WAIT_MS.
const WAIT_MS = 120000, RETRY_MS = 600000, RETRIES = 2;
const LOCK_FILE = 'dsh-copy.lock', LOCK_KIND = 'dsh-copy';

const jobs = new Map();

// One source after the other. `attempt(source)` answers 'next', 'later' (worth another try) or 'done'.
async function pass(sources, attempt) {
  for (const source of sources) {
    const outcome = await attempt(source);
    if (outcome === 'later') return source;
    if (outcome === 'done') return null;
  }
  return null;
}

// Resolves when the first pass ends or after waitMs, whichever is first. A copy already running for this profile is
// left to finish; a pass waiting for its retry is replaced.
function start(dataDir, sources, attempt, { waitMs = WAIT_MS, retryMs = RETRY_MS, retries = RETRIES } = {}) {
  const previous = jobs.get(dataDir);
  if (previous?.copying) return Promise.resolve();
  if (previous) clearTimeout(previous.timer);
  const job = { copying: false, timer: null };
  jobs.set(dataDir, job);
  return new Promise(resolve => {
    const waiting = setTimeout(resolve, waitMs);
    const run = async (order, left) => {
      job.copying = true;
      let failed = null;
      try { failed = await pass(order, attempt); } catch { console.warn('DSH runtime copy stopped'); }
      job.copying = false; clearTimeout(waiting); resolve();
      if (failed === null || left === 0) { jobs.delete(dataDir); return; }
      const after = sources.indexOf(failed) + 1;
      job.timer = setTimeout(run, retryMs, [...sources.slice(after), ...sources.slice(0, after)], left - 1);
      job.timer.unref();
    };
    run(sources, retries);
  });
}

// The copy's own process. It ends with this one (see `serve`), and this one never waits for it to exit.
function copy(executablePath, source, target) {
  return new Promise((resolve, reject) => {
    // No verdict, so nothing is known about the source: the copier could not start, was ended, or another one runs.
    const stopped = () => reject(Object.assign(Error('DSH runtime copy ended without a result'), { reason: 'stopped' }));
    let child;
    try {
      child = spawn(executablePath, ['--disable-sigusr1', __filename, source, target],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    } catch { stopped(); return; }
    child.on('error', stopped);
    child.once('close', stopped);
    child.once('message', ({ result, failure }) => {
      if (result) { resolve(result); return; }
      const { code, message, ...rest } = failure;
      reject(Object.assign(Error('DSH runtime copy failed', { cause: Object.assign(Error(message), { code }) }), rest));
    });
    child.unref();
    child.channel?.unref();
  });
}

// Changes services.json after the start that began the copy has let go of it. From the check of the startup lock to
// its release there is no await, so nothing else in this process can find it taken.
async function updateLayout(dataDir, change) {
  const file = path.join(dataDir, 'services.lock');
  for (let tries = 0; readLock(file) !== undefined; tries++) {
    if (tries === 600) throw Error('Service startup lock is not released');
    await new Promise(resolve => setTimeout(resolve, 1000).unref());
  }
  const lock = createLock(file, 'startup', dataDir);
  try {
    const layout = readLayout(dataDir);
    change(layout);
    writeLayout(dataDir, layout);
  } finally { releaseLock(file, lock); }
}

// A live owner is the copier of a window that is just ending, or of another one: its result is worth waiting for.
async function lockTarget(target) {
  const file = path.join(target, LOCK_FILE);
  for (let tries = 0; tries < 1800; tries++) {
    const left = readLock(file);
    if (left === undefined || left && !ownerMayBeAlive(left, target, LOCK_KIND) && releaseLock(file, left)) {
      try { return createLock(file, LOCK_KIND, target); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error('Another DSH runtime copy does not end');
}

async function serve(source, target) {
  // The window process is gone: the half copy stays for the next copier to clear.
  process.once('disconnect', () => process.exit(0));
  const tui = require('./dsh-tui.cjs');
  // verifyRuntime loads these late; the app bundle can be replaced while a copy runs.
  require('./butler-dsh-privacy.cjs'); require('./dsh-tui-update-off.cjs');
  const lock = await lockTarget(target);
  let message;
  try { message = { result: await tui.inheritRuntime(source, target, { cleanStaging: true }) }; }
  catch (error) {
    message = { failure: { reason: error.reason, progress: error.progress, targetEntry: error.targetEntry, code: error.cause?.code, message: error.cause?.message } };
  } finally { releaseLock(path.join(target, LOCK_FILE), lock); }
  process.send(message, () => process.exit(0));
}

module.exports = { WAIT_MS, RETRY_MS, RETRIES, LOCK_FILE, start, copy, updateLayout };
if (require.main === module) serve(...process.argv.slice(2)).catch(() => process.exit(1));
