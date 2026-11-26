// A simulated person for an isolated test instance of NAW: real key and mouse events through the hidden test window's
// own input path (Playwright keyboard/mouse, which send CDP Input events), never a product call. Production code never
// imports this module. A person exists only for an app that passed both checks (simulatedPerson): this repository's own
// Electron, unpackaged, on a private test folder, every window hidden. It takes the app, never a page.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { openSession } = require('./space-membership.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function daily() {
  const support = path.join(os.userInfo().homedir, 'Library', 'Application Support');
  const found = (stat(support) ? fs.readdirSync(support) : []).filter(name => /^native[ -]agent[ -]workspace/i.test(name));
  return [...new Set(['Native Agent Workspace', ...found])].map(name => path.join(support, name));
}
const stat = file => { try { return fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const same = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
// Inside or above the daily data folder, by path or by the folder itself (links, other spellings).
function touchesDaily(target) {
  const full = path.resolve(target), real = stat(full) ? fs.realpathSync(full) : full;
  for (const reference of daily()) {
    const info = stat(reference);
    for (const value of new Set([full, real])) {
      const inside = (a, b) => a === b || a.startsWith(b + path.sep);
      if (inside(value.toLowerCase(), reference.toLowerCase()) || inside(reference.toLowerCase(), value.toLowerCase())) return true;
    }
    for (let current = real; ; current = path.dirname(current)) {
      if (same(stat(current), info)) return true;
      if (current === path.dirname(current)) break;
    }
  }
  return false;
}
// A private folder made by this test, not the daily data folder by any spelling.
function assertPrivate(profile) {
  if (typeof profile !== 'string' || !path.isAbsolute(profile)) throw Error('Refused: no test profile');
  if (touchesDaily(profile)) throw Error('Refused: the profile is in the daily data folder');
  const real = fs.realpathSync(profile), info = fs.lstatSync(real);
  const parents = [os.tmpdir(), '/tmp'].map(value => fs.realpathSync(value));
  if (!parents.includes(path.dirname(path.dirname(real))) || !path.basename(path.dirname(real)).startsWith('naw-person-') ||
      info.uid !== process.getuid() || info.mode & 0o077) throw Error('Refused: the profile is not this test\'s private folder');
}
// Before anything starts: a fresh private folder of the test's own, and the repository's Electron, never an installed app.
function assertIsolated({ profile, executable, code, env = process.env }) {
  if (env.NAW_DATA_DIR) throw Error(touchesDaily(env.NAW_DATA_DIR) ? 'Refused: NAW_DATA_DIR is the daily data folder' : 'Refused: NAW_DATA_DIR is set; the harness makes its own');
  if (env.NAW_APP_EXECUTABLE) throw Error('Refused: NAW_APP_EXECUTABLE names an app; the harness drives only the source tree');
  if (!profile) return;
  assertPrivate(profile);
  const electron = fs.realpathSync(executable), modules = fs.realpathSync(path.join(code, 'node_modules', 'electron'));
  if (!electron.startsWith(modules + path.sep) || /\/Applications\//.test(electron)) throw Error('Refused: not the repository\'s own Electron');
}
// After it started: what runs is that Electron on that profile, hidden and unfocused.
async function assertHidden(app, profile) {
  const seen = await app.evaluate(({ app: electron, BrowserWindow }) => ({ packaged: electron.isPackaged, userData: electron.getPath('userData'), exe: process.execPath,
    windows: BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused() })) }));
  assert.equal(seen.packaged, false, 'Not a packaged app');
  assert.equal(fs.realpathSync(seen.userData), fs.realpathSync(profile), 'Its data folder is the test profile');
  assert.ok(seen.windows.length && seen.windows.every(win => !win.visible && !win.focused), 'Every window is hidden and unfocused');
  return seen;
}

const CHECKED = Symbol('checked');
class SimulatedPerson {
  constructor(checked, page, options) {
    if (checked !== CHECKED) throw Error('Refused: simulatedPerson(app, profile) makes it');
    const { snapshot, log = () => {} } = options;
    this.page = page;
    this.snapshot = snapshot;
    this.log = log;
    this.actions = [];
  }
  note(action, detail) { const row = { at: Date.now(), action, ...detail }; this.actions.push(row); this.log(row); }
  session(id) { return this.snapshot().then(state => state.sessions.find(s => s.id === id)); }
  // Clicks the session in the sidebar (or the panorama) and the view's tab.
  async open(id, view = 'chat') {
    this.note('open', { id, view });
    const toast = this.page.locator('#toast-close');
    if (await toast.isVisible()) await toast.click();
    await openSession(this.page, id);
    const tab = this.page.locator(view === 'chat' ? '#chat-tab' : '#terminal-tab');
    if (!((await tab.getAttribute('class')) || '').split(/\s+/).includes('active')) await tab.click();
    if (view === 'terminal') await this.page.locator(`[data-terminal-id="${id}"] .xterm-screen`).waitFor();
    else await this.page.locator('#message-input').waitFor();
  }
  async focus(id, view) {
    if (view === 'chat') await this.page.locator('#message-input').click();
    else await this.page.locator(`[data-terminal-id="${id}"] .xterm-screen`).click();
  }
  screen(id) { return this.page.locator(`[data-terminal-id="${id}"] .xterm-rows`).innerText(); }
  // Types into the session and leaves it there: its composer, or its native terminal's prompt.
  async type(id, text, view = 'chat') {
    await this.focus(id, view);
    this.note('type', { id, view, characters: text.length });
    await this.page.keyboard.type(text, { delay: 25 });
  }
  async pressEnter() { this.note('press Enter'); await this.page.keyboard.press('Enter'); }
  async pressEsc() { this.note('press Esc'); await this.page.keyboard.press('Escape'); }
  async erase(id, count, view = 'chat') {
    await this.focus(id, view);
    this.note('erase', { id, view, count });
    if (view === 'chat') { await this.page.keyboard.press('Meta+A'); await this.page.keyboard.press('Backspace'); return; }
    for (let n = 0; n < count; n++) await this.page.keyboard.press('Backspace');
  }
  // A draft kept in the composer, as NAW itself records it.
  async keepDraft(id, text) {
    await this.type(id, text, 'chat');
    for (let n = 0; n < 100; n++) { if ((await this.session(id))?.liveDraft === text) return; await delay(50); }
    throw Error('The draft was not kept');
  }
  async sendMessage(id, text) {
    await this.type(id, text, 'chat');
    await this.pressEnter();
    for (let n = 0; n < 200; n++) { if ((await this.session(id))?.messages.some(m => m.role === 'user' && m.text === text)) return; await delay(50); }
    throw Error('The message was not sent');
  }
  // A button on a card in the conversation, by its exact name: exactly one visible, enabled match.
  async clickCard(name) {
    const button = this.page.getByRole('button', { name, exact: true }).filter({ visible: true });
    assert.equal(await button.count(), 1, `One card button ${name}`);
    this.note('click card', { name });
    await button.click();
  }
  async idle(ms) { this.note('idle', { ms }); await delay(ms); }
}
// The only way to one: the running app itself is checked, and the page is the one it opened.
async function simulatedPerson(app, profile, options) {
  assertPrivate(profile);
  const seen = await assertHidden(app, profile);
  assertIsolated({ profile, executable: seen.exe, code: path.resolve(__dirname, '../..'), env: {} });
  return new SimulatedPerson(CHECKED, await app.firstWindow(), options);
}
module.exports = { simulatedPerson, assertIsolated, assertPrivate, assertHidden, touchesDaily };
