// A restart record says how the last run ended (the person's butler, 2026-11-24: 「崩溃后的弹窗/重启记录要说清是崩溃，
// 不写成普通重启」): 20:38 the main process died of V8 OOM and 20:39 the record only said 「重启完成 296->296」.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { VersionEvents } = require('../version-events.cjs');

const OLD = '0.1.0-alpha.296', NEW = '0.1.0-alpha.297';
const START = Date.UTC(2026, 10, 25, 4, 38, 20);
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-restart-exit-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const marker = dir => path.join(dir, 'main-running.json');
// One run of the app: constructed at start, told once a window is up, `exitClean` on the quit path.
function run(dir, { version = NEW, at = START } = {}) {
  const events = [], owed = [];
  const value = new VersionEvents(dir, { version, now: () => at, record: e => events.push(e), owe: text => { owed.push(text); return true; } });
  return { value, events, owed, observe: () => value.observe([], () => undefined), clean: () => value.exitClean(), last: () => events[events.length - 1], text: () => events[events.length - 1].payload.text };
}
// A run that quit on its own path; one that ends without it leaves its marker behind.
function quits(dir, options) { const r = run(dir, options); r.observe(); r.clean(); return r; }
function dies(dir, options) { const r = run(dir, options); r.observe(); return r; }

test('a normal quit, then a start on the same version: the record says the last run ended normally', t => {
  const dir = directory(t);
  quits(dir, { at: START });
  assert.equal(fs.existsSync(marker(dir)), false, 'the normal quit leaves no running mark');
  const again = run(dir, { at: START + 60000 }); again.observe();
  assert.equal(again.last().payload.reason, 'version-restarted');
  assert.equal(again.last().kind, 'blocked');
  assert.match(again.text(), /^【NAW 版本】重启完成：0\.1\.0-alpha\.297，2026-11-25T04:39:20Z。上次正常退出。\n后台都已在/u);
  assert.equal(again.owed.length, 1); assert.match(again.owed[0], /上次正常退出/u, 'the secretary reads the same');
});

