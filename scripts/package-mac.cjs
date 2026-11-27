// Build from an explicit source allowlist and a clean production dependency tree.
// Personal profiles, native agents, credentials and test evidence never enter it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { packageFuseOptions, verifyPackageFuses } = require('./package-fuses.cjs');
const { includePushLicenses } = require('./package-push-licenses.cjs');
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
// The successful whole build is the only caller. Report missing policy and
// proofs explicitly; never infer installation, occupancy, N or deletion consent.
function reportArtifactRetention(directory, version, output = console.log) {
  const { inventoryArtifacts, planRetention } = require('./artifact-retention.cjs');
  const inventory = inventoryArtifacts(directory);
  const names = ['zip', 'dmg'].flatMap(kind => [
    `native-agent-workspace-${version}-mac-arm64.${kind}`,
    `native-agent-workspace-${version}-mac-arm64.${kind}.sha256`,
  ]);
  if (!inventory.snapshotStable || inventory.errors.length || names.some(name =>
    !inventory.entries.some(row => row.name === name && row.version === version && row.regular && row.stable && row.type === 'file'))) {
    throw Error('Retention report requires a stable complete four-file build.');
  }
  const report = planRetention(inventory, { root: inventory.root,
    rootIdentity: inventory.rootIdentity, buildSucceeded: true, newBuildVersion: version });
  output('Artifact retention (report only; no files removed): ' + JSON.stringify(report));
  return report;
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
    const sources = [
      'adapters.cjs',
      'addressed-handoffs.cjs',
      'agy-tui.cjs',
      'agy_hook.py',
      'answer-notices.cjs',
      'approval-policy.js',
      'backend-switch.cjs',
      'background-control-native.cjs',
      'background-control.cjs',
      'background-fingerprint.cjs',
      'background-operation.cjs',
      'butler-backend-host.cjs',
      'butler-backend.cjs',
      'butler-business.cjs',
      'butler-controller.cjs',
      'butler-dsh-driver.cjs',
      'butler-dsh-host.mjs',
      'butler-dsh-input.cjs',
      'butler-dsh-launch.py',
      'butler-dsh-privacy.cjs',
      'butler-dsh-read-budget.cjs',
      'butler-dsh-usage.cjs',
      'butler-entry-host.cjs',
      'butler-ingress.cjs',
      'butler-ledger.cjs',
      'butler-person.cjs',
      'butler-policy.cjs',
      'butler-presence.cjs',
      'butler-question-notification.cjs',
      'butler-read-audit.cjs',
      'butler-ready.cjs',
      'butler-review-policy.js',
      'butler-review-projection.cjs',
      'butler-role-lock.cjs',
      'butler-role.cjs',
      'butler-rotation-proof.cjs',
      'butler-runner.cjs',
      'butler-runner.py',
      'butler-service-driver.cjs',
      'butler-usage.cjs',
      'claude-bridge/.claude-plugin/plugin.json',
      'claude-bridge/hooks/hooks.json',
      'claude-bridge/hooks/register.js',
      'claude-bridge/native-media.test.ts',
      'claude-bridge/queued-input.test.ts',
      'claude-bridge/submission.test.ts',
      'claude-bridge/turn-records.test.ts',
      'claude-compat-plugin.cjs',
      'claude-loopback.cjs',
      'claude-message-tool.cjs',
      'claude-mod-check.cjs',
      'claude-native-journeys.cjs',
      'claude-pin.cjs',
      'claude-qualification.cjs',
      'claude-session-list.cjs',
      'claude-submit.cjs',
      'claude_hook.py',
      'codex-profile.cjs',
      'codex-qualification.cjs',
      'codex-surface.cjs',
      'codex-surface/0.167.0.json',
      'codex-terminal-bridge.cjs',
      'codex-tool-content.cjs',
      'collaboration-spaces.cjs',
      'compaction-count.cjs',
      'computer-use-outbox-broker.cjs',
      'computer-use-outbox-native.cjs',
      'computer-use-outbox-owner.cjs',
      'computer-use-outbox-tool.cjs',
      'computer-use-outbox-view.cjs',
      'computer-use-outbox.cjs',
      'confirmation-inbox.cjs',
      'confirmation-notifications.cjs',
      'creation-defaults.cjs',
      'daemon.cjs',
      'discussion-guidelines.cjs',
      'dsh-copy.cjs',
      'dsh-egress.cjs',
      'dsh-host.cjs',
      'dsh-server.mjs',
      'dsh-tui-preload.mjs',
      'dsh-tui-update-off.cjs',
      'dsh-tui.cjs',
      'dsh-witness.cjs',
      'dsh/client.js',
      'dsh/host.js',
      'dsh/package.json',
      'git-worktree.cjs',
      'goal-continuation-runner.cjs',
      'goal-continuation.cjs',
      'integrator-engine.cjs',
      'integrator-git.cjs',
      'integrator-handoff.cjs',
      'integrator-repository.cjs',
      'integrator-role.cjs',
      'integrator-words.cjs',
      'legacy-claude.cjs',
      'legacy-codex.cjs',
      'legacy-input.cjs',
      'legacy-observation.cjs',
      'legacy-shared.cjs',
      'local-files.cjs',
      'local-images.cjs',
      'local-pages.cjs',
      'main.cjs',
      'managed-outbox-transport.cjs',
      'manager-notices.cjs',
      'mobile-access.cjs',
      'mobile-broker.cjs',
      'mobile-carrier.cjs',
      'mobile-consent.cjs',
      'mobile-http.cjs',
      'mobile-identity.js',
      'mobile-pairing-keychain.jxa',
      'mobile-pairing-store.cjs',
      'mobile-push.cjs',
      'mobile-qr.cjs',
      'mobile-qr.jxa',
      'mobile-receipts.cjs',
      'mobile-session.cjs',
      'mobile-web/client.js',
      'mobile-web/index.html',
      'mobile-web/manifest.webmanifest',
      'mobile-web/passkeys.js',
      'mobile-web/push.js',
      'mobile-web/style.css',
      'mobile-web/sw.js',
      'mobile-web/workspace.js',
      'mobile-workspace.cjs',
      'model-change.cjs',
      'native-accessibility.cjs',
      'native-blocks.cjs',
      'native-computer-use.cjs',
      'native-directory-trust.cjs',
      'native-history.cjs',
      'native-images.cjs',
      'native-root-proof.cjs',
      'native-terminal-dialog.cjs',
      'native-usage.js',
      'observation.cjs',
      'operator-control.cjs',
      'peer-handoffs.cjs',
      'person-actions.cjs',
      'pi-confirm.mjs',
      'pi-tui.cjs',
      'platform.cjs',
      'preflight.cjs',
      'preload.cjs',
      'pty_host.py',
      'queue-dispatch.cjs',
      'queue-secretary.cjs',
      'quiet-windows.cjs',
      'reader-cache.cjs',
      'reading-state.cjs',
      'record-history.cjs',
      'record-reminders.cjs',
      'regular-popup-dsh.cjs',
      'regular-popup-source.cjs',
      'regular-popup-transport.cjs',
      'regular-popup-worker.mjs',
      'regular-popup.cjs',
      'renderer/cmd-links.js',
      'renderer/confirmation-batch.js',
      'renderer/disclosure-list.js',
      'renderer/fleet-observation.js',
      'renderer/local-search.js',
      'renderer/model-dialog.js',
      'renderer/record-reminders.js',
      'renderer/steward-record.js',
      'renderer/task-board.js',
      'retired-backend.cjs',
      'room-mention.js',
      'room-state.cjs',
      'room-threads.js',
      'rotation-handoff.cjs',
      'runtime-locations.cjs',
      'scoped-outbox-runtime.cjs',
      'service-binding.cjs',
      'service-client.cjs',
      'service-connection.cjs',
      'service-layout.cjs',
      'service-lock.cjs',
      'service-reconnect.cjs',
      'service-transport.cjs',
      'session-labels.cjs',
      'session-model.cjs',
      'session-retirement.cjs',
      'session-wake.cjs',
      'shared-replies.cjs',
      'shown-sessions.cjs',
      'space-images.cjs',
      'space-managers.cjs',
      'space-merge.cjs',
      'startup.html',
      'startup.js',
      'state-delta.cjs',
      'state-push.cjs',
      'state-share.cjs',
      'steward-record.cjs',
      'steward-role.cjs',
      'steward-standing.cjs',
      'steward-wake.cjs',
      'submission-policy.cjs',
      'task-stream.js',
      'temp-cleanup.py',
      'temp-ownership.cjs',
      'temp-reminders.cjs',
      'terminal-continuation.js',
      'terminal-interrupt.cjs',
      'terminal-keyboard.cjs',
      'text-paths.cjs',
      'ui-errors.cjs',
      'ui-locale-profile.mjs',
      'ui-locale.js',
      'ui-messages.js',
      'ui-parent-lease.cjs',
      'vendor-icons.cjs',
      'version-events.cjs',
      'view-drafts.cjs',
      'view-store.cjs',
      'window-frames.cjs',
      'window-placement.cjs',
      'workspace-client.cjs',
      'workspace.cjs',
    ];
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
    includePushLicenses(stage);
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
    reportArtifactRetention(path.join(root, 'dist'), manifest.version);
    // T-167 (user 2026-11-08): old daily release worktrees go after a successful whole build only. A retention
    // problem is reported and leaves the build successful; it never runs on a failed build.
    try { require('./release-worktree-retention.cjs').retainReleaseWorktrees({ root }); } catch (error) { console.error(`Release worktree retention skipped: ${error.message}`); }
    console.log(`Built ${path.basename(archive)} from ${revision}; ${inventory.length} production packages. Not notarized; publication requires artifact review.`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sourceRevision, localSigningIdentity, verifyLocalSigning, localSigningOptions, reportArtifactRetention };
