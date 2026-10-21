// Private local JSON-lines transport. Bounds apply to each frame, not a read
// chunk; snapshots may be large, and a slow UI must not lose ordered replies.
const RESPONSE_BYTES = 64 * 1024 * 1024;
const REQUEST_BYTES = 2 * 1024 * 1024;

function readFrames(socket, maxBytes, onMessage) {
  let parts = [], bytes = 0;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    if (socket.destroyed) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start);
      const part = chunk.slice(start, end < 0 ? chunk.length : end);
      bytes += Buffer.byteLength(part);
      if (bytes > maxBytes) { parts = []; socket.destroy(); return; }
      if (part) parts.push(part);
      if (end < 0) return;
      const line = parts.join(''); parts = []; bytes = 0;
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return; }
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

function createWriter(socket, { maxBytes = 2 * RESPONSE_BYTES, maxFrames = 1024 } = {}) {
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
    if (frame.length > RESPONSE_BYTES + 1 || queuedBytes + frame.length > maxBytes || queue.length >= maxFrames) {
      socket.destroy(); return false;
    }
    queue.push({ frame, key }); queuedBytes += frame.length; flush(); return true;
  }
  return {
    sendFrame,
    send(value, key = null) {
      let frame;
      try { frame = encodeFrame(value); } catch { socket.destroy(); return false; }
      return sendFrame(frame, key);
    },
  };
}
module.exports = { RESPONSE_BYTES, REQUEST_BYTES, readFrames, encodeFrame, createWriter };
