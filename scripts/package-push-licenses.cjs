// http_ece 1.2.0 omits its upstream MIT LICENSE from the npm archive.
// Preserve the verified original in both production and inspection staging.
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const digest = '717363ac0c7f0883042868db171cfed1f4b423119249eac9bce5131291017ea8';
function includePushLicenses(stage) {
  const folder = path.join(stage, 'node_modules/http_ece');
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  if (pkg.name !== 'http_ece' || pkg.version !== '1.2.0' || pkg.license !== 'MIT') throw Error('Recheck http_ece upstream license provenance');
  const source = path.join(__dirname, '../third-party/http_ece-1.2.0-LICENSE');
  const bytes = fs.readFileSync(source);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw Error('Upstream http_ece license changed');
  fs.copyFileSync(source, path.join(folder, 'LICENSE'), fs.constants.COPYFILE_EXCL);
}
module.exports = { includePushLicenses };
