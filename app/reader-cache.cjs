// Private display history only. Reading a cache grants no native authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readerPath = (dataDir, nativeId) => path.join(dataDir, `legacy-reader-${crypto.createHash('sha256').update(nativeId).digest('hex')}.json`);
const maxBytes = 64 * 1024 * 1024;
function readReaderCache(filename, record) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > maxBytes) throw Error('Unsafe reader cache');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (saved.nativeId !== record.nativeId || JSON.stringify(saved.processIdentity) !== JSON.stringify(record.processIdentity) ||
      saved.provider && saved.provider !== record.provider || !Array.isArray(saved.messages) ||
      record.provider === 'codex' && JSON.stringify(saved.serverIdentity) !== JSON.stringify(record.serverIdentity)) throw Error('Reader identity changed');
    return saved;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function writeReaderCache(filename, record, extra = {}) {
  const body = JSON.stringify({ ...extra, nativeId: record.nativeId, provider: record.provider,
    processIdentity: record.processIdentity, ...(record.provider === 'codex' ? { serverIdentity: record.serverIdentity } : {}),
    messages: record.messages.filter(row => !row.volatile) });
  if (Buffer.byteLength(body) > maxBytes) throw Error('Reader cache exceeds limit');
  const temporary = filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
module.exports = { readerPath, readReaderCache, writeReaderCache };
