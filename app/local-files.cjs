const { uiError } = require('./ui-errors.cjs');
// Local, explicitly chosen text snapshots. No watcher, crawl, upload or model call.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const MAX_BYTES = 256 * 1024;
const extensions = ['txt', 'md', 'csv', 'tsv', 'json'];
async function readPreview(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !extensions.includes(path.extname(file).slice(1).toLowerCase())) throw uiError("error.files.textTypeRequired");
  const name = path.basename(file);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) throw uiError("error.files.controlCharacterName");
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) throw uiError("error.files.notRegular");
    if (before.size > MAX_BYTES) throw uiError("error.files.tooLarge");
    const buffer = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw uiError("error.files.changedWhileReading");
    const bytes = Buffer.from(buffer.subarray(0, offset));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw uiError("error.files.notDisplayableText");
    return { token: randomUUID(), name, text, bytes };
  } catch { throw uiError("error.files.previewUnavailable"); }
  finally { await handle?.close(); }
}
async function saveCopy(preview, file) {
  if (!preview?.bytes || typeof file !== 'string' || !path.isAbsolute(file)) throw uiError("error.files.previewExpired");
  let handle;
  try {
    // Never replace a source, symlink or an existing result. The picker suggests
    // a new copy name, and collision is recoverable in the still-open preview.
    handle = await fs.promises.open(file, 'wx', 0o600);
    await handle.writeFile(preview.bytes); await handle.sync();
  } catch (error) {
    if (handle) {
      // Clean only the inode we created, never a concurrently replaced file.
      try { const opened = await handle.stat(), current = await fs.promises.lstat(file);
        if (opened.dev === current.dev && opened.ino === current.ino) await fs.promises.unlink(file);
      } catch { /* Preserve an unconfirmed target rather than remove someone else's file. */ }
    }
    if (error.code === 'EEXIST') throw uiError("error.files.copyNameExists");
    throw uiError("error.files.copySaveFailed");
  } finally { await handle?.close(); }
}
const openExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json']);
const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 &&
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
const changed = () => uiError("error.files.originalMessageChanged");
function origin(snapshot, source) {
  if (!source || !['session', 'room'].includes(source.kind) ||
    ['sessionId', 'messageId'].some(key => typeof source[key] !== 'string' || !source[key] || source[key].length > 512) ||
    !(source.nativeId === null || typeof source.nativeId === 'string' && source.nativeId.length > 0 && source.nativeId.length <= 512) ||
    !(source.cwd === null || validPath(source.cwd) && path.isAbsolute(source.cwd)) ||
    source.roomId !== undefined && (source.kind !== 'room' || !require('./collaboration-spaces.cjs').roomId(source.roomId)) ||
    Object.keys(source).some(key => !['kind', 'roomId', 'sessionId', 'messageId', 'nativeId', 'cwd'].includes(key))) throw changed();
  const session = snapshot?.sessions?.find(item => item.id === source.sessionId);
  // A room row authorizes only its own already-shared content, never a lookup
  // into a private row through nativeMessageId. Addressed/final rows need not
  // carry the streaming marker.
  const message = source.kind === 'room'
    ? (snapshot?.rooms || [snapshot?.room]).find(r => (r?.id || 'shared') === (source.roomId || 'shared'))?.messages?.find(item => item.id === source.messageId && item.sessionId === source.sessionId)
    : session?.messages?.find(item => item.id === source.messageId);
  // No old cwd is persisted for Markdown replies. A changed or reused native
  // context must not reinterpret its historical relative links in today's cwd.
  const cwdKnown = session && !session.nativeContextPending && (message?.nativeId
    ? message.nativeId === session.nativeId && !session.nativeContexts?.some(item => item.nativeId === message.nativeId)
    : !session.nativeContexts?.length);
  const cwd = cwdKnown ? session.cwd || null : null;
  if (!message || message.role !== 'assistant' || typeof message.text !== 'string' || !message.text ||
    (message.nativeId || null) !== source.nativeId || cwd !== source.cwd) throw changed();
  return { cwd };
}
function material(file, stat) {
  if (!openExtensions.has(path.extname(file).slice(1).toLowerCase())) throw uiError("error.files.linkTypeUnsupported");
  if (!stat.isFile() || stat.isSymbolicLink?.() || Number(stat.mode) & 0o111) throw uiError("error.files.onlyNonExecutableMaterials");
}
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
async function openMessageFile({ snapshot, openPath, isCurrent = () => true, background = false }, source, requestedPath, options) {
  if (!validPath(requestedPath) || /^[a-z][a-z0-9+.-]*:/i.test(requestedPath) || /^[/\\]{2}/u.test(requestedPath)) throw uiError("error.files.localPathInvalid");
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some(key => key !== 'line') || options.line !== undefined && (!Number.isSafeInteger(options.line) || options.line < 1))) throw uiError("error.files.locationInvalid");
  source = source && { ...source }; const line = options?.line;
  const current = () => { if (!isCurrent()) throw changed(); };
  current(); const first = origin(await snapshot(), source); current();
  // DSH already decodes the path once. Decoding again would open a different
  // file when a real filename contains a literal percent sequence.
  const explicit = requestedPath.startsWith('~/') ? path.join(os.homedir(), requestedPath.slice(2)) : requestedPath;
  if (!path.isAbsolute(explicit) && !first.cwd) throw uiError("error.files.messageWorkingDirectoryMissing");
  const file = path.isAbsolute(explicit) ? path.normalize(explicit) : path.resolve(first.cwd, explicit);
  let handle;
  try {
    const before = await fs.promises.lstat(file, { bigint: true }); material(file, before);
    const canonical = await fs.promises.realpath(file);
    handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true }); material(canonical, opened);
    if (!sameFile(before, opened)) throw uiError("error.files.changedBeforeOpen");
    await handle.close(); handle = null;
    origin(await snapshot(), source); current();
    const resolved = await fs.promises.realpath(file);
    const after = await fs.promises.lstat(file, { bigint: true }); material(file, after);
    if (!sameFile(opened, after) || resolved !== canonical) throw uiError("error.files.changedBeforeOpen");
    current();
    if (background) {
      // Resolve and validate the same material without launching another app.
      // Text is actually read; other material returns its validated local path.
      const extension = path.extname(canonical).slice(1).toLowerCase();
      const preview = extensions.includes(extension) ? await readPreview(canonical) : null;
      current();
      return { accepted: true, path: canonical, line: line ?? null, lineNavigation: false,
        background: true, externalAppOpened: false, ...(preview ? { name: preview.name, text: preview.text, size: preview.bytes.length } : { material: extension }) };
    }
    const error = await openPath(canonical);
    if (error !== '') throw (typeof error === 'string' && error ? Error(error) : uiError("error.localOpenUnconfirmed"));
    // This is an OS dispatch receipt, not proof that another app displayed it.
    return { accepted: true, path: canonical, line: line ?? null, lineNavigation: false };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw uiError("error.files.missing");
    if (['EACCES', 'EPERM'].includes(error.code)) throw uiError("error.files.readDenied");
    if (error.code === 'ELOOP') throw uiError("error.files.symlinkChanged");
    throw error;
  } finally { await handle?.close(); }
}
module.exports = { readPreview, saveCopy, extensions, MAX_BYTES, openMessageFile };
