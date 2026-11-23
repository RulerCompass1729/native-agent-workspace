// Extend only the existing synthetic host. No provider, model or network boot.
require('./mobile-host.cjs');
const { NativeHost } = require('../../adapters.cjs');
const { Workspace } = require('../../workspace.cjs');
const originalCreate = NativeHost.prototype.create, originalPrepare = Workspace.prototype.mobilePrepare;
const runtimes = new Map(), lastTags = new Map(), replies = [], held = [];
let holdPrepare = false;
NativeHost.prototype.create = function (record) {
  const runtime = originalCreate.call(this, record); runtimes.set(record.id, runtime);
  runtime.on('submitted', tag => lastTags.set(record.id, tag));
  return runtime;
};
Workspace.prototype.mobilePrepare = function (...args) {
  const result = originalPrepare.apply(this, args);
  if (!holdPrepare || result?.prepared !== true) return result;
  return new Promise(resolve => held.push(() => resolve(result)));
};
process.on('message', value => {
  if (!value?.brokerFixture) return;
  if (value.brokerFixture === 'question') {
    const runtime = runtimes.get(value.sessionId); let open = true;
    runtime.emit('state', 'working');
    runtime.emit('askQuestion', { questions: [{ header: 'Choose', question: 'Original fixture question?', multiSelect: false,
      options: [{ label: 'Original fixture answer', description: 'Original fixture description' }] }],
    open: () => open, reply: answer => { replies.push(answer); open = false; runtime.emit('state', 'idle'); } });
  }
  if (value.brokerFixture === 'idle') {
    const runtime = runtimes.get(value.sessionId), tag = lastTags.get(value.sessionId);
    if (tag) { runtime.emit('complete', { tag }); lastTags.delete(value.sessionId); }
    runtime.emit('state', 'idle');
  }
  if (value.brokerFixture === 'holdPrepare') holdPrepare = true;
  if (value.brokerFixture === 'releasePrepare') { holdPrepare = false; for (const release of held.splice(0)) release(); }
  process.send?.({ brokerFixtureResult: value.id, held: held.length, replies });
});
