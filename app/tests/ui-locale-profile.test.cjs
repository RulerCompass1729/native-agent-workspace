const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const anchor = path.resolve(__dirname, '../../package.json');
const localeModule = require.resolve('@deepseek-ai/dsh-client-locale');
const oldModule = '/old/install/node_modules/@deepseek-ai/dsh-client-locale/lib/index.js';
let sdk;
async function fixture(t, { legacy = false, patch = '[]\n', manifest } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'naw-ui-locale-'));
  let live, prepared, restoreSchema = () => {};
  t.after(async () => { try { await live?.fiber.dispose(); } finally { restoreSchema(); } await fs.rm(dir, { recursive: true, force: true }); });
  process.env.DSH_HOME = dir;
  process.env.DSH_TELEMETRY_DISABLED = '1';
  sdk ||= import('@deepseek-ai/dsh-app-boot');
  const { prepareLocaleProfile, completeLocaleMigration, applyLegacyLocaleDefault } = await import('../ui-locale-profile.mjs');
  const roots = ['config-editor', 'settings'].map(name => ({ id: name, name: require.resolve(`@deepseek-ai/dsh-${name}`) }));
  const filename = path.join(dir, 'ui.json');
  const patchPath = path.join(dir, 'cordis.patch.yml');
  if (legacy) await fs.writeFile(filename, JSON.stringify([{ id: 'native-workspace', name: '/old/app/dsh/host.js' }, { id: 'client-locale', name: oldModule }]));
  await fs.writeFile(patchPath, patch);
  if (manifest) await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest));
  const profile = { name: 'workspace', dir, home: dir, cwd: dir, patchPath, installAnchor: anchor, startedBundles: [], overlays: [] };
  const prepare = () => prepareLocaleProfile({ dataDir: dir, localeModule });
  const close = async () => { try { await live?.fiber.dispose(); } finally { live = undefined; restoreSchema(); restoreSchema = () => {}; } };
  const start = async (migrate = true) => {
    prepared = await prepare();
    const { Config } = await import('@deepseek-ai/dsh-client-locale');
    restoreSchema = applyLegacyLocaleDefault(Config, prepared.legacyDefault);
    profile.home = prepared.home;
    profile.startedBundles = [prepared.bundleName];
    await fs.writeFile(filename, JSON.stringify(roots));
    const { boot, readProfilePatches } = await sdk;
    live = await boot('locale-test', filename, readProfilePatches('locale-test', profile), ctx => ctx.provide('profileContext', profile), pathToFileURL(anchor).href);
    if (migrate) { await completeLocaleMigration({ dataDir: dir, context: live, legacyDefault: prepared.legacyDefault }); restoreSchema(); }
    return live;
  };
  return { dir, patchPath, profile, prepare, start, close, complete: async context => { await completeLocaleMigration({ dataDir: dir, context, legacyDefault: prepared?.legacyDefault }); restoreSchema(); } };
}
const locale = ctx => ctx.settings.describe().find(row => row.ns === 'locale');

test('real SDK saves locale-only profile base, refuses stale writes and reopens without remounting', async t => {
  const f = await fixture(t);
  let ctx = await f.start();
  assert.equal(locale(ctx).value.preference, undefined, 'New profiles keep system default');
  assert.equal([...ctx.loader.entries()].filter(row => row.options.id === 'locale').length, 1);
  const fibers = [...ctx.loader.entries()].map(row => [row.options.id, row.fiber?.uid]);
  const before = locale(ctx);
  await ctx.settings.update('locale', { preference: 'en' }, before.revision);
  assert.deepEqual([...ctx.loader.entries()].map(row => [row.options.id, row.fiber?.uid]), fibers);
  const saved = await fs.readFile(f.patchPath, 'utf8');
  await assert.rejects(ctx.settings.update('locale', { preference: 'zh' }, before.revision), /changed since it was read/);
  assert.equal(await fs.readFile(f.patchPath, 'utf8'), saved);
  await f.close();
  ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'en');
  await ctx.settings.replace('locale', {}, locale(ctx).revision);
  await f.close();
  ctx = await f.start();
  assert.equal(locale(ctx).value.preference, undefined, 'An explicit reset stays system default after reopen');
});

