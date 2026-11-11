// A backend's own program locations (the person, 2026-11-10: 「为啥不把 agent 更新到最新」). A backend must not
// be left unable to run a provider with nothing shown, nor kept on an older version by an entry nothing in the
// interface shows: its own entries are taken out when it starts and kept in a record, and it uses the shared
// Settings file. Fake programs only; nothing is started but NAW's own backend service.
for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const locations = require('../runtime-locations.cjs'), platform = require('../platform.cjs');
const root = path.resolve(__dirname, '../..'), KEY = 'backends/aaaaaaaaaaaaaaaaaaaa';

// A data directory with one backend of its own, a folder of installed versions, and launchers on a private PATH.
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-backend-programs-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, 'data'), backend = path.join(data, KEY), versions = path.join(base, 'versions'), bin = path.join(base, 'bin');
  for (const folder of [data, path.join(data, 'backends'), backend, versions, bin]) fs.mkdirSync(folder, { mode: 0o700 });
  const program = file => { fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); return file; };
  const launchers = { claude: program(path.join(bin, 'claude')), codex: program(path.join(bin, 'codex')), python3: program(path.join(bin, 'python3')) };
  const write = (file, value) => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return file; };
  const own = path.join(backend, 'runtime-locations.json'), shared = path.join(data, 'runtime-locations.json'), record = path.join(backend, 'runtime-locations.removed.json');
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { base, data, backend, bin, launchers, own, shared, record, write, read, old: program(path.join(versions, '0.165.0')), gone: path.join(versions, '0.164.0') };
}
// Discovery as the installed app does it, but on the fixture's launchers first.
function searchPath(t, value) { const before = process.env.PATH; process.env.PATH = value; t.after(() => { process.env.PATH = before; }); }

test('every own entry is taken out at a start, for a program that is gone and for an older version that still exists, and kept in the record', t => {
  const f = fixture(t), goneClaude = path.join(f.base, 'versions', '2.1.312');
  f.write(f.own, { claude: goneClaude, codex: f.old });
  const before = fs.readFileSync(f.own, 'utf8'), removed = [{ key: 'claude', path: goneClaude, existed: false }, { key: 'codex', path: f.old, existed: true }];
  // Without repair nothing is written: the same answer, for a check before an update.
  const dry = locations.backendLocations(f.backend, f.shared);
  assert.deepEqual(dry, { file: f.shared, locations: null, removed });
  assert.equal(fs.readFileSync(f.own, 'utf8'), before); assert.equal(fs.existsSync(f.record), false);
  assert.deepEqual(locations.backendLocations(f.backend, f.shared, { repair: true }), dry);
  assert.deepEqual(f.read(f.own), {}); assert.equal(fs.statSync(f.own).mode & 0o777, 0o600);
  // What was taken out can be put back from the record: every entry, with whether its program still existed.
  const kept = f.read(f.record);
  assert.deepEqual(kept.removals.map(entry => entry.removed), [removed]); assert.ok(Date.parse(kept.removals[0].at) <= Date.now()); assert.equal(fs.statSync(f.record).mode & 0o777, 0o600);
  assert.deepEqual(Object.fromEntries(kept.removals[0].removed.map(entry => [entry.key, entry.path])), JSON.parse(before));
  assert.deepEqual(fs.readdirSync(f.backend).sort(), ['runtime-locations.json', 'runtime-locations.removed.json'], 'No temporary file is left');
  // The next start has nothing to take out and writes nothing.
  const stamp = fs.statSync(f.own).mtimeMs, recorded = fs.readFileSync(f.record, 'utf8');
  assert.deepEqual(locations.backendLocations(f.backend, f.shared, { repair: true }), { file: f.shared, locations: null, removed: [] });
  assert.equal(fs.statSync(f.own).mtimeMs, stamp); assert.equal(fs.readFileSync(f.record, 'utf8'), recorded);
  // A file written again later is taken out again; the record keeps the last twenty and stays private even if it was not.
  fs.chmodSync(f.record, 0o644);
  for (let i = 0; i < 21; i++) { f.write(f.own, { python3: path.join(f.base, 'versions', `python-${i}`) }); locations.backendLocations(f.backend, f.shared, { repair: true }); }
  const later = f.read(f.record).removals;
  assert.equal(later.length, 20); assert.deepEqual(later.at(-1).removed, [{ key: 'python3', path: path.join(f.base, 'versions', 'python-20'), existed: false }]); assert.equal(later[0].removed[0].path, path.join(f.base, 'versions', 'python-1'));
  assert.equal(fs.statSync(f.record).mode & 0o777, 0o600);
  // A record that cannot be used holds the only copy of earlier removals: it is kept under another name, never written over.
  const asides = () => fs.readdirSync(f.backend).filter(name => name.startsWith('runtime-locations.removed.json.') && name.endsWith('.unreadable'));
  for (const damaged of ['{ not json', JSON.stringify({ removed: 'an older shape' })]) {
    for (const name of asides()) fs.rmSync(path.join(f.backend, name), { recursive: true });
    fs.writeFileSync(f.record, damaged); f.write(f.own, { codex: f.old });
    assert.equal(locations.backendLocations(f.backend, f.shared, { repair: true }).file, f.shared, 'It does not stop the start');
    assert.equal(asides().length, 1); assert.equal(fs.readFileSync(path.join(f.backend, asides()[0]), 'utf8'), damaged);
    assert.deepEqual(f.read(f.record).removals.map(entry => entry.removed), [[{ key: 'codex', path: f.old, existed: true }]]); assert.deepEqual(f.read(f.own), {});
  }
  // The same for something at the record's path that cannot be read as a file at all (here a folder with a file in it).
  for (const name of asides()) fs.rmSync(path.join(f.backend, name), { recursive: true });
  fs.rmSync(f.record); fs.mkdirSync(f.record); fs.writeFileSync(path.join(f.record, 'kept'), 'earlier'); f.write(f.own, { codex: f.old });
  assert.equal(locations.backendLocations(f.backend, f.shared, { repair: true }).file, f.shared);
  assert.equal(asides().length, 1); assert.equal(fs.readFileSync(path.join(f.backend, asides()[0], 'kept'), 'utf8'), 'earlier'); assert.equal(f.read(f.record).removals.length, 1);
});

