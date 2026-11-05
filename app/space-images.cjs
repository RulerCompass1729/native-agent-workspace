// User-uploaded space images. These references never claim a native read.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { roomId: validRoom } = require('./collaboration-spaces.cjs');
const { imageDimensions } = require('./native-images.cjs');
const { saveImages } = require('./local-images.cjs');
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'NAW_SPACE_IMAGE' }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
function validSpaceImagePacket(packet, roomId) {
  return Boolean(packet && typeof packet === 'object' && !Array.isArray(packet) && Object.keys(packet).length === 2 &&
    Object.keys(packet).every(key => ['version', 'refs'].includes(key)) && validRoom(packet.version) && packet.version !== 'shared' &&
    Array.isArray(packet.refs) && packet.refs.length > 0 && packet.refs.length <= 4 &&
    packet.refs.every(ref => validSpaceImage(ref, roomId)) && new Set(packet.refs.map(ref => ref.id)).size === packet.refs.length &&
    packet.refs.reduce((n, ref) => n + ref.size, 0) <= MAX_BYTES);
}
function spaceImageRoot(dataDir) {
  // The only service layout forms are '.' and 'backends/<20 hex>' (service-layout).
  const root = fs.realpathSync(dataDir);
  return /^[a-f0-9]{20}$/.test(path.basename(root)) && path.basename(path.dirname(root)) === 'backends' ? path.dirname(path.dirname(root)) : root;
}

