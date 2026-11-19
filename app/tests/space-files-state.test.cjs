const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const disclosure = require('../renderer/disclosure-list.js'), locale = require('../ui-locale.js');
const start = source.indexOf('function renderSpaceFiles()');
assert.ok(start >= 0);
const renderSource = source.slice(start, source.indexOf("$('close-space-files').onclick", start));
function fixture() {
 const node = () => ({ children: [], append(...values) { this.children.push(...values); }, get firstElementChild() { return this.children[0]; }, get lastElementChild() { return this.children.at(-1); } });
 const after = [];
 const list = Object.assign(node(), { dataset: {}, replaceChildren(...values) { this.children = values; }, after(...values) { after.push(...values); } });
 const add = {}, title = {}, elements = { 'space-files-list': list, 'add-space-files': add, 'space-files-title': title };
 let room = { name: 'Synthetic room', files: [{ id: 'file-one', name: '完整名称.md', path: '/opt/synthetic/完整名称.md' }], archived: false, metadataRevision: 1 };
 const focus = { active: null };
 const button = (text, onclick) => ({ textContent: text, onclick, disabled: false, attributes: {}, focus() { focus.active = this; } });
 // The shared pager's own elements; its text is written as ui.display would write it.
 const element = tag => ({ tagName: tag, hidden: false, disabled: false, textContent: '', attributes: {}, listeners: [], setAttribute(k, v) { this.attributes[k] = String(v); },
  addEventListener(type, fn) { this.listeners.push(fn); }, async click() { for (const fn of this.listeners) await fn(); } });
 const zh = (key, params) => locale.format('zh', key, typeof params === 'function' ? params() : params);
 const calls = [];
 const context = { spaceName: room => room?.name, $: id => elements[id], filesSpace: 'shared', spaceRecord: () => room, disconnected: false, node, button, uiButton: button, uiNode: node,
  spaceFilesShown: 15, spaceFilesPager: null, window: { nativeWorkspaceDisclosure: disclosure }, document: { createElement: element },
  api: { async spaceAction(...args) { calls.push(args); }, async initial() { return {}; } }, updateState() {},
  ui: { display: { text(el, key, params) { el.textContent = zh(key, params); }, attribute(element, name, _key, params) { element.attributes[name] = { ...(typeof params === 'function' ? params() : params) }; } } } };
 const render = vm.runInNewContext('(' + renderSource + ')', context);
 context.renderSpaceFiles = render;
 return { get room() { return room; }, set room(value) { room = value; }, list, add, after, focus, context, calls, render };
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
test('a long file list shows its first 15 files and each press brings the next 15 below them, focus on the first', async () => {
 const f = fixture();
 f.room.files = Array.from({ length: 40 }, (_, i) => ({ id: `file-${i + 1}`, name: `合成文件-${i + 1}.md`, path: `/opt/synthetic/合成文件-${i + 1}.md` }));
 f.render();
 const [more, status] = f.after;
 const names = () => f.list.children.map(row => row.children[0].textContent);
 assert.deepEqual(names(), f.room.files.slice(0, 15).map(file => file.name));
 assert.equal(more.hidden, false);
 assert.equal(more.textContent, '再显示 15 条 · 共 40 条');
 assert.equal(status.attributes.role, 'status');
 assert.equal(status.textContent, '已显示 15/40 条');
 await more.click();
 assert.equal(f.list.children.length, 30);
 assert.equal(f.focus.active, f.list.children[15].children[0], 'focus on the first file that appeared');
 assert.equal(more.textContent, '再显示 10 条 · 共 40 条');
 assert.equal(status.textContent, '已显示 30/40 条');
 await more.click();
 assert.deepEqual(names(), f.room.files.map(file => file.name), 'every file can be reached');
 assert.equal(more.hidden, true, 'no button once every file is shown');
 assert.equal(status.textContent, '已显示 40/40 条');
 assert.equal(f.after.length, 2, 'the button and the count are placed once');
});
