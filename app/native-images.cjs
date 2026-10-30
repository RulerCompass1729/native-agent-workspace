// Display references only. No provider upload, file watcher or model call.
const fs = require('node:fs'), path = require('node:path'), { randomUUID, createHash } = require('node:crypto');
const MAX_IMAGES = 16, MAX_BYTES = 20 * 1024 * 1024, MAX_PIXELS = 16 * 1024 * 1024;
const MAX_NATIVE_BYTES = 1024 * 1024, MAX_NATIVE_ENCODED = Math.ceil(MAX_NATIVE_BYTES / 3) * 4;
const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 &&
  !/[\u0000-\u001f\u007f]/u.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
const fileIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
function userImageReferences(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (!['localImage', 'image'].includes(part?.type)) continue;
    if (images.length === MAX_IMAGES) { images.push({ unavailable: '其余图片超过本地预览上限，请在原生终端核对。' }); break; }
    images.push(part.type === 'localImage' && validPath(part.path) ? { path: part.path } : { unavailable: '原生记录没有提供可读的本机图片路径。' });
  }
  return images;
}
function imageReferences(images, cwd, previous = [], observedAt = Date.now()) {
  if (!Array.isArray(previous)) previous = [];
  if (!Array.isArray(images) || !images.length) return previous.map(ref => ({ ...ref, unavailable: '图片记录未完整同步，请核对原生会话。' }));
  const refs = images.slice(0, MAX_IMAGES + 1).map((image, index) => {
    const local = validPath(image?.path), old = previous[index];
    if (old && local && old.path === image.path) return { ...old };
    if (old && local && validPath(old.path) && old.path !== image.path) return { ...old, unavailable: '原生图片引用已变化，请重新核对原生记录。' };
    if (!local) return { ...(old && validPath(old.path) ? old : {}), unavailable: typeof image?.unavailable === 'string' ? image.unavailable.slice(0, 200) : '图片没有有效的本机路径。' };
    const ref = { path: image.path, ...(validPath(cwd) && path.isAbsolute(cwd) ? { cwd } : {}), observedAt };
    // Pin the file observed with this native reference. An older file moved
    // under the same path (including through an ancestor symlink) is not it.
    try { ref.fileIdentity = fileIdentity(fs.statSync(resolvedImagePath(ref))); }
    catch { ref.unavailable = '原图片在记录时不存在或无法读取，请重新在原生会话查看。'; }
    return ref;
  });
  return refs;
}
function applyInputImages(record, event) {
  if (event?.nativeId !== record.nativeId || typeof event.id !== 'string' || !Array.isArray(event.images) || !event.images.length) return null;
  const row = record.messages.find(m => m.role === 'user' && (!m.nativeId || m.nativeId === event.nativeId) &&
    ((m.nativeItemId || m.id) === event.id || typeof event.clientId === 'string' && m.id === event.clientId));
  if (!row) return null;
  row.images = imageReferences(event.images, event.cwd || record.cwd, row.images);
  row.nativeId = event.nativeId; row.nativeItemId ||= event.id;
  return row;
}
function imageSource(snapshot, source) {
  if (!source || !['session', 'room'].includes(source.kind) || typeof source.sessionId !== 'string' ||
    typeof source.messageId !== 'string' || typeof source.nativeId !== 'string' ||
    [source.sessionId, source.messageId, source.nativeId].some(id => !id || id.length > 512) ||
    !Number.isSafeInteger(source.index) || source.index < 0 || source.index > MAX_IMAGES ||
    Object.keys(source).some(key => !['kind', 'sessionId', 'nativeId', 'messageId', 'index'].includes(key))) throw Error('图片来源无效。');
  const session = snapshot?.sessions?.find(s => s.id === source.sessionId);
  const message = source.kind === 'room'
    ? snapshot?.room?.messages?.find(m => m.id === source.messageId && m.sessionId === source.sessionId && m.sharedStream === true)
    : session?.messages?.find(m => m.id === source.messageId);
  if (!message || message.nativeId !== source.nativeId || !['complete', 'submitted'].includes(message.status) ||
    !(message.role === 'user' || message.kind === 'tool') || !Array.isArray(message.images)) throw Error('原图片记录已变化或原生读取尚未确认。');
  const ref = message.images[source.index];
  if (!ref) throw Error('原图片记录已变化。');
  // A shared row is its own authority. Never follow nativeMessageId into the
  // complete private session to obtain an image that wasn't on the shared row.
  return { ...ref };
}
function resolvedImagePath(ref) {
  if (ref?.unavailable) throw Error(ref.unavailable);
  if (ref?.kind === 'native-pixels') {
    if (!validPath(ref.cachedPath) || !path.isAbsolute(ref.cachedPath) || !/^[a-f0-9]{64}$/.test(ref.pixelSha256 || '')) throw Error('原生图片缓存来源无效。');
    return ref.cachedPath;
  }
  if (!validPath(ref?.path)) throw Error('图片没有有效的本机路径。');
  if (path.isAbsolute(ref.path)) return path.normalize(ref.path);
  if (typeof ref.cwd !== 'string' || !path.isAbsolute(ref.cwd)) throw Error('原生记录未保存这张图片的工作目录。');
  return path.resolve(ref.cwd, ref.path);
}
function validImagePayload(payload) {
  if (!payload || !Number.isSafeInteger(payload.index) || payload.index < 0 || payload.index > MAX_IMAGES ||
    Object.keys(payload).some(key => !['index', 'mime', 'data', 'sourcePath', 'unavailable'].includes(key)) ||
    payload.sourcePath !== undefined && (!validPath(payload.sourcePath) || !path.isAbsolute(payload.sourcePath))) return false;
  if (payload.unavailable !== undefined) return typeof payload.unavailable === 'string' && payload.unavailable.length > 0 && payload.unavailable.length <= 200 && payload.data === undefined && payload.mime === undefined;
  return payload.index < MAX_IMAGES && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(payload.mime) &&
    typeof payload.data === 'string' && payload.data.length > 0 && payload.data.length <= MAX_NATIVE_ENCODED;
}
function nativePixelReference(dataDir, sessionId, payload, previous) {
  const original = payload.sourcePath ? { path: payload.sourcePath } : {};
  if (payload.unavailable) return { ...original, unavailable: payload.unavailable };
  let bytes, digest;
  try {
    if (payload.data.length % 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(payload.data)) throw Error('原生图片编码无法核验。');
    bytes = Buffer.from(payload.data, 'base64');
    if (!bytes.length || bytes.length > MAX_NATIVE_BYTES || bytes.toString('base64') !== payload.data) throw Error('原生图片超过 1 MB 或编码无法核验。');
    imageDimensions(bytes);
    const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp';
    if (mime !== payload.mime) throw Error('原生图片类型与文件头不符。');
    digest = createHash('sha256').update(bytes).digest('hex');
    if (previous && !previous.pending && previous.pixelSha256 !== digest) return { ...previous, unavailable: '原生图片内容已变化，请核对原生会话。' };
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof sessionId !== 'string' || !sessionId) throw Error('原生图片缺少本机存储位置。');
    const safeDirectory = (directory, create) => {
      if (create) try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('原生图片缓存目录无法核验。');
      return directory;
    };
    safeDirectory(dataDir, false);
    const base = safeDirectory(path.join(dataDir, 'native-image-cache'), true);
    const folder = safeDirectory(path.join(base, createHash('sha256').update(sessionId).digest('hex')), true);
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
    const file = path.join(folder, digest + '.' + extension); let stat;
    if (fs.existsSync(file)) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== bytes.length) throw Error('原生图片缓存已变化。');
        const stored = Buffer.alloc(bytes.length + 1); let offset = 0;
        while (offset < stored.length) { const read = fs.readSync(fd, stored, offset, stored.length - offset, offset); if (!read) break; offset += read; }
        if (offset !== bytes.length || !stored.subarray(0, offset).equals(bytes) || JSON.stringify(fileIdentity(stat)) !== JSON.stringify(fileIdentity(fs.fstatSync(fd)))) throw Error('原生图片缓存已变化。');
      } finally { fs.closeSync(fd); }
    } else {
      let stored = 0;
      for (const name of fs.readdirSync(folder)) {
        const value = fs.lstatSync(path.join(folder, name));
        if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name) || !value.isFile() || value.isSymbolicLink()) throw Error('原生图片缓存目录无法核验。');
        stored += value.size;
      }
      if (stored + bytes.length > 64 * 1024 * 1024) throw Error('本会话原生图片已达 64 MB 上限。');
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const created = fs.fstatSync(fd);
      try { fs.writeFileSync(fd, bytes); stat = fs.fstatSync(fd); }
      catch (error) {
        try { const current = fs.lstatSync(file); if (current.dev === created.dev && current.ino === created.ino && !current.isSymbolicLink()) fs.unlinkSync(file); } catch {}
        throw error;
      } finally { fs.closeSync(fd); }
    }
    return previous && !previous.pending && previous.cachedPath ? previous : { ...original, kind: 'native-pixels', pixelSha256: digest, cachedPath: file, observedAt: Date.now(), fileIdentity: fileIdentity(stat) };
  } catch (error) {
    return { ...(previous && !previous.pending ? previous : original), ...(!previous?.pixelSha256 && digest ? { kind: 'native-pixels', pixelSha256: digest } : {}), unavailable: error.code ? '原生图片无法存入本机缓存。' : error.message };
  }
}
function applyImagePayload(row, payload, dataDir, sessionId) {
  if (!validImagePayload(payload) || !['tool', 'input'].includes(row.kind) || !['complete', 'submitted'].includes(row.status)) return false;
  if (!Array.isArray(row.images)) row.images = [];
  while (row.images.length <= payload.index) row.images.push({ pending: true, unavailable: '图片尚未完整同步。' });
  row.images[payload.index] = nativePixelReference(dataDir, sessionId, payload, row.images[payload.index]);
  if (row.images[payload.index].unavailable) row.incomplete = true;
  return true;
}
// Preflight the bounded encoded bytes before nativeImage allocates a bitmap.
// Static PNG/JPEG/GIF/WebP only; unknown or animated containers fail closed.
// This is a dimension/resource guard, not a replacement image decoder.
function imageDimensions(b) {
  const invalid = () => { throw Error('图片文件头不完整、格式不支持或是动画。'); };
  const dimensions = (width, height) => {
    if (!width || !height || width > 10000 || height > 10000 || width * height > MAX_PIXELS) throw Error('图片尺寸超过 10000 像素或总像素超过 16 Mi 像素。');
    return { width, height };
  };
  if (!Buffer.isBuffer(b) || b.length < 10) return invalid();
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (b.length < 33 || b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR') return invalid();
    const size = dimensions(b.readUInt32BE(16), b.readUInt32BE(20)); let offset = 8, data = false;
    while (offset + 12 <= b.length) {
      const length = b.readUInt32BE(offset), type = b.toString('ascii', offset + 4, offset + 8), end = offset + 12 + length;
      if (end > b.length || offset > 8 && type === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(type)) return invalid();
      if (type === 'IDAT') data = true;
      if (type === 'IEND') return !length && data && end === b.length ? size : invalid();
      offset = end;
    }
    return invalid();
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2, size;
    while (offset < b.length) {
      if (b[offset++] !== 0xff) return invalid();
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > b.length) return invalid();
      const length = b.readUInt16BE(offset); if (length < 2 || offset + length > b.length) return invalid();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size || length < 8 || length !== 8 + 3 * b[offset + 7]) return invalid();
        size = dimensions(b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 3));
      }
      if (marker === 0xda) return size || invalid();
      offset += length;
    }
    return invalid();
  }
  if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) {
    if (b.length < 13) return invalid();
    const size = dimensions(b.readUInt16LE(6), b.readUInt16LE(8));
    let offset = 13 + (b[10] & 128 ? 3 * 2 ** ((b[10] & 7) + 1) : 0), frames = 0;
    const skipBlocks = () => {
      while (offset < b.length) { const n = b[offset++]; if (!n) return; offset += n; }
      invalid();
    };
    while (offset < b.length) {
      const marker = b[offset++];
      if (marker === 0x3b) return frames === 1 && offset === b.length ? size : invalid();
      if (marker === 0x21) { if (offset >= b.length) return invalid(); offset++; skipBlocks(); continue; }
      if (marker !== 0x2c || offset + 9 > b.length || ++frames !== 1) return invalid();
      const left = b.readUInt16LE(offset), top = b.readUInt16LE(offset + 2), width = b.readUInt16LE(offset + 4), height = b.readUInt16LE(offset + 6), flags = b[offset + 8];
      dimensions(width, height); if (left + width > size.width || top + height > size.height) return invalid();
      offset += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      if (offset >= b.length || b[offset] < 2 || b[offset] > 8) return invalid(); offset++; skipBlocks();
    }
    return invalid();
  }
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    if (b.readUInt32LE(4) + 8 !== b.length) return invalid();
    let offset = 12, size, canvas;
    while (offset + 8 <= b.length) {
      const type = b.toString('ascii', offset, offset + 4), length = b.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
      if (end + (length & 1) > b.length || ['ANIM', 'ANMF'].includes(type)) return invalid();
      if (type === 'VP8X') {
        if (canvas || size || length !== 10 || b[start] & 2) return invalid();
        canvas = dimensions(b.readUIntLE(start + 4, 3) + 1, b.readUIntLE(start + 7, 3) + 1);
      } else if (type === 'VP8 ') {
        if (size || length < 10 || b[start] & 1 || b.toString('hex', start + 3, start + 6) !== '9d012a') return invalid();
        size = dimensions(b.readUInt16LE(start + 6) & 0x3fff, b.readUInt16LE(start + 8) & 0x3fff);
      } else if (type === 'VP8L') {
        if (size || length < 5 || b[start] !== 0x2f || b[start + 4] & 0xe0) return invalid();
        const bits = b.readUInt32LE(start + 1); size = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      offset = end + (length & 1);
    }
    if (offset !== b.length || !size || canvas && (canvas.width !== size.width || canvas.height !== size.height)) return invalid();
    return size;
  }
  return invalid();
}
async function readImage(ref, nativeImage) {
  const file = resolvedImagePath(ref);
  if (!Number.isFinite(ref.observedAt) || ref.observedAt < 0) throw Error('图片记录缺少来源时间，请重新在原生会话查看。');
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > (ref.kind === 'native-pixels' ? MAX_NATIVE_BYTES : MAX_BYTES)) throw Error('图片须为本机大小限制内的普通文件（本机文件 20 MB，原生缓存 1 MB）。');
    if (!Array.isArray(ref.fileIdentity) || ref.fileIdentity.length !== 5) throw Error('图片记录缺少文件来源，请重新在原生会话查看。');
    if (ref.kind !== 'native-pixels' && JSON.stringify(fileIdentity(before)) !== JSON.stringify(ref.fileIdentity)) throw Error('图片在这条记录后已变化，请重新在原生会话查看。');
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('图片在读取时已变化。');
    const encoded = buffer.subarray(0, offset);
    if (ref.kind === 'native-pixels' && createHash('sha256').update(encoded).digest('hex') !== ref.pixelSha256) throw Error('原生图片缓存已变化。');
    const declared = imageDimensions(encoded);
    const image = nativeImage.createFromBuffer(encoded), size = image.getSize();
    if (image.isEmpty() || !size.width || !size.height || size.width > 10000 || size.height > 10000 || size.width * size.height > MAX_PIXELS ||
      !(size.width === declared.width && size.height === declared.height || size.width === declared.height && size.height === declared.width)) throw Error('图片无法解码或尺寸与文件头不符。');
    const png = image.toPNG();
    if (!png.length || png.length > MAX_BYTES) throw Error('解码后的图片超过本地预览上限。');
    const scale = Math.min(1, 256 / size.width, 192 / size.height);
    const thumbnail = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toPNG();
    if (!thumbnail.length || thumbnail.length > MAX_BYTES) throw Error('图片缩略图无法读取。');
    return { png, thumbnail: `data:image/png;base64,${thumbnail.toString('base64')}`, width: size.width, height: size.height };
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw Error('图片不存在、无权读取或是符号链接。');
    throw error;
  } finally { await handle?.close(); }
}
class ImagePreviews {
  constructor({ snapshot, nativeImage, maxBytes = 32 * 1024 * 1024, maxEntries = 16 }) {
    this.snapshot = snapshot; this.nativeImage = nativeImage; this.maxBytes = maxBytes; this.maxEntries = maxEntries;
    this.entries = new Map(); this.bytes = 0; this.closed = false; this.pending = 0; this.readTail = Promise.resolve();
  }
  async source(source) {
    if (this.closed) throw Error('图片窗口已关闭。');
    const snapshot = await this.snapshot();
    if (this.closed) throw Error('图片窗口已关闭。');
    return imageSource(snapshot, source);
  }
  async preview(source) {
    source = { ...source };
    if (this.closed || this.pending >= 64) throw Error('图片预览暂时繁忙，请稍后重新打开。');
    this.pending++;
    const preceding = this.readTail; let release;
    this.readTail = new Promise(resolve => { release = resolve; });
    try {
      await preceding;
      const ref = await this.source(source);
      if (this.closed) throw Error('图片窗口已关闭。');
      const image = await readImage(ref, this.nativeImage);
      // Keep decoded data inside the bounded operation while the fresh
      // authority check waits on the service; do not admit another decode yet.
      const current = await this.source(source);
      if (this.closed || JSON.stringify(ref) !== JSON.stringify(current)) throw Error('原图片记录已变化。');
      if (image.png.length > this.maxBytes) throw Error('图片超过当前窗口的预览上限。');
      while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + image.png.length > this.maxBytes)) this.release(this.entries.keys().next().value);
      const token = randomUUID(); this.entries.set(token, { source: { ...source }, ref, png: image.png }); this.bytes += image.png.length;
      const key = 'image:' + createHash('sha256').update(JSON.stringify([source.kind, source.sessionId, source.nativeId, source.messageId, source.index])).digest('hex').slice(0, 32);
      return { token, key, path: ref.path, thumbnail: image.thumbnail, width: image.width, height: image.height };
    } finally { this.pending--; release(); }
  }
  async entry(token) {
    const entry = this.entries.get(token);
    if (!entry) throw Error('图片预览已失效，请重新打开原图片。');
    const current = await this.source(entry.source);
    if (this.closed || this.entries.get(token) !== entry || JSON.stringify(current) !== JSON.stringify(entry.ref)) throw Error('图片预览已失效，请重新打开原图片。');
    return entry;
  }
  async expand(token) { return `data:image/png;base64,${(await this.entry(token)).png.toString('base64')}`; }
  async copy(token, clipboard) {
    const entry = await this.entry(token);
    // Revalidation is complete before this synchronous, explicit clipboard write.
    clipboard.writeImage(this.nativeImage.createFromBuffer(entry.png));
  }
  release(token) { const entry = this.entries.get(token); if (entry) { this.bytes -= entry.png.length; this.entries.delete(token); } }
  close() { this.closed = true; this.entries.clear(); this.bytes = 0; }
}
module.exports = { MAX_IMAGES, MAX_BYTES, MAX_PIXELS, MAX_NATIVE_BYTES, MAX_NATIVE_ENCODED, validImagePayload, applyImagePayload, imageDimensions, userImageReferences, imageReferences, applyInputImages, imageSource, resolvedImagePath, readImage, ImagePreviews };
