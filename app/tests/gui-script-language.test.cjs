const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });
// T-170: the GUI scripts' expected text is Chinese, but a profile with no saved language follows the system language,
// so on an English-first Mac the interface is English. Every GUI script that launches Electron on a profile it creates
// must pin the test language (scripts/fixtures/test-language.cjs: NAW_TEST_UI_LANGUAGE, default zh) in one of two ways:
// - launch through test-scratch's wrapper (`testScratch.playwright(...)`), which seeds the profile named by the
//   launch's env.NAW_DATA_DIR. The env must name it: the wrapper silently skips a launch whose env does not.
// - for a stable profile reused across runs (test-desktop), call pinStableProfileLanguage before launching.
// Not caught: a script that pre-creates the profile's dsh folder (the wrapper then keeps whatever is saved), or one
// whose first launch spawns the Electron binary itself. Today the binary is only spawned for a second launch on a
// profile already pinned (test-background-launch, test-daily-use, test-desktop); installed-renderer is wrapped.
const parse = source => box.exports.parse(source, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
function walk(node, visit) {
  const pending = [node];
  while (pending.length) {
    const n = pending.pop(); if (!n || typeof n !== 'object') continue;
    visit(n);
    for (const value of Object.values(n)) if (value && typeof value === 'object') { if (Array.isArray(value)) pending.push(...value); else pending.push(value); }
  }
}
const namesDataDir = node => { let found = false; walk(node, n => { if (n.type === 'Property' && (n.key?.name ?? n.key?.value) === 'NAW_DATA_DIR') found = true; }); return found; };
function unpinnedLaunches(source) {
  const ast = parse(source), literals = new Map();
  let wrapped = false, pinned = false;
  walk(ast, n => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init?.type === 'ObjectExpression') literals.set(n.id.name, [...(literals.get(n.id.name) || []), n.init]);
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && n.id.properties.some(p => p.key?.name === '_electron') &&
      n.init?.type === 'CallExpression' && n.init.callee.type === 'MemberExpression' && n.init.callee.property.name === 'playwright') wrapped = true;
    if (n.type === 'CallExpression' && (n.callee.name ?? n.callee.property?.name) === 'pinStableProfileLanguage') pinned = true;
  });
  // The env passed to a launch: an object literal, a helper call given one, or a variable bound to one.
  const envNamesDataDir = env => env?.type === 'ObjectExpression' ? namesDataDir(env) :
    env?.type === 'CallExpression' ? env.arguments.some(namesDataDir) :
    env?.type === 'Identifier' ? (literals.get(env.name) || []).some(namesDataDir) : false;
  const lines = [];
  walk(ast, n => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.property.name !== 'launch' || n.callee.object.type !== 'Identifier' || !/electron/i.test(n.callee.object.name)) return;
    const options = n.arguments[0], env = options?.type === 'ObjectExpression' ? options.properties.find(p => p.key?.name === 'env')?.value : null;
    if (!(pinned || (wrapped && envNamesDataDir(env)))) lines.push(n.loc.start.line);
  });
  return lines.sort((a, b) => a - b);
}

test('the language check accepts wrapped launches that name the profile and pinned stable profiles, and nothing else', () => {
  for (const source of [
    "const { _electron } = testScratch.playwright(require('playwright')); _electron.launch({ env: { ...process.env, NAW_DATA_DIR: profile } });",
    "const { _electron } = scratch.playwright(require('playwright')); _electron.launch({ env: env({ NAW_DATA_DIR: profile }) });",
    "const { _electron } = scratch.playwright(require('playwright')); const env = { ...process.env, NAW_DATA_DIR: profile }; _electron.launch({ executablePath, env });",
    "const { _electron } = require('playwright'); await pinStableProfileLanguage(dataDir); _electron.launch({ env: { NAW_DATA_DIR: dataDir } });",
  ]) assert.deepEqual(unpinnedLaunches(source), [], source);
  for (const source of [
    "const { _electron } = require('playwright'); _electron.launch({ env: { ...process.env, NAW_DATA_DIR: profile } });",
    "const { _electron } = testScratch.playwright(require('playwright')); _electron.launch({ env: process.env });",
    "const { _electron } = testScratch.playwright(require('playwright')); _electron.launch({ executablePath });",
  ]) assert.deepEqual(unpinnedLaunches(source), [1], source);
});

test('every GUI script that launches Electron on its own profile pins the test language', () => {
  const dir = path.join(__dirname, '../../scripts');
  const files = [...fs.readdirSync(dir).filter(n => n.endsWith('.cjs')), ...fs.readdirSync(path.join(dir, 'fixtures')).filter(n => n.endsWith('.cjs')).map(n => 'fixtures/' + n)];
  let launches = 0;
  const offenders = files.flatMap(n => {
    const source = fs.readFileSync(path.join(dir, n), 'utf8');
    walk(parse(source), x => { if (x.type === 'CallExpression' && x.callee.property?.name === 'launch' && /electron/i.test(x.callee.object?.name || '')) launches++; });
    return unpinnedLaunches(source).map(line => `${n}:${line}`);
  });
  assert.ok(launches >= 160, 'The census must still see the GUI scripts\' Electron launches');
  assert.deepEqual(offenders, []);
});

