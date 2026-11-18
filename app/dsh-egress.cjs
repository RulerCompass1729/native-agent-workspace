'use strict';
// The only way out of a DSH TUI session's sandbox: a loopback CONNECT proxy
// that lets through api.deepseek.com:443 and nothing else. The first other
// target closes the proxy for good and reports a violation, so the session
// can be stopped. It records targets and times only, never payloads.
const http = require('node:http');
const net = require('node:net');

const ALLOWED = Object.freeze(['api.deepseek.com:443']);
const MAX_RECORDS = 200;

function normalTarget(value) {
  const match = /^([a-z0-9.-]{1,253}):([0-9]{1,5})$/i.exec(String(value || ''));
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return `${match[1].toLowerCase()}:${port}`;
}

// `route` exists for offline tests only: it maps an allowed target to the
// loopback address of a fake server. Production callers never pass it.
function startEgress({ allow = ALLOWED, onViolation = () => {}, route = null } = {}) {
  const allowed = new Set(allow);
  const records = [];
  const sockets = new Set();
  let violated = null;
  const record = (target, verdict) => {
    records.push({ at: Date.now(), target, verdict });
    if (records.length > MAX_RECORDS) records.shift();
  };
  // `answering` is the refused client's own socket: it already holds the
  // 403 and closes after it, so it is not cut off before the answer.
  const violation = (target, answering) => {
    record(target, 'blocked');
    if (violated) return;
    violated = { at: Date.now(), target };
    // Nothing else leaves after the first violation, allowed targets included.
    for (const socket of sockets) {
      if (socket !== answering) socket.destroy();
    }
    try {
      onViolation(violated);
    } catch {
      // The proxy is already closed to traffic; a failing listener changes nothing.
    }
  };
  const server = http.createServer((request, response) => {
    // Plain HTTP through the proxy is never allowed.
    response.writeHead(403, { connection: 'close' });
    response.end();
    violation(`http:${normalTarget(request.headers.host) || 'invalid'}`, request.socket);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, client, head) => {
    const target = normalTarget(request.url);
    if (violated || !target || !allowed.has(target)) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      // Every refused attempt is recorded; only the first one is reported.
      violation(target || 'invalid', client);
      return;
    }
    record(target, 'allowed');
    const [host, port] = route ? route(target) : [target.slice(0, target.lastIndexOf(':')), Number(target.slice(target.lastIndexOf(':') + 1))];
    const upstream = net.connect(port, host);
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('connect', () => {
      if (violated) {
        upstream.destroy();
        client.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  server.on('clientError', (error, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        get violated() { return violated; },
        records: () => records.slice(),
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise(done => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { ALLOWED, normalTarget, startEgress };
