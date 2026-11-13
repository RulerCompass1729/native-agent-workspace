const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs'), locale = require('../ui-locale.js');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function section(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Production section exists: ' + start);
  return text.slice(a, b);
}
function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-decision-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RoomState(dir), outcomes = [];
  state.onQueueOutcome = value => outcomes.push(value);
  const sent = () => { const id = state.queueAdd('Synthetic task', null); state.queueMarkSent('shared', id, 'member', 'Member', Date.now()); return id; };
  return { state, outcomes, sent, dir };
}
for (const reason of ['', 'send-unconfirmed', 'member-missing', 'record-missing', 'synthetic-send-error', 'not-sent: busy']) {
  test(`persisted outcome callback: ${reason || 'decision'}`, t => {
    const { state, outcomes, sent, dir } = room(t), id = sent(), status = reason ? 'failed' : 'waiting';
    state.queueSettle('shared', id, status, reason, 'Member', '需要你决定：Proceed?');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].eventId, new RoomState(dir).metadata().events.at(-1).id);
    assert.equal(outcomes[0].itemId, id); assert.equal(outcomes[0].status, status);
    assert.equal(outcomes[0].memberId, 'member');
    assert.throws(() => state.queueSettle('shared', id, status, reason, 'Member'));
    assert.equal(outcomes.length, 1);
  });
}
test('ordinary outcomes are silent; callback failure cannot undo the durable outcome', t => {
  const { state, outcomes, sent, dir } = room(t);
  for (const [status, reason] of [['done',''], ['waiting','person-intervened'], ['waiting','no-reply'], ['cancelled','']]) state.queueSettle('shared', sent(), status, reason, 'Member');
  assert.equal(outcomes.length, 0);
  state.onQueueOutcome = () => { throw Error('Synthetic notifier failed'); };
  const id = sent(); state.queueSettle('shared', id, 'waiting', '', 'Member', '需要你决定：Proceed?');
  const persisted = new RoomState(dir);
  assert.equal(persisted.queueFind('shared', id).status, 'waiting');
  assert.equal(persisted.metadata().events.at(-1).uiMessage.key, 'notice.queue.waiting');
});
test('in the space record, only a decision asks the person to decide; the other waiting items are left to look at (11-12)', t => {
  const { state, sent } = room(t);
  for (const reason of ['person-intervened', 'no-reply']) {
    state.queueSettle('shared', sent(), 'waiting', reason, 'Member');
    const event = state.metadata().events.at(-1);
    assert.equal(event.uiMessage.key, 'notice.queue.lookAt', reason);
    assert.equal(event.text, 'Member 做的「Synthetic task」留给你看一眼；它已经可以接下一项');
    assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), '“Synthetic task” from Member is left for you to look at; the member can already take its next item');
    assert.equal(event.butlerSource, undefined, 'nothing for the steward to bring to the person');
  }
  state.queueSettle('shared', sent(), 'waiting', '', 'Member', '需要你决定：Proceed?');
  const decision = state.metadata().events.at(-1);
  assert.equal(decision.uiMessage.key, 'notice.queue.waiting');
  assert.equal(decision.text, 'Member 需要你决定：Synthetic task');
});
test('decision line strips three markers and ANSI, bounds only the first line, and falls back to task', () => {
  for (const marker of ['需要你决定：', '需要你决定:', 'Needs your decision:']) {
    assert.equal(rules.decisionLine(marker + ' Proceed?\nPrivate remainder', 'Task'), 'Proceed?');
    assert.equal(rules.decisionLine(marker + '\nPrivate remainder', 'Task'), 'Task');
  }
  assert.equal(rules.decisionLine('\x1b[32m需要你决定：Proceed?\x1b[0m\nPrivate'), 'Proceed?');
  assert.equal(rules.decisionLine('需要你决定：' + '字'.repeat(70)), '字'.repeat(59) + '…');
});
function harness(language = 'zh') {
  const notices = [], sent = [], callbacks = new Map(); let supported = true, fail = false, activations = 0;
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() { if (fail) throw Error('Synthetic delivery failure'); this.shown = true; }
  }
  const c = { uiReady: true, win: { isDestroyed: () => false, isFocused: () => false, webContents: { send: (...args) => sent.push(args) } } };
  const sandbox = { Notification, butlerIngress: null, showQuestionNotification: require('../butler-question-notification.cjs').showQuestionNotification, queueRules: rules, untouchedDefault: require('../collaboration-spaces.cjs').untouchedDefault,
    queueOutcomeSeen: new Set(), queueOutcomeNotifications: new Map(), pendingReveal: null,
    windows: new Map([[1,c]]), quitting: false, backgroundTest: true, focusOrOpen: () => activations++,
    roomState: { metadata: () => ({ id: 'shared', name: '共同工作' }) }, backgroundOperation: require('../background-operation.cjs'),
    displayText: (key, params) => locale.format(language, key, params), register: (key, fn) => callbacks.set(key, fn) };
  vm.createContext(sandbox);
  vm.runInContext(section(main, 'function notifyBackgroundConfirmation(', '\nfunction bindClient(') + '\n' + section(main, "register('uiReady',", '\n  register('), sandbox);
  return { sandbox, c, notices, sent, ready: () => callbacks.get('uiReady')(c), fire: value => sandbox.notifyQueueOutcome({ roomId:'shared', eventId:'event', status:'waiting', reason:'', memberName:'Member', task:'Task', reply:'需要你决定：Proceed?', ...value }),
    set supported(v) { supported=v; }, set fail(v) { fail=v; }, get activations() { return activations; } };
}
for (const language of ['zh','en']) test(`actual notifier localizes, deduplicates and navigates: ${language}`, () => {
  const h=harness(language); h.fire(); h.fire(); assert.equal(h.notices.length,1);
  assert.equal(h.notices[0].options.title, language==='zh'?'NAW · 需要你决定':'NAW · Needs your decision');
  assert.equal(h.notices[0].options.body, language==='zh'?'Member · 共同工作：Proceed?':'Member · Shared work: Proceed?');
  h.notices[0].emit('click'); assert.equal(h.activations,1);
  assert.equal(JSON.stringify(h.sent), JSON.stringify([['workspace:reveal-record',{roomId:'shared',eventId:'event'}]]));
  assert.equal(h.sandbox.queueOutcomeNotifications.size,0);
  h.fire({eventId:'failure',status:'failed',reason:'member-missing'});
  assert.equal(h.notices[1].options.title,language==='zh'?'NAW · 派活没有完成':'NAW · Task not delivered');
  assert.equal(h.notices[1].options.body,language==='zh'?'Task → Member · 共同工作；不会自动重发':'Task → Member · Shared work; not resent automatically');
});
test('unsupported or failing notification never retries; active and remembered sets are bounded', () => {
  for (const fail of [false,true]) { const h=harness(); h.supported=fail;h.fail=fail;h.fire();h.fire();assert.equal(h.notices.length,fail?1:0);assert.equal(h.sandbox.queueOutcomeNotifications.size,0); }
  const h=harness(); for(let i=0;i<205;i++) h.fire({eventId:String(i)});
  assert.equal(h.sandbox.queueOutcomeSeen.size,200);assert.equal(h.sandbox.queueOutcomeNotifications.size,50);
  assert.ok(!h.sandbox.queueOutcomeNotifications.has('0'));
  h.notices.at(-1).emit('close');assert.equal(h.sandbox.queueOutcomeNotifications.size,49);
});
test('click waits for an actual workspace renderer; latest click wins, background context cannot consume', () => {
  const h=harness();h.c.uiReady=false;h.fire();h.notices[0].emit('click');assert.equal(h.sent.length,0);
  h.fire({eventId:'latest'});h.notices[1].emit('click');h.c.background=true;h.ready();assert.equal(h.sent.length,0);
  h.c.background=false;h.ready();h.ready();assert.equal(h.sent.length,1);assert.equal(h.sent[0][1].eventId,'latest');
  h.sandbox.quitting=true;h.fire({eventId:'quit'});h.notices.at(-1).emit('click');assert.equal(h.sent.length,1);
});
test('closed and timed-out loading windows discard a pending reveal', async () => {
  const h=harness();h.c.uiReady=false;h.fire();h.notices[0].emit('click');
  // Execute the actual cleanup called by openWindow's close and failure paths.
  h.sandbox.discardReveal(h.c);h.ready();assert.equal(h.sent.length,0);
  assert.match(main,/win\.on\('closed', \(\) => \{\s*discardReveal\(context\)/);
  assert.match(main,/catch \(error\) \{ discardReveal\(context\); if \(quitting/);
});
test('record navigation validates before changing views, including archived and missing records', async () => {
  const source=fs.readFileSync(require.resolve('../renderer/search-view.js'),'utf8');
  const calls=[],nodes=new Map(), $=id=>{if(!nodes.has(id))nodes.set(id,{value:'draft'});return nodes.get(id);};
  let current={events:[{id:'event'}],messages:[{id:'message'}]};
  const c={spaceRecord:()=>current,toast:x=>calls.push(x),uiText:x=>x,$,
    selectSpace:async id=>calls.push(id),selectRoom:async()=>{},roomReadingKey:()=>'',pointToMessage:(_el,_key,id)=>calls.push(id)};
  vm.createContext(c);vm.runInContext(section(source,'async function showRoomRecord(', '\nasync function returnToReading('),c);
  for(const [room,id] of [[null,'event'],[{archived:true,events:[{id:'event'}]},'event'],[current,'missing'],[current,42]]){
    current=room;calls.length=0;assert.equal(await c.showRoomRecord('shared',id),false);assert.deepEqual(calls,['search.sharedRemoved']);
  }
  current={events:[{id:'event'}],messages:[]};calls.length=0;await c.showRoomRecord('shared','event');assert.deepEqual(calls,['shared','event']);
});
for (const language of ['zh', 'en']) test(`background confirmation uses B1 one-shot notification and exact session target: ${language}`, () => {
  const h = harness(language), record = { id: 'operation', actor: { id: 'agent', nativeId: 'native-agent', name: 'Agent' }, command: { method: 'openLocalFile', arguments: [], paths: ['/synthetic/PRIVATE'] } };
  h.sandbox.notifyBackgroundConfirmation(record); h.sandbox.notifyBackgroundConfirmation(record);
  assert.equal(h.notices.length, 1); assert.ok(!JSON.stringify(h.notices[0].options).includes('PRIVATE'));
  assert.equal(h.notices[0].options.body, language === 'zh' ? 'Agent 请求读取本机文件，等你确认' : 'Agent requests Read a local file; waiting for your confirmation');
  h.c.uiReady = false; h.notices[0].emit('click'); assert.equal(h.sent.length, 0);
  h.ready(); assert.equal(h.sent.length, 1);
  assert.equal(JSON.stringify(h.sent[0][1]), JSON.stringify({ sessionId: 'agent', nativeId: 'native-agent', messageId: 'background:native-agent:operation' }));
});
test('background notification renders format characters visibly in the actor name', () => {
  const h = harness(), record = { id: 'operation', actor: { id: 'agent', nativeId: 'native', name: 'Agent\u202e\u200b\u2028' }, command: { method: 'input', arguments: ['target', 'not a notification payload'] } };
  h.sandbox.notifyBackgroundConfirmation(record);
  const body = h.notices[0].options.body;
  assert.equal(/[\p{Cf}\p{Zl}\p{Zp}]/u.test(body), false); assert.match(body, /Agent\\u202e\\u200b\\u2028/);
  assert.equal(body.includes('not a notification payload'), false);
});
test('session confirmation navigation rejects stale identities or handled requests before changing views', async () => {
  const source = fs.readFileSync(require.resolve('../renderer/search-view.js'), 'utf8'), calls = [];
  const row = { id: 'message', backgroundOperation: { state: 'confirmation-required' } }, record = { id: 'agent', nativeId: 'native-agent', messages: [row] };
  const c = { state: { sessions: [record] }, toast: m => calls.push(m), uiText: k => k, $: () => ({}), ensureMessages: () => null,
    select: async (...args) => calls.push(args), pointToMessage: (_el, key, id) => { calls.push([key, id]); return true; } };
  vm.createContext(c); vm.runInContext(section(source, 'async function showBackgroundConfirmation(', '\nasync function showRoomRecord('), c);
  const target = { sessionId: 'agent', nativeId: 'native-agent', messageId: 'message' };
  assert.equal(await c.showBackgroundConfirmation({ ...target, nativeId: 'new-native' }), false); assert.deepEqual(calls, ['search.changed']);
  calls.length = 0; assert.equal(await c.showBackgroundConfirmation(target), true); assert.deepEqual(calls, [['agent', 'chat'], ['agent', 'message']]);
  calls.length = 0; row.backgroundOperation.state = 'complete'; assert.equal(await c.showBackgroundConfirmation(target), false); assert.deepEqual(calls, ['search.changed']);
  // A session this page does not show comes without messages: they are fetched first (shown-sessions.cjs).
  row.backgroundOperation.state = 'confirmation-required';
  const omitted = { id: 'agent', nativeId: 'native-agent', messages: [], messagesOmitted: true, messageSummary: {} };
  c.state.sessions = [omitted]; c.ensureMessages = ids => { calls.push(['ensure', ...ids]); return Promise.resolve().then(() => { c.state.sessions = [record]; }); };
  calls.length = 0; assert.equal(await c.showBackgroundConfirmation(target), true); assert.deepEqual(calls, [['ensure', 'agent'], ['agent', 'chat'], ['agent', 'message']]);
  c.state.sessions = [omitted]; c.ensureMessages = () => Promise.resolve();
  calls.length = 0; assert.equal(await c.showBackgroundConfirmation(target), false); assert.deepEqual(calls, ['search.changed']);
});
test('a durable control audit never waits for a window broadcast to finish', t => {
  const { state } = room(t), record = { id: 'restore', actor: { id: 'agent', nativeId: 'native', name: 'Agent', provider: 'codex' },
    command: { method: 'restoreSession', arguments: ['target'] }, state: 'confirmation-required' };
  let broadcasts = 0;
  const c = { roomState: state, broadcastRoom: () => { broadcasts++; return new Promise(() => {}); } };
  vm.createContext(c); vm.runInContext(section(main, 'function auditBackgroundOperation(', '\nfunction notifyBackgroundConfirmation('), c);
  assert.equal(c.auditBackgroundOperation(record), undefined); assert.equal(broadcasts, 1);
  assert.equal(state.value.events.at(-1).controlAudit.state, 'confirmation-required');
});
test('a missing member uses its recorded name, never a local session ID', () => {
  const h=harness();h.sandbox.roomState.metadata=()=>({name:'Space',events:[{sessionId:'local-private-id',uiMessage:{key:'notice.queue.dispatched',params:{name:'Former member'}}}]});
  h.fire({status:'failed',memberId:'local-private-id',memberName:'local-private-id'});
  assert.ok(h.notices[0].options.body.includes('Former member'));assert.ok(!h.notices[0].options.body.includes('local-private-id'));
});
for (const closed of [false,true]) test(`actual loading window ${closed?'closes':'times out'} without replaying a click`, async () => {
  const h=harness(), timers=[], win=new EventEmitter();let destroyed=false;
  Object.assign(win,{isDestroyed:()=>destroyed,loadURL:async()=>{},getBounds:()=>({})});
  win.webContents=new EventEmitter();Object.assign(win.webContents,{id:9,setWindowOpenHandler(){},send(){}});
  Object.assign(h.sandbox,{windows:new Map(),views:[],connect:async()=>({close(){}}),dataDir:'synthetic',
    startupWindow:null,createWindow:()=>win,backups(){},saveViews(){},bindClient(){},
    setTimeout:fn=>{timers.push(fn);return 1;},clearTimeout(){},entry:'synthetic',displayLanguage:()=>'zh',startupMessage:e=>e.message});
  vm.runInContext(section(main,'async function openWindow(', '\nfunction hasSavedSpaceDraft('),h.sandbox);
  const opening=h.sandbox.openWindow({owner:'synthetic'});
  await new Promise(resolve=>setImmediate(resolve));h.fire();h.notices[0].emit('click');
  assert.ok(h.sandbox.pendingReveal);
  if(closed){destroyed=true;win.emit('closed');}
  timers[0]();
  if(closed) await opening;else await assert.rejects(opening,/UI did not become ready/);
  assert.equal(h.sandbox.pendingReveal,null);
});
test('recorded fallback also rejects a session ID', () => {
  const h=harness();h.sandbox.roomState.metadata=()=>({name:'Space',events:[{sessionId:'internal-id',uiMessage:{key:'notice.queue.dispatched',params:{name:'internal-id'}}}]});
  h.fire({status:'failed',memberId:'internal-id',memberName:'internal-id'});
  assert.ok(!h.notices[0].options.body.includes('internal-id'));
});
test('all line separators keep the rest of the reply out of notifications', () => {
  for(const newline of ['\r','\r\n','\n','\u2028','\u2029']) assert.equal(rules.decisionLine('Needs your decision: Proceed?'+newline+'Private remainder'), 'Proceed?');
});
test('a missing pre-flattened question safely falls back to the task', t => {
  const {state,sent,outcomes}=room(t);state.queueSettle('shared',sent(),'waiting','','Member','Needs your decision: Proceed? Private remainder');
  assert.equal(outcomes[0].question,'Synthetic task');
});
test('reveal foregrounds the same ready workspace it targets, even if another window is loading', () => {
  const h=harness(), calls=[];h.sandbox.backgroundTest=false;
  Object.assign(h.c.win,{isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')});
  h.sandbox.windows=new Map([[0,{uiReady:false,win:{isDestroyed:()=>false}}],[1,h.c]]);
  h.fire();h.notices[0].emit('click');assert.deepEqual(calls,['restore','show','focus']);assert.equal(h.sent.length,1);
});
