// A UI-only composition of the pinned upstream DSH packages. Native sessions
// belong to daemon.cjs; no DSH model, tools, telemetry or account plugins mount.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot, readProfilePatches } from '@deepseek-ai/dsh-app-boot';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2];
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Private UI directory required');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.DSH_HOME = dataDir;
const names = ['host-webserver', 'credentials-local', 'typert-registry', 'typert-loader',
  'config-editor', 'settings', 'api-settings-controller', 'api-remote-access', 'api-gateway', 'client-connection', 'api-remotes', 'client-modules',
  'host-frontend-static', 'client-ui-renderer', 'client-ui-settings', 'client-locale', 'client-shortcuts',
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
const profileContext = { name: 'workspace', dir: dataDir, home: dataDir, cwd: dataDir, patchPath: path.join(dataDir, 'cordis.patch.yml'), installAnchor: anchor, startedBundles: [], overlays: [] };
const profileManifest = path.join(dataDir, 'package.json');
if (!fs.existsSync(profileManifest)) fs.writeFileSync(profileManifest, JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }), { mode: 0o600 });
if (!fs.existsSync(profileContext.patchPath)) fs.writeFileSync(profileContext.patchPath, '[]\n', { mode: 0o600 });
const ctx = await boot('workspace', filename, readProfilePatches('dsh', profileContext), ctx => ctx.provide('profileContext', profileContext), pathToFileURL(anchor).href);
// Only the desktop parent consumes this private launch URL; never persist it.
console.log(`dsh web: ${ctx.connection.authenticatedUrl(ctx.webServer.getOrigin())}`);
let closing;
const close = () => closing ||= ctx.fiber.dispose().finally(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
