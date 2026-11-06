const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const start = source.indexOf('function renderSpaceFiles()');
assert.ok(start >= 0);
const renderSource = source.slice(start, source.indexOf("$('close-space-files').onclick", start));
function fixture() {
 const node = () => ({ children: [], append(...values) { this.children.push(...values); }, get lastElementChild() { return this.children.at(-1); } });
 const list = Object.assign(node(), { dataset: {}, replaceChildren(...values) { this.children = values; } });
 const add = {}, title = {}, elements = { 'space-files-list': list, 'add-space-files': add, 'space-files-title': title };
 let room = { name: 'Synthetic room', files: [{ id: 'file-one', name: '完整名称.md', path: '/opt/synthetic/完整名称.md' }], archived: false, metadataRevision: 1 };
 const button = (text, onclick) => ({ textContent: text, onclick, disabled: false, attributes: {} });
 const calls = [];
 const context = { $: id => elements[id], filesSpace: 'shared', spaceRecord: () => room, disconnected: false, node, button, uiButton: button, uiNode: node,
  api: { async spaceAction(...args) { calls.push(args); }, async initial() { return {}; } }, updateState() {},
  ui: { display: { text() {}, attribute(element, name, _key, params) { element.attributes[name] = { ...params }; } } } };
 return { get room() { return room; }, set room(value) { room = value; }, list, add, context, calls, render: vm.runInNewContext('(' + renderSource + ')', context) };
}
test('cached file rows adopt archive/restore and room name without replacing focused targets', () => {
 const f = fixture(); f.render(); const row = f.list.children[0], open = row.children[0], remove = row.lastElementChild;
 assert.equal(remove.disabled, false);
 f.room.archived = true; f.room.name = 'Renamed room'; f.render();
 assert.equal(f.add.disabled, true); assert.equal(remove.disabled, true);
 assert.equal(remove.attributes['aria-label'].space, 'Renamed room');
 assert.equal(remove.attributes['aria-label'].file, '完整名称.md');
 assert.equal(f.list.children[0], row); assert.equal(row.children[0], open);
 assert.equal(open.title, '/opt/synthetic/完整名称.md');
 f.room.archived = false; f.render(); assert.equal(remove.disabled, false); assert.equal(f.add.disabled, false);
 assert.equal(f.list.children[0], row);
});
test('disconnection disables adding but retains existing file actions and cache identity', () => {
 const f = fixture(); f.render(); const row = f.list.children[0]; f.context.disconnected = true; f.render();
 assert.equal(f.add.disabled, true); assert.equal(row.lastElementChild.disabled, false);
 f.context.disconnected = false; f.render(); assert.equal(f.add.disabled, false); assert.equal(f.list.children[0], row);
});
test('changed file references rebuild rows with exact path/title and can return to empty', () => {
 const f = fixture(); f.render(); const old = f.list.children[0];
 f.room.files = [{ id: 'file-two', name: 'different.txt', path: '/opt/synthetic/different.txt' }]; f.render();
 assert.notEqual(f.list.children[0], old); assert.equal(f.list.children[0].children[0].title, '/opt/synthetic/different.txt');
 f.room.files = []; f.render(); assert.equal(f.list.children.length, 1); assert.equal(f.list.children[0].lastElementChild, undefined);
});
test('cached removal submits the last rendered metadata revision, retaining the server race guard', async () => {
 const f = fixture(); f.render(); const remove = f.list.children[0].lastElementChild;
 f.room = { ...f.room, metadataRevision: 3, name: 'Renamed room' }; f.render();
 await remove.onclick(); assert.equal(f.calls.length, 1);
 assert.equal(f.calls[0][0], 'shared'); assert.equal(f.calls[0][1], 'removeFile');
 assert.equal(f.calls[0][2][0], 'file-one'); assert.equal(f.calls[0][2][1], 3);
});
