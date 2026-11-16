// The bell's reminders about records kept whole, and export (the person, 2026-11-11; design section 9 as recommended).
// Real blocks written by the product's own modules in scratch folders; a fake page for the bell. Nothing native, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const reminders = require('../record-reminders.cjs'), history = require('../record-history.cjs');
const { ButlerReadAudit } = require('../butler-read-audit.cjs');
const { bind } = require('../renderer/record-reminders.js');
const locale = require('../ui-locale.js');

const DAY = 24 * 3600 * 1000, NOW = Date.UTC(2026, 10, 12, 12), MIB = 1024 * 1024, zh = (key, params) => locale.format('zh', key, params);
function folder(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-record-reminders-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
// The butler's read log with one page a day on each of `days` days ending at `last`: each earlier day's block is sealed.
function readLog(dir, days, last = NOW) {
  let clock; const audit = new ButlerReadAudit(dir, { now: () => clock });
  for (let n = days - 1; n >= 0; n--) { clock = last - n * DAY; audit.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 1, runnerRef: 'butler-runner-synthetic' },
    query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } }); }
}
const of = (status, record) => status.records.find(item => item.record === record);
const manifestFile = (dir, record) => path.join(dir, 'history', record, 'manifest.json');

test('empty record status has no due reminder', t => {
  const dir = folder(t), status = reminders.status(dir, NOW);
  assert.deepEqual([status.count, status.records.map(item => [item.record, item.blocks, item.items.length])], [0, [['operations', 0, 0], ['butler-reads', 0, 0], ['steward', 0, 0]]]);
  assert.equal(fs.existsSync(path.join(dir, 'history')), false, 'Asking writes nothing');
});

test('blocks past 30 days are reminded of; "知道了" holds until another 30 blocks pass 30 days', t => {
  const dir = folder(t); readLog(dir, 33);
  let reads = of(reminders.status(dir, NOW), 'butler-reads');
  // 33 daily blocks: the 2 oldest have their newest line more than 30 days ago.
  assert.deepEqual(reads.items.map(item => [item.kind, item.blocks, item.level, item.shown]), [['age', 2, 1, true]]);
  assert.deepEqual([reads.blocks, reads.oldestDay], [33, new Date(NOW - 32 * DAY).toISOString().slice(0, 10)]);
  reminders.acknowledge(dir, 'butler-reads', 'age', 1);
  assert.equal(reminders.status(dir, NOW).count, 0, 'Acknowledged');
  // Twenty days on, 22 blocks are past the line: the same notch, still quiet. Thirty days on, 32: the next notch.
  assert.equal(of(reminders.status(dir, NOW + 20 * DAY), 'butler-reads').items[0].shown, false);
  reads = of(reminders.status(dir, NOW + 30 * DAY), 'butler-reads');
  assert.deepEqual(reads.items.map(item => [item.kind, item.blocks, item.level, item.shown]), [['age', 32, 2, true]]);
  assert.equal(fs.statSync(path.join(dir, 'history', 'reminders.json')).mode & 0o777, 0o600);
});

test('a whole past 0.5 GiB, a block that cannot be read, a manifest that cannot be read and a record the app could not load are each said', t => {
  const dir = folder(t); fs.mkdirSync(path.join(dir, 'history', 'operations'), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(dir, 'history'), 0o700);
  const block = (n, extra = {}) => ({ name: history.blockName(n, '2026-11-10'), firstSequence: n, lastSequence: n, offset: 0, count: 1, bytes: 32 * MIB, oldestTime: NOW - DAY, newestTime: NOW - DAY,
    days: { '2026-11-10': 1 }, sha256: 'a'.repeat(64), status: 'sealed', origin: 'native', ...extra });
  const write = blocks => fs.writeFileSync(manifestFile(dir, 'operations'), JSON.stringify({ version: 1, record: 'operations', blocks }), { mode: 0o600 });
  write(Array.from({ length: 16 }, (_, n) => block(n + 1)));
  assert.deepEqual(of(reminders.status(dir, NOW), 'operations').items, [], 'Exactly 0.5 GiB is not past the line');
  // An older version's file kept beside the blocks counts toward the size.
  fs.writeFileSync(path.join(dir, 'history', 'operations', 'legacy-0001.json'), 'x', { mode: 0o600 });
  assert.deepEqual(of(reminders.status(dir, NOW), 'operations').items.map(item => [item.kind, item.level, item.bytes]), [['size', 1, 512 * MIB + 1]]);
  write([block(1, { status: 'unreadable' }), block(2)]);
  assert.deepEqual(of(reminders.status(dir, NOW), 'operations').items.map(item => [item.kind, item.blocks, item.fromSequence, item.throughSequence]), [['unreadable', 1, 1, 1]]);
  fs.writeFileSync(manifestFile(dir, 'operations'), '{broken', { mode: 0o600 });
  assert.deepEqual(of(reminders.status(dir, NOW), 'operations').items.map(item => [item.kind, item.manifest]), [['unreadable', true]]);
  fs.rmSync(manifestFile(dir, 'operations'));
  assert.deepEqual(of(reminders.status(dir, NOW, { unavailable: { operations: 'history' } }), 'operations').items.map(item => [item.kind, item.level, item.cause, item.shown]), [['unavailable', 1, 'history', true]]);
  assert.equal(of(reminders.status(dir, NOW, { unavailable: { operations: 'migration' } }), 'operations').items[0].cause, 'other');
  // "知道了" holds while the condition does; once it is no longer due, the next time it rings again.
  reminders.acknowledge(dir, 'operations', 'unavailable', 1);
  assert.equal(of(reminders.status(dir, NOW, { unavailable: { operations: 'history' } }), 'operations').items[0].shown, false);
  assert.deepEqual(of(reminders.status(dir, NOW), 'operations').items, [], 'Background control loaded again');
  assert.equal(of(reminders.status(dir, NOW, { unavailable: { operations: 'other' } }), 'operations').items[0].shown, true, 'A new stop rings the bell');
});

