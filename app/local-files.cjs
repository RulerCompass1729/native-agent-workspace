// Local, explicitly chosen text snapshots. No watcher, crawl, upload or model call.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
module.exports = { readPreview, saveCopy, extensions, MAX_BYTES };