test('a backend uses the shared Settings file whether or not it has a file of its own, and that file is never touched', t => {
  const f = fixture(t); f.write(f.shared, { codex: f.old });
  const settings = fs.readFileSync(f.shared, 'utf8');
  // No file of its own: nothing is created.
  assert.deepEqual(locations.backendLocations(f.backend, f.shared, { repair: true }), { file: f.shared, locations: null, removed: [] });
  assert.deepEqual(fs.readdirSync(f.backend), []);
  // An own entry for another existing program does not override the person's selection any more.
  const other = path.join(f.base, 'versions', '0.167.0'); fs.writeFileSync(other, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  f.write(f.own, { codex: other });
  assert.deepEqual(locations.backendLocations(f.backend, f.shared, { repair: true }), { file: f.shared, locations: null, removed: [{ key: 'codex', path: other, existed: true }] });
  // An own file with no entry stays as it is.
  const stamp = fs.statSync(f.own).mtimeMs;
  assert.deepEqual(locations.backendLocations(f.backend, f.shared, { repair: true }), { file: f.shared, locations: null, removed: [] });
  assert.equal(fs.statSync(f.own).mtimeMs, stamp);
  assert.equal(fs.readFileSync(f.shared, 'utf8'), settings);
});

test('the shared Settings file is never repaired, a hand-started service keeps its file as it is, and an unreadable file is an error', t => {
  const f = fixture(t); f.write(f.shared, { codex: f.gone });
  // The root backend's own file is the Settings file: a program the person selected stays selected.
  assert.deepEqual(locations.backendLocations(f.data, f.shared, { repair: true }), { file: f.shared, locations: null, removed: [] });
  // Also when the two paths spell the same file differently, here through a linked folder.
  const link = path.join(f.base, 'data-link'); fs.symlinkSync(f.data, link);
  assert.deepEqual(locations.backendLocations(link, f.shared, { repair: true }), { file: f.shared, locations: null, removed: [] });
  assert.deepEqual(locations.backendLocations(f.data, path.join(link, 'runtime-locations.json'), { repair: true }).removed, []);
  assert.deepEqual(f.read(f.shared), { codex: f.gone }); assert.equal(fs.existsSync(path.join(f.data, 'runtime-locations.removed.json')), false);
  // No Settings file is known: the own file is used unchanged, as before.
  f.write(f.own, { codex: f.gone });
  assert.deepEqual(locations.backendLocations(f.backend, undefined, { repair: true }), { file: f.own, locations: { codex: f.gone }, removed: [] });
  assert.deepEqual(f.read(f.own), { codex: f.gone });
  assert.deepEqual(locations.backendLocations(path.join(f.base, 'versions'), undefined, { repair: true }), { file: undefined, locations: null, removed: [] });
  fs.writeFileSync(f.own, '{ not json'); assert.throws(() => locations.backendLocations(f.backend, f.shared, { repair: true }));
  f.write(f.own, { codex: f.old }); fs.chmodSync(f.own, 0o644); assert.throws(() => locations.backendLocations(f.backend, f.shared, { repair: true }), 'A file others can read is refused, as before');
  assert.deepEqual(f.read(f.own), { codex: f.old });
});

test('when the record or the file cannot be written nothing is taken out, and the backend starts with its file as it is', { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t); f.write(f.own, { claude: path.join(f.base, 'versions', '2.1.312'), codex: f.old });
  const before = fs.readFileSync(f.own, 'utf8');
  fs.chmodSync(f.backend, 0o500);
  // (Made writable again here, before the fixture's folder is removed.)
  try { assert.deepEqual(locations.backendLocations(f.backend, f.shared, { repair: true }), { file: f.own, locations: { claude: path.join(f.base, 'versions', '2.1.312'), codex: f.old }, removed: [] }); }
  finally { fs.chmodSync(f.backend, 0o700); }
  assert.equal(fs.readFileSync(f.own, 'utf8'), before); assert.deepEqual(fs.readdirSync(f.backend), ['runtime-locations.json']);
  // A record that can neither be read nor moved aside (here: a damaged record in a folder that cannot be changed):
  // nothing is taken out, and the damaged record is still there.
  const g = fixture(t); g.write(g.own, { codex: g.old }); fs.writeFileSync(g.record, '{ not json');
  fs.chmodSync(g.backend, 0o500);
  try { assert.deepEqual(locations.backendLocations(g.backend, g.shared, { repair: true }), { file: g.own, locations: { codex: g.old }, removed: [] }); }
  finally { fs.chmodSync(g.backend, 0o700); }
  assert.deepEqual(g.read(g.own), { codex: g.old }, 'Without a record the entry stays in the file'); assert.equal(fs.readFileSync(g.record, 'utf8'), '{ not json');
});

