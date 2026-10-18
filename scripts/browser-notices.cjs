// Preserve full license/notice texts for dependencies embedded in upstream's
// prebuilt browser bundles. Downloads are public, integrity-pinned tarballs;
// nothing is installed or executed. This is not a general license audit.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const inputs = require('../docs/browser-notices.json');
async function browserNotices(scratch, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const queue = [...inputs.packages], results = [];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const metadataURL = `https://registry.npmjs.org/${encodeURIComponent(row.name)}/${row.version}`;
      const response = await fetch(metadataURL, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Cannot retrieve notice metadata for ${row.name}`);
      const metadata = await response.json();
      const url = new URL(metadata.dist.tarball);
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw new Error('Unexpected notice source');
      const archive = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!archive.ok) throw new Error(`Cannot retrieve notices for ${row.name}`);
      const bytes = Buffer.from(await archive.arrayBuffer());
      const [algorithm, expected] = row.integrity.split('-');
      if (algorithm !== 'sha512' || createHash('sha512').update(bytes).digest('base64') !== expected) throw new Error(`Notice integrity mismatch for ${row.name}`);
      const key = `${row.name.replaceAll('/', '__')}@${row.version}`;
      const file = path.join(scratch, `${key}.tgz`); fs.writeFileSync(file, bytes);
      const names = execFileSync('/usr/bin/tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n');
      const notices = names.filter(name => !name.endsWith('/') && !name.startsWith('/') && !name.split('/').includes('..') && /^(licen[cs]e|copying|copyright|notice)([.\-_]|$)/i.test(path.basename(name)));
      // The xterm npm file lists omit these notices; they are supplemented by
      // package-mac from the matching xterm.js release's full MIT license.
      if (!notices.length && !['@xterm/headless', '@xterm/addon-serialize'].includes(row.name)) throw new Error(`No full notice found for ${row.name}`);
      const folder = path.join(destination, key); fs.mkdirSync(folder, { recursive: true });
      for (const name of notices) {
        const text = execFileSync('/usr/bin/tar', ['-xOzf', file, name], { maxBuffer: 4 * 1024 * 1024 });
        fs.writeFileSync(path.join(folder, name.replace(/^[^/]+\//, '').replaceAll('/', '__')), text);
      }
      fs.rmSync(file);
      results.push({ ...row, license: metadata.license, source: url.href, notices });
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const failure = outcomes.find(result => result.status === 'rejected');
  if (failure) throw failure.reason; // All writers have stopped before scratch cleanup.
  results.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(destination, 'INDEX.json'), JSON.stringify({ source: inputs.source, scope: inputs.scope, packages: results }, null, 2) + '\n');
  return results;
}
module.exports = { browserNotices };
