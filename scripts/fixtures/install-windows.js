ObjC.import('CoreGraphics');
function run(argv) {
  if (argv.length !== 1 || !/^\d+$/.test(argv[0]) || Number(argv[0]) < 2) throw Error('Explicit PID required');
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
    result.push({ pid, id: value(row, 'kCGWindowNumber'), onScreen, bounds });
  }
  return JSON.stringify(result);
}