test('the record is written before the file: when only the record cannot be written, the entry stays in the file', { skip: process.platform !== 'darwin' || process.getuid?.() === 0 }, t => {
  // A record the system refuses to replace (marked unchangeable), in a folder where the locations file itself can be rewritten.
  const f = fixture(t); f.write(f.own, { codex: f.old }); f.write(f.record, { removals: [] });
  const flag = value => require('node:child_process').execFileSync('/usr/bin/chflags', [value, f.record]);
  flag('uchg');
  try { assert.deepEqual(locations.backendLocations(f.backend, f.shared, { repair: true }), { file: f.own, locations: { codex: f.old }, removed: [] }); }
  finally { flag('nouchg'); }
  assert.deepEqual(f.read(f.own), { codex: f.old }); assert.deepEqual(f.read(f.record), { removals: [] });
  assert.deepEqual(fs.readdirSync(f.backend).sort(), ['runtime-locations.json', 'runtime-locations.removed.json'], 'No temporary file is left');
});

test('a backend whose own file cannot be read still refuses to start and names the file, as before this repair', async t => {
  const { ensureServiceAt } = require('../service-client.cjs');
  const f = fixture(t); process.env.NAW_RUNTIME_CONFIG = f.shared; t.after(() => { delete process.env.NAW_RUNTIME_CONFIG; });
  for (const broken of [() => fs.writeFileSync(f.own, '{ not json', { mode: 0o600 }), () => { f.write(f.own, { codex: f.old }); fs.chmodSync(f.own, 0o644); }]) {
    fs.rmSync(f.own, { force: true }); broken();
    await assert.rejects(ensureServiceAt(f.backend, process.execPath, path.join(f.base, 'workspace')), error => error.uiMessage?.key === 'error.service.locationsUnreadable' && error.uiMessage.params.arg1 === f.own);
    assert.equal(fs.existsSync(path.join(f.backend, 'runtimes')), false, 'Nothing was started');
  }
});

test('the check before an update: a gone entry, an existing older version and no entry all leave both providers runnable', t => {
  const f = fixture(t); searchPath(t, f.bin);
  const found = name => ({ available: true, path: f.launchers[name], source: 'found' }), all = { claude: found('claude'), codex: found('codex'), python3: found('python3') };
  // No file anywhere: everything is discovered.
  assert.deepEqual(platform.backendPrograms(f.data, KEY), { backend: KEY, wouldDrop: [], programs: all, ok: true });
  assert.deepEqual(platform.backendPrograms(f.data, '.').programs, all);
  // Entries for a removed Claude and an existing older Codex: both would be taken out, and the current programs are found.
  const goneClaude = path.join(f.base, 'versions', '2.1.312');
  f.write(f.own, { claude: goneClaude, codex: f.old });
  const before = fs.readFileSync(f.own, 'utf8');
  assert.deepEqual(platform.backendPrograms(f.data, KEY), { backend: KEY, wouldDrop: [{ key: 'claude', path: goneClaude, existed: false }, { key: 'codex', path: f.old, existed: true }], programs: all, ok: true });
  assert.equal(fs.readFileSync(f.own, 'utf8'), before, 'The check changes nothing'); assert.equal(fs.existsSync(f.record), false);
});

