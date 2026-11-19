'use strict';
function windowFrames(contexts) {
  const proof = { windows: [], hiddenBackgroundWindows: [] }, ids = new Set(), owners = new Set();
  for (const c of contexts) {
    if (c.win.isDestroyed()) continue;
    const background = c.background === true;
    const hidden = () => c.win.isVisible() === false && c.win.isFocusable() === false;
    if (background && !hidden()) throw Error('Window frame unavailable');
    const owner = c.view?.owner, source = c.win.getMediaSourceId();
    if (typeof source !== 'string' || !/^window:[1-9][0-9]*:[0-9]+$/.test(source)) throw Error('Window frame unavailable');
    const id = Number(source.split(':')[1]), frame = c.win.getBounds();
    if (!Number.isSafeInteger(id) || id > 0xffffffff || ids.has(id) || owners.has(owner) ||
        typeof owner !== 'string' || !owner || owner.length > 200 || /[\x00-\x1f\x7f]/.test(owner) ||
        !frame || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) || frame.width <= 0 || frame.height <= 0 ||
        c.win.isDestroyed() || c.win.getMediaSourceId() !== source || c.view?.owner !== owner ||
        (c.background === true) !== background || background && !hidden()) throw Error('Window frame unavailable');
    ids.add(id); owners.add(owner);
    proof[background ? 'hiddenBackgroundWindows' : 'windows'].push({ id, owner, frame: Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, frame[k]])) });
    if (ids.size > 1000) throw Error('Window frame unavailable');
  }
  if (!proof.windows.length) throw Error('Window frame unavailable');
  return proof;
}
module.exports = { windowFrames };
