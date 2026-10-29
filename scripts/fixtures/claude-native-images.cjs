// Existing synthetic transport; use the actual Claude receiver with explicit
// native-media capability. No provider process, model or native configuration.
require('./inline-input.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record);
  runtime.bindRoot({ sessionId: record.nativeId, nativeBlocks: true, nativeInlineInput: true,
    nativePromptInput: true, nativeQueue: true, nativeMedia: true });
  return runtime;
};
