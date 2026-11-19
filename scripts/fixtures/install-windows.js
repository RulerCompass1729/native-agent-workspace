ObjC.import('CoreGraphics');
function run(argv) {
  if (argv.length !== 1 || !/^\d+$/.test(argv[0]) || Number(argv[0]) < 2) throw Error('Explicit PID required');
  const rows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0)));
  if (!Array.isArray(rows)) throw Error('CoreGraphics metadata unavailable');
  return JSON.stringify(rows.filter(row => row.kCGWindowOwnerPID === Number(argv[0]) && row.kCGWindowLayer === 0 && row.kCGWindowBounds.Width > 0 && row.kCGWindowBounds.Height > 0).map(row => ({
    id: row.kCGWindowNumber, onScreen: row.kCGWindowIsOnscreen === true,
    bounds: { x: row.kCGWindowBounds.X, y: row.kCGWindowBounds.Y, width: row.kCGWindowBounds.Width, height: row.kCGWindowBounds.Height },
  })));
}
