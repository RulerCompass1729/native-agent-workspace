const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { assertBinding } = require('./service-binding.cjs');

// A window's service transport that closed without being asked to is connected again here; its live transports
// stay as they are. Calls in flight on the closed one have already failed (error.serviceClosed) and nothing is
// sent again.
const DELAYS = [0, 500, 2000, 5000, 15000, 30000], NOTICE_MS = 3000;

function createReconnector({ connect, restored, lost, record = () => {}, delays = DELAYS, noticeMs = NOTICE_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  // Per window: the pass of each transport that closed, the backends that came back since its page was last
  // told, and whether the page was told the window is disconnected.
  const windows = new WeakMap(), recorded = new WeakSet();
  return function closed(context, client) {
    const stale = () => context.client !== client || client.closing || context.win.isDestroyed();
    const note = (event, backends, extra) => {
      try { record({ event, window: context.background ? 'background' : 'page', backends, ...extra }); }
      catch { /* A record that cannot be written changes nothing else. */ }
    };
    // A window that is closing, or whose connections were all replaced by hand, is not a lost connection.
    if (stale()) return Promise.resolve('stale');
    const down = client.entries.filter(e => e.closed && !e.closing);
    // No transport closed: the window's own state could not be assembled. Only the person reconnects that.
    if (!down.length) { note('closed', [], { reasons: ['window-state'] }); lost(context, client); return Promise.resolve('lost'); }
    let view = windows.get(client);
    if (!view) windows.set(client, view = { passes: new Map(), redraw: new Set(), noticed: false, timer: null });
    const notice = () => { if (!view.noticed && !stale() && client.socket.destroyed) { view.noticed = true; lost(context, client); } };
    // One closed transport, with attempts and a record of its own: a backend that stays unreachable takes nothing
    // from another one's reconnection.
    async function pass(entry) {
      const key = entry.key, transport = entry.client, started = Date.now();
      let attempts = 0, refused = false;
      const ended = (event, extra) => { note(event, [key], { attempts, ms: Date.now() - started, ...extra }); return event; };
      // Another path gave this backend its transport meanwhile (main.cjs replaceBackendSockets): that one stays.
      const replaced = () => entry.client !== transport || !entry.closed;
      if (!recorded.has(transport)) { recorded.add(transport); note('closed', [key], { reasons: [transport.closeReason || 'unknown'] }); }
      for (const delay of delays) {
        if (delay) await sleep(delay);
        if (stale()) return 'stale';
        if (replaced()) return ended('replaced');
        // A backend being updated hands each window its new transport itself.
        if (client.control.maintenance.has(key)) continue;
        attempts++;
        let next;
        try { next = await connect(context, key); } catch { continue; }
        // What changed while this connected is left alone: only the transport made here is closed.
        if (stale()) { next.client.close(); return 'stale'; }
        if (replaced()) { next.client.close(); return ended('replaced'); }
        if (client.control.maintenance.has(key)) { next.client.close(); continue; }
        // As a window's first connection (service-client.cjs connect): never a service kept for another purpose.
        try { assertBinding(next.state?.serviceBinding); } catch { refused = true; next.client.close(); continue; }
        try { client.replaceService(key, next.client, next.state, { reconnected: true }); } catch { continue; }
        view.redraw.add(key);
        // The service's own reason for ending the transport that closed, when it had one (daemon.cjs).
        const prior = next.client.priorClose;
        return ended('restored', prior ? { service: [{ backend: key, reason: prior.reason, endedAt: new Date(prior.at).toISOString() }] } : {});
      }
      return ended('lost', refused ? { refused: 'service-binding' } : {});
    }
    // After a pass: a window with every transport open is told so once, with all that came back; a window whose
    // passes all ended without that is the person's to reconnect.
    async function settle() {
      if (view.passes.size && client.socket.destroyed) return;
      clearTimeout(view.timer); view.timer = null;
      if (stale()) return;
      if (client.socket.destroyed) { notice(); return; }
      if (!view.redraw.size && !view.noticed) return;
      const keys = [...view.redraw]; view.redraw.clear(); view.noticed = false;
      try { await restored(context, client, keys); } catch { /* The page's own button still reconnects everything. */ }
    }
    for (const entry of down) {
      const transport = entry.client;
      if (view.passes.has(transport)) continue;
      view.timer ||= setTimeout(notice, noticeMs);
      view.passes.set(transport, pass(entry).catch(() => 'lost').then(async result => { view.passes.delete(transport); await settle(); return result; }));
    }
    return (async () => {
      while (view.passes.size) await Promise.all([...view.passes.values()]);
      return stale() ? 'stale' : client.socket.destroyed ? 'lost' : 'restored';
    })();
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
