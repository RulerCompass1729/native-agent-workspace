// Full workspace state reaches a window's page as one large message. A page that is alive but slow
// leaves every message it has not handled yet in memory that no process accounts for, and that memory
// grew until the machine ran out (2026-11-10). Pushes to a ready page are therefore bounded here: at
// most one snapshot is unacknowledged, and while it is, only the newest later snapshot is kept. The page
// acknowledges after it has handled a snapshot; the newest waiting one is sent then, so the last state
// always arrives.
// With a wait, snapshots are also spaced: one is sent at once when the previous one left at least `wait` ms
// ago, otherwise the newest is sent when that time is up. Several changes in quick succession are then one
// redraw of the page, and a single change is not delayed (UI lag, 2026-11-12).
function createStatePush(send, { wait = 0, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let sequence = 0;
  let lastSent = -Infinity;
  let timer = null;
  let urgent = false;
  let unacknowledged = 0;
  let waiting = false;
  let waitingValue = null;
  let superseded = 0;

  // A snapshot counts as in transit only once the send returned. If the send throws, that snapshot is
  // lost, as it was before the bound existed, and the window is not left waiting for a reply.
  function deliver(value) {
    sequence += 1;
    urgent = false;
    send(value, sequence);
    unacknowledged = sequence;
    lastSent = now();
  }

  function hold(value) {
    if (waiting) {
      superseded += 1;
    }
    waiting = true;
    waitingValue = value;
  }

  // The time is up: the newest waiting snapshot goes, unless one is still in transit. A send that throws
  // here loses that snapshot, as above; it must not reach the event loop.
  function flush() {
    timer = null;
    if (!waiting || unacknowledged) {
      return;
    }
    const value = waitingValue;
    waiting = false;
    waitingValue = null;
    try {
      deliver(value);
    } catch {
      // Lost, as a send that throws in push loses its snapshot.
    }
  }

  function remaining() {
    return lastSent + wait - now();
  }

  function push(value) {
    if (unacknowledged || timer) {
      hold(value);
      return false;
    }
    const left = remaining();
    if (left > 0) {
      hold(value);
      timer = setTimer(flush, left);
      return false;
    }
    deliver(value);
    return true;
  }

  // Only the acknowledgement of the snapshot in transit counts; a late or repeated one changes nothing.
  function acknowledged(received) {
    if (!unacknowledged || received !== unacknowledged) {
      return false;
    }
    unacknowledged = 0;
    if (waiting && (urgent || !timer)) {
      const left = urgent ? 0 : remaining();
      if (timer && left <= 0) {
        clearTimer(timer);
        timer = null;
      }
      if (left > 0) {
        timer = setTimer(flush, left);
      } else {
        const value = waitingValue;
        waiting = false;
        waitingValue = null;
        deliver(value);
      }
    }
    return true;
  }

  // The page's own action has finished (main.cjs, before its reply). Pages read what their action changed
  // as soon as the reply arrives, so what is waiting goes now, without the wait; if a snapshot is still in
  // transit, it goes as soon as that one is acknowledged. A send that throws here is the caller's.
  function flushNow() {
    if (!waiting) {
      return false;
    }
    if (unacknowledged) {
      urgent = true;
      return false;
    }
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    const value = waitingValue;
    waiting = false;
    waitingValue = null;
    deliver(value);
    return true;
  }

  // Another path just sent the page a newer complete state. The waiting snapshot is older than that one
  // and must not arrive after it.
  function discardWaiting() {
    if (waiting) {
      superseded += 1;
    }
    waiting = false;
    waitingValue = null;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  // The page this bound served is gone (a reload, a crashed renderer, a closed window): nothing waiting
  // may be sent later to whatever document comes next.
  function close() {
    waiting = false;
    waitingValue = null;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  function status() {
    return { sequence, unacknowledged, waiting, superseded };
  }

  return { push, acknowledged, flushNow, discardWaiting, close, status };
}

module.exports = { createStatePush };
