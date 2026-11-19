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
  focus() { Element.focused = this; }
}
function page(t, dir, now = NOW, options = {}) {
  const document = { createElement: tag => new Element(tag) }, button = new Element('button'), badge = new Element('span'), dialog = new Element('dialog'), calls = [];
  const out = folder(t); let chosen = null, deleteAnswer = () => ({ deleted: [] });
  let onChanged = null, unavailable = {}, overlay = {}; const navigated = [];
  const api = { onRecordsChanged: callback => { onChanged = callback; }, records: async (action, ...args) => {
    calls.push([action, ...args]);
    if (action === 'status') return { ...reminders.status(dir, now, { unavailable }), ...overlay };
    if (action === 'acknowledge') { reminders.acknowledge(dir, ...args); return reminders.status(dir, now); }
    if (action === 'blocks') return reminders.blocks(dir, args[0], now);
    if (action === 'chooseFolder') { chosen = out; return { folder: out }; }
    if (action === 'export') return reminders.exportBlocks(dir, args[0], args[1], chosen);
    if (action === 'reveal') return true;
    if (action === 'delete') return deleteAnswer();
    throw Error('unknown');
  } };
  const view = bind({ button, badge, dialog, document, api, text: zh, summaryText: s => zh('background.action.' + s.action), confirmation: async target => { navigated.push(target); return true; }, ...options });
  t.after(() => view.dispose?.());
  const find = action => dialog.all().find(node => node.tag === 'button' && node.dataset.action === action);
  return { view, button, badge, dialog, calls, out, find, navigated, status: value => { overlay = value; }, answer: hook => { deleteAnswer = hook; }, changed: () => onChanged?.(), unavailable: value => { unavailable = value; }, text: () => dialog.all().filter(node => !node.hidden).map(node => node.textContent).filter(Boolean).join('\n') };
}

for(const language of ['zh','en'])for(const issue of ['incomplete','metadata-unavailable'])test(`registration refusal explains status and the kept result (${issue}, ${language})`,async()=>{
  const dialog=new Element('dialog'),button=new Element('button'),badge=new Element('span'),document={createElement:tag=>new Element(tag)};
  const format=(key,params)=>locale.format(language,key,params),key=issue==='incomplete'?'records.temp.registrationIncomplete':'records.temp.registrationUnavailable';
  const result={cleaned:0,bytes:0,skipped:1,reasons:{unverified:1},registrationIssue:issue};
  let status={count:1,records:[],temp:{shown:true,directories:1,bytes:4096,ticket:'synthetic-person-ticket'}};
  const api={records:async action=>{if(action==='tempClean'){status={count:1,records:[],temp:{shown:true,directories:0,anomaly:'registration-unverified',registrationIssue:issue}};return {...status,result};}return status;}};
  const view=bind({button,badge,dialog,document,api,text:format});await view.open();
  await dialog.all().find(node=>node.dataset.action==='tempClean').fire('click');
  const paragraphs=dialog.all().filter(node=>node.tag==='p').map(node=>node.textContent);
  assert.notEqual(format(key),key,'A translated explanation exists');
  assert.equal(paragraphs.filter(text=>text===format(key)).length,2,'Both result and blocked status explain the same cause');
  assert.equal(dialog.all().find(node=>node.dataset.action==='tempClean').disabled,true);
  assert.ok(dialog.all().some(node=>node.attributes.role==='status'));
});

