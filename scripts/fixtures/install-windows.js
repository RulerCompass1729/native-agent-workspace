ObjC.import('CoreGraphics');
function run(argv) {
  if (![1, 2].includes(argv.length) || argv.length === 2 && argv[1] !== '--menu-metadata' || !/^\d+$/.test(argv[0]) || Number(argv[0]) < 2) throw Error('Explicit PID required');
  const menuMetadata = argv.length === 2;
  const rows = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0)), result = [];
  const count = rows ? Number(rows.count) : NaN;
  if (!Number.isSafeInteger(count) || count < 0 || count > 100000) throw Error('CoreGraphics metadata unavailable');
  const value = (object, key) => ObjC.unwrap(object.objectForKey(key));
  for (let i = 0; i < count; i++) {
    const row = rows.objectAtIndex(i);
    const pid = value(row, 'kCGWindowOwnerPID');
    if (pid !== Number(argv[0])) continue;
    if (value(row, 'kCGWindowLayer') !== 0) continue;
    const b = row.objectForKey('kCGWindowBounds');
    const bounds = { x: value(b, 'X'), y: value(b, 'Y'), width: value(b, 'Width'), height: value(b, 'Height') };
    if (!Object.keys(bounds).every(key => Number.isFinite(bounds[key]))) throw Error('Window bounds unavailable');
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const visibility = value(row, 'kCGWindowIsOnscreen');
    // CoreGraphics defines an absent on-screen key as false.
    const onScreen = visibility == null ? false : visibility;
    if (typeof onScreen !== 'boolean' || result.length >= 1000) throw Error('Window identity unavailable');
    result.push({ pid, id: value(row, 'kCGWindowNumber'), onScreen, bounds, ...(menuMetadata ? { layer: 0 } : {}) });
  }
  if (!menuMetadata) return JSON.stringify(result);
  const displays = [];
  try {
    ObjC.import('AppKit');
    const screens = $.NSScreen.screens;
    if (Number(screens.count) > 64) throw Error('Display limit');
    for (let i = 0; i < Number(screens.count); i++) {
      const screen = screens.objectAtIndex(i), id = value(screen.deviceDescription, 'NSScreenNumber');
      const frame = screen.frame, visible = screen.visibleFrame, cg = $.CGDisplayBounds(id);
      const menuBarHeight = frame.origin.y + frame.size.height - visible.origin.y - visible.size.height;
      if (![frame.origin.x, frame.origin.y, frame.size.width, frame.size.height, visible.origin.x, visible.origin.y, visible.size.width, visible.size.height, menuBarHeight].every(Number.isFinite) ||
          menuBarHeight <= 0 || menuBarHeight >= frame.size.height || frame.size.width !== cg.size.width || frame.size.height !== cg.size.height) continue;
      displays.push({ id, bounds: { x: cg.origin.x, y: cg.origin.y, width: cg.size.width, height: cg.size.height }, menuBarHeight });
    }
  } catch { displays.length = 0; }
  return JSON.stringify({ windows: result, displays });
}