function ownedDirectory(directory, create) {
  if (create) try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('Space image storage is not a private owned directory');
  return directory;
}
function folder(root, roomId, create = false) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !validRoom(roomId)) fail('Invalid space image location');
  root = fs.realpathSync(root); ownedDirectory(root, false);
  const base = ownedDirectory(path.join(root, 'images'), create);
  return ownedDirectory(path.join(base, 'room-' + digest(roomId)), create);
}
function validSpaceImage(ref, roomId) {
  return Boolean(ref && typeof ref === 'object' && !Array.isArray(ref) && ref.roomId === roomId && validRoom(roomId) &&
    IMAGE_ID.test(ref.id) && /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.size) && ref.size > 0 && ref.size <= MAX_BYTES &&
    Number.isSafeInteger(ref.width) && ref.width > 0 && Number.isSafeInteger(ref.height) && ref.height > 0 &&
    ref.width <= 10000 && ref.height <= 10000 && ref.width * ref.height <= 16 * 1024 * 1024 &&
    typeof ref.name === 'string' && ref.name.length > 0 && ref.name.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(ref.name) &&
    Object.keys(ref).length === 8 && Object.keys(ref).every(key => ['roomId', 'id', 'sha256', 'size', 'width', 'height', 'name', 'kind'].includes(key)) && ref.kind === 'space-upload');
}
function readSpaceImage(root, roomId, ref) {
  if (!validSpaceImage(ref, roomId)) fail('Invalid or changed space image reference');
  const file = path.join(folder(root, roomId), ref.id);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size !== ref.size) fail('Space image file no longer matches its reference');
    // A bounded read also catches a file growing between stat and read.
    const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < buffer.length) { const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!read) break; offset += read; }
    if (offset !== stat.size || JSON.stringify(identity(stat)) !== JSON.stringify(identity(fs.fstatSync(fd)))) fail('Space image changed while it was read');
    const png = buffer.subarray(0, offset);
    if (!png.subarray(0, 8).equals(PNG) || digest(png) !== ref.sha256) fail('Space image bytes no longer match their reference');
    const size = imageDimensions(png);
    if (size.width !== ref.width || size.height !== ref.height) fail('Space image dimensions no longer match their reference');
    return { path: file, png, width: size.width, height: size.height, fileIdentity: identity(stat) };
  } finally { fs.closeSync(fd); }
}
function stageSpaceImages(root, roomId, files, nativeImage) {
  if (!Array.isArray(files) || !files.length || files.length > 4) fail('Choose between one and four space images');
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || !(file.bytes instanceof Uint8Array) || !file.bytes.length || (total += file.bytes.length) > MAX_BYTES ||
      file.name !== undefined && typeof file.name !== 'string') fail('Invalid space image import');
    imageDimensions(Buffer.from(file.bytes)); // Before the platform decoder allocates pixels.
  }
  const directory = folder(root, roomId, true), namespace = path.basename(directory);
  const saved = saveImages(fs.realpathSync(root), namespace, files.map(f => f.bytes), nativeImage);
  try {
    return saved.map((file, index) => {
      const bytes = fs.readFileSync(file), size = imageDimensions(bytes);
      if (!bytes.subarray(0, 8).equals(PNG)) fail('The platform decoder did not produce a PNG');
      const name = path.basename(files[index].name || 'Image.png').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 160) || 'Image.png';
      const ref = { kind: 'space-upload', roomId, id: path.basename(file), sha256: digest(bytes), size: bytes.length, width: size.width, height: size.height, name };
      readSpaceImage(root, roomId, ref);
      return ref;
    });
  } catch (error) {
    // Only this import's fresh UUID paths; never original files or prior uploads.
    for (const file of saved) try {
      const stat = fs.lstatSync(file);
      if (path.dirname(file) === directory && IMAGE_ID.test(path.basename(file)) && stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()) fs.unlinkSync(file);
    } catch {}
    throw error;
  }
}
function discardStagedSpaceImages(root, roomId, refs) {
  // For a failed, unacknowledged import only. Referenced draft/history files
  // are removed by the caller's complete keep-list operation instead.
  let failed = false;
  for (const ref of refs) try {
    const read = readSpaceImage(root, roomId, ref), stat = fs.lstatSync(read.path);
    if (JSON.stringify(identity(stat)) !== JSON.stringify(read.fileIdentity)) fail('Space image changed before cleanup');
    fs.unlinkSync(read.path);
  } catch { failed = true; }
  return !failed;
}
function removeUnusedSpaceImages(root, roomId, keepIds, candidates) {
  if (!Array.isArray(keepIds) || keepIds.some(id => typeof id !== 'string' || !IMAGE_ID.test(id))) fail('An explicit valid space image keep list is required');
  if (candidates !== undefined && (!Array.isArray(candidates) || candidates.some(id => typeof id !== 'string' || !IMAGE_ID.test(id)))) fail('Invalid image cleanup cut');
  const eligible = candidates === undefined ? null : new Set(candidates);
  const result = { removed: 0, kept: 0, failed: false }, keep = new Set(keepIds); let directory;
  try { directory = folder(root, roomId); }
  catch (error) { if (error.code === 'ENOENT') return result; result.failed = true; return result; }
  for (const id of fs.readdirSync(directory)) {
    if (eligible && !eligible.has(id)) { result.kept++; continue; }
    try {
      const file = path.join(directory, id), stat = fs.lstatSync(file);
      if (!IMAGE_ID.test(id) || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) { result.kept++; result.failed = true; continue; }
      if (keep.has(id)) { result.kept++; continue; }
      fs.unlinkSync(file); result.removed++;
    } catch { result.failed = true; }
  }
  return result;
}
function hasSpaceImageCopies(root, roomId) {
  try { return fs.readdirSync(folder(root, roomId)).length > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function spaceImageCopyIds(root, roomId) {
  const ids = fs.readdirSync(folder(root, roomId));
  if (ids.some(id => !IMAGE_ID.test(id))) fail('Unknown file in space image storage');
  return ids;
}
function spaceImageKeepIds(records, snapshot, roomId) {
  if (!Array.isArray(records) || !Array.isArray(snapshot?.sessions) || !Array.isArray(snapshot?.rooms || (snapshot?.room ? [snapshot.room] : null))) fail('Complete image owners are required');
  const keep = new Set(), add = refs => {
    if (refs === undefined) return;
    if (!Array.isArray(refs)) fail('Invalid image owner record');
    for (const ref of refs) if (ref?.kind === 'space-upload' && ref.roomId === roomId) {
      if (!validSpaceImage(ref, roomId)) fail('Invalid retained space image');
      keep.add(ref.id);
    }
  };
  for (const view of records) for (const draft of Object.values(view.roomViews || {})) add(draft.roomImages);
  for (const room of snapshot.rooms || [snapshot.room]) for (const row of room.messages || []) add(row.images);
  for (const session of snapshot.sessions) for (const row of session.messages || []) add(row.spaceUploads);
  return [...keep];
}

// Created inside the trusted sender after resolving this space's saved draft.
// The native echo identifies input acceptance; its paths are not hash receipts
// and do not prove that a model understood the image.
class SpaceImageSubmission {
  constructor(root, roomId, version, refs, nativeId, tag) {
    if (!validRoom(roomId) || !validRoom(version) || version === 'shared' ||
        !Array.isArray(refs) || !refs.length || refs.length > 4 ||
        new Set(refs.map(ref => ref?.id)).size !== refs.length ||
        refs.some(ref => !validSpaceImage(ref, roomId)) || refs.reduce((n, ref) => n + ref.size, 0) > MAX_BYTES ||
        typeof nativeId !== 'string' || !nativeId || typeof tag !== 'string' || !tag) fail('Invalid space image submission');
    this.root = root; this.roomId = roomId; this.version = version;
    this.refs = refs.map(ref => Object.freeze({ ...ref })); this.nativeId = nativeId; this.tag = tag;
    this.paths = this.refs.map(ref => readSpaceImage(root, roomId, ref).path);
  }
  input(text) {
    // Recheck immediately before dispatch; never send a substituted local file.
    this.refs.forEach((ref, index) => { if (readSpaceImage(this.root, this.roomId, ref).path !== this.paths[index]) fail('Space image path changed'); });
    return [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...this.paths.map(file => ({ type: 'localImage', path: file }))];
  }
  observe(params) {
    const item = params?.item;
    if (params?.threadId !== this.nativeId || typeof params.turnId !== 'string' || !params.turnId ||
        item?.type !== 'userMessage' || item.clientId !== this.tag || typeof item.id !== 'string' || !item.id || !Array.isArray(item.content)) return;
    const media = item.content.filter(part => part?.type !== 'text');
    if (media.length !== this.paths.length || media.some((part, i) => part?.type !== 'localImage' || part.path !== this.paths[i])) return;
    this.echo = { turnId: params.turnId, nativeItemId: item.id };
  }
  confirm(turnId) {
    if (this.accepted || !this.echo || this.echo.turnId !== turnId) return null;
    try { this.input(''); } catch { return null; }
    this.accepted = true;
    return { roomId: this.roomId, version: this.version, tag: this.tag, nativeId: this.nativeId,
      nativeItemId: this.echo.nativeItemId, turnId, basis: 'native-local-image-echo',
      images: this.refs.map(ref => ({ ...ref })), time: Date.now() };
  }
}
module.exports = { stageSpaceImages, readSpaceImage, discardStagedSpaceImages, removeUnusedSpaceImages, hasSpaceImageCopies, spaceImageCopyIds, spaceImageKeepIds, validSpaceImage, validSpaceImagePacket, spaceImageRoot, SpaceImageSubmission };
