// Same real workspace/service path, with synthetic native provider reports only.
require('./column-input.cjs');
const path = require('node:path');
const { NativeHost } = require(path.join(process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..'), 'app/adapters.cjs'));
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function(record) {
  const runtime = create.call(this, record), start = runtime.start;
  runtime.start = async function() {
    if (record.provider === 'codex') runtime.emit('modelProvider', record.name.startsWith('DeepSeek') ? 'deepseek' : 'openai');
    return start.apply(this, arguments);
  };
  return runtime;
};