test('export copies the chosen sealed blocks as they are and checks them, never over a different file and never into NAW\'s own folder', t => {
  const dir = folder(t), out = folder(t); readLog(dir, 4);
  const listed = reminders.blocks(dir, 'butler-reads', NOW);
  assert.equal(listed.length, 3, 'The open block is still being written'); assert.deepEqual(listed.map(item => item.old), [false, false, false]);
  const names = listed.slice(0, 2).map(item => item.name), result = reminders.exportBlocks(dir, 'butler-reads', names, out);
  assert.deepEqual([result.folder, result.exported.map(item => item.name)], [path.join(fs.realpathSync(out), 'butler-reads'), names]);
  for (const name of names) {
    assert.deepEqual(fs.readFileSync(path.join(out, 'butler-reads', name)), fs.readFileSync(path.join(dir, 'history', 'butler-reads', name)));
    assert.equal(fs.statSync(path.join(out, 'butler-reads', name)).mode & 0o777, 0o600);
  }
  assert.deepEqual(reminders.exportBlocks(dir, 'butler-reads', names, out).exported.length, 2, 'Exporting again finds the same copies');
  fs.writeFileSync(path.join(out, 'butler-reads', listed[2].name), 'someone else\'s file', { mode: 0o600 });
  assert.throws(() => reminders.exportBlocks(dir, 'butler-reads', [listed[2].name], out), /does not match/);
  assert.equal(fs.readFileSync(path.join(out, 'butler-reads', listed[2].name), 'utf8'), 'someone else\'s file', 'Never written over');
  const open = JSON.parse(fs.readFileSync(manifestFile(dir, 'butler-reads'))).blocks.at(-1).name;
  assert.throws(() => reminders.exportBlocks(dir, 'butler-reads', [open], out), /sealed/);
  assert.throws(() => reminders.exportBlocks(dir, 'butler-reads', names, path.join(dir, 'history')), /outside/);
  assert.throws(() => reminders.exportBlocks(dir, 'butler-reads', [], out), /Choose/);
  assert.throws(() => reminders.exportBlocks(dir, 'notes', names, out), /Unknown record/);
  // A link where a copy would be, even one to NAW's own block, is not a copy.
  const linked = folder(t); fs.mkdirSync(path.join(linked, 'butler-reads'), { mode: 0o700 });
  fs.symlinkSync(path.join(dir, 'history', 'butler-reads', listed[0].name), path.join(linked, 'butler-reads', listed[0].name));
  assert.throws(() => reminders.exportBlocks(dir, 'butler-reads', [listed[0].name], linked), /does not match/);
  assert.throws(() => reminders.verifyExport(dir, 'butler-reads', [listed[0].name], path.join(linked, 'butler-reads')), /not there/);
  assert.equal(reminders.verifyExport(dir, 'butler-reads', names, path.join(fs.realpathSync(out), 'butler-reads')), true);
  // A block that no longer matches its record is not exported.
  fs.appendFileSync(path.join(dir, 'history', 'butler-reads', listed[2].name), 'x');
  assert.throws(() => reminders.exportBlocks(dir, 'butler-reads', [listed[2].name], folder(t)), /does not match/);
});

