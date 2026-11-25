// What a test command left running: a process with no owner any more (its parent is 1) whose environment carries the
// command's own random directory, or whose command does when it is node or Electron (an editor or a tail that a person
// opened there is not the run's); and whatever that process started. Never found by name alone.
const { execFileSync } = require('node:child_process'), path = require('node:path');
const { inside } = require('./test-temp.cjs');
const PROGRAM = /^(?:node|electron)(?:$|[ -])/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// The environment is only searched: it can hold credentials, so nothing of it is kept or printed.
const ps = (...args) => execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 * 1024, env: { LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
function running() {
  const rows = new Map();
  for (const line of ps('-axwwo', 'pid=,ppid=,stat=,lstart=,command=')) {
    const found = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    if (found && !found[3].startsWith('Z')) rows.set(Number(found[1]), { pid: Number(found[1]), parent: Number(found[2]), started: found[4], command: found[5] });
  }
  return rows;
}
// One tree for each process left. `kept`: directories whose own helper decides about their processes (test-scratch.cjs).
function trees(directory, kept) {
  const rows = running(), mark = '/' + path.basename(directory), carrying = new Set(), protectedBy = new Map(), programs = new Map();
  for (const line of ps('-axwwo', 'pid=,ucomm=')) programs.set(parseInt(line, 10), line.replace(/^\s*\d+ /, '').trim());
  for (const line of ps(process.platform === 'darwin' ? '-axEwwo' : '-axwwo', 'pid=,command=')) {
    if (!line.includes(mark)) continue;
    const pid = parseInt(line, 10), text = line.replace(/^\s*\d+ /, ''), command = rows.get(pid)?.command;
    // The environment follows the command. Where a shell stands says nothing about who started the program.
    const env = command && text.startsWith(command) ? text.slice(command.length).replace(/ (?:OLD)?PWD=\S*/g, '') : '';
    if (env.includes(mark) || command?.includes(mark) && PROGRAM.test(programs.get(pid))) carrying.add(pid);
    const by = kept.find(file => line.includes('/' + path.basename(directory) + file.slice(directory.length)));
    if (by) protectedBy.set(pid, by);
  }
  return [...rows.values()].filter(row => row.parent === 1 && carrying.has(row.pid) && row.pid !== process.pid).map(root => {
    const members = [root];
    for (const member of members) for (const row of rows.values()) if (row.parent === member.pid && !members.includes(row)) members.push(row);
    const by = members.map(member => protectedBy.get(member.pid)).find(Boolean);
    return { members, by };
  });
}
// Those still there after graceMs are ended, each only while its PID still has the start time it was found with.
async function endLeft(directory, { kept = [], graceMs = 10000, stopMs = 3000 } = {}) {
  kept = kept.filter(file => inside(directory, file));
  let found = trees(directory, kept);
  for (const end = Date.now() + graceMs; found.some(tree => !tree.by) && Date.now() < end; found = trees(directory, kept)) await delay(200);
  const left = new Map();
  const add = list => { for (const tree of list) if (!tree.by) for (const row of tree.members) left.set(row.pid, row); };
  const alive = () => { const rows = running(); return [...left.values()].filter(row => rows.get(row.pid)?.started === row.started); };
  const signal = name => { for (const row of alive()) try { process.kill(row.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  add(found);
  if (left.size) {
    signal('SIGTERM');
    for (const end = Date.now() + stopMs; alive().length && Date.now() < end;) await delay(100);
    add(trees(directory, kept)); signal('SIGKILL');
    for (const end = Date.now() + stopMs; alive().length && Date.now() < end;) await delay(100);
  }
  const still = new Set(alive().map(row => row.pid));
  return { ended: [...left.values()].filter(row => !still.has(row.pid)), left: [...left.values()].filter(row => still.has(row.pid)),
    protected: found.filter(tree => tree.by).flatMap(tree => tree.members.map(row => ({ ...row, by: tree.by }))) };
}
module.exports = { endLeft };
