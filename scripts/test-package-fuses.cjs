// Read-only gate for Main's signed macOS bundle; never flips an installed app.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyPackageFuses } = require('./package-fuses.cjs');
async function main() {
  const app = process.argv[2];
  if (process.platform !== 'darwin' || !app || !path.isAbsolute(app) || !app.endsWith('.app') || !fs.statSync(app).isDirectory()) throw Error('Provide the absolute path to Main\'s signed macOS .app.');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const current = await verifyPackageFuses(app);
  console.log(JSON.stringify({ signedFuseReadback: 'PASS', wire: Object.entries(current).filter(([key]) => key !== 'version').map(([, value]) => String.fromCharCode(value)).join(''), runAsNode: true, nodeOptions: false, nodeCliInspect: false, runtimeAcceptance: 'Not run by this read-only gate' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