// The page: a fake document, and the person-only call answered by the real module over a real record.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.id = ''; this.open = false; this.title = ''; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name) { return (this.listeners[name] || []).map(callback => callback())[0]; }
  showModal() { if (this.open) throw Error('already open'); this.open = true; }
  close() { if (!this.open) return; this.open = false; this.fire('close'); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
function page(t, dir, now = NOW) {
  const document = { createElement: tag => new Element(tag) }, button = new Element('button'), badge = new Element('span'), dialog = new Element('dialog'), calls = [];
  const out = folder(t); let chosen = null, deleteAnswer = () => ({ deleted: [] });
  let onChanged = null, unavailable = {};
  const api = { onRecordsChanged: callback => { onChanged = callback; }, records: async (action, ...args) => {
    calls.push([action, ...args]);
    if (action === 'status') return reminders.status(dir, now, { unavailable });
    if (action === 'acknowledge') { reminders.acknowledge(dir, ...args); return reminders.status(dir, now); }
    if (action === 'blocks') return reminders.blocks(dir, args[0], now);
    if (action === 'chooseFolder') { chosen = out; return { folder: out }; }
    if (action === 'export') return reminders.exportBlocks(dir, args[0], args[1], chosen);
    if (action === 'reveal') return true;
    if (action === 'delete') return deleteAnswer();
    throw Error('unknown');
  } };
  const view = bind({ button, badge, dialog, document, api, text: zh });
  const find = action => dialog.all().find(node => node.tag === 'button' && node.dataset.action === action);
  return { view, button, badge, dialog, calls, out, find, answer: hook => { deleteAnswer = hook; }, changed: () => onChanged?.(), unavailable: value => { unavailable = value; }, text: () => dialog.all().filter(node => !node.hidden).map(node => node.textContent).filter(Boolean).join('\n') };
}

test('the bell stays present when empty; its dialog says what, and "知道了" puts the item away', async t => {
  const dir = folder(t); readLog(dir, 33);
  const quiet = page(t, folder(t)); await quiet.view.refresh();
  assert.deepEqual([quiet.button.hidden, quiet.badge.textContent], [false, '']);
  const p = page(t, dir); await p.view.refresh();
  assert.deepEqual([p.button.hidden, p.badge.textContent, p.button.attributes['aria-label']], [false, '1', zh('records.bellCount', { count: 1 })]);
  await p.view.open();
  assert.equal(p.dialog.open, true);
  const text = p.text();
  for (const line of [zh('records.title'), zh('records.name.butler-reads'), zh('records.item.age', { blocks: 2, oldest: new Date(NOW - 32 * DAY).toISOString().slice(0, 10), total: 33, size: p.view.size(of(reminders.status(dir, NOW), 'butler-reads').bytes) })])
    assert.ok(text.includes(line), line);
  assert.equal(text.includes(zh('records.name.operations')), false, 'A record with nothing due is not listed');
  await p.find('acknowledge').fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.calls.find(call => call[0] === 'acknowledge'), ['acknowledge', 'butler-reads', 'age', 1]);
  assert.deepEqual([p.button.hidden, p.text().includes(zh('records.nothing'))], [false, true]);
});

test('export from the dialog: the old blocks chosen to start with, nothing sent before a folder is chosen, then a checked copy', async t => {
  const dir = folder(t); readLog(dir, 33);
  const p = page(t, dir); await p.view.open();
  p.find('export').fire('click'); await new Promise(resolve => setImmediate(resolve));
  const boxes = p.dialog.all().filter(node => node.tag === 'input');
  assert.deepEqual([boxes.length, boxes.filter(box => box.checked).length], [32, 2]);
  const run = p.find('run');
  assert.deepEqual([run.textContent, run.disabled], [zh('records.export.run', { count: 2 }), true], 'Nothing is exported before a folder is chosen');
  await p.find('choose').fire('click'); assert.equal(run.disabled, false);
  await run.fire('click');
  const exported = p.calls.find(call => call[0] === 'export');
  assert.deepEqual(exported, ['export', 'butler-reads', boxes.filter(box => box.checked).map(box => box.value)]);
  assert.ok(p.text().includes(zh('records.export.done', { count: 2, size: p.view.size(reminders.blocks(dir, 'butler-reads', NOW).filter(block => block.old).reduce((sum, block) => sum + block.bytes, 0)), folder: path.join(fs.realpathSync(p.out), 'butler-reads') })));
  assert.equal(fs.readdirSync(path.join(p.out, 'butler-reads')).length, 2);
  assert.equal(reminders.status(dir, NOW).count, 1, 'Exporting changes nothing in NAW, the reminder included');
});

