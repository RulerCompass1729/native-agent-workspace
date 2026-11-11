const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { directoryTrustPrompt } = require('../native-directory-trust.cjs');

const prompts = {
  // Short native labels verified on isolated Claude 2.1.322 / Codex 0.167.1 first screens.
  claude: 'Accessing workspace:\r\n/synthetic/project\r\nQuick safety check: Is this a project you created or one you trust?\r\n❯ No, exit\r\n  Yes, I trust this folder\r\nEnter to confirm · Esc to cancel\r\n',
  codex: 'Folder access\r\n/synthetic/repo/child\r\nTrusting will apply to the repository root:\r\n/synthetic/repo\r\nTrust this folder? Codex can read, edit, and run files here, subject to your permission settings.\r\n› 1. Trust and continue\r\n  2. Back to Agent Command Center\r\nenter continue · esc back\r\n',
};
const write = (screen, text) => new Promise(resolve => screen.write(text, resolve));
for (const provider of ['claude', 'codex']) test(`directory trust: ${provider} reads the current cooked startup screen without native actions`, async t => {
  const screen = new Terminal({ cols: 38, rows: 20, scrollback: 100, allowProposedApi: true }); t.after(() => screen.dispose());
  const runtime = { terminal: { alive: true, screen } }, session = { provider, state: 'starting' };
  await write(screen, '\x1b[32m' + prompts[provider].slice(0, 34));
  assert.equal(directoryTrustPrompt(session, runtime), null, 'partial question does not authorize even a prompt classification');
  await write(screen, prompts[provider].slice(34) + '\x1b[0m');
  assert.deepEqual(directoryTrustPrompt(session, runtime), { kind: 'directory-trust', provider, source: 'native-terminal' });
  assert.deepEqual(Object.keys(directoryTrustPrompt(session, runtime)).sort(), ['kind', 'provider', 'source'], 'no question text, directory or terminal content enters a snapshot');
  assert.equal(directoryTrustPrompt({ ...session, state: 'idle' }, runtime), null, 'ordinary model output cannot become startup trust');
  assert.equal(directoryTrustPrompt(session, { terminal: { alive: false, screen } }), null);
  await write(screen, '\r\nordinary line\r\n'.repeat(35));
  assert.equal(directoryTrustPrompt(session, runtime), null, 'a prompt in scrollback is not a current prompt');
});

test('directory trust: mentions, login prompts and unrelated providers are not a trust choice', async t => {
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true }); t.after(() => screen.dispose());
  const runtime = { terminal: { alive: true, screen } };
  await write(screen, 'Do you trust the contents of this directory?\r\nA README quotes Yes, continue.\r\n');
  assert.equal(directoryTrustPrompt({ provider: 'codex', state: 'starting' }, runtime), null, 'the native decline choice is required');
  await write(screen, '\x1b[2J\x1b[HChoose how to log in\r\n1. Sign in\r\n2. API key\r\n');
  assert.equal(directoryTrustPrompt({ provider: 'claude', state: 'starting' }, runtime), null);
  await write(screen, prompts.claude);
  assert.equal(directoryTrustPrompt({ provider: 'other', state: 'starting' }, runtime), null);
});

test('directory trust: an unavailable screen is unknown, never a snapshot failure or inferred approval', () => {
  const runtime = { terminal: { alive: true, screen: { get buffer() { throw Error('screen unavailable'); } } } };
  assert.equal(directoryTrustPrompt({ provider: 'claude', state: 'starting' }, runtime), null);
});

test('directory trust: the older Codex Yes/No screen is still observed without an answer', async t => {
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true }); t.after(() => screen.dispose());
  await write(screen, 'Do you trust the contents of this directory?\r\n1. Yes, continue\r\n2. No, quit\r\n');
  assert.deepEqual(directoryTrustPrompt({ provider: 'codex', state: 'starting' }, { terminal: { alive: true, screen } }), { kind: 'directory-trust', provider: 'codex', source: 'native-terminal' });
});
