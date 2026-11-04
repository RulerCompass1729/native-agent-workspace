// Keep the locale entry in the same profile layers that DSH's ConfigEditor
// re-reads on every write. Other UI plugins remain in the ordinary UI root.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { composeEntries } from '@deepseek-ai/dsh-app-boot';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

// Use the parser declared by the pinned ConfigEditor, including its YAML tags.
const require = createRequire(import.meta.url);
const { parseDocument, isMap, isSeq } = createRequire(require.resolve('@deepseek-ai/dsh-config-editor'))('yaml');
export const localeBundleName = '@native-agent-workspace/locale-profile';
const owner = 'native-agent-workspace/locale-profile-v1';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function optional(filename) {
  try { return await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function json(filename, fallback) {
  const raw = await optional(filename);
  const value = raw === undefined ? fallback : JSON.parse(raw);
  if (!plain(value)) throw new Error('Invalid UI profile manifest');
  return value;
}
function localeName(name, current) {
  if (name === undefined || name === current || name === '@deepseek-ai/dsh-client-locale') return true;
  if (typeof name !== 'string') return false;
  try {
    const filename = name.startsWith('file:') ? fileURLToPath(name) : name;
    return path.isAbsolute(filename) && filename.endsWith('/node_modules/@deepseek-ai/dsh-client-locale/lib/index.js');
  } catch { return false; }
}
function migrationOf(manifest) {
  const value = manifest.nativeAgentWorkspace?.localeProfile;
  if (value !== undefined && (!plain(value) || value.version !== 1 || !['pending-zh', 'complete'].includes(value.seed))) throw new Error('Unknown UI locale migration');
  return value;
}
function patchDocument(raw) {
  const document = parseDocument(raw, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (document.errors.length) throw document.errors[0];
  if (!isSeq(document.contents)) throw new Error('UI profile patch must be a YAML sequence');
  return document;
}
function normalizedPatch(raw, current, firstMigration) {
  const document = patchDocument(raw);
  const known = document.contents.items.filter(row => isMap(row) && !row.has('insert') && localeName(row.get('name'), current));
  const canonical = known.some(row => row.get('id') === 'locale');
  let changed = false;
  for (const row of known) {
    // A previously accepted canonical row wins over old unsupported aliases,
    // regardless of their file order. Never reorder unknown patches.
    if (row.get('id') === 'client-locale' && firstMigration && !canonical) {
      row.set('id', 'locale');
      changed = true;
    }
    if (row.get('id') === 'locale' && row.has('name') && row.get('name') !== current) {
      row.set('name', current);
      changed = true;
    }
  }
  return changed ? String(document) : raw;
}
async function legacyUi(dataDir, localeModule) {
  const raw = await optional(path.join(dataDir, 'ui.json'));
  if (raw === undefined) return false;
  try {
    const rows = JSON.parse(raw);
    return Array.isArray(rows) && rows.some(row => row?.id === 'native-workspace') && rows.some(row => row?.id === 'client-locale' && localeName(row.name, localeModule));
  } catch { return false; }
}
async function privateDirectories(dataDir, parts) {
  let dir = dataDir;
  for (const part of parts) {
    dir = path.join(dir, part);
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await fs.lstat(dir)).isDirectory()) throw new Error('Expected an owned locale profile directory');
  }
  return dir;
}

// Import an older explicit language before A1 can seed Chinese. Let DSH keep
// handling the other legacy sections, but do not let that async importer later
// overwrite an accepted profile language. Retain the entire original document.
async function prepareLegacySettings({ dataDir, home, patch, current, firstMigration }) {
  const source = path.join(dataDir, 'settings.yaml');
  const raw = await optional(source);
  if (raw === undefined) return { patch };
  if (!(await fs.lstat(source)).isFile()) throw new Error('Invalid legacy UI settings');
  const document = parseDocument(raw);
  // The upstream importer tolerates empty/null documents and reports malformed
  // legacy input asynchronously. Do not turn that into a startup failure.
  const map = document.errors.length === 0 && isMap(document.contents);
  const patches = patchDocument(patch);
  const explicit = patches.contents.items.some(row => isMap(row) && row.get('id') === 'locale' && localeName(row.get('name'), current) && row.has('config'));
  const preference = map ? document.getIn(['locale', 'preference']) ?? document.getIn(['client-locale', 'preference']) : undefined;
  if (firstMigration && !explicit && typeof preference === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(preference)) {
    patches.add(patches.createNode({ id: 'locale', name: current, config: { preference } }));
    patch = String(patches);
  }
  if (map) { document.delete('locale'); document.delete('client-locale'); }
  const pending = path.join(home, 'settings.yaml');
  const filtered = map ? String(document) : raw;
  const before = await optional(pending);
  if (before !== undefined && before !== filtered) throw new Error('Pending legacy UI settings already exist');
  const digest = createHash('sha256').update(raw).digest('hex');
  const archive = path.join(dataDir, `settings.yaml.naw-imported-${digest}`);
  try { await fs.link(source, archive); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await fs.lstat(archive)).isFile() || await fs.readFile(archive, 'utf8') !== raw) throw error;
  }
  // A retry observes the same complete filtered document or an untouched source.
  if (before === undefined) await writeFileAtomic(pending, filtered, { mode: 0o600 });
  return { patch, source }; // Retire the old source only after the patch commits.
}

