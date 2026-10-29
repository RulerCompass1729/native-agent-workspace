// Existing isolated transport, with the real Claude observation receiver.
// No native process, model, submission or provider configuration is started.
require('./collaboration-overview.cjs');
const path = require('node:path'), { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Claude } = require(path.join(root, 'app/adapters.cjs'));
const { SubmissionChannel } = require(path.join(root, 'app/claude-submit.cjs'));
const create = NativeHost.prototype.create, runtimes = new Map();
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record); record.nativeId = randomUUID();
  runtime.submission = new SubmissionChannel();
  for (const name of ['bindRoot', 'validRootBinding', 'observeRoot', 'observeBlock', 'observeRootGap', 'cancelNativeAbort', 'reportCapacityFailure', 'hook']) runtime[name] = Claude.prototype[name];
  runtime.bindRoot({ sessionId: record.nativeId, nativeBlocks: true, nativeInlineInput: true, nativePromptInput: true, nativeQueue: true });
  Object.defineProperty(runtime, 'nativeActivity', { get() { return Object.getOwnPropertyDescriptor(Claude.prototype, 'nativeActivity').get.call(this); } });
  runtimes.set(record.id, runtime); return runtime;
};
process.prependListener('message', packet => {
  if (packet.method === 'inlineHook') {
    const r = runtimes.get(packet.target); if (!r) throw Error('Unknown fixture receiver');
    r.hook({ ...packet.value, session_id: r.record.nativeId }); return;
  }
  if (packet.method !== 'inlineObservation') return;
  const r = runtimes.get(packet.target); if (!r) throw Error('Unknown fixture receiver');
  r.observeRoot({ ...packet.value, block: true, sessionId: r.record.nativeId, lease: r.rootLease,
    epoch: r.observationEpoch, sequence: (r.rootObservation?.sequence || 0) + 1 });
});
