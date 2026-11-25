// scripts/fixtures/test-processes.cjs over a made-up process list. Nothing real is read or signalled here, so an edit
// that widens what it ends can be tried in this file alone.
const test = require('node:test'), assert = require('node:assert/strict'), childProcess = require('node:child_process');
const file = require.resolve('../../scripts/fixtures/test-processes.cjs');
const DIRECTORY = '/private/tmp/nt-suite-abc123', FIRST = 'Wed Nov 25 08:00:00 2026', LATER = 'Wed Nov 25 08:00:09 2026';
const row = (pid, program, command, { env = '', parent = 1, started = FIRST, shown = command } = {}) => ({ pid, program, command, env, parent, started, shown });
// list(reads): the processes there are when the table with the start times is read for that time.
function guard(t, list, signalled = () => {}) {
  const kills = []; let reads = 0;
  t.mock.method(childProcess, 'execFileSync', (program, [flags, columns]) => {
    assert.equal(program, '/bin/ps');
    if (columns.includes('lstart')) reads++;
    return list(reads).map(({ pid, parent, started, program: name, command, env, shown }) => columns.includes('lstart') ? `${pid} ${parent} S ${started} ${command}`
      : columns.includes('ucomm') ? `${pid} ${name}` : `${pid} ${shown}${flags.includes('E') && env ? ' ' + env : ''}`).join('\n');
  });
  t.mock.method(process, 'kill', (pid, name) => { kills.push([pid, name]); signalled(pid, name); return true; });
  delete require.cache[file];
  const { endLeft } = require(file);
  delete require.cache[file];
  return { kills, end: () => endLeft(DIRECTORY, { graceMs: 0, stopMs: 0 }) };
}
const node = (pid, extra) => row(pid, 'node', `node ${DIRECTORY}/naw-a/worker.cjs`, extra);
test('a process that stays is signalled twice, while its start time is the one it was found with', async t => {
  const g = guard(t, () => [node(10)]);
  assert.deepEqual((await g.end()).left.map(left => left.pid), [10]);
  assert.deepEqual(g.kills, [[10, 'SIGTERM'], [10, 'SIGKILL']]);
});
test('a PID that another process took before the first signal gets none', async t => {
  const g = guard(t, reads => [reads === 1 ? node(10) : row(10, 'node', 'node of.cjs someone', { started: LATER })]);
  await g.end();
  assert.deepEqual(g.kills, []);
});
test('a PID that another process took after the first signal does not get the second', async t => {
  let taken = false;
  const g = guard(t, () => [taken ? row(10, 'node', 'node of.cjs someone', { started: LATER }) : node(10)], () => { taken = true; });
  await g.end();
  assert.deepEqual(g.kills, [[10, 'SIGTERM']]);
});
for (const [name, counted, process] of [
  ['node, named by its command alone', true, node(10)],
  ['an Electron helper, named by its command alone', true, row(10, 'Electron Helper', `/x/Electron Helper --user-data-dir=${DIRECTORY}/naw-a`)],
  ['another program with the run\'s environment', true, row(10, 'python3.14', 'python3 serve.py', { env: `PATH=/usr/bin TMPDIR=${DIRECTORY} LANG=C` })],
  ['another program named by its command alone', false, row(10, 'tail', `tail -f ${DIRECTORY}/log`)],
  ['an editor opened on the directory', false, row(10, 'Code', `/Applications/Visual Studio Code.app/Contents/MacOS/Code ${DIRECTORY}`)],
  ['an editor opened from a shell that stood there', false, row(10, 'Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Code .', { env: `PWD=${DIRECTORY} OLDPWD=${DIRECTORY}/naw-a SHLVL=1` })],
  ['a program that another one became between two reads', false, row(10, 'tail', 'sh t', { shown: `tail -f ${DIRECTORY}/log` })],
  ['a program whose name only begins like one of them', false, row(10, 'nodestat', `nodestat ${DIRECTORY}/log`)],
  ['node with the directory of another run', false, row(10, 'node', 'node /private/tmp/nt-suite-zzz999/worker.cjs', { env: 'TMPDIR=/private/tmp/nt-suite-zzz999' })],
  ['node whose owner is alive', false, node(10, { parent: 700 })],
]) test(`${name}: ${counted ? 'ended' : 'left alone'}`, async t => {
  const g = guard(t, () => [process]);
  await g.end();
  assert.equal(g.kills.length > 0, counted, JSON.stringify(g.kills));
});
