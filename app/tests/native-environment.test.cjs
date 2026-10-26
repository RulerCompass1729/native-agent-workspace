const test = require('node:test'), assert = require('node:assert/strict');
const { nativeEnvironment } = require('../platform.cjs');
const keys = ['CODEX_CI', 'NO_COLOR', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_HOME'];
function withEnv(values, fn) {
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try { return fn(); } finally { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
}
test('a NAW started from an agent tool shell gives native terminals colour and no launcher identity', () => {
  withEnv({ CODEX_CI: '1', NO_COLOR: '1', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's', CODEX_TOOL_CALL_ID: 'c', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_CHILD_SESSION: '1', CODEX_HOME: '/custom/codex' }, () => {
    const env = nativeEnvironment();
    for (const key of keys.slice(0, 9)) assert.equal(env[key], undefined, key);
    assert.equal(env.CODEX_HOME, '/custom/codex', 'The person\'s Codex home is configuration, not identity');
  });
});
test('a person\'s own NO_COLOR is kept', () => {
  withEnv({ NO_COLOR: '1' }, () => assert.equal(nativeEnvironment().NO_COLOR, '1'));
});
test('native programs do not inherit the launcher terminal\'s identity', () => {
  const outer = { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.9', TERM_SESSION_ID: 'w0', TERM_FEATURES: 'T3', TERMINFO_DIRS: '/x', LC_TERMINAL: 'iTerm2', LC_TERMINAL_VERSION: '3.6.9', ITERM_SESSION_ID: 'w0', ITERM_PROFILE: 'Default', COLORFGBG: '15;0', TMUX: '/tmp/t,1,0', TMUX_PANE: '%1', KITTY_WINDOW_ID: '1', ZELLIJ: '0', __CFBundleIdentifier: 'com.googlecode.iterm2' };
  const saved = Object.fromEntries(Object.keys(outer).map(key => [key, process.env[key]]));
  Object.assign(process.env, outer);
  try {
    const env = nativeEnvironment({ TERM_PROGRAM_NOT_IDENTITY: 'kept' });
    for (const key of Object.keys(outer)) assert.equal(env[key], undefined, key);
    assert.equal(env.TERM_PROGRAM_NOT_IDENTITY, 'kept');
    assert.ok(env.PATH && env.HOME, 'Ordinary environment is kept');
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