test('old profile seeds Chinese through actual Host exactly once, and preserves unrelated configuration', async t => {
  const manifest = { private: true, description: 'keep', dsh: { profile: { bundles: [] }, custom: { retained: true } }, custom: ['keep'] };
  const patch = '# retained comment\n- id: unknown-plugin\n  config:\n    value: keep\n';
  const f = await fixture(t, { legacy: true, patch, manifest });
  let ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'zh');
  assert.equal(locale(ctx).user.preference, 'zh', 'A1 must persist an actual explicit override');
  assert.match(await fs.readFile(f.patchPath, 'utf8'), /# retained comment/);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dir, 'package.json'), 'utf8'));
  assert.deepEqual(persisted.custom, ['keep']);
  assert.deepEqual(persisted.dsh.custom, { retained: true });
  await ctx.settings.replace('locale', {}, locale(ctx).revision);
  assert.equal(locale(ctx).value.preference, undefined, 'Temporary legacy default is removed after A1 succeeds; reset is immediate');
  await f.close();
  ctx = await f.start();
  assert.equal(locale(ctx).value.preference, undefined, 'Legacy detection must not undo a later reset');
});

test('known legacy override survives relocation; reset cannot resurrect it', async t => {
  const patch = `# original locale\n- id: client-locale\n  name: ${oldModule}\n  config:\n    preference: en\n- id: unrelated\n  name: /custom/unrelated.js\n  disabled: true\n`;
  const f = await fixture(t, { legacy: true, patch });
  let ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'en', 'A1 must not overwrite a stored explicit preference');
  const migrated = await fs.readFile(f.patchPath, 'utf8');
  assert.match(migrated, /# original locale/);
  assert.match(migrated, /\/custom\/unrelated.js/);
  assert.doesNotMatch(migrated, /\/old\/install/);
  assert.match(migrated, /id: locale/);
  await ctx.settings.replace('locale', {}, locale(ctx).revision);
  await f.close();
  ctx = await f.start();
  assert.equal(locale(ctx).value.preference, undefined);
});

for (const order of ['alias-first', 'canonical-first']) test(`canonical accepted override wins ${order} without reviving old aliases`, async t => {
  const alias = `- id: client-locale\n  name: ${oldModule}\n  config: { preference: zh }\n`;
  const canonical = `- id: locale\n  name: ${pathToFileURL(oldModule).href}\n  config: { preference: en }\n`;
  const f = await fixture(t, { legacy: true, patch: order === 'alias-first' ? alias + canonical : canonical + alias });
  let ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'en');
  await ctx.settings.replace('locale', {}, locale(ctx).revision);
  await f.close();
  ctx = await f.start();
  assert.equal(locale(ctx).value.preference, undefined);
});

test('actual Host overlay refusal leaves language and persisted bytes unchanged', async t => {
  const f = await fixture(t);
  f.profile.overlays = [{ id: 'locale', config: { preference: 'en' } }];
  const ctx = await f.start();
  const before = await fs.readFile(f.patchPath, 'utf8');
  await assert.rejects(ctx.settings.update('locale', { preference: 'zh' }, locale(ctx).revision), /overridden/);
  assert.equal(locale(ctx).value.preference, 'en');
  assert.equal(await fs.readFile(f.patchPath, 'utf8'), before);
});