/** Prepare only application-owned bundle metadata in this private UI profile.
 * Existing installed dependency directories, unknown bundles and patch rows are
 * not rewritten. The profile patch remains the sole language-value authority.
 */
export async function prepareLocaleProfile({ dataDir, localeModule }) {
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(localeModule)) throw new Error('Absolute UI profile paths required');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(dataDir, 'package.json');
  return withFileLock(manifestPath, async () => {
    const manifest = await json(manifestPath, { private: true });
    for (const value of [manifest.dsh, manifest.dsh?.profile, manifest.nativeAgentWorkspace]) {
      if (value !== undefined && !plain(value)) throw new Error('Invalid UI profile configuration');
    }
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    if (!Array.isArray(bundles) || !bundles.every(value => typeof value === 'string')) throw new Error('Invalid UI profile bundles');
    const prior = migrationOf(manifest);
    const current = pathToFileURL(localeModule).href;
    const patchPath = path.join(dataDir, 'cordis.patch.yml');
    const before = await optional(patchPath);
    const next = normalizedPatch(before ?? '[]\n', current, prior === undefined);
    const legacy = prior === undefined && await legacyUi(dataDir, localeModule);
    const bundleDir = await privateDirectories(dataDir, ['node_modules', '@native-agent-workspace', 'locale-profile']);
    const bundleManifestPath = path.join(bundleDir, 'package.json');
    const existing = await json(bundleManifestPath, {});
    if (Object.keys(existing).length && (existing.name !== localeBundleName || existing.nativeAgentWorkspaceOwner !== owner)) throw new Error('Expected an owned locale profile bundle');
    // A profile must not also be its own home overlay: that re-applies old
    // values after ConfigEditor's prospective edits and makes resets fail.
    const home = await privateDirectories(dataDir, ['home']);
    const withLegacySettings = await prepareLegacySettings({ dataDir, home, patch: next, current, firstMigration: prior === undefined });
    const bundle = { name: localeBundleName, version: '0.0.0', private: true, nativeAgentWorkspaceOwner: owner, dsh: { bundle: { patch: 'base.json' } } };
    await writeFileAtomic(path.join(bundleDir, 'base.json'), JSON.stringify([{ insert: [{ id: 'locale', name: current }] }]) + '\n', { mode: 0o600 });
    await writeFileAtomic(bundleManifestPath, JSON.stringify(bundle) + '\n', { mode: 0o600 });
    if (before !== withLegacySettings.patch) await writeFileAtomic(patchPath, withLegacySettings.patch, { mode: 0o600 });
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...new Set([...bundles, localeBundleName])] } };
    manifest.nativeAgentWorkspace = { ...manifest.nativeAgentWorkspace, localeProfile: prior ?? { version: 1, seed: legacy ? 'pending-zh' : 'complete' } };
    await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    if (withLegacySettings.source) await fs.unlink(withLegacySettings.source);
    return { bundleName: localeBundleName, home, legacyDefault: legacy || prior?.seed === 'pending-zh' };
  });
}

