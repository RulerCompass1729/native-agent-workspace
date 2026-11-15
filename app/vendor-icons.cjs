// Optional, local-only trademark assets. No downloads or arbitrary file names.
const fs = require('node:fs'), path = require('node:path');
const VENDORS = ['anthropic', 'openai', 'deepseek'], LIMIT = 256 * 1024;
function loadVendorIcons(directory) {
  const result = {};
  for (const vendor of VENDORS) {
    let fd;
    try {
      fd = fs.openSync(path.join(directory, vendor + '.png'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > LIMIT) continue;
      const bytes = Buffer.alloc(LIMIT + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0), data = bytes.subarray(0, length);
      if (length < 33 || length > LIMIT || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.toString('ascii', 12, 16) !== 'IHDR') continue;
      const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
      if (!width || !height || width > 1024 || height > 1024) continue;
      result[vendor] = 'data:image/png;base64,' + data.toString('base64');
    } catch { /* Missing, unreadable or unsafe files keep the letter mark. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return result;
}
module.exports = { loadVendorIcons };