// The stable-profile pin, read back with the app's own locale reader.
const language = require('../../scripts/fixtures/test-language.cjs');
const localeModule = require.resolve('@deepseek-ai/dsh-client-locale');
const reader = () => import(pathToFileURL(path.join(__dirname, '../ui-locale-profile.mjs')).href);
const saved = async profile => (await (await reader()).readLocaleProfile({ dataDir: path.join(profile, 'dsh'), localeModule })).preference;
const patchOf = profile => fs.readFileSync(path.join(profile, 'dsh', 'cordis.patch.yml'), 'utf8');
function stableProfile(t, patch) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-language-pin-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  if (patch !== undefined) {
    // The marker the app leaves in a profile it has already opened (as in test-desktop's stable profile).
    fs.mkdirSync(path.join(profile, 'dsh'));
    fs.writeFileSync(path.join(profile, 'dsh', 'package.json'), JSON.stringify({ private: true, nativeAgentWorkspace: { localeProfile: { version: 1, seed: 'complete' } } }));
    fs.writeFileSync(path.join(profile, 'dsh', 'cordis.patch.yml'), patch);
  }
  return profile;
}

test('the test language is zh by default, en or system on request, and nothing else', () => {
  assert.equal(language.testLanguage({}), 'zh');
  assert.equal(language.testLanguage({ NAW_TEST_UI_LANGUAGE: 'en' }), 'en');
  assert.equal(language.testLanguage({ NAW_TEST_UI_LANGUAGE: 'system' }), 'system');
  assert.throws(() => language.testLanguage({ NAW_TEST_UI_LANGUAGE: 'fr' }), /zh, en or system/);
});

for (const [state, patch] of [['a new profile', undefined], ['a profile that saved no language ([])', '[]\n']]) test(`pinning ${state} makes the app read the test language`, async t => {
  const profile = stableProfile(t, patch);
  if (patch !== undefined) assert.equal(await saved(profile), null, 'Before the pin the app has no saved language and follows the system');
  assert.equal(await language.pinStableProfileLanguage(profile, {}), 'zh');
  assert.equal(await saved(profile), 'zh');
});

test('a profile already pinned, after the app has rewritten the row on startup, is kept as it is', async t => {
  const profile = stableProfile(t, '[]\n');
  await language.pinStableProfileLanguage(profile, {});
  await (await reader()).prepareLocaleProfile({ dataDir: path.join(profile, 'dsh'), localeModule });
  const rewritten = patchOf(profile);
  assert.notEqual(rewritten, language.localePatch('zh'), 'The app rewrote the row it was given');
  assert.equal(await language.pinStableProfileLanguage(profile, {}), 'zh');
  assert.equal(patchOf(profile), rewritten);
});

for (const [state, patch] of [['another saved language', language.localePatch('en')], ['other interface settings', '- id: other-plugin\n  name: other\n']]) test(`a profile with ${state} is refused and left unchanged`, async t => {
  const profile = stableProfile(t, patch);
  await assert.rejects(language.pinStableProfileLanguage(profile, {}), /its own saved interface settings/);
  assert.equal(patchOf(profile), patch);
});

test('system leaves the profile untouched', async t => {
  const profile = stableProfile(t);
  assert.equal(await language.pinStableProfileLanguage(profile, { NAW_TEST_UI_LANGUAGE: 'system' }), 'system');
  assert.equal(fs.existsSync(path.join(profile, 'dsh')), false);
});

test('test-scratch seeds a new scratch profile with the same row as the stable-profile pin', () => {
  const helper = path.resolve(__dirname, '../../scripts/fixtures/test-scratch.cjs');
  const source = `const scratch=require(${JSON.stringify(helper)}),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const root=scratch.directory(path.join(os.tmpdir(),'naw-language-drift-'));
    const electron=scratch.playwright({_electron:{async launch(){return{process:()=>({exitCode:0,signalCode:null}),async close(){}};}}})._electron;
    electron.launch({env:{NAW_DATA_DIR:root}}).then(()=>console.log(JSON.stringify(fs.readFileSync(path.join(root,'dsh','cordis.patch.yml'),'utf8')))).finally(scratch.cleanup(async()=>{}));`;
  const env = { ...process.env, NAW_EVIDENCE_DIR: '' }; delete env.NAW_TEST_UI_LANGUAGE;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 15000, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n')[0]), language.localePatch('zh'));
});