/** A1: seed old Chinese UI once, through the actual Host writer/revision.
 * A failed write leaves the receipt pending and never claims a saved language.
 */
export async function completeLocaleMigration({ dataDir, context, legacyDefault = false }) {
  const manifestPath = path.join(dataDir, 'package.json');
  if (migrationOf(await json(manifestPath))?.seed !== 'pending-zh') return;
  const descriptor = context.settings.describe().find(row => row.ns === 'locale');
  if (descriptor === undefined) throw new Error('UI locale settings unavailable');
  if (descriptor.value.preference === undefined || legacyDefault && descriptor.value.preference === 'zh' && descriptor.user.preference === undefined && descriptor.base.preference === 'zh') await context.settings.update('locale', { preference: 'zh' }, descriptor.revision);
  // ConfigEditor owns this same lock during update: acquire only after it ends.
  await withFileLock(manifestPath, async () => {
    const manifest = await json(manifestPath);
    if (migrationOf(manifest)?.seed !== 'pending-zh') return;
    manifest.nativeAgentWorkspace.localeProfile.seed = 'complete';
    await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  });
}


/** Read the same known locale rows without preparing, importing or writing a
 * profile. A damaged/offline profile yields a recoverable display fallback.
 */
export async function readLocaleProfile({ dataDir, localeModule }) {
  try {
    const manifest = await json(path.join(dataDir, 'package.json'), {});
    const prior = migrationOf(manifest);
    const current = pathToFileURL(localeModule).href;
    const raw = normalizedPatch(await optional(path.join(dataDir, 'cordis.patch.yml')) ?? '[]\n', current, prior === undefined);
    const document = patchDocument(raw);
    const rows = document.contents.items.filter(row => isMap(row) && !row.has('insert') && row.get('id') === 'locale' && localeName(row.get('name'), current));
    const explicit = rows.some(row => row.has('config'));
    const entries = composeEntries([[{ insert: [{ id: 'locale', name: current }] }], rows.map(row => row.toJSON())]);
    let preference = entries.find(row => row.id === 'locale')?.config?.preference;
    if (prior === undefined && !explicit) {
      const legacy = await optional(path.join(dataDir, 'settings.yaml'));
      if (legacy !== undefined) {
        const parsed = parseDocument(legacy);
        if (!parsed.errors.length && isMap(parsed.contents)) preference = parsed.getIn(['locale', 'preference']) ?? parsed.getIn(['client-locale', 'preference']);
      }
    }
    const accepted = typeof preference === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(preference) ? preference : null;
    return { preference: accepted, legacyChinese: accepted === null && (prior?.seed === 'pending-zh' || prior === undefined && await legacyUi(dataDir, localeModule)), warning: null };
  } catch {
    return { preference: null, legacyChinese: false, warning: 'unavailable' };
  }
}

/** Project only accepted Host settings to the existing desktop parent channel.
 * Presentation-only browser callbacks are deliberately not write receipts.
 */
export function observeLocaleProfile(context, callback) {
  let reading = false;
  const publish = () => {
    if (reading) return;
    reading = true;
    try {
      const descriptor = context.settings.describe().find(row => row.ns === 'locale');
      if (!descriptor) return;
      const value = descriptor.value.preference;
      if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value))) return;
      callback({ preference: value ?? null, revision: descriptor.revision, explicit: descriptor.user.preference !== undefined });
    } catch {
      // Never forward raw SDK/disk errors (they may contain profile contents).
      try { callback({ warning: 'unavailable' }); } catch {}
    } finally { reading = false; }
  };
  const dispose = context.on('settings/document-updated', ns => { if (ns === 'locale') publish(); });
  publish();
  return dispose;
}


// Keep the verified previous Chinese default while A1 cannot save. This uses
// the pinned SDK's public schema/default mechanism in this private UI process,
// not a second persisted preference. ConfigEditor still writes the explicit
// override, including when the chosen language equals the temporary default.
export function applyLegacyLocaleDefault(config, enabled) {
  if (!enabled) return () => {};
  const original = config.dict.preference;
  const derived = original.default('zh');
  config.dict.preference = derived;
  return () => { if (config.dict.preference === derived) config.dict.preference = original; };
}
