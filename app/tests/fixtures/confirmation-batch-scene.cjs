const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), vm = require('node:vm');
const { BackgroundControl } = require('../../background-control.cjs'), locale = require('../../ui-locale.js');
const actor = { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Agent' };
const identity = { nativeId: 'native', sessionId: 'native-session', turnId: 'turn', callId: 'call' };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(failB = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-batch-recovery-'));
  let release, revision = 0;
  const hold = new Promise(resolve => { release = resolve; }), entered = [], effects = [];
  const sessions = [{ ...actor, state: 'idle', roomIds: [] }, ...['A', 'B', 'C'].map(id => ({
    id, nativeId: 'native-' + id, name: 'Target ' + id, provider: 'codex', state: 'idle', roomIds: [],
    terminalState: { alive: true, epoch: 'epoch-' + id, observationIndex: 1 },
  }))];
  const c = { background: true, view: { selected: actor.id, draft: '' }, confirmationActors: () => [actor],
    checkActor: async () => {}, client: { snapshot: () => ({ sessions }), close() {} }, win: { destroy() {} },
    fingerprint: command => ({ target: command.arguments[0], revision }) };
  const control = new BackgroundControl({ dataDir: dir, context: async () => c,
    handlers: new Map([['archiveSession', async (_context, id) => {
      entered.push(id); if (id === 'A') await hold;
      effects.push(id);
      if (id === 'B' && failB) throw Error('Synthetic archive side effect happened; receipt not confirmed');
    }], ['input', async (_context, id, text) => {
      entered.push(id); if (id === 'A') await hold;
      effects.push(id + ':' + text);
    }]]),
    confirmation: (_actor, args) => args.method === 'input'
      ? { message: 'Input?', detail: JSON.stringify({ method: 'input', arguments: args.arguments }, null, 2), buttons: ['Cancel', 'Confirm'], cancelId: 0 }
      : { message: 'Archive?', buttons: ['Cancel', 'Archive'], cancelId: 0 },
    audit: () => {}, confirmationFingerprint: row => c.fingerprint(row.command),
  });
  const ask = async id => assert.equal((await control.call({ sender: actor, identity, valid: () => true }, {
    action: 'invoke', operation_id: id, method: 'archiveSession', arguments: [id],
  })).state, 'confirmation-required');
  const askInput = async (id, target, text) => assert.equal((await control.call({ sender: actor, identity, valid: () => true }, {
    action: 'invoke', operation_id: id, method: 'input', arguments: [target, text],
  })).state, 'confirmation-required');
  return { control, c, entered, effects, release, ask, askInput, bump: () => { revision++; },
    cards: () => control.confirmations({ sessions, rooms: [] }),
    async cleanup() { release(); await control.close(); fs.rmSync(dir, { recursive: true }); },
  };
}
class Element {
  constructor(tag, text = '', cls = '') {
    this.tag = tag; this.own = text ?? ''; this.children = []; this.dataset = {}; this.className = cls;
    this.classList = { add() {}, toggle() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  set textContent(value) { this.own = String(value ?? ''); this.children = []; }
  get textContent() { return [this.own, ...this.children.map(c => typeof c === 'string' ? c : c.textContent)].filter(Boolean).join(' '); }
  querySelectorAll() { return []; }
  remove() {} setAttribute() {} addEventListener() {}
}
function render(cards, started) {
  const text = (key, params) => locale.format('zh', key, params), node = (tag, value, cls) => new Element(tag, value, cls);
  const sandbox = vm.createContext({ console, state: { backgroundConfirmations: cards }, disconnected: false, render() {}, node,
    uiNode: (tag, key, params, cls) => node(tag, text(key, params), cls), uiText: text,
    backgroundStates: ['running', 'complete', 'unconfirmed', 'cancelled', 'not-executed'],
    backgroundSummaryText: summary => summary.target || summary.method,
    backgroundActionText: summary => text('background.action.' + summary.action), backgroundButtonKeys: () => null,
    backgroundClock: () => '', backgroundRemaining() {}, scheduleBackgroundExpiryClock() {}, api: {}, toastError() {},
    ui: { display: { computed: (el, _property, fn) => { el.textContent = fn(); },
      text: (el, key, params) => { el.textContent = text(key, params); }, attribute() {}, unbind() {} } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../renderer/confirmation-batch.js'), 'utf8'), sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  vm.runInContext(source.match(/function providerName\([\s\S]*?\n}/)[0], sandbox);
  const start = source.indexOf('const confirmationBatchStarted ='), end = source.indexOf('\nfunction renderOperatorControls(', start);
  vm.runInContext(source.slice(start, end), sandbox);
  if (started) {
    sandbox.keys = cards.map(card => card.key);
    vm.runInContext("confirmationBatchStarted.set('agent\\nnative\\narchiveSession',{key:'agent\\nnative\\narchiveSession',keys});", sandbox);
  }
  const entry = { item: node('div'), actions: { before() {} } };
  sandbox.entry = entry; sandbox.message = cards[0].message;
  vm.runInContext('renderBackgroundControls(entry,message)', sandbox);
  return { shown: entry.backgroundControls.textContent, itemState: sandbox.nativeWorkspaceConfirmationBatch.itemState(cards.at(-1)), sandbox };
}
module.exports = { actor, tick, fixture, render };
