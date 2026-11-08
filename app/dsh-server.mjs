// A UI-only composition of the pinned upstream DSH packages. Native sessions
// belong to daemon.cjs; no DSH model, tools, telemetry or account plugins mount.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Config as LocaleConfig } from '@deepseek-ai/dsh-client-locale';
import { boot, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { prepareLocaleProfile, completeLocaleMigration, observeLocaleProfile, applyLegacyLocaleDefault } from './ui-locale-profile.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2];
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Private UI directory required');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.DSH_HOME = dataDir;
// The locale base must be visible to ConfigEditor as well as startup.
const localeProfile = await prepareLocaleProfile({ dataDir, localeModule: require.resolve('@deepseek-ai/dsh-client-locale') });
const restoreLocaleSchema = applyLegacyLocaleDefault(LocaleConfig, localeProfile.legacyDefault);
const names = ['host-webserver', 'credentials-local', 'typert-registry', 'typert-loader',
  'config-editor', 'settings', 'api-settings-controller', 'api-remote-access', 'api-gateway', 'client-connection', 'api-remotes', 'client-modules',
  'host-frontend-static', 'client-ui-renderer', 'client-ui-settings', 'client-shortcuts',
  'client-ui-theme', 'client-ui-layout'];
const config = names.map(name => ({ id: name, name: require.resolve(`@deepseek-ai/dsh-${name}`) }));
config[0].config = { host: '127.0.0.1', port: 0 };
config.find(row => row.id === 'host-frontend-static').config = {
  distIndex: path.join(path.dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/index.html'),
};
config.push({ id: 'native-workspace', name: path.join(here, 'dsh/host.js') });
const filename = path.join(dataDir, 'ui.json');
fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
const anchor = path.join(here, '../package.json');
const profileContext = { name: 'workspace', dir: dataDir, home: localeProfile.home, cwd: dataDir, patchPath: path.join(dataDir, 'cordis.patch.yml'), installAnchor: anchor, startedBundles: [localeProfile.bundleName], overlays: [] };
const ctx = await boot('workspace', filename, readProfilePatches('dsh', profileContext), ctx => ctx.provide('profileContext', profileContext), pathToFileURL(anchor).href);
// A rejected migration must not take down the interface or claim acceptance.
let localeWarning;
await completeLocaleMigration({ dataDir, context: ctx, legacyDefault: localeProfile.legacyDefault }).catch(() => { localeWarning = 'migrationNotSaved'; });
if (!localeWarning) restoreLocaleSchema();
observeLocaleProfile(ctx, value => {
  // Whitelisted display metadata only; never forward raw SDK errors or config.
  if (value.explicit) { restoreLocaleSchema(); localeWarning = undefined; }
  try { if (process.connected) process.send({ type: 'ui-locale', ...value, warning: value.warning || localeWarning || null }); } catch {}
});
// Same Host settings writer as the visible configuration forms, reached only
// over the existing parent's private IPC. No browser activation or new port.
process.on('message', async request => {
  if (request?.type !== 'ui-settings' || typeof request.id !== 'string') return;
  const allowed = new Set(['locale', 'client-ui-theme']);
  try {
    if (!Array.isArray(request.args) || request.args.length > 4) throw Error('Invalid interface settings command');
    const [action, namespace, patch, revision] = request.args, settings = ctx.get('settings');
    if (!settings || !['describe', 'update'].includes(action)) throw Error('Interface settings are unavailable');
    if (action === 'update') {
      if (!allowed.has(namespace) || !patch || Array.isArray(patch) || !Number.isSafeInteger(revision)) throw Error('Current interface settings revision is required');
      await settings.update(namespace, patch, revision);
    }
    const value = settings.describe({ redactSecrets: true }).filter(row => allowed.has(row.ns));
    if (process.connected) process.send({ type: 'ui-settings-result', id: request.id, value });
  } catch (error) {
    if (process.connected) process.send({ type: 'ui-settings-result', id: request.id, error: error.message || 'Interface settings update failed' });
  }
});
// Only the desktop parent consumes this private launch URL; never persist it.
console.log(`dsh web: ${ctx.connection.authenticatedUrl(ctx.webServer.getOrigin())}`);
let closing;
const close = () => closing ||= ctx.fiber.dispose().finally(() => { restoreLocaleSchema(); process.exit(0); });
process.on('SIGTERM', close);
process.on('SIGINT', close);