test('corrupt profile and unknown generated-bundle ownership are refused without discarding data', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.patchPath, '[: broken');
  await assert.rejects(f.prepare());
  assert.equal(await fs.readFile(f.patchPath, 'utf8'), '[: broken');
  await fs.writeFile(f.patchPath, '[]\n');
  const bundleDir = path.join(f.dir, 'node_modules/@native-agent-workspace/locale-profile');
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.writeFile(path.join(bundleDir, 'package.json'), '{"name":"custom-owned"}');
  await assert.rejects(f.prepare(), /owned locale profile/);
  assert.equal(await fs.readFile(path.join(bundleDir, 'package.json'), 'utf8'), '{"name":"custom-owned"}');
});

test('actual read failure cannot mark a pending legacy migration accepted', async t => {
  const f = await fixture(t, { legacy: true });
  const ctx = await f.start(false);
  const saved = await fs.readFile(f.patchPath, 'utf8');
  await fs.rename(f.patchPath, `${f.patchPath}.saved`);
  await fs.mkdir(f.patchPath);
  await assert.rejects(f.complete(ctx));
  assert.equal([...ctx.loader.entries()].find(row => row.options.id === 'locale').options.config?.preference, undefined);
  assert.equal(await fs.readFile(`${f.patchPath}.saved`, 'utf8'), saved);
  const manifest = JSON.parse(await fs.readFile(path.join(f.dir, 'package.json'), 'utf8'));
  assert.equal(manifest.nativeAgentWorkspace.localeProfile.seed, 'pending-zh');
  await fs.rmdir(f.patchPath);
  await fs.rename(`${f.patchPath}.saved`, f.patchPath);
  await f.complete(ctx);
  assert.equal(locale(ctx).value.preference, 'zh');
});

test('accepted preference can change again after actual module-path relocation', async t => {
  const f = await fixture(t);
  let ctx = await f.start();
  await ctx.settings.update('locale', { preference: 'en' }, locale(ctx).revision);
  await f.close();
  const install = path.join(f.dir, 'moved-install');
  await fs.mkdir(install);
  await fs.symlink(path.dirname(anchor) + '/node_modules', path.join(install, 'node_modules'), 'dir');
  const movedModule = path.join(install, 'node_modules/@deepseek-ai/dsh-client-locale/lib/index.js');
  const { prepareLocaleProfile } = await import('../ui-locale-profile.mjs');
  await prepareLocaleProfile({ dataDir: f.dir, localeModule: movedModule });
  const movedPatch = await fs.readFile(f.patchPath, 'utf8');
  assert.match(movedPatch, /moved-install/);
  // Start manually to keep this changed installation path through the boot.
  const { boot, readProfilePatches } = await sdk;
  ctx = await boot('relocated-locale', path.join(f.dir, 'ui.json'), readProfilePatches('locale-test', f.profile), root => root.provide('profileContext', f.profile), pathToFileURL(anchor).href);
  try {
    assert.equal(locale(ctx).value.preference, 'en');
    await ctx.settings.update('locale', { preference: 'zh' }, locale(ctx).revision);
    assert.equal(locale(ctx).value.preference, 'zh');
  } finally { await ctx.fiber.dispose(); }
});

