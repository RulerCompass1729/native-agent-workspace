// Synthetic providers whose model can be changed: the transport of native-progress.cjs, with the Claude adapter's
// maintenance stop, the model a session was started with, and Codex's own list and change. No model.
const path = require('node:path');
require('./native-progress.cjs');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs')), sessionModel = require(path.join(root, 'app/session-model.cjs'));
const create = NativeHost.prototype.create;
const MODELS = [['gpt-6.2-sol', ['low', 'medium', 'high', 'xhigh'], 'high'], ['gpt-6.2-luna', ['low', 'medium'], 'low']];
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record);
  runtime.stopForMaintenance = check => { check(); return runtime.stop(); };
  if (record.provider === 'codex') {
    runtime.models = async () => sessionModel.codexModels(MODELS.map(([model, efforts, defaultReasoningEffort]) => ({ model, defaultReasoningEffort, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) })));
    runtime.changeModel = async (value, guard) => {
      const taken = sessionModel.codexValue(value, await runtime.models());
      guard();
      runtime.nativeSettings = { nativeId: record.nativeId, ...taken, mode: 'default' };
      runtime.emit('model', taken.model); runtime.emit('capability');
      return taken;
    };
  }
  runtime.start = async () => {
    runtime.emit('model', record.requestedSettings?.model || (record.provider === 'codex' ? 'gpt-6.2-sol' : 'claude-fable-5-2'));
    runtime.emit('state', 'idle');
  };
  return runtime;
};
