// Private local JSON-lines transport. Bounds apply to each frame, not a read
// chunk; snapshots may be large, and a slow UI must not lose ordered replies.
const RESPONSE_BYTES = 64 * 1024 * 1024;
const REQUEST_BYTES = 2 * 1024 * 1024;
// Why the service ended a client's transport itself. Its next transport is told (daemon.cjs, the ready frame):
// the reason cannot travel on the transport being ended, least of all one whose reader has stopped.
const SERVICE_CLOSE_REASONS = ['write-queue-frames', 'write-queue-bytes', 'frame-too-large', 'encode-failed', 'broadcast-failed', 'request-too-large', 'request-unreadable', 'request-refused'];

// refused(reason) runs before this side ends the transport: 'too-large' or 'unreadable' for a frame it read.
function readFrames(socket, maxBytes, onMessage, refused = () => {}) {
  let parts = [], bytes = 0;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    if (socket.destroyed) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start);
      const part = chunk.slice(start, end < 0 ? chunk.length : end);
      bytes += Buffer.byteLength(part);
      if (bytes > maxBytes) { parts = []; refused('too-large'); socket.destroy(); return; }
      if (part) parts.push(part);
      if (end < 0) return;
      const line = parts.join(''); parts = []; bytes = 0;
      let message;
      try { message = JSON.parse(line); } catch { refused('unreadable'); socket.destroy(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { refused('unreadable'); socket.destroy(); return; }
      onMessage(message);
      if (socket.destroyed) return;
      start = end + 1;
    }
  });
  socket.on('close', () => { parts = []; bytes = 0; });
}

function encodeFrame(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > RESPONSE_BYTES) throw new RangeError('Local response exceeds frame limit');
  return Buffer.from(text + '\n');
}

// refused(reason) runs before the writer ends the transport, with one of SERVICE_CLOSE_REASONS.
function createWriter(socket, { maxBytes = 2 * RESPONSE_BYTES, maxFrames = 1024, refused = () => {} } = {}) {
  let queue = [], queuedBytes = 0, blocked = false;
  function flush() {
    while (!blocked && !socket.destroyed && queue.length) {
      const entry = queue.shift(); queuedBytes -= entry.frame.length;
      // false means accepted by Node but awaiting drain. Never send it twice.
      blocked = !socket.write(entry.frame);
    }
  }
  socket.on('drain', () => { blocked = false; flush(); });
  socket.on('close', () => { queue = []; queuedBytes = 0; });
  function sendFrame(frame, key = null) {
    if (socket.destroyed) return false;
    if (key !== null) {
      const previous = queue.findIndex(entry => entry.key === key);
      if (previous >= 0) queuedBytes -= queue.splice(previous, 1)[0].frame.length;
      // Append the replacement AFTER intervening RPC replies. Replacing in
      // place would allow an older initial response to overwrite newer state.
    }
    const over = frame.length > RESPONSE_BYTES + 1 ? 'frame-too-large' : queuedBytes + frame.length > maxBytes ? 'write-queue-bytes' : queue.length >= maxFrames ? 'write-queue-frames' : null;
    if (over) { refused(over); socket.destroy(); return false; }
    queue.push({ frame, key }); queuedBytes += frame.length; flush(); return true;
  }
  return {
    sendFrame,
    // Whether a frame of this kind waits unsent, so that the next one would replace it.
    queued: key => queue.some(entry => entry.key === key),
    send(value, key = null) {
      let frame;
      try { frame = encodeFrame(value); } catch (error) { refused(error instanceof RangeError ? 'frame-too-large' : 'encode-failed'); socket.destroy(); return false; }
      return sendFrame(frame, key);
    },
  };
}
module.exports = { RESPONSE_BYTES, REQUEST_BYTES, SERVICE_CLOSE_REASONS, readFrames, encodeFrame, createWriter };
