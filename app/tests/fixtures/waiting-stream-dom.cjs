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
    waitingChanged: items => { observed.push(items.length); status.setWaiting(items); }, cardHidden: () => false, cardTitle: () => '', original() {}, toggleChanged() {}, label: () => '', displayText: x => x });
  const render = () => { status.update(input); stream.render(); };
  render();
  const need = () => f.host.querySelector('.task-status-need'), due = () => f.host.querySelector('.task-status-due');
  const confirmation = () => f.host.querySelector('.task-confirmation-entry');
  return { input, observed, render, dispose: () => status.dispose(),
    advance(ms) { now += ms; status.tick(); },
    // R264 gives confirmations their own count beside the other waiting items.
    count: () => need().hidden ? 0 : Number(/\d+/u.exec(need().textContent)[0]),
    confirmationCount: () => confirmation().hidden ? 0 : Number(/\d+/u.exec(confirmation().textContent)[0]),
    confirmationHidden: () => confirmation().hidden, confirmationLabel: () => confirmation().textContent,
    strip: () => f.doc.getElementById('stream-waiting'),
    deadline: () => due().textContent,
    cardHidden: () => due().hidden,
    label: () => f.host.querySelector('.task-board-toggle').getAttribute('aria-label'),
    hidden: () => need().hidden,
    subs() { status.open(); const subs = f.host.querySelectorAll('.task-board-sub').filter(e => !e.hidden).map(e => e.textContent); status.close(); return subs.sort(); } };
}
module.exports = { scene };
