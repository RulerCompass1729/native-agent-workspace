const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');

// The actual listener from main.cjs, on a window that fails like Electron's once it is destroyed.
function fixture() {
  const lines = main.split('\n').filter(line => line.includes("'page-title-updated'"));
  assert.equal(lines.length, 1);
  const win = {
    webContents: new EventEmitter(), destroyed: false, title: 'From the page',
    isDestroyed() { return this.destroyed; },
    setTitle(title) { if (this.destroyed) throw new TypeError('Object has been destroyed'); this.title = title; },
  };
  vm.runInNewContext(lines[0], { win });
  return {
    win,
    retitle() { let prevented = false; win.webContents.emit('page-title-updated', { preventDefault: () => { prevented = true; } }, 'From the page'); return prevented; },
  };
}

test('the main window keeps its own title when the page changes its title', () => {
  const f = fixture();
  assert.equal(f.retitle(), true);
  assert.equal(f.win.title, 'Native Agent Workspace');
});

test('a title that arrives after the main window is destroyed is ignored', () => {
  const f = fixture();
  f.win.destroyed = true; f.win.title = 'before destroy';
  assert.equal(f.retitle(), true);
  assert.equal(f.win.title, 'before destroy');
});