test('a block that cannot be read offers to show it in Finder, never export', async t => {
  const dir = folder(t); fs.mkdirSync(path.join(dir, 'history', 'operations'), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(dir, 'history'), 0o700);
  fs.writeFileSync(manifestFile(dir, 'operations'), '{broken', { mode: 0o600 });
  const p = page(t, dir); await p.view.open();
  assert.ok(p.text().includes(zh('records.item.unreadableManifest')));
  assert.deepEqual([Boolean(p.find('reveal')), Boolean(p.find('export'))], [true, false]);
  await p.find('reveal').fire('click');
  assert.deepEqual(p.calls.at(-1), ['reveal', 'operations', null]);
});

test('the main process keeps the reminders to the person\'s own window and out of the agent catalog', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8'), at = main.indexOf("register('records',");
  assert.ok(at > 0); assert.ok(main.slice(at, at + 200).includes("if (!isCurrentHumanContext(c)) throw uiError('error.records.personOnly');"));
  assert.ok(main.includes("applicationHandlers.delete('records');"));
  assert.ok(!/\b(unlinkSync|rmSync|rmdirSync|removeFile|unlink|rm)\(/.test(fs.readFileSync(path.join(__dirname, '..', 'record-reminders.cjs'), 'utf8')), 'Nothing in the reminders module removes a file');
  // Deleting goes through each record's owner, only after a checked export in this window, checked again around the
  // person's own confirmation.
  const remove = main.slice(main.indexOf("if (action === 'delete' && args.length === 2) {"), main.indexOf("applicationHandlers.delete('records');"));
  for (const part of ["names.some(item => !exported.names.has(item))) throw uiError('error.records.notExported');", "await showDialog(c, 'message',", "if (answer.response !== 1 || c.win.isDestroyed()) return { deleted: [] };",
    'backgroundControl.deleteBlocks(names);', 'butlerReadAudit.deleteBlocks(c, names);']) assert.ok(remove.includes(part), part);
  assert.equal(remove.split('recordReminders.verifyExport(dataDir, name, names, exported.folder);').length - 1, 2, 'Checked before asking and again after the answer');
});

test('after a checked export the dialog offers to delete exactly those blocks; the person\'s "no" leaves everything', async t => {
  const dir = folder(t); readLog(dir, 33);
  const p = page(t, dir); let answer = { deleted: [] }; const asked = [];
  await p.view.open(); p.find('export').fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.find('delete').hidden, true, 'Not there before an export');
  await p.find('choose').fire('click'); await p.find('run').fire('click');
  const remove = p.find('delete');
  assert.deepEqual([remove.hidden, remove.textContent], [false, zh('records.delete.button', { count: 2 })]);
  assert.ok(p.text().includes(zh('records.delete.about')));
  p.answer(() => answer); await remove.fire('click'); asked.push(p.calls.at(-1));
  assert.deepEqual(asked[0].slice(0, 2), ['delete', 'butler-reads']); assert.equal(asked[0][2].length, 2);
  assert.deepEqual([remove.hidden, remove.disabled], [false, false], 'Cancelled: still offered');
  answer = { deleted: asked[0][2] }; await remove.fire('click');
  assert.ok(p.text().includes(zh('records.delete.done', { count: 2 }))); assert.equal(remove.hidden, true);
  assert.equal(p.dialog.all().filter(node => node.tag === 'label' && !node.hidden).length, 30, 'The deleted blocks leave the list');
});

test('the bell is worked out again when the main process says a record changed, and each reason for a stop has its own sentence', async t => {
  const p = page(t, folder(t)); await p.view.refresh(); assert.equal(p.button.hidden, false);
  p.unavailable({ operations: 'other' }); p.changed(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([p.button.hidden, p.badge.textContent], [false, '1']);
  await p.view.open(); assert.ok(p.text().includes(zh('records.item.unavailableOther'))); assert.equal(p.text().includes(zh('records.item.unavailable')), false);
  p.dialog.close(); p.unavailable({ operations: 'history' }); await p.view.open();
  assert.ok(p.text().includes(zh('records.item.unavailable')));
  // The main process: a sealed or added block, or a record not loaded at start, sends the event; nothing polls.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.ok(main.includes("changed: () => { broadcastRoom().catch(() => {}); recordsChanged(); },"));
  assert.ok(main.includes("operationsUnavailable = /history cannot be read/.test(String(error?.message)) ? 'history' : 'other'; recordsChanged(); }"));
  assert.ok(main.includes("for (const c of windows.values()) sendToPage(c, 'workspace:records-changed');"));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8').includes("['onRecordsChanged', 'workspace:records-changed']"));
});
