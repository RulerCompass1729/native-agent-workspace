// Build from an explicit source allowlist and a clean production dependency tree.
// Personal profiles, native agents, credentials and test evidence never enter it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const run = (bin, args, cwd) => execFileSync(bin, args, { cwd, stdio: 'inherit' });
async function build() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This alpha is verified only on Apple Silicon macOS.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-package-'));
  // Keep executable staging bundles out of application search. Only the
  // installable archives survive the build; /Applications is the daily entry.
  const stage = path.join(scratch, 'app'); fs.mkdirSync(stage);
  try {
    for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'COPYRIGHT', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(stage, name));
    const sources = ['main.cjs', 'preload.cjs', 'startup.html', 'startup.js',
      'dsh-host.cjs', 'dsh-server.mjs', 'ui-errors.cjs', 'ui-parent-lease.cjs',
      'service-client.cjs', 'service-layout.cjs', 'workspace-client.cjs', 'legacy-observation.cjs', 'legacy-input.cjs', 'platform.cjs', 'runtime-locations.cjs', 'preflight.cjs', 'daemon.cjs',
      'adapters.cjs', 'workspace.cjs', 'observation.cjs', 'pty_host.py', 'claude_hook.py',
      'claude-submit.cjs', 'submission-policy.cjs', 'session-labels.cjs', 'room-state.cjs', 'view-drafts.cjs', 'reading-state.cjs', 'claude-bridge/.claude-plugin/plugin.json',
      'claude-bridge/hooks/hooks.json', 'claude-bridge/hooks/register.js',
      'dsh/package.json', 'dsh/host.js', 'dsh/client.js'];
    for (const name of sources) {
      const target = path.join(stage, 'app', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, 'app', name), target);
    }
    // No dependency install scripts, audit submissions, development tools or
    // locally cached node_modules are inherited by the application payload.
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
    for (const name of ['headless', 'addon-serialize']) {
      const folder = path.join(stage, 'node_modules/@xterm', name);
      if (!fs.existsSync(path.join(folder, 'LICENSE'))) fs.copyFileSync(path.join(stage, 'node_modules/@xterm/xterm/LICENSE'), path.join(folder, 'LICENSE'));
    }
    const inventory = [];
    function packages(folder) {
      if (!fs.existsSync(folder)) return;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const target = path.join(folder, entry.name);
        if (entry.name.startsWith('@')) { packages(target); continue; }
        const file = path.join(target, 'package.json');
        if (!fs.existsSync(file)) continue;
        const p = JSON.parse(fs.readFileSync(file, 'utf8'));
        const licenses = fs.readdirSync(target).filter(n => /^(licen[cs]e|copying|notice)/i.test(n));
        if (!licenses.length) throw new Error(`Missing distributed license: ${p.name}`);
        inventory.push({ name: p.name, version: p.version, license: p.license, path: path.relative(stage, target), notices: licenses });
        packages(path.join(target, 'node_modules'));
      }
    }
    packages(path.join(stage, 'node_modules'));
    fs.writeFileSync(path.join(stage, 'DEPENDENCIES.json'), JSON.stringify(inventory, null, 2) + '\n');
    const notices = path.join(stage, 'third-party'); fs.mkdirSync(notices);
    const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
    if (fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim() !== manifest.devDependencies.electron) throw new Error('Electron notice version mismatch');
    fs.copyFileSync(path.join(electronDist, 'LICENSE'), path.join(notices, 'Electron-LICENSE'));
    fs.copyFileSync(path.join(electronDist, 'LICENSES.chromium.html'), path.join(notices, 'LICENSES.chromium.html'));
    const browser = await require('./browser-notices.cjs').browserNotices(scratch, path.join(notices, 'browser'));
    for (const row of browser.filter(row => !row.notices.length)) fs.copyFileSync(path.join(stage, 'node_modules/@xterm/xterm/LICENSE'), path.join(notices, 'browser', `${row.name.replaceAll('/', '__')}@${row.version}`, 'LICENSE'));
    const { packager } = await import('@electron/packager');
    const output = await packager({ dir: stage, name: 'Native Agent Workspace',
      appBundleId: 'io.github.rulercompass1729.native-agent-workspace',
      appVersion: manifest.version, buildVersion: '1', platform: 'darwin', arch: 'arm64',
      electronVersion: manifest.devDependencies.electron,
      out: path.join(scratch, 'bundles.noindex'), overwrite: true, asar: false, prune: false,
      // Ad-hoc signatures are for local alpha testing, not notarized distribution.
      osxSign: { identity: '-', identityValidation: false, preAutoEntitlements: false, optionsForFile: () => ({ hardenedRuntime: false }) },
    });
    const app = path.join(output[0], 'Native Agent Workspace.app');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    const archive = path.join(root, 'dist', `native-agent-workspace-${manifest.version}-mac-arm64.zip`);
    fs.rmSync(archive, { force: true });
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
    require('./package-dmg.cjs').buildDmg(app);
    console.log(`Built ${path.basename(archive)}; ${inventory.length} production packages. Not notarized; publication requires artifact review.`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
build().catch(error => { console.error(error.message); process.exitCode = 1; });
