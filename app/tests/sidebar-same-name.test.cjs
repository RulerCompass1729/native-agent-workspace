// U22 / product.md V13: sessions that share a name are told apart in the sidebar. Their rows show
// the short id beside the name; a uniquely named row stays without it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../renderer/styles.css'), 'utf8');
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return source.slice(a, b); }
function sameName(sessions) {
  const context = vm.createContext({});
  vm.runInContext(section('function sameNameSessions(', '\nfunction versionValue('), context);
  return [...vm.runInContext('sameNameSessions', context)(sessions)].sort();
}
const session = (id, name) => ({ id, name });

test('only sessions whose name another listed session shares are marked', () => {
  assert.deepEqual(sameName([session('a', '学习'), session('b', '学习'), session('c', '常用')]), ['a', 'b']);
  assert.deepEqual(sameName([session('a', 'one'), session('b', 'two'), session('c', 'three')]), []);
  assert.deepEqual(sameName([session('a', 'x'), session('b', 'y'), session('c', 'x'), session('d', 'y'), session('e', 'x'), session('f', 'z')]), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(sameName([]), []); assert.deepEqual(sameName([session('a', 'alone')]), []);
});
test('the comparison is the exact name, as for member labels', () => {
  assert.deepEqual(sameName([session('a', 'Review'), session('b', 'review'), session('c', 'Review ')]), []);
  assert.deepEqual(sameName([session('a', ''), session('b', '')]), ['a', 'b']);
  // The same rule the space views use for a member's label.
  assert.ok(source.includes("people.filter(s => s.name === session.name).length > 1"));
});
test('it counts sessions, and changes nothing it is given', () => {
  const list = [session('a', 'same'), session('b', 'same')], before = JSON.stringify(list);
  assert.deepEqual(sameName(list), ['a', 'b']); assert.equal(JSON.stringify(list), before);
});
test('the sidebar marks the row from the listed sessions, once per render', () => {
  const render = section('function renderSessions() {', '\nfunction ');
  // 11-23: in a space the listed sessions are its members, so the set follows whichever list is shown.
  assert.ok(render.includes("const visible = selected === 'room' ? orderedMembers() : sidebarSessions();") && render.includes('const positions = new Map(), repeated = sameNameSessions(visible);'), 'The set comes from the sessions listed in the sidebar, not from grouped occurrences');
  assert.ok(render.includes("row.element.classList.toggle('same-name', repeated.has(record.id));"), 'Every row update sets or clears the mark');
  assert.equal(render.split('sameNameSessions(').length - 1, 1);
});
test('the expanded sidebar hides the short id except on a marked row; the rail is not changed', () => {
  // The block of the expanded sidebar that holds the compact rows (the file has several blocks with this selector).
  const hide = styles.indexOf('.session-link .label>.session-short-id{display:none}');
  const open = styles.lastIndexOf('&[data-native-surface="sidebar"]:not([data-collapsed="true"]){', hide), close = styles.indexOf('\n}', hide);
  assert.ok(hide > 0 && open > 0 && close > hide);
  const expanded = styles.slice(open, close);
  assert.ok(!expanded.slice(0, hide - open).includes('\n}'), 'The hide rule is inside that block');
  assert.ok(expanded.includes('.session-link .label>.session-short-id{display:none}'), 'A unique name stays compact');
  for (const rule of ['.session-row.same-name .session-link .label{grid-template-columns:minmax(0,1fr) auto auto}',
    '.session-row.same-name .session-link .label>.session-short-id{display:block;grid-column:2;grid-row:1;max-width:none;white-space:nowrap}',
    '.session-row.same-name .session-link .label>.session-backend-version{grid-column:3}']) assert.ok(expanded.includes(rule), rule);
  assert.ok(expanded.indexOf('.session-row.same-name .session-link .label>.session-short-id') > expanded.indexOf('.session-link .label>.session-short-id{display:none}'));
  assert.equal(styles.split('same-name').length - 1, 3, 'The mark is used by these three rules only');
  // The collapsed rail shows every row's short id by its own rule, which is left as it was.
  assert.ok(styles.includes('.session-link .label > span:not(.session-short-id), .session-link .label > small { display: none; }'));
});
