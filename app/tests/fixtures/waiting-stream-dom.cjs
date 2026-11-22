const fs = require('node:fs'), vm = require('node:vm');
const board = require('../../renderer/task-board.js'), model = require('../../task-stream.js'), locale = require('../../ui-locale.js');
const { fixture } = require('./task-board-dom.cjs');

function scene(language, input) {
  const f = fixture(), proto = Object.getPrototypeOf(f.host);
  proto.before = function (...nodes) { for (const n of nodes) this.parentElement.insertBefore(n, this); };
  if (!Object.getOwnPropertyDescriptor(proto, 'firstChild')) Object.defineProperty(proto, 'firstChild', { get() { return this.children[0]; } });
  if (!Object.getOwnPropertyDescriptor(proto, 'lastChild')) Object.defineProperty(proto, 'lastChild', { get() { return this.children.at(-1); } });
  proto.replaceChild = function (n, old) { this.insertBefore(n, old); old.remove(); };
  f.doc.getElementById = id => [f.doc.body, ...f.doc.body.querySelectorAll('*')].find(n => n.id === id) || null;
  for (const id of ['header', 'header-actions', 'room-layout', 'room-record']) { const e = f.doc.createElement('div'); e.id = id; f.doc.body.append(e); }
  let now = Date.now();
  const status = board.bind({ host: f.host, document: f.doc, text: (k, p) => locale.format(language, k, p), now: () => now });
  const scope = vm.createContext({ nativeWorkspaceTaskStream: model });
  vm.runInContext(fs.readFileSync(require.resolve('../../renderer/disclosure-list.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(require.resolve('../../renderer/activity-stream.js'), 'utf8'), scope);
  const observed = [];
  const stream = scope.nativeWorkspaceActivityStream.bind({ document: f.doc, state: () => ({ sessions: input.sessions, backgroundConfirmations: input.confirmations }),
    rooms: () => input.rooms, roomName: r => r.name || r.id, isMember: (s, id) => s?.roomIds?.includes(id), inRoom: () => true,
    text: (k, p) => locale.format(language, k, p), language: () => language, connected: () => true, attempt: fn => fn(),
    waitingChanged: n => { observed.push(n); status.setWaitingCount(n); }, card() {}, question() {}, toggleChanged() {}, label: () => '', displayText: x => x });
  const render = () => { status.update(input); stream.render(); };
  render();
  return { input, observed, render, dispose: () => status.dispose(),
    advance(ms) { now += ms; status.tick(); },
    // The strip is the one place the needs-you count is shown (11-22); the task bar must not repeat it.
    count: () => { const strip = f.doc.getElementById('stream-waiting'), m = strip.hidden ? null : /(\d+) (?:件等你(?!确认)|waiting for you)/u.exec(strip.getAttribute('aria-label')); return m ? Number(m[1]) : 0; },
    barRepeats: () => Boolean(f.host.querySelector('.task-status-waiting')) || /等你|need you|waiting/u.test(f.host.querySelector('.task-status-chips').textContent),
    deadline: () => f.host.querySelector('.task-status-card-time').textContent,
    cardHidden: () => f.host.querySelector('.task-status-card-time').hidden,
    label: () => f.doc.getElementById('stream-waiting').getAttribute('aria-label'),
    hidden: () => f.doc.getElementById('stream-waiting').hidden };
}
module.exports = { scene };
