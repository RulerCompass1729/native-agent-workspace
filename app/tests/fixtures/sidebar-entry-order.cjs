const assert = require('node:assert/strict');

// The user-facing contract is priority/order, not adjacency to a later control.
// Keep the designated entry first under the brand, followed by the closed
// built-in entry. The space rail belongs below both, before creation/search.
module.exports = function sidebarEntryOrder(html) {
  const start = html.indexOf('<aside class="sidebar">'), end = html.indexOf('</aside>', start);
  assert.ok(start >= 0 && end > start, 'The sidebar exists');
  const sidebar = html.slice(start, end), brand = sidebar.indexOf('<div class="brand">');
  assert.ok(brand >= 0, 'The brand precedes the butler entry');
  const ids = ['steward-entry', 'butler-row', 'space-rail-routes', 'new-session', 'search-button', 'panorama-nav', 'sessions-group'];
  const positions = ids.map(id => {
    const matches = [...sidebar.matchAll(new RegExp('<[a-z][^>]*\\bid="' + id + '"[^>]*>', 'g'))];
    assert.equal(matches.length, 1, 'One sidebar control: ' + id);
    return matches[0].index;
  });
  assert.ok(brand < positions[0] && positions.every((n, i) => !i || positions[i - 1] < n), 'Butler entries stay above navigation, creation and session controls');
  assert.match(sidebar, /<button id="butler-row" class="butler-row" type="button" aria-haspopup="dialog" hidden><\/button>/);
};
