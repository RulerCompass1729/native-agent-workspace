// Only bounded scroll geometry crosses IPC or enters the local view file.
function readingState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) throw Error('无效阅读位置。');
  const result = Object.create(null);
  for (const [id, p] of Object.entries(value)) {
    if (!id || id.length > 100 || !p || typeof p !== 'object' || Array.isArray(p) ||
        typeof p.follow !== 'boolean' || typeof p.anchor !== 'string' || p.anchor.length > 100 ||
        !Number.isFinite(p.top) || p.top < 0 || p.top > 1e9 || !Number.isFinite(p.offset) || Math.abs(p.offset) > 1e9) throw Error('无效阅读位置。');
    result[id] = { top: p.top, follow: p.follow, anchor: p.anchor, offset: p.offset };
  }
  return result;
}
module.exports = { readingState };
