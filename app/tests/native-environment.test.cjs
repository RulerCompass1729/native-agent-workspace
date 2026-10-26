const test = require('node:test'), assert = require('node:assert/strict');
const { nativeEnvironment } = require('../platform.cjs');
const keys = ['CODEX_CI', 'NO_COLOR', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME'];
function withEnv(values, fn) {
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try { return fn(); } finally { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
}
test('a NAW started from an agent tool shell gives native terminals colour and no launcher identity', () => {
  withEnv({ CODEX_CI: '1', NO_COLOR: '1', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's', CODEX_TOOL_CALL_ID: 'c', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_HOME: '/custom/codex' }, () => {
    const env = nativeEnvironment();
    for (const key of keys.slice(0, 8)) assert.equal(env[key], undefined, key);
    assert.equal(env.CODEX_HOME, '/custom/codex', 'The person\'s Codex home is configuration, not identity');
  });
});
test('a person\'s own NO_COLOR is kept', () => {
  withEnv({ NO_COLOR: '1' }, () => assert.equal(nativeEnvironment().NO_COLOR, '1'));
});
