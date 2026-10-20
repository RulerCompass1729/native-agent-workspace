// Retain intentional placement, including negative-coordinate displays and
// partly offscreen windows, as long as the native title bar remains reachable.
function windowPlacement(saved, screen) {
  if (!saved || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(saved[key])) ||
      saved.width <= 0 || saved.height <= 0 ||
      ['x', 'y', 'width', 'height'].some(key => Math.abs(saved[key]) > 2147483647)) return undefined;
  const bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  const areas = screen.getAllDisplays().map(display => display.workArea);
  const reachableArea = areas.find(area =>
    bounds.y >= area.y && bounds.y + 30 <= area.y + area.height &&
    Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= Math.min(160, bounds.width));
  if (reachableArea) return {
    ...bounds,
    width: Math.max(bounds.width, Math.min(850, reachableArea.width)),
    height: Math.max(bounds.height, Math.min(600, reachableArea.height)),
  };
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(Math.max(bounds.width, 850), area.width);
  const height = Math.min(Math.max(bounds.height, 600), area.height);
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
}
module.exports = { windowPlacement };
