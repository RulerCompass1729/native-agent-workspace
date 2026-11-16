// Stage only the push-related part of package-mac's payload, without packaging,
// signing, registering an app, installing packages or accessing the network.
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
function stagePushPayload(output) {
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw Error('New absolute private output directory required');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))), lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  if (pkg.dependencies['web-push'] !== '3.6.7' || lock.packages[''].dependencies['web-push'] !== '3.6.7') throw Error('Push dependency is not exactly pinned');
  const files = ['mobile-push.cjs', 'mobile-web/push.js', 'mobile-web/sw.js', 'mobile-web/manifest.webmanifest'];
  const packaging = fs.readFileSync(path.join(root, 'scripts/package-mac.cjs'), 'utf8');
  const sources = packaging.slice(packaging.indexOf('const sources = ['), packaging.indexOf('];', packaging.indexOf('const sources = [')));
  for (const name of files) if (!sources.includes(`'${name}'`)) throw Error('Push source missing from package-mac');
  if (!packaging.includes("['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']")) throw Error('Recheck production dependency staging');
  const modules = new Map();
  function visit(name, from) {
    let directory = path.dirname(createRequire(path.join(from, 'package.json')).resolve(name));
    while (directory !== path.dirname(directory)) {
      const file = path.join(directory, 'package.json');
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).name === name) break;
      directory = path.dirname(directory);
    }
    const p = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    const locked = lock.packages['node_modules/' + name];
    if (p.name !== name || locked?.version !== p.version || locked.dev) throw Error('Runtime dependency/lock mismatch: ' + name);
    if (modules.has(name)) { if (modules.get(name).version !== p.version) throw Error('Nested version needs separate staging'); return; }
    modules.set(name, { directory, version: p.version });
    for (const child of Object.keys(p.dependencies || {})) visit(child, directory);
  }
  visit('web-push', root);
  const app = path.join(output, 'Native Agent Workspace.app/Contents/Resources/app');
  fs.mkdirSync(app, { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, name), path.join(app, name));
  for (const name of files) { const target = path.join(app, 'app', name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, 'app', name), target); }
  for (const [name, value] of modules) fs.cpSync(value.directory, path.join(app, 'node_modules', name), {
    recursive: true, dereference: true, filter: value => path.basename(value) !== 'node_modules',
  });
  const listed = [];
  function list(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) list(file); else listed.push(path.relative(output, file)); } }
  list(output);
  return { app, dependencies: [...modules].map(([name, p]) => `${name}@${p.version}`).sort(), files: listed.sort() };
}
module.exports = { stagePushPayload };
if (require.main === module) {
  const result = stagePushPayload(process.argv[2]);
  for (const file of result.files) console.log(file);
  console.log(`PUSH PAYLOAD: ${result.dependencies.length} runtime packages, ${result.files.length} files; staged only, unsigned`);
}
