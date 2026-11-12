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

// The rest of a Claude session that the launcher's command tool carries: what Claude Code sets for the commands
// it runs (its documentation, and the child-environment list of 2.1.322), with made-up values.
const launcherSession = {
  CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PID: '4242', CLAUDE_EFFORT: 'high',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/launcher-inbox.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'launcher-inbox-token',
  CLAUDE_JOB_DIR: '/tmp/launcher-job', CLAUDE_CODE_EXECPATH: '/launcher/bin/claude', CLAUDE_CODE_INVOKED_SKILLS: 'a-skill', CLAUDE_CODE_BRIDGE_SESSION_ID: 'launcher-bridge',
  AI_AGENT: 'claude-code_2-1-322_agent',
};
// What a person configures in a settings file or a shell profile. None of it is the launcher's session.
const personSettings = {
  CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_TMPDIR: '/custom/tmp', CLAUDE_CONFIG_DIR: '/custom/claude', ANTHROPIC_MODEL: 'a-model', CODEX_HOME: '/custom/codex',
};
function withProcessEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const restore = () => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  Object.assign(process.env, values);
  let result;
  try { result = fn(); } catch (error) { restore(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore(); return result;
}
test('a NAW started from a Claude session\'s command tool does not hand that session to native programs', () => {
  withProcessEnv({ ...launcherSession, ...personSettings }, () => {
    const env = nativeEnvironment({ NAW_HOOK_TOKEN: 'token', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' });
    for (const key of Object.keys(launcherSession)) assert.equal(env[key], undefined, key + ' belongs to the launcher\'s session');
    for (const [key, value] of Object.entries(personSettings)) assert.equal(env[key], value, key + ' is the person\'s setting and is kept');
    assert.equal(env.NAW_HOOK_TOKEN, 'token', 'What NAW itself passes for this launch is still passed');
    assert.equal(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  });
});
test('only Claude Code\'s own agent marker is removed', () => {
  for (const value of ['claude-code_2-1-322_agent', 'claude-code_2-1-322_harness', 'claude-code/2.1.200/agent']) withProcessEnv({ AI_AGENT: value }, () => assert.equal(nativeEnvironment().AI_AGENT, undefined, value));
  withProcessEnv({ AI_AGENT: 'someone-elses-marker' }, () => assert.equal(nativeEnvironment().AI_AGENT, 'someone-elses-marker', 'A value Claude Code did not write is left alone'));
});
// The whole path a native terminal takes: nativeEnvironment, the PTY host, and the program it starts.
test('the program a native terminal really starts has none of the launcher\'s session', { timeout: 15000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Terminal } = require('../adapters.cjs'), { pythonExecutable } = require('../platform.cjs');
  const python = pythonExecutable(); assert.ok(python, 'A real Python runtime is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'environment.json');
  // The started program writes the names it was given, and the values of the made-up entries only.
  const source = 'import os,sys,json\nopen(sys.argv[1],"w").write(json.dumps({"names":sorted(os.environ),"values":{k:os.environ.get(k) for k in sys.argv[2:]}}))';
  const all = { ...launcherSession, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'launcher', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_CHILD_SESSION: '1', ...personSettings };
  await withProcessEnv(all, async () => {
    const terminal = new Terminal([python, '-c', source, report, ...Object.keys(personSettings), 'NAW_HOOK_TOKEN', 'PWD'], dir, { NAW_HOOK_TOKEN: 'token' });
    try {
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('The started program did not finish')), 10000); terminal.on('closed', () => { clearTimeout(timer); resolve(); }); });
    } finally { if (terminal.alive && terminal.pid) { try { process.kill(terminal.pid, 'SIGKILL'); } catch { /* already gone */ } } terminal.screen.dispose(); }
  });
  const seen = JSON.parse(fs.readFileSync(report, 'utf8'));
  for (const key of [...Object.keys(launcherSession), 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION']) assert.equal(seen.names.includes(key), false, key + ' reached the started program');
  for (const [key, value] of Object.entries(personSettings)) assert.equal(seen.values[key], value, key);
  assert.equal(seen.values.NAW_HOOK_TOKEN, 'token'); assert.equal(seen.values.PWD, dir);
});
// The other place a native program is run with this environment: asking Claude which sessions are live.
test('the check that asks Claude for its live sessions runs it without the launcher\'s session', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { claudeImportAvailable } = require('../adapters.cjs'), { pythonExecutable } = require('../platform.cjs');
  const python = pythonExecutable(); assert.ok(python, 'A real Python runtime is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'names.json'), stand = path.join(dir, 'claude');
  fs.writeFileSync(stand, `#!/bin/sh\nexec "$NAW_TEST_PYTHON" -c 'import os,json\nopen(os.environ["NAW_TEST_REPORT"],"w").write(json.dumps(sorted(os.environ)))\nprint("[]")'\n`, { mode: 0o700 });
  withProcessEnv({ ...launcherSession, ...personSettings, NAW_TEST_PYTHON: python, NAW_TEST_REPORT: report }, () => {
    assert.equal(claudeImportAvailable({ nativeId: '11111111-2222-4333-8444-555555555555' }, { binaries: { claude: stand } }), undefined);
  });
  const names = JSON.parse(fs.readFileSync(report, 'utf8'));
  for (const key of Object.keys(launcherSession)) assert.equal(names.includes(key), false, key + ' reached the started program');
  for (const key of Object.keys(personSettings)) assert.equal(names.includes(key), true, key);
});
// NAW's own per-session values: the token and sockets through which a native Claude's hooks and bridge speak to
// the backend as that session. A NAW started from a NAW session's command tool finds that session's in its own
// environment.
const launcherNaw = { NAW_HOOK_TOKEN: 'launcher-hook-token', NAW_HOOK_SOCKET: '/tmp/launcher-hook.sock', NAW_SUBMIT_SOCKET: '/tmp/launcher-submit.sock' };
test('a hook token inherited from the NAW session that started this NAW is not passed on', { timeout: 15000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Terminal } = require('../adapters.cjs'), { pythonExecutable } = require('../platform.cjs');
  const python = pythonExecutable(); assert.ok(python, 'A real Python runtime is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'names.json');
  await withProcessEnv({ ...launcherNaw, NAW_TEST_ORDINARY: 'inherited', NAW_OUTBOX_DESCRIPTOR: '/the/apps/own/outbox-owner.json' }, async () => {
    // A launch that is given nothing of its own (a native Codex terminal, the Codex app server) gets none.
    const bare = nativeEnvironment();
    for (const key of Object.keys(launcherNaw)) assert.equal(bare[key], undefined, key + ' is the launching session\'s');
    // A native Claude is given its own three, and gets exactly those.
    const own = nativeEnvironment({ NAW_HOOK_TOKEN: 'own-token', NAW_HOOK_SOCKET: '/own/hook.sock', NAW_SUBMIT_SOCKET: '/own/submit.sock' });
    assert.deepEqual([own.NAW_HOOK_TOKEN, own.NAW_HOOK_SOCKET, own.NAW_SUBMIT_SOCKET], ['own-token', '/own/hook.sock', '/own/submit.sock']);
    // A launch given only one of them does not fall back to the launching session's for the others.
    const partial = nativeEnvironment({ NAW_HOOK_TOKEN: 'own-token' });
    assert.deepEqual([partial.NAW_HOOK_TOKEN, partial.NAW_HOOK_SOCKET, partial.NAW_SUBMIT_SOCKET], ['own-token', undefined, undefined]);
    // Every other name is as before: inherited when nothing is given, replaced by what is given.
    assert.equal(nativeEnvironment().NAW_TEST_ORDINARY, 'inherited'); assert.equal(nativeEnvironment({ NAW_TEST_ORDINARY: 'given' }).NAW_TEST_ORDINARY, 'given');
    // The outbox descriptor is the app's own (it deletes an inherited one before setting it), and native programs are meant to inherit it.
    assert.equal(nativeEnvironment().NAW_OUTBOX_DESCRIPTOR, '/the/apps/own/outbox-owner.json');
    // The real path, started the way a Codex terminal is: nothing passed with the launch.
    const terminal = new Terminal([python, '-c', 'import os,sys,json\nopen(sys.argv[1],"w").write(json.dumps(sorted(os.environ)))', report], dir);
    try {
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('The started program did not finish')), 10000); terminal.on('closed', () => { clearTimeout(timer); resolve(); }); });
    } finally { if (terminal.alive && terminal.pid) { try { process.kill(terminal.pid, 'SIGKILL'); } catch { /* already gone */ } } terminal.screen.dispose(); }
  });
  const names = JSON.parse(fs.readFileSync(report, 'utf8'));
  for (const key of Object.keys(launcherNaw)) assert.equal(names.includes(key), false, key + ' reached the started program');
  assert.equal(names.includes('NAW_TEST_ORDINARY'), true);
});