for (const language of ['zh','en']) test(`a changed temporary directory uses the existing kept result rather than the in-use-only result (${language})`,async()=>{
  const dialog=new Element('dialog'),button=new Element('button'),badge=new Element('span'),document={createElement:tag=>new Element(tag)};
  const format=(key,params)=>locale.format(language,key,params),result={cleaned:0,bytes:0,skipped:1,reasons:{busy:0,changed:1,unverified:0}};
  let status={count:1,records:[],temp:{shown:true,directories:1,bytes:4096,oldestDay:'2026-11-01',ticket:'synthetic-person-ticket'}};
  const api={records:async action=>{
    if(action==='tempClean') {status={count:0,records:[],temp:{shown:false}};return {...status,result};}
    assert.equal(action,'status');return status;
  }};
  const view=bind({button,badge,dialog,document,api,text:format});await view.open();
  await dialog.all().find(node=>node.dataset.action==='tempClean').fire('click');
  const text=dialog.all().map(node=>node.textContent).join('\n');
  assert.ok(text.includes(format('records.temp.kept',{count:1})));
  assert.equal(text.includes(format('records.temp.keptBusy',{count:1})),false);
  assert.ok(dialog.all().some(node=>node.attributes.role==='status'));
});

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
  const changed = main.match(/changed: change => \{([\s\S]*?)\},\s*confirmationFingerprint:/);
  assert.ok(changed, 'The BackgroundControl change callback remains present');
  const callback = changed[1], broadcast = callback.indexOf('broadcastRoom().catch(() => {});'), records = callback.indexOf('recordsChanged(change?.confirmations === true);');
  assert.ok(broadcast >= 0, 'Record changes still broadcast room state and handle rejection');
  assert.ok(records >= 0, 'Record changes retain the strict confirmation flag');
  assert.ok(broadcast < records, 'The original broadcast and records-change order remains');
  const sync = callback.indexOf('backgroundNotifications?.sync();');
  assert.ok(sync >= 0 && sync < broadcast && sync < records, 'Notifications sync before both existing change calls');
  assert.ok(main.includes("operationsUnavailable = /history cannot be read/.test(String(error?.message)) ? 'history' : 'other'; recordsChanged(); }"));
  assert.ok(main.includes("for (const c of windows.values()) sendToPage(c, 'workspace:records-changed');"));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8').includes("['onRecordsChanged', 'workspace:records-changed']"));
});

test('confirmations lead the bell, All includes ended cards, and a row only navigates to its exact original card', async t => {
 const p=page(t,folder(t)),time=Date.now(),card={id:'background:old-native:same-operation',key:'requester:old-native:same-operation',operationId:'same-operation',sessionId:'requester',nativeId:'old-native',actorName:'Requester',targetName:'Target',summary:{action:'input',method:'input',target:'Target'},state:'confirmation-required',actionable:true,time,expiresAt:time+120000};
 p.status({count:1,confirmationCount:1,confirmations:[card,{...card,id:'background:new-native:same-operation',key:'requester:new-native:same-operation',nativeId:'new-native',state:'not-executed',disposition:'expired',actionable:false}]});
 await p.view.open();assert.equal(p.badge.textContent,'1');
 const sections=p.dialog.all().filter(n=>n.tag==='section');assert.equal(sections[0]?.dataset.record,'confirmations');
 assert.equal(p.dialog.all().filter(n=>n.dataset.action==='openConfirmation').length,1);
 assert.equal(sections[0].all().some(n=>/acknowledge/i.test(n.dataset.action||'')),false,'Confirmation TTL has no acknowledgement');
 await p.find('allConfirmations').fire('click');assert.equal(p.dialog.all().filter(n=>n.dataset.action==='openConfirmation').length,2);
 await p.find('openConfirmation').fire('click');assert.deepEqual(p.navigated,[{sessionId:'requester',nativeId:'old-native',messageId:card.id,operationId:card.operationId,history:true}]);
 assert.equal(p.dialog.open,false);assert.ok(p.calls.every(c=>c[0]==='status'),'No decision, terminal input, cleanup or acknowledgement from filtering/navigation');
});