test('the check fails when a provider cannot be run: a Settings selection that is gone, or nothing installed', t => {
  const f = fixture(t); searchPath(t, f.bin);
  // The person's own selection is not replaced by discovery: every backend loses Codex, whatever its own file says.
  f.write(f.shared, { codex: f.gone }); f.write(f.own, { codex: f.old });
  for (const key of ['.', KEY]) {
    const result = platform.backendPrograms(f.data, key);
    assert.deepEqual([result.ok, result.programs.codex, result.programs.claude.available], [false, { available: false, path: f.gone, source: 'settings' }, true], key);
  }
  assert.deepEqual(platform.backendPrograms(f.data, KEY).wouldDrop, [{ key: 'codex', path: f.old, existed: true }]);
  // A selection that exists is used by every backend.
  f.write(f.shared, { codex: f.old });
  assert.deepEqual([platform.backendPrograms(f.data, KEY).ok, platform.backendPrograms(f.data, KEY).programs.codex], [true, { available: true, path: f.old, source: 'settings' }]);
  assert.deepEqual(platform.executable('codex', undefined, { codex: f.gone }), undefined); assert.equal(platform.executable('codex', undefined, {}), f.launchers.codex);
  // Nothing to discover (only the conventional folders remain, which this machine may or may not have).
  fs.rmSync(f.shared); fs.rmSync(f.own); fs.rmSync(f.launchers.claude);
  const bare = platform.backendPrograms(f.data, KEY).programs.claude;
  assert.equal(bare.source, bare.available ? 'found' : 'missing'); assert.notEqual(bare.path, f.launchers.claude);
});

test('the check script prints one JSON object, changes nothing, and exits by the result', t => {
  const f = fixture(t), script = path.join(root, 'scripts/check-backend-programs.cjs');
  const run = (...args) => { const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, NAW_RUNTIME_CONFIG: f.shared } }); return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr }; };
  f.write(f.own, { claude: path.join(f.base, 'versions', '2.1.312'), codex: f.old });
  const before = fs.readFileSync(f.own, 'utf8');
  const good = run(f.data, '--backend', KEY, '--path', f.bin);
  assert.deepEqual([good.status, good.out.ok, good.out.backend, good.out.pathAssumed, good.out.wouldDrop.map(entry => [entry.key, entry.existed]), good.out.programs.codex, good.out.programs.claude.path],
    [0, true, KEY, f.bin, [['claude', false], ['codex', true]], { available: true, path: f.launchers.codex, source: 'found' }, f.launchers.claude]);
  assert.equal(fs.readFileSync(f.own, 'utf8'), before); assert.equal(fs.existsSync(f.record), false);
  // Without --backend the active backend of services.json is checked.
  f.write(path.join(f.data, 'services.json'), { format: 1, active: KEY, entries: ['.', KEY] });
  assert.equal(run(f.data, '--path', f.bin).out.backend, KEY);
  fs.rmSync(path.join(f.data, 'services.json')); assert.equal(run(f.data, '--path', f.bin).out.backend, '.');
  f.write(f.shared, { codex: f.gone }); fs.rmSync(f.own);
  const bad = run(f.data, '--backend', KEY, '--path', f.bin);
  assert.deepEqual([bad.status, bad.out.ok, bad.out.programs.codex.available], [1, false, false]);
  fs.writeFileSync(f.shared, '{ not json');
  const unreadable = run(f.data, '--backend', KEY, '--path', f.bin); assert.deepEqual([unreadable.status, unreadable.out.ok, typeof unreadable.out.error], [1, false, 'string']);
  for (const usage of [[], ['relative/path'], [f.data, '--backend', '../outside'], [f.data, 'extra']]) { const r = run(...usage); assert.equal(r.status, 2, usage.join(' ')); assert.equal(r.out, null); assert.match(r.err, /^Usage:/); }
});

