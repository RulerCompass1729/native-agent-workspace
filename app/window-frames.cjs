'use strict';
function windowFrames(contexts) {
  const rows = [], ids = new Set(), owners = new Set();
  for (const c of contexts) {
    if (c.background || c.win.isDestroyed()) continue;
    const owner = c.view?.owner, source = c.win.getMediaSourceId();
    if (typeof source !== 'string' || !/^window:[1-9][0-9]*:[0-9]+$/.test(source)) throw Error('Window frame unavailable');
    const id = Number(source.split(':')[1]), frame = c.win.getBounds();
    if (!Number.isSafeInteger(id) || id > 0xffffffff || ids.has(id) || owners.has(owner) ||
        typeof owner !== 'string' || !owner || owner.length > 200 || /[\x00-\x1f\x7f]/.test(owner) ||
        !frame || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) || frame.width <= 0 || frame.height <= 0 ||
        c.win.isDestroyed() || c.win.getMediaSourceId() !== source || c.view?.owner !== owner) throw Error('Window frame unavailable');
    ids.add(id); owners.add(owner);
    rows.push({ id, owner, frame: Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, frame[k]])) });
    if (rows.length > 1000) throw Error('Window frame unavailable');
  }
  if (!rows.length) throw Error('Window frame unavailable');
  return rows;
}
module.exports = { windowFrames };