test('generated metadata refuses symlink directory escape and preserves unknown locale guards', async t => {
  const patch = '- id: locale\n  name: /custom/not-the-locale.js\n  config: { preference: en }\n';
  const f = await fixture(t, { patch });
  const sentinel = path.join(f.dir, 'outside');
  await fs.mkdir(sentinel);
  await fs.writeFile(path.join(sentinel, 'keep'), 'original');
  await fs.symlink(sentinel, path.join(f.dir, 'home'), 'dir');
  await assert.rejects(f.prepare(), /owned locale profile directory/);
  assert.equal(await fs.readFile(path.join(sentinel, 'keep'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(sentinel), ['keep']);
  assert.equal(await fs.readFile(f.patchPath, 'utf8'), patch);
  await fs.unlink(path.join(f.dir, 'home'));
  await f.prepare();
  assert.equal(await fs.readFile(f.patchPath, 'utf8'), patch, 'An arbitrary same-ID module guard must not be removed');
});

test('legacy settings preference is migrated before A1 and its full raw document is retained', async t => {
  const f = await fixture(t, { legacy: true });
  const raw = '# old document\nlocale:\n  preference: en\nunknown-section:\n  keep: original\n';
  await fs.writeFile(path.join(f.dir, 'settings.yaml'), raw);
  const ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'en');
  assert.equal(await fs.readFile(path.join(f.dir, (await fs.readdir(f.dir)).find(name => name.startsWith('settings.yaml.naw-imported-'))), 'utf8'), raw);
  await assert.rejects(fs.stat(path.join(f.dir, 'settings.yaml')), { code: 'ENOENT' });
});

test('accepted profile preference is not overwritten by stale legacy settings document', async t => {
  const f = await fixture(t, { legacy: true, patch: '- id: locale\n  config: { preference: en }\n' });
  const raw = 'locale:\n  preference: zh\n';
  await fs.writeFile(path.join(f.dir, 'settings.yaml'), raw);
  const ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'en');
  assert.equal(await fs.readFile(path.join(f.dir, (await fs.readdir(f.dir)).find(name => name.startsWith('settings.yaml.naw-imported-'))), 'utf8'), raw);
});

test('legacy import partial preparation retries without losing explicit locale or raw source', async t => {
  const f = await fixture(t, { legacy: true });
  const raw = 'client-locale:\n  preference: en\ncustom:\n  retained: true\n';
  await fs.writeFile(path.join(f.dir, 'settings.yaml'), raw);
  // A previous process saved the filtered SDK input but not the profile commit.
  await fs.mkdir(path.join(f.dir, 'home'));
  await fs.writeFile(path.join(f.dir, 'home/settings.yaml'), 'custom:\n  retained: true\n');
  const ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'en');
  const archives = (await fs.readdir(f.dir)).filter(name => name.startsWith('settings.yaml.naw-imported-'));
  assert.equal(archives.length, 1);
  assert.equal(await fs.readFile(path.join(f.dir, archives[0]), 'utf8'), raw);
});

for (const [label, raw] of [['empty', ''], ['comment-only', '# only comment\n'], ['null', 'null\n'], ['non-map', '- not a section\n'], ['malformed', '[: broken']]) test(`legacy ${label} document cannot prevent UI Host startup`, async t => {
  const f = await fixture(t, { legacy: true });
  await fs.writeFile(path.join(f.dir, 'settings.yaml'), raw);
  const ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'zh');
  const archive = (await fs.readdir(f.dir)).find(name => name.startsWith('settings.yaml.naw-imported-'));
  assert.equal(await fs.readFile(path.join(f.dir, archive), 'utf8'), raw);
  await ctx.settings.update('locale', { preference: 'en' }, locale(ctx).revision);
  assert.equal(locale(ctx).value.preference, 'en');
});

test('startup reader is read-only and agrees with the Host after known explicit legacy migration', async t => {
  const f = await fixture(t, { legacy: true, patch: `- id: client-locale\n  name: ${oldModule}\n  config: { preference: en }\n` });
  const { readLocaleProfile } = await import('../ui-locale-profile.mjs');
  const before = await fs.readdir(f.dir, { recursive: true });
  const patchBefore = await fs.readFile(f.patchPath, 'utf8');
  const initial = await readLocaleProfile({ dataDir: f.dir, localeModule });
  assert.deepEqual(initial, { preference: 'en', legacyChinese: false, warning: null });
  assert.deepEqual(await fs.readdir(f.dir, { recursive: true }), before);
  assert.equal(await fs.readFile(f.patchPath, 'utf8'), patchBefore);
  const ctx = await f.start();
  assert.equal(initial.preference, locale(ctx).value.preference);
  await ctx.settings.replace('locale', {}, locale(ctx).revision);
  assert.deepEqual(await readLocaleProfile({ dataDir: f.dir, localeModule }), { preference: null, legacyChinese: false, warning: null });
});