test('the alert names what the backend that takes new sessions cannot run, and only believes a backend that resolves again', () => {
  const { WorkspaceClient } = require('../workspace-client.cjs');
  const entry = (key, available, capabilities = ['programAvailabilityV1']) => ({ key, client: { on() {}, call: async () => ({}) }, state: { sessions: [], rooms: [], room: { id: 'shared', revision: 0, run: null, messages: [] }, capabilities, available, runtimeVersion: 'fixture' } });
  const warning = (active, other = entry('.', { claude: true, codex: true, python: true })) => { const snapshot = new WorkspaceClient([other, active], active.key, os.tmpdir()).snapshot(); return [snapshot.programWarning, snapshot.programWarningUiMessage?.key, snapshot.programWarningUiMessage?.params.programs]; };
  assert.deepEqual(warning(entry(KEY, { claude: true, codex: true, python: true })), [null, undefined, undefined]);
  const both = warning(entry(KEY, { claude: false, codex: false, python: true }));
  assert.deepEqual(both.slice(1), ['error.warning.programsMissing', 'Claude Code, Codex']); assert.ok(both[0].includes('Claude Code, Codex'));
  assert.equal(warning(entry(KEY, { claude: true, codex: true, python: false }))[2], 'Python 3');
  // Another backend's missing program does not concern new sessions; an older backend's answer may be from its last start.
  assert.equal(warning(entry(KEY, { claude: true, codex: true, python: true }), entry('.', { claude: false, codex: false, python: false }))[0], null);
  assert.equal(warning(entry(KEY, { claude: false, codex: false, python: false }, []))[0], null);
  assert.equal(warning(entry(KEY, undefined))[0], null);
  // The storage warning, which holds back image sends, is not used for this.
  const snapshot = new WorkspaceClient([entry(KEY, { claude: false, codex: true, python: true })], KEY, os.tmpdir()).snapshot();
  assert.equal(snapshot.storageWarning, null);
  const locale = require('../ui-locale.js');
  for (const language of ['zh', 'en']) assert.ok(locale.format(language, 'error.warning.programsMissing', { programs: 'Codex' }).includes('Codex'));
  const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
  assert.match(renderer, /warningText\(state\.programWarning, state\.programWarningUiMessage\)/, 'The alert line shows it');
});

test('a backend started with entries of its own runs the current programs, and its initial state is resolved again each time', async t => {
  const { ensureServiceAt, connectService } = require('../service-client.cjs');
  const f = fixture(t); searchPath(t, f.bin);
  // A Claude version that is gone, and a program that still exists and must not be the one the backend runs.
  const stale = path.join(f.base, 'versions', 'python3'); fs.writeFileSync(stale, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  f.write(f.own, { claude: path.join(f.base, 'versions', '2.1.312'), codex: f.gone, python3: stale });
  process.env.NAW_RUNTIME_CONFIG = f.shared; t.after(() => { delete process.env.NAW_RUNTIME_CONFIG; });
  // The backend also searches ~/.local/bin: give it a home with nothing installed, so only the fixture's launchers count.
  const home = process.env.HOME; process.env.HOME = path.join(f.base, 'home'); fs.mkdirSync(process.env.HOME); t.after(() => { process.env.HOME = home; });
  let client, pid;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const started = await ensureServiceAt(f.backend, process.execPath, path.join(f.base, 'workspace')); pid = started.servicePid;
    assert.ok(started.capabilities.includes('programAvailabilityV1'));
    assert.deepEqual(started.available, { claude: true, codex: true, python: true }, 'The entries were taken out before the backend started');
    assert.deepEqual(f.read(f.own), {}); assert.deepEqual(f.read(f.record).removals.map(entry => entry.removed.map(item => [item.key, item.existed]).sort()), [[['claude', false], ['codex', false], ['python3', true]]]);
    // While it runs, a program that disappears or comes back is seen at the next initial state, not at the next restart.
    client = await connectService(f.backend, 'availability-check');
    fs.renameSync(f.launchers.codex, f.launchers.codex + '.away');
    const away = (await client.call('initial')).available;
    fs.renameSync(f.launchers.codex + '.away', f.launchers.codex);
    const back = (await client.call('initial')).available;
    // (The conventional install folders are also searched; on a machine with Codex there the first answer stays true.)
    const elsewhere = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex'].some(file => fs.existsSync(file));
    assert.deepEqual([away.codex, back.codex, away.claude], [elsewhere, true, true]);
  } finally {
    // The backend is closed here, before the fixture's folder is removed under it; one that does not close
    // within ten seconds is ended by its own process id, so a failure cannot leave the suite waiting.
    try { client ||= await connectService(f.backend, 'test-cleanup'); await client.call('shutdown'); } catch { /* not started, or already closing */ }
    client?.close();
    for (let i = 0; i < 100 && pid && alive(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (pid && alive()) process.kill(pid, 'SIGKILL');
  }
});
