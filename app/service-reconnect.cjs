const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { monitorEventLoopDelay } = require('node:perf_hooks');

// A window's service transport that closed without being asked to is connected again here; its live transports
// stay as they are. Calls in flight on the closed one have already failed (error.serviceClosed) and nothing is
// sent again.
const DELAYS = [0, 500, 2000, 5000, 15000, 30000], NOTICE_MS = 3000;

function createReconnector({ connect, restored, lost, record = () => {}, delays = DELAYS, noticeMs = NOTICE_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const running = new WeakMap();
  const closedEntries = client => client.entries.filter(e => e.closed && !e.closing);
  async function pass(context, client) {
    const stale = () => context.client !== client || client.closing || context.win.isDestroyed();
    const started = Date.now(), first = closedEntries(client), replaced = new Set();
    let noticed = false, attempts = 0;
    const notice = () => { if (!noticed && !stale()) { noticed = true; lost(context, client); } };
    const note = (event, extra) => {
      try { record({ event, window: context.background ? 'background' : 'page', backends: first.map(e => e.key), ...extra }); }
      catch { /* A record that cannot be written changes nothing else. */ }
    };
    // A window that is closing, or whose connections were all replaced by hand, is not a lost connection.
    if (stale()) return 'stale';
    // No transport closed: the window's own state could not be assembled. Only the person reconnects that.
    note('closed', { reasons: first.length ? first.map(e => e.client.closeReason || 'unknown') : ['window-state'] });
    if (!first.length) { notice(); return 'lost'; }
    const timer = setTimeout(notice, noticeMs);
    try {
      for (const delay of delays) {
        if (delay) await sleep(delay);
        if (stale()) return 'stale';
        // A backend being updated hands each window its new transport itself (replaceBackendSockets).
        if (client.control.maintenance.size) continue;
        attempts++;
        try {
          for (const entry of closedEntries(client)) {
            const service = await connect(context, entry.key);
            if (stale() || client.control.maintenance.size) { service.client.close(); break; }
            client.replaceService(entry.key, service.client, service.state); replaced.add(entry.key);
          }
          if (stale()) return 'stale';
          if (client.socket.destroyed) continue;
          await restored(context, client, [...replaced]);
          note('restored', { attempts, ms: Date.now() - started });
          return 'restored';
        } catch { /* The next attempt starts from what is closed then. */ }
      }
      notice(); note('lost', { attempts, ms: Date.now() - started });
      return 'lost';
    } finally { clearTimeout(timer); }
  }
  return function closed(context, client) {
    const current = running.get(client);
    if (current) { current.again = true; return current.run; }
    const next = { again: false };
    next.run = pass(context, client).then(result => {
      running.delete(client);
      // A transport that closed while this pass was finishing gets a pass of its own.
      if (result === 'restored' && next.again && closedEntries(client).length) closed(context, client);
      return result;
    }, error => { running.delete(client); throw error; });
    running.set(client, next);
    return next.run;
  };
}

// The longest this process's event loop was held in the last one to two minutes, measured from the moment the
// file loads so that the first close already has it. The timer that starts a new minute can run before the close
// it would explain, so the minute before stays readable.
const loopDelay = monitorEventLoopDelay({ resolution: 20 }); loopDelay.enable();
let earlierDelay = 0;
setInterval(() => { earlierDelay = loopDelay.max; loopDelay.reset(); }, 60000).unref();

// The newest connection events of this installation, private to the person: which transport closed, why this
// process thinks it did, the event loop delay above, and whether the transport came back. No session content.
function createEventLog(file, { kept = 200 } = {}) {
  return {
    add(event) {
      let events = [];
      try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(saved)) events = saved; } catch { /* Starts again from this event. */ }
      events.push({ at: new Date().toISOString(), loopDelayMs: Math.round(Math.max(earlierDelay, loopDelay.max) / 1e6), ...event });
      const temp = path.join(path.dirname(file), `${path.basename(file)}.${randomUUID()}.tmp`);
      try { fs.writeFileSync(temp, JSON.stringify(events.slice(-kept)), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
      catch (error) { fs.rmSync(temp, { force: true }); throw error; }
    },
  };
}

module.exports = { createReconnector, createEventLog, DELAYS, NOTICE_MS };
