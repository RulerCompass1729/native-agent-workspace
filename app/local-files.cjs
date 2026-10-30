// Local, explicitly chosen text snapshots. No watcher, crawl, upload or model call.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const MAX_BYTES = 256 * 1024;
const extensions = ['txt', 'md', 'csv', 'tsv', 'json'];
async function readPreview(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !extensions.includes(path.extname(file).slice(1).toLowerCase())) throw Error('请选择 TXT、Markdown、CSV、TSV 或 JSON 文本文件。');
  const name = path.basename(file);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) throw Error('文件名包含控制字符，未读取。');
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) throw Error('不是普通文件');
    if (before.size > MAX_BYTES) throw Error('文件过大');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('文件在读取时变化');
    const bytes = Buffer.from(buffer.subarray(0, offset));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw Error('不是可显示文本');
    return { token: randomUUID(), name, text, bytes };
  } catch { throw Error('无法预览这个文件。需要不超过 256 KB 的 UTF-8 普通文本文件；符号链接、特殊文件或读取中变化的文件不会打开。'); }
  finally { await handle?.close(); }
}
async function saveCopy(preview, file) {
  if (!preview?.bytes || typeof file !== 'string' || !path.isAbsolute(file)) throw Error('文件预览已失效，请重新打开。');
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
    if (error.code === 'EEXIST') throw Error('该文件名已存在。请另选一个名称，原文件没有改变。');
    throw Error('副本未能保存，请检查空间和目录权限后重试。');
  } finally { await handle?.close(); }
}
const openExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json']);
const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 &&
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
const changed = () => Error('原消息或工作目录已变化，请重新打开这个链接。');
function origin(snapshot, source) {
  if (!source || !['session', 'room'].includes(source.kind) ||
    ['sessionId', 'messageId'].some(key => typeof source[key] !== 'string' || !source[key] || source[key].length > 512) ||
    !(source.nativeId === null || typeof source.nativeId === 'string' && source.nativeId.length > 0 && source.nativeId.length <= 512) ||
    !(source.cwd === null || validPath(source.cwd) && path.isAbsolute(source.cwd)) ||
    Object.keys(source).some(key => !['kind', 'sessionId', 'messageId', 'nativeId', 'cwd'].includes(key))) throw changed();
  const session = snapshot?.sessions?.find(item => item.id === source.sessionId);
  // A room row authorizes only its own already-shared content, never a lookup
  // into a private row through nativeMessageId. Addressed/final rows need not
  // carry the streaming marker.
  const message = source.kind === 'room'
    ? snapshot?.room?.messages?.find(item => item.id === source.messageId && item.sessionId === source.sessionId)
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
  if (!openExtensions.has(path.extname(file).slice(1).toLowerCase())) throw Error('此链接不是支持的图片、PDF 或文本材料；不会从消息执行脚本或应用。');
  if (!stat.isFile() || stat.isSymbolicLink?.() || Number(stat.mode) & 0o111) throw Error('只打开没有执行权限的普通材料文件；目录、符号链接和特殊文件不会打开。');
}
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
async function openMessageFile({ snapshot, openPath, isCurrent = () => true }, source, requestedPath, options) {
  if (!validPath(requestedPath) || /^[a-z][a-z0-9+.-]*:/i.test(requestedPath) || /^[/\\]{2}/u.test(requestedPath)) throw Error('链接没有有效的本机文件路径。');
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some(key => key !== 'line') || options.line !== undefined && (!Number.isSafeInteger(options.line) || options.line < 1))) throw Error('文件定位信息无效。');
  source = source && { ...source }; const line = options?.line;
  const current = () => { if (!isCurrent()) throw changed(); };
  current(); const first = origin(await snapshot(), source); current();
  // DSH already decodes the path once. Decoding again would open a different
  // file when a real filename contains a literal percent sequence.
  const explicit = requestedPath.startsWith('~/') ? path.join(os.homedir(), requestedPath.slice(2)) : requestedPath;
  if (!path.isAbsolute(explicit) && !first.cwd) throw Error('原消息没有可核对的工作目录，未猜测相对路径。');
  const file = path.isAbsolute(explicit) ? path.normalize(explicit) : path.resolve(first.cwd, explicit);
  let handle;
  try {
    const before = await fs.promises.lstat(file, { bigint: true }); material(file, before);
    const canonical = await fs.promises.realpath(file);
    handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true }); material(canonical, opened);
    if (!sameFile(before, opened)) throw Error('文件在检查时已变化，未打开。');
    await handle.close(); handle = null;
    origin(await snapshot(), source); current();
    const resolved = await fs.promises.realpath(file);
    const after = await fs.promises.lstat(file, { bigint: true }); material(file, after);
    if (!sameFile(opened, after) || resolved !== canonical) throw Error('文件在检查时已变化，未打开。');
    current();
    const error = await openPath(canonical);
    if (error !== '') throw Error(typeof error === 'string' && error ? error : '系统没有确认接收打开请求，请先检查系统窗口。');
    // This is an OS dispatch receipt, not proof that another app displayed it.
    return { accepted: true, path: canonical, line: line ?? null, lineNavigation: false };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw Error('文件不存在，未打开。');
    if (['EACCES', 'EPERM'].includes(error.code)) throw Error('没有权限读取这个文件，未打开。');
    if (error.code === 'ELOOP') throw Error('符号链接已变化，未打开。');
    throw error;
  } finally { await handle?.close(); }
}
module.exports = { readPreview, saveCopy, extensions, MAX_BYTES, openMessageFile };
