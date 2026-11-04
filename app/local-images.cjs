const { uiError } = require('./ui-errors.cjs');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
// User-initiated image imports only. Originals never enter logs or the repository.
// The native TUI owns attachment editing, acceptance and submission.
const limit = 20 * 1024 * 1024;
function saveImages(dataDir, id, files, nativeImage) {
  if (!Array.isArray(files) || !files.length || files.length > 4) throw uiError("error.images.countLimit");
  let bytes = 0;
  const images = files.map(file => {
    if (!(file instanceof Uint8Array) || !file.length || (bytes += file.length) > limit) throw uiError("error.images.totalSizeLimit");
    const image = nativeImage.createFromBuffer(Buffer.from(file)), size = image.getSize();
    if (image.isEmpty() || !size.width || !size.height || size.width > 10000 || size.height > 10000) throw uiError("error.images.unreadableOrDimensionLimit");
    return image.toPNG();
  });
  if (images.reduce((n, image) => n + image.length, 0) > limit) throw uiError("error.images.decodedSizeLimit");
  const folder = path.join(dataDir, 'images', id); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stored = fs.readdirSync(folder).reduce((n, name) => n + fs.statSync(path.join(folder, name)).size, 0);
  if (stored + images.reduce((n, image) => n + image.length, 0) > 64 * 1024 * 1024) throw uiError("error.images.sessionCacheLimit");
  const saved = [];
  try {
    for (const image of images) {
      const file = path.join(folder, crypto.randomUUID() + '.png'), fd = fs.openSync(file, 'wx', 0o600); saved.push(file);
      try { fs.writeFileSync(fd, image); } finally { fs.closeSync(fd); }
    }
    return saved;
  } catch (error) { for (const file of saved) fs.rmSync(file, { force: true }); throw error; }
}
module.exports = { saveImages };