test('All lists the latest 15 ended confirmations with the waiting one kept, and brings 15 earlier at a time above them', async t => {
  const p = page(t, folder(t));
  const card = n => ({ id: 'original-' + n, key: 'a:n:op-' + n, sessionId: 'a', nativeId: 'n', operationId: 'op-' + n, actorName: 'A', targetName: 'B', summary: { action: 'input' },
    state: 'not-executed', disposition: 'expired', actionable: false, time: NOW - (40 - n) * 60000, expiresAt: NOW });
  const waiting = { ...card(99), id: 'original-waiting', key: 'a:n:op-waiting', state: 'confirmation-required', disposition: undefined, actionable: true, time: NOW - 3600000, expiresAt: NOW + 600000 };
  p.status({ count: 1, confirmationCount: 1, confirmations: [...Array.from({ length: 40 }, (_, n) => card(n)), waiting] });
  const links = () => p.dialog.all().filter(n => n.dataset.action === 'openConfirmation').map(n => n.dataset.confirmationKey);
  const more = () => p.dialog.all().find(n => n.className === 'disclosure-more');
  const status = () => p.dialog.all().find(n => n.className === 'disclosure-status');
  await p.view.open();
  assert.deepEqual([links(), more().hidden], [['a:n:op-waiting'], true], 'Waiting only: nothing earlier to bring');
  await p.find('allConfirmations').fire('click');
  assert.deepEqual(links(), ['a:n:op-waiting', ...Array.from({ length: 15 }, (_, n) => 'a:n:op-' + (25 + n))], 'The waiting card stays, then the latest 15 in time order');
  assert.deepEqual([more().hidden, more().textContent, status().attributes.role, status().textContent],
    [false, zh('disclosure.older', { count: 15, total: 41 }), 'status', zh('disclosure.shown', { shown: 16, total: 41 })]);
  assert.ok(p.dialog.all().indexOf(more()) < p.dialog.all().findIndex(n => n.dataset.action === 'openConfirmation'), 'Earlier ones appear above');
  await more().fire('click');
  assert.equal(links().length, 31);
  assert.equal(Element.focused?.dataset.confirmationKey, 'a:n:op-10', 'Focus goes to the first card that appeared');
  assert.deepEqual([more().textContent, status().textContent], [zh('disclosure.older', { count: 10, total: 41 }), zh('disclosure.shown', { shown: 31, total: 41 })]);
  await more().fire('click');
  assert.deepEqual([links().length, more().hidden, status().textContent], [41, true, zh('disclosure.shown', { shown: 41, total: 41 })]);
  await p.find('pendingConfirmations').fire('click'); await p.find('allConfirmations').fire('click');
  assert.equal(links().length, 16, 'Switching filters starts again from the latest 15');
  assert.ok(p.calls.every(c => c[0] === 'status'), 'Paging reads nothing new and decides nothing');
});


test('the open-dialog clock refreshes once at the source deadline and stops on close', async t => {
 t.mock.timers.enable({apis:['setTimeout']});let clock=NOW;
 const p=page(t,folder(t),NOW,{now:()=>clock}),card={id:'original',key:'a:n:op',sessionId:'a',nativeId:'n',operationId:'op',actorName:'A',targetName:'B',summary:{action:'input'},state:'confirmation-required',actionable:true,time:NOW,expiresAt:NOW+2000};
 p.status({count:1,confirmations:[card]});await p.view.open();const reads=p.calls.length;
 clock+=1000;t.mock.timers.tick(1000);assert.equal(p.calls.length,reads,'No per-second RPC');
 clock+=1000;t.mock.timers.tick(1000);await Promise.resolve();assert.equal(p.calls.length,reads+1,'One source refresh at expiry');
 p.dialog.close();clock+=10000;t.mock.timers.tick(10000);assert.equal(p.calls.length,reads+1,'Closed dialog stops its display clock');
});

test('a missing original keeps its summary and follow-up expiry never claims earlier steps were undone', async t => {
 const p=page(t,folder(t),NOW,{confirmation:async()=>false});
 p.status({count:0,confirmations:[{id:'original',key:'a:n:op',sessionId:'a',nativeId:'n',operationId:'op',actorName:'A',targetName:'B',summary:{action:'input'},state:'unconfirmed',disposition:'expired',afterStart:true,actionable:false,time:NOW-120000,expiresAt:NOW}]});
 await p.view.open();await p.find('allConfirmations').fire('click');assert.ok(p.text().includes(zh('background.card.expiredAfterStart')));assert.ok(p.text().includes(zh('records.confirmations.partial')));
 await p.find('openConfirmation').fire('click');assert.equal(p.dialog.open,true);assert.ok(p.text().includes(zh('records.confirmations.unavailable')));
 await p.find('allConfirmations').fire('click');assert.equal(p.find('openConfirmation')!==undefined,true,'Original summary remains available');
});
