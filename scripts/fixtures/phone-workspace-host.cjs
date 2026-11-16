// Only an owned isolated daemon may load the underlying synthetic native host.
require('../../app/tests/fixtures/mobile-broker-host.cjs');
const { Workspace } = require('../../app/workspace.cjs');
let workspace;
const bind = Workspace.prototype.bind;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
process.on('message', message => {
  if (!message?.phoneFixture) return;
  try {
    if (message.phoneFixture === 'seed') {
      for (const entry of message.sessions) {
        const s = workspace.get(entry.id), runtime = workspace.runtime(entry.id);
        if (entry.provider) s.provider = entry.provider;
        s.messages.push(...entry.messages);
        if (entry.state) runtime.emit('state', entry.state);
      }
      workspace.room.messages.push(...message.sharedMessages);
      workspace.changed();
    }
    process.send?.({ phoneFixtureResult: message.id, ok: true });
  } catch { process.send?.({ phoneFixtureResult: message.id, ok: false }); }
});
