// Wrap the existing reviewed app using macOS tools; no installer dependency.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const appName = 'Native Agent Workspace';
const run = (bin, args) => execFileSync(bin, args, { stdio: 'inherit' });

function buildDmg(app) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This alpha DMG is verified only on Apple Silicon macOS.');
  const bundled = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/app/package.json'), 'utf8'));
  if (bundled.name !== manifest.name || bundled.version !== manifest.version) throw new Error('Build the matching app with npm run package:mac first.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dmg-'));
  try {
    const contents = path.join(scratch, 'contents'); fs.mkdirSync(contents);
    run('/usr/bin/ditto', [app, path.join(contents, `${appName}.app`)]);
    fs.symlinkSync('/Applications', path.join(contents, 'Applications'));
    fs.writeFileSync(path.join(contents, 'Install.txt'), [
      'Drag Native Agent Workspace.app to Applications, then eject this disk image.',
      'Open the installed app from Applications. Git, Node.js and npm are not needed to run this app.',
      'Apple Silicon Mac, Python 3, and your own installed/signed-in Claude Code or Codex are required.',
      'This is a local alpha build, not an Apple-notarized public release.',
      '',
      '把应用拖到 Applications（应用程序），推出此磁盘映像，再从应用程序中打开。',
      '运行应用不需要 Git、Node.js 或 npm；仍需 Python 3 及已安装、登录的 Claude Code 或 Codex。',
      '这是本地试用构建，尚未完成 Apple 公证。',
      '',
    ].join('\n'));
    const image = path.join(root, 'dist', `${manifest.name}-${manifest.version}-mac-arm64.dmg`);
    run('/usr/bin/hdiutil', ['create', '-volname', appName, '-srcfolder', contents, '-fs', 'HFS+', '-format', 'UDZO', '-ov', image]);
    run('/usr/bin/hdiutil', ['verify', image]);
    fs.writeFileSync(`${image}.sha256`, `${createHash('sha256').update(fs.readFileSync(image)).digest('hex')}  ${path.basename(image)}\n`);
    console.log(`Built ${path.basename(image)}. Unnotarized alpha: downloaded copies may need app-specific Gatekeeper approval; publication requires artifact review.`);
    return image;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

module.exports = { buildDmg };
if (require.main === module) {
  try { buildDmg(path.join(root, 'dist', `${appName}-darwin-arm64`, `${appName}.app`)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