test('startup reader distinguishes legacy provisional Chinese from an accepted preference and tolerates bad disk', async t => {
  const f = await fixture(t, { legacy: true });
  const { readLocaleProfile } = await import('../ui-locale-profile.mjs');
  assert.deepEqual(await readLocaleProfile({ dataDir: f.dir, localeModule }), { preference: null, legacyChinese: true, warning: null });
  const ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'zh');
  assert.deepEqual(await readLocaleProfile({ dataDir: f.dir, localeModule }), { preference: 'zh', legacyChinese: false, warning: null });
  await f.close();
  await fs.writeFile(f.patchPath, '[: not a valid profile');
  assert.deepEqual(await readLocaleProfile({ dataDir: f.dir, localeModule }), { preference: null, legacyChinese: false, warning: 'unavailable' });
});

test('Host observer reports only accepted preferences; refusal and unrelated updates cannot publish a new choice', async t => {
  const f = await fixture(t);
  const ctx = await f.start();
  const { observeLocaleProfile } = await import('../ui-locale-profile.mjs');
  const events = [];
  const stop = observeLocaleProfile(ctx, value => events.push(value));
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['explicit', 'preference', 'revision']);
  assert.equal(events[0].preference, null);
  const first = locale(ctx).revision;
  await ctx.settings.update('locale', { preference: 'en' }, first);
  assert.equal(events.at(-1).preference, 'en');
  const accepted = events.length;
  await assert.rejects(ctx.settings.update('locale', { preference: 'zh' }, first), /changed since it was read/);
  ctx.emit('settings/document-updated', 'unrelated', 99);
  assert.equal(events.length, accepted);
  stop();
  await ctx.settings.update('locale', { preference: 'zh' }, locale(ctx).revision);
  assert.equal(events.length, accepted);
});

test('Host observer read failures emit only a fixed warning and continue after disk recovery', async t => {
  const f = await fixture(t);
  const ctx = await f.start();
  const { observeLocaleProfile } = await import('../ui-locale-profile.mjs');
  const events = [];
  const stop = observeLocaleProfile(ctx, value => events.push(value));
  await fs.rename(f.patchPath, `${f.patchPath}.saved`);
  await fs.mkdir(f.patchPath);
  ctx.emit('settings/document-updated', 'locale', 99);
  assert.deepEqual(events.at(-1), { warning: 'unavailable' });
  await fs.rmdir(f.patchPath);
  await fs.rename(`${f.patchPath}.saved`, f.patchPath);
  await ctx.settings.update('locale', { preference: 'en' }, locale(ctx).revision);
  assert.equal(events.at(-1).preference, 'en');
  stop();
});

test('A1 retains the prior Chinese default on real write denial and only completes after an explicit Host write', async t => {
  const f = await fixture(t, { legacy: true });
  let ctx = await f.start(false);
  assert.equal(locale(ctx).value.preference, 'zh');
  assert.equal(locale(ctx).user.preference, undefined, 'The fallback is not a saved explicit preference');
  try {
    await fs.chmod(f.dir, 0o500);
    await assert.rejects(f.complete(ctx), { code: 'EACCES' });
  } finally { await fs.chmod(f.dir, 0o700); }
  assert.equal(locale(ctx).value.preference, 'zh');
  assert.equal(locale(ctx).user.preference, undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir, 'package.json'), 'utf8')).nativeAgentWorkspace.localeProfile.seed, 'pending-zh');
  assert.doesNotMatch(await fs.readFile(f.patchPath, 'utf8'), /preference:/);
  await f.complete(ctx);
  assert.equal(locale(ctx).user.preference, 'zh');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir, 'package.json'), 'utf8')).nativeAgentWorkspace.localeProfile.seed, 'complete');
  await f.close();
  ctx = await f.start();
  assert.equal(locale(ctx).value.preference, 'zh');
  assert.equal(locale(ctx).user.preference, 'zh', 'Reopen has no temporary schema default and keeps the actual override');
});
