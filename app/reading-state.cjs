// Only bounded reading geometry and disclosure choices enter the local view file.
function readingState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) throw Error('无效阅读位置。');
  const result = Object.create(null);
  for (const [id, p] of Object.entries(value)) {
    if (!id || id.length > 100 || !p || typeof p !== 'object' || Array.isArray(p) ||
        typeof p.follow !== 'boolean' || typeof p.anchor !== 'string' || p.anchor.length > 100 ||
        !Number.isFinite(p.top) || p.top < 0 || p.top > 1e9 || !Number.isFinite(p.offset) || Math.abs(p.offset) > 1e9) throw Error('无效阅读位置。');
    result[id] = { top: p.top, follow: p.follow, anchor: p.anchor, offset: p.offset };
    if (p.folds !== undefined) {
      if (!p.folds || typeof p.folds !== 'object' || Array.isArray(p.folds) || Object.keys(p.folds).length > 200 ||
        Object.entries(p.folds).some(([key, choice]) => !key || key.length > 200 || (typeof choice !== 'boolean' &&
          (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.keys(choice).length !== 2 || typeof choice.open !== 'boolean' ||
            !['', 'failed', 'declined', 'interrupted', 'incomplete'].includes(choice.error))))) throw Error('无效过程折叠状态。');
      result[id].folds = Object.fromEntries(Object.entries(p.folds));
    }
  }
  return result;
}
module.exports = { readingState };
