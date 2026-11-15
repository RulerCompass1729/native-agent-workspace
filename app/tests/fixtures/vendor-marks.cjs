// Loads the renderer's own vendor labels (sessionMaker, makerLabel) into a test's renderer context.
// These fixtures have no text nodes, so painting a mark is a no-op and icon() gives a plain span.
const vm = require('node:vm');
module.exports = function vendorMarks(renderer, context) {
  const start = renderer.indexOf('const VENDOR_MARKS'), end = renderer.indexOf('// Paints the mark in place');
  if (start < 0 || end < start) throw Error('vendor mark block not found');
  vm.runInContext(renderer.slice(start, end), context);
  if (!context.paintVendorMark) context.paintVendorMark = element => element;
  if (!context.icon) context.icon = (_record, small) => context.node('span', '', small ? 'small' : '');
};
