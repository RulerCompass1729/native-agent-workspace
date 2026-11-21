// reconnect-native.cjs plus control over the service's own client connections, for test-service-reconnect.cjs.
// No model and no provider process.
const net = require('node:net');
const accepted = new Set(); let refuseUntil = 0, refused = 0;
const createServer = net.createServer;
net.createServer = function (...args) {
  const server = createServer.apply(this, args);
  server.on('connection', socket => {
    const address = server.address();
    if (typeof address !== 'string' || !address.endsWith('desktop.sock')) return;
    if (Date.now() < refuseUntil) { refused++; socket.destroy(); return; }
    accepted.add(socket); socket.on('close', () => accepted.delete(socket));
  });
  return server;
};
require('./reconnect-native.cjs');
process.on('message', q => {
  if (q.method !== 'drop-connections') return;
  // value: how long the service then refuses new connections, in milliseconds.
  refuseUntil = Date.now() + (q.value || 0);
  const dropped = accepted.size;
  for (const socket of accepted) socket.destroy();
  process.send({ dropId: q.id, dropped, refused });
});