test('the last run never wrote its normal quit: the record says abnormal, with its pid, its start and where to look', t => {
  const dir = directory(t);
  dies(dir, { at: START });
  assert.equal(fs.existsSync(marker(dir)), true, 'a run without a normal quit leaves its running mark');
  const again = run(dir, { at: START + 60000 }); again.observe();
  assert.equal(again.last().payload.reason, 'version-restarted-after-abnormal-exit');
  assert.equal(again.last().kind, 'failure');
  assert.equal(again.last().payload.outcome, `${NEW}->${NEW}`);
  const text = again.text();
  assert.match(text, /^【NAW 版本】重启完成：0\.1\.0-alpha\.297，2026-11-25T04:39:20Z。上次没有正常退出：/u);
  assert.match(text, new RegExp(`主进程 ${process.pid}，2026-11-25T04:38:20Z 启动`, 'u'));
  assert.match(text, /具体原因看 ~\/Library\/Logs\/DiagnosticReports/u);
  assert.doesNotMatch(text, new RegExp(os.userInfo().username, 'u'), 'no user name');
  assert.doesNotMatch(text, /\/Users\//u, 'no path with a name in it');
  // Told once: a crash of this run is its own, not that one again.
  again.clean();
  const third = run(dir, { at: START + 120000 }); third.observe();
  assert.equal(third.last().payload.reason, 'version-restarted');
  assert.match(third.text(), /上次正常退出。/u);
});

test('two crashes in a row: each start names the run that crashed before it', t => {
  const dir = directory(t);
  dies(dir, { at: START });
  dies(dir, { at: START + 600000 });
  const third = run(dir, { at: START + 1200000 }); third.observe();
  assert.equal(third.last().payload.reason, 'version-restarted-after-abnormal-exit');
  assert.match(third.text(), /2026-11-25T04:48:20Z 启动/u);
});

test('an install restart: the new version is told as installed, with how the replaced version ended', t => {
  const dir = directory(t);
  quits(dir, { version: OLD, at: START });
  const installed = run(dir, { version: NEW, at: START + 60000 }); installed.observe();
  assert.equal(installed.last().payload.reason, 'version-installed');
  assert.equal(installed.last().kind, 'blocked');
  assert.equal(installed.last().payload.outcome, `${OLD}->${NEW}`);
  assert.match(installed.text(), /^【NAW 版本】已装 0\.1\.0-alpha\.297（原来是 0\.1\.0-alpha\.296），2026-11-25T04:39:20Z 重启完成。上次正常退出。\n/u);
});

test('installed over a version that had crashed: both are said', t => {
  const dir = directory(t);
  dies(dir, { version: OLD, at: START });
  const installed = run(dir, { version: NEW, at: START + 60000 }); installed.observe();
  assert.equal(installed.last().payload.reason, 'version-installed-after-abnormal-exit');
  assert.equal(installed.last().kind, 'failure');
  assert.match(installed.text(), /^【NAW 版本】已装 0\.1\.0-alpha\.297（原来是 0\.1\.0-alpha\.296），2026-11-25T04:39:20Z 重启完成。上次没有正常退出：/u);
});

test('a first start has no record of a last run, and says so, not normal and not abnormal', t => {
  const dir = directory(t);
  const first = run(dir); first.observe();
  assert.equal(first.last().payload.reason, 'version-installed');
  assert.match(first.text(), /重启完成。没有上次退出的记录。\n/u);
});

test('a version without this mark ran since: its run is not called normal or crashed', t => {
  const dir = directory(t);
  // This version crashed, then an older NAW without the mark started and only wrote version-seen.json.
  dies(dir, { version: NEW, at: START });
  fs.writeFileSync(path.join(dir, 'version-seen.json'), JSON.stringify({ format: 1, version: OLD, at: START + 60000 }), { mode: 0o600 });
  const again = run(dir, { version: NEW, at: START + 120000 }); again.observe();
  assert.equal(again.last().payload.reason, 'version-installed');
  assert.match(again.text(), /没有上次退出的记录。/u);
  assert.doesNotMatch(again.text(), /没有正常退出/u);
  // And the reverse: an old version's own normal run, after a run of this one that had quit normally.
  const other = directory(t);
  quits(other, { version: NEW, at: START });
  fs.writeFileSync(path.join(other, 'version-seen.json'), JSON.stringify({ format: 1, version: NEW, at: START + 60000 }), { mode: 0o600 });
  const later = run(other, { version: NEW, at: START + 120000 }); later.observe();
  assert.match(later.text(), /没有上次退出的记录。/u, 'an unmarked run is never called normal');
});

test('a mark that cannot be read still says abnormal, without inventing a pid; a link is not followed', t => {
  const dir = directory(t);
  quits(dir);
  fs.writeFileSync(marker(dir), '{not json', { mode: 0o600 });
  const bad = run(dir, { at: START + 60000 }); bad.observe();
  assert.equal(bad.last().payload.reason, 'version-restarted-after-abnormal-exit');
  assert.doesNotMatch(bad.text(), /主进程 (?:undefined|null|NaN|\{)/u);
  const other = directory(t);
  quits(other);
  fs.rmSync(marker(other), { force: true });
  fs.symlinkSync('/etc/hosts', marker(other));
  const link = run(other, { at: START + 60000 }); link.observe();
  assert.doesNotMatch(link.text(), /hosts/u, 'a link is not read as the last run');
});

test('a mark that could not be written makes the next start say it has no record, not that the last run was normal', t => {
  if (process.getuid() === 0) return t.skip('root writes anywhere');
  const dir = directory(t);
  quits(dir, { at: START });
  // version-seen.json from a run that could not leave its mark.
  const file = path.join(dir, 'version-seen.json');
  const blocked = run(dir, { at: START + 60000 });
  // The mark is gone while the run lives, as a full disk would leave it.
  fs.rmSync(marker(dir), { force: true });
  blocked.value.marked = false;
  blocked.observe();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).marks, undefined);
  const next = run(dir, { at: START + 120000 }); next.observe();
  assert.match(next.text(), /没有上次退出的记录。/u);
});

test('another run\'s mark is left alone by a quit: not the same process, or not the same start', t => {
  const dir = directory(t);
  const mine = run(dir, { at: START }); mine.observe();
  const other = over => fs.writeFileSync(marker(dir), JSON.stringify({ format: 1, pid: process.pid, at: START, version: NEW, ...over }), { mode: 0o600 });
  other({ pid: 999999 }); mine.clean();
  assert.equal(fs.existsSync(marker(dir)), true, 'another process');
  other({ at: START - 1 }); mine.clean();
  assert.equal(fs.existsSync(marker(dir)), true, 'an earlier start of this process');
  other({}); mine.clean();
  assert.equal(fs.existsSync(marker(dir)), false, 'its own');
});

test('main.cjs: the normal-exit mark is removed on will-quit, even when an earlier disposer throws; before-quit does not', () => {
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const start = source.indexOf("app.on('will-quit'"), end = source.indexOf('\n});', start);
  assert.ok(start > 0 && end > start);
  const handler = source.slice(start, end + 4);
  const listeners = [];
  let cleaned = 0;
  const context = vm.createContext({ app: { on: (name, fn) => { assert.equal(name, 'will-quit'); listeners.push(fn); } },
    discoveries: { dispose() { throw Error('synthetic'); } }, backgroundNotifications: null, notificationScreen: null, queueDispatcher: null,
    butlerIngress: null, versionEvents: { exitClean() { cleaned++; } } });
  vm.runInContext(handler, context);
  assert.equal(listeners.length, 1);
  try { listeners[0](); } catch { /* A disposer threw after the mark was handled. */ }
  assert.equal(cleaned, 1, 'will-quit clears the running mark first');
  const before = source.slice(source.indexOf("app.on('before-quit'"), start);
  assert.doesNotMatch(before, /exitClean/u, 'a quit that is refused keeps the mark');
});
