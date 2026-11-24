'use strict';
function windowId(source) {
  if (typeof source !== 'string' || !/^window:[1-9][0-9]*:[0-9]+$/.test(source)) throw Error('Window frame unavailable');
  const id = Number(source.split(':')[1]);
  if (!Number.isSafeInteger(id) || id > 0xffffffff) throw Error('Window frame unavailable');
  return id;
}

function windowFrames(contexts, localPageWindows, electronWindows) {
  const proof = { windows: [], hiddenBackgroundWindows: [] }, ids = new Set(), owners = new Set();
  for (const c of contexts) {
    if (c.win.isDestroyed()) continue;
    const background = c.background === true;
    const hidden = () => c.win.isVisible() === false && c.win.isFocusable() === false;
    if (background && !hidden()) throw Error('Window frame unavailable');
    const owner = c.view?.owner, source = c.win.getMediaSourceId();
    const id = windowId(source), frame = c.win.getBounds();
    if (ids.has(id) || owners.has(owner) ||
        typeof owner !== 'string' || !owner || owner.length > 200 || /[\x00-\x1f\x7f]/.test(owner) ||
        !frame || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) || frame.width <= 0 || frame.height <= 0 ||
        c.win.isDestroyed() || c.win.getMediaSourceId() !== source || c.view?.owner !== owner ||
        (c.background === true) !== background || background && !hidden()) throw Error('Window frame unavailable');
    ids.add(id); owners.add(owner);
    proof[background ? 'hiddenBackgroundWindows' : 'windows'].push({ id, owner, frame: Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, frame[k]])) });
    if (ids.size > 1000) throw Error('Window frame unavailable');
  }
  if (!proof.windows.length) throw Error('Window frame unavailable');
  if (localPageWindows !== undefined) {
    proof.localPageWindowIds = [];
    for (const win of localPageWindows) {
      if (win.isDestroyed()) throw Error('Window frame unavailable');
      const source = win.getMediaSourceId(), id = windowId(source);
      if (ids.has(id) || ids.size >= 1000 || win.getMediaSourceId() !== source || win.isDestroyed())
        throw Error('Window frame unavailable');
      ids.add(id);
      proof.localPageWindowIds.push(id);
    }
  }
  if (electronWindows !== undefined) {
    // Every BrowserWindow, so the installer can tell an unregistered NAW window from a system one.
    const listed = new Set();
    for (const win of electronWindows) {
      if (win.isDestroyed()) continue;
      const source = win.getMediaSourceId(), id = windowId(source);
      if (listed.has(id) || listed.size >= 1000 || win.getMediaSourceId() !== source || win.isDestroyed())
        throw Error('Window frame unavailable');
      listed.add(id);
    }
    for (const id of ids) if (!listed.has(id)) throw Error('Window frame unavailable');
    proof.electronWindowIds = [...listed];
  }
  return proof;
}
module.exports = { windowFrames };
