// Full workspace state reaches a window's page as one large message. A page that is alive but slow
// leaves every message it has not handled yet in memory that no process accounts for, and that memory
// grew until the machine ran out (2026-11-10). Pushes to a ready page are therefore bounded here: at
// most one snapshot is unacknowledged, and while it is, only the newest later snapshot is kept. The page
// acknowledges after it has handled a snapshot; the newest waiting one is sent then, so the last state
// always arrives.
function createStatePush(send) {
  let sequence = 0;
  let unacknowledged = 0;
  let waiting = false;
  let waitingValue = null;
  let superseded = 0;

  function deliver(value) {
    sequence += 1;
    unacknowledged = sequence;
    send(value, sequence);
  }

  function push(value) {
    if (unacknowledged) {
      if (waiting) {
        superseded += 1;
      }
      waiting = true;
      waitingValue = value;
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
    if (waiting) {
      const value = waitingValue;
      waiting = false;
      waitingValue = null;
      deliver(value);
    }
    return true;
  }

  function status() {
    return { sequence, unacknowledged, waiting, superseded };
  }

  return { push, acknowledged, status };
}

module.exports = { createStatePush };
