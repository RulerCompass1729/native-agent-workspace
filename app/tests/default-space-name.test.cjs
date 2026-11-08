// T-60: the default shared space keeps its stored name; while that name is still the system default,
// displays show the interface-language name. A name the person gave is never translated.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const spaces = require('../collaboration-spaces.cjs'), locale = require('../ui-locale.js');
const shown = (room, language) => spaces.untouchedDefault(room) ? locale.format(language, 'space.defaultName') : room.name;

test('only the default space with its untouched system name counts as the default name', () => {
  const B = '11111111-1111-4111-8111-111111111111';
  assert.equal(spaces.untouchedDefault({ id: 'shared', name: spaces.DEFAULT_ROOM_NAME }), true);
  assert.equal(spaces.untouchedDefault({ id: 'shared', name: 'Team' }), false, 'renamed default space');
  assert.equal(spaces.untouchedDefault({ id: 'shared', name: spaces.DEFAULT_ROOM_NAME + ' ' }), false, 'any change is a rename');
  assert.equal(spaces.untouchedDefault({ id: B, name: spaces.DEFAULT_ROOM_NAME }), false, 'another space given the same name');
  for (const value of [null, undefined, {}]) assert.equal(spaces.untouchedDefault(value), false);
});

test('the default name is the one the backends store and the Chinese catalog name', () => {
  assert.equal(locale.format('zh', 'space.defaultName'), spaces.DEFAULT_ROOM_NAME);
  const literal = `'${spaces.DEFAULT_ROOM_NAME}'`, read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.ok(read('room-state.cjs').includes(`initialRoom(${literal})`), 'room-state creates the default space with this name');
  assert.ok(read('workspace.cjs').includes(`this.room = { id: 'shared', name: ${literal},`), 'workspace creates the default space with this name');
});

test('Chinese shows 共同工作, English shows Shared work, and a renamed space shows its own name in both', () => {
  const untouched = { id: 'shared', name: spaces.DEFAULT_ROOM_NAME }, renamed = { id: 'shared', name: '学习小组' };
  assert.equal(shown(untouched, 'zh'), '共同工作'); assert.equal(shown(untouched, 'en'), 'Shared work');
  assert.equal(shown(renamed, 'zh'), '学习小组'); assert.equal(shown(renamed, 'en'), '学习小组');
  assert.equal(untouched.name, '共同工作', 'display never changes the stored record');
});

test('the renderer names spaces through one helper on the sidebar row, its accessible names and the panorama', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(source, /const spaceName = room => window\.nativeWorkspaceSpaces\.untouchedDefault\(room\) \? uiText\('space\.defaultName'\) : room\?\.name;/);
  // Visible text, accessible name and tooltip of the sidebar row all read the same helper.
  assert.match(source, /navParams = \(\) => \(\{ name: spaceName\(room\), count:/);
  assert.match(source, /ui\.display\.computed\(row\.name, 'text', \(\) => spaceName\(room\)\)/);
  assert.match(source, /'sidebar\.spaceActions', \(\) => \(\{ name: spaceName\(room\) \}\)\); ui\.display\.attribute\(row\.more, 'title', 'sidebar\.spaceActions', \(\) => \(\{ name: spaceName\(room\) \}\)\)/);
  assert.match(source, /label: s => participantLabel\(s, state\.sessions\), spaceName,/, 'the panorama receives the same helper');
});
