// Build from an explicit source allowlist and a clean production dependency tree.
// Personal profiles, native agents, credentials and test evidence never enter it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { packageFuseOptions, verifyPackageFuses } = require('./package-fuses.cjs');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const run = (bin, args, cwd) => execFileSync(bin, args, { cwd, stdio: 'inherit' });
const localIdentityName = 'NAW Local Code Signing';
function localSigningIdentity(query = execFileSync) {
  let output;
  try { output = query('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw Error(`Cannot inspect ${localIdentityName}; unlock the login keychain before packaging.`); }
  // A local self-signed identity need not be a system-trusted identity. Do not
  // use security's -v filter or change the certificate's trust/access policy.
  const rows = [...output.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"NAW Local Code Signing"([^\r\n]*)$/gm)];
  const identities = new Set(rows.map(row => row[1].toUpperCase()));
  if (identities.size !== 1 || rows.some(row => !['', '(CSSMERR_TP_NOT_TRUSTED)'].includes(row[2].trim()))) {
    throw Error(`A unique usable ${localIdentityName} keychain identity is required; no ad-hoc fallback.`);
  }
  return [...identities][0];
}
function verifyLocalSigning(app, identity, query = execFileSync) {
  const requirement = query('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const expected = new RegExp('^designated => identifier "?io\\.github\\.rulercompass1729\\.native-agent-workspace"? and certificate leaf = H"' + identity + '"$', 'i');
  if (!expected.test(requirement)) throw Error('The application must retain the selected certificate-bound designated requirement.');
  return requirement;
}
function localSigningOptions(identity) {
  return { identity, identityValidation: false, preAutoEntitlements: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }) };
}
function sourceRevision(directory = root) {
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit source changes before packaging; no bundle was published.');
  return git(['rev-parse', '--verify', 'HEAD']);
}
async function build() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This alpha is verified only on Apple Silicon macOS.');
  const revision = sourceRevision();
  const signingIdentity = localSigningIdentity();
  // Generate the ignored client only after checking its committed inputs.
  run(process.execPath, [path.join(root, 'scripts/build-ui.cjs')], root);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-package-'));
  // Keep executable staging bundles out of application search. Only the
  // installable archives survive the build; /Applications is the daily entry.
  const stage = path.join(scratch, 'app'); fs.mkdirSync(stage);
  try {
    for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'COPYRIGHT', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(stage, name));
    const sources = ['main.cjs', 'local-files.cjs', 'local-images.cjs', 'preload.cjs', 'startup.html', 'startup.js',
      'dsh-host.cjs', 'dsh-server.mjs', 'ui-errors.cjs', 'ui-parent-lease.cjs',
      'service-client.cjs', 'service-transport.cjs', 'service-layout.cjs', 'workspace-client.cjs', 'legacy-observation.cjs', 'legacy-input.cjs', 'legacy-codex.cjs', 'legacy-claude.cjs', 'reader-cache.cjs', 'legacy-shared.cjs', 'platform.cjs', 'runtime-locations.cjs', 'preflight.cjs', 'daemon.cjs',
      'adapters.cjs', 'terminal-keyboard.cjs', 'codex-terminal-bridge.cjs', 'codex-tool-content.cjs', 'workspace.cjs', 'mobile-access.cjs', 'mobile-session.cjs', 'native-blocks.cjs', 'native-images.cjs', 'shared-replies.cjs', 'session-wake.cjs', 'addressed-handoffs.cjs', 'claude-message-tool.cjs', 'room-threads.js', 'room-mention.js', 'native-history.cjs', 'approval-policy.js', 'native-usage.js', 'peer-handoffs.cjs', 'service-connection.cjs', 'observation.cjs', 'window-placement.cjs', 'pty_host.py', 'claude_hook.py',
      'claude-submit.cjs', 'submission-policy.cjs', 'session-labels.cjs', 'room-state.cjs', 'view-drafts.cjs', 'reading-state.cjs', 'view-store.cjs', 'claude-bridge/.claude-plugin/plugin.json',
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
      extendInfo: { NAWSourceRevision: revision },
      electronVersion: manifest.devDependencies.electron,
      out: path.join(scratch, 'bundles.noindex'), overwrite: true, asar: false, prune: false,
      ...packageFuseOptions,
      // Use the existing local keychain identity without exporting its key or
      // changing system trust. Offline local signing is not notarization.
      osxSign: localSigningOptions(signingIdentity),
    });
    const app = path.join(output[0], 'Native Agent Workspace.app');
    if (sourceRevision() !== revision) throw new Error('Source revision changed during packaging; no bundle was published.');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    verifyLocalSigning(app, signingIdentity);
    await verifyPackageFuses(app);
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    const archive = path.join(root, 'dist', `native-agent-workspace-${manifest.version}-mac-arm64.zip`);
    fs.rmSync(archive, { force: true });
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
    require('./package-dmg.cjs').buildDmg(app);
    console.log(`Built ${path.basename(archive)} from ${revision}; ${inventory.length} production packages. Not notarized; publication requires artifact review.`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sourceRevision, localSigningIdentity, verifyLocalSigning, localSigningOptions };
