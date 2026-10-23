const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
function validViews(views) {
  if (!Array.isArray(views)) return false;
  const owners = new Set();
  for (const view of views) {
    if (!object(view) || !text(view.owner, 100) || !view.owner || owners.has(view.owner)) return false;
    owners.add(view.owner);
    if (view.active !== undefined && typeof view.active !== 'boolean') return false;
    for (const key of ['selected', 'roomSession', 'roomRecipient', 'roomFilter', 'roomThread', 'roomReplyTo'])
      if (view[key] !== undefined && !text(view[key], 100)) return false;
    for (const key of ['mode', 'preference'])
      if (view[key] !== undefined && !['chat', 'terminal'].includes(view[key])) return false;
    if (view.sharedDraft !== undefined && !text(view.sharedDraft, 16000)) return false;
    if (view.roomMention !== undefined && view.roomMention !== null && !require('./room-mention.js').validView(view.roomMention, view.sharedDraft, view.roomRecipient)) return false;
    if (view.roomSearch !== undefined && !text(view.roomSearch, 1000)) return false;
    if (view.draft !== undefined && (!object(view.draft) || !text(view.draft.id, 100) || !text(view.draft.text, 16000))) return false;
    if (view.draftBackups !== undefined) {
      if (!object(view.draftBackups)) return false;
      for (const [id, copy] of Object.entries(view.draftBackups)) {
        if (!id || id.length > 100 || !object(copy) || !text(copy.text, 16000)) return false;
        for (const key of ['acknowledged', 'discarded'])
          if (copy[key] !== undefined && typeof copy[key] !== 'boolean') return false;
        if (copy.recoveries !== undefined && (!Array.isArray(copy.recoveries) || copy.recoveries.some(value => !text(value, 16000)))) return false;
      }
    }
    if (view.bounds !== undefined && (!object(view.bounds) ||
      ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(view.bounds[key])) ||
      view.bounds.width <= 0 || view.bounds.height <= 0)) return false;
  }
  return true;
}
function readError() { return Object.assign(new Error('界面记录无法读取；原文件已保留，未写入空白记录。'), { code: 'NAW_VIEW_RECORD' }); }

// A failed read is never permission to overwrite the previous recovery copies.
class ViewStore {
  constructor(directory) { this.file = path.join(directory, 'views.json'); this.loaded = false; }
  load() {
    this.loaded = false;
    let found = false;
    try {
      const stat = fs.lstatSync(this.file);
      found = true;
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw readError();
      const views = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!validViews(views)) throw readError();
      this.loaded = true; return views;
    } catch (error) {
      if (!found && error.code === 'ENOENT') { this.loaded = true; return []; }
      throw readError();
    }
  }
  save(views) {
    if (!this.loaded) throw readError();
    if (!validViews(views)) throw Error('界面记录格式异常，未覆盖已保存的草稿。');
    const temporary = `${this.file}.${randomUUID()}.tmp`; let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(views)); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch { throw Error('界面与草稿副本未能保存，请检查磁盘空间与本机数据权限。'); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}
module.exports = { ViewStore };
