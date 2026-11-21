const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMobileClient, mount, KEY } = require('../mobile-web/client.js');
const deviceId = '10000000-0000-4000-8000-000000000001', secondDevice = '10000000-0000-4000-8000-000000000002';
function fixture({ stored, disk, failStorage = false, failSend = false, holdSend = false, holdRead = false, receiptUnknown = false, readonly = false } = {}) {
  const values = disk || new Map(stored ? [[KEY, JSON.stringify(stored)]] : []), calls = []; let releaseSend, releaseRead, device = deviceId;
  const storage = { getItem: k => values.get(k) || null, setItem(k, v) { if (failStorage) throw Error('synthetic quota'); values.set(k, v); } };
  const request = async (route, value, csrf) => {
    calls.push({ route, value: structuredClone(value), csrf });
    if (route === '/mobile/session') return { deviceId: device, csrf: 'c'.repeat(43), sessions: [{ id: 'a', actions: readonly ? ['read'] : ['read', 'send', 'answer'] }, { id: 'b', actions: ['read', 'send'] }] };
    if (route === '/mobile/pair') return { paired: true };
    if (route.startsWith('/mobile/read/')) {
      const row = { id: route.split('/').at(-1), contextId: 'x'.repeat(43), canSend: !readonly, question: { questions: [{ id: 'native-choice', header: 'Separate header', question: 'Original?', options: [{ label: 'Choice' }] }] }, messages: [{ text: 'Literal original' }] };
      if (holdRead) await new Promise(resolve => { releaseRead = resolve; }); return row;
    }
    if (route === '/mobile/send' || route === '/mobile/answer') {
      const saved = JSON.parse(values.get(KEY)); assert.equal(saved.pending.at(-1).requestId, value.requestId, 'original pending persisted BEFORE native-bound request');
      if (holdSend) await new Promise(resolve => { releaseSend = resolve; });
      if (typeof failSend === 'string') throw Object.assign(Error('refused'), { code: failSend });
      if (failSend) throw Error('lost acknowledgement');
      return { requestId: value.requestId, sessionId: 'a', action: route.endsWith('send') ? 'send' : 'answer', status: route.endsWith('send') ? 'submitted' : 'reply-written' };
    }
    if (route === '/mobile/receipt') {
      if (receiptUnknown) throw Object.assign(Error('unknown'), { code: 'MOBILE_RECEIPT_UNKNOWN' });
      const original = JSON.parse(values.get(KEY)).pending.find(p => p.requestId === value.requestId);
      return { requestId: value.requestId, sessionId: original.sessionId, action: original.action, status: 'submitted' };
    }
    if (route === '/mobile/logout') return { authorizationRevoked: false, committedWorkMayContinue: true };
    throw Error('unexpected route');
  };
  const client = createMobileClient({ request, storage, newId: randomUUID });
  return { client, calls, values, storage, releaseSend: () => releaseSend(), releaseRead: () => releaseRead(), takeRead: () => releaseRead, failStorage: v => { failStorage = v; }, device: v => { device = v; } };
}
test('pair then selected original read is read-only; draft and request persistence excludes credentials', async () => {
  const f = fixture(); await f.client.start('p'.repeat(43)); await f.client.select('a'); f.client.setDraft('My own phone draft');
  assert.deepEqual(f.calls.map(c => c.route), ['/mobile/pair', '/mobile/session', '/mobile/read/a']);
  await f.client.send(); assert.equal(f.calls.filter(c => c.route === '/mobile/send').length, 1); assert.equal(f.client.state.draft, '');
  const raw = f.values.get(KEY); assert.ok(!raw.includes('c'.repeat(43)) && !raw.includes('x'.repeat(43)) && !raw.includes('p'.repeat(43))); assert.equal(f.client.state.pending[0].status, 'submitted');
});
test('editing while send awaits ACK preserves new text and revision', async () => {
  const f = fixture({ holdSend: true }); await f.client.start(); await f.client.select('a'); f.client.setDraft('Original phone text');
  const pending = f.client.send(); f.client.setDraft('Newer edit'); f.releaseSend(); await pending; assert.equal(f.client.state.draft, 'Newer edit');
  assert.equal(f.calls.find(c => c.route === '/mobile/send').value.text, 'Original phone text');
});
test('switching reading session while send awaits ACK preserves both scoped drafts', async () => {
  const f = fixture({ holdSend: true }); await f.client.start(); await f.client.select('a'); f.client.setDraft('A original');
  const pending = f.client.send(); await f.client.select('b'); f.client.setDraft('B original'); f.releaseSend(); await pending;
  assert.equal(f.client.state.draft, 'B original'); await f.client.select('a'); assert.equal(f.client.state.draft, 'A original');
});
test('lost ACK and reload retain pending, query only original receipt, and never auto-send', async () => {
  const f = fixture({ failSend: true }); await f.client.start(); await f.client.select('a'); f.client.setDraft('One possibly committed input'); await f.client.send();
  assert.equal(f.client.state.pending[0].status, 'unconfirmed'); const requestId = f.client.state.pending[0].requestId;
  const reload = fixture({ disk: f.values }); await reload.client.start(); await reload.client.select('a');
  assert.equal(reload.calls.filter(c => ['/mobile/send', '/mobile/answer', '/mobile/receipt'].includes(c.route)).length, 0);
  await reload.client.receipt(requestId); assert.equal(reload.calls.at(-1).route, '/mobile/receipt'); assert.deepEqual(reload.calls.at(-1).value, { requestId }); assert.equal(reload.client.state.pending[0].status, 'submitted');
});
test('unknown receipt blocks a second send and cannot be dismissed as not-sent', async () => {
  const f = fixture({ failSend: true, receiptUnknown: true }); await f.client.start(); await f.client.select('a'); f.client.setDraft('Retained'); await f.client.send();
  const id = f.client.state.pending[0].requestId; await f.client.receipt(id); assert.equal(f.client.state.pending[0].status, 'unconfirmed'); assert.throws(() => f.client.forget(id));
  await assert.rejects(f.client.send()); assert.equal(f.calls.filter(c => c.route === '/mobile/send').length, 1); assert.equal(f.client.state.draft, 'Retained');
});
test('new pairing cannot query, resend or silently retarget an old device pending input', async () => {
  const f = fixture({ failSend: true }); await f.client.start(); await f.client.select('a'); f.client.setDraft('Old pair input'); await f.client.send();
  const reload = fixture({ disk: f.values }); reload.device(secondDevice); await reload.client.start('p'.repeat(43)); await reload.client.select('a');
  assert.equal(reload.client.state.draft, ''); assert.match(reload.client.state.notice, /旧配对/); await assert.rejects(reload.client.receipt(f.client.state.pending[0].requestId));
  assert.equal(reload.calls.filter(c => ['/mobile/send', '/mobile/answer', '/mobile/receipt'].includes(c.route)).length, 0);
});
test('local persistence failure keeps the human text and prevents a native-bound request', async () => {
  const f = fixture(); await f.client.start(); await f.client.select('a'); f.failStorage(true); assert.equal(f.client.setDraft('Unsaved original'), false);
  await assert.rejects(f.client.send()); assert.equal(f.client.state.draft, 'Unsaved original'); assert.equal(f.calls.filter(c => c.route === '/mobile/send').length, 0);
});
test('answer binds original question keys and reply-written never claims native handling complete', async () => {
  const f = fixture(); await f.client.start(); await f.client.select('a'); await f.client.answer({ 'native-choice': ['Choice'] });
  const call = f.calls.find(c => c.route === '/mobile/answer'); assert.deepEqual(call.value.answers, { 'native-choice': ['Choice'] }); assert.equal(f.client.state.pending[0].status, 'reply-written'); assert.match(f.client.state.notice, /待确认/);
  assert.equal(f.client.state.pending[0].question, 'Original?'); assert.equal(f.client.state.pending[0].answer, 'Choice');
  assert.ok(Number.isSafeInteger(f.client.state.pending[0].createdAt));
});
test('read-only device can read and explicitly log out, but cannot submit ordinary text', async () => {
  const f = fixture({ readonly: true }); await f.client.start(); await f.client.select('a'); f.client.setDraft('Retained only'); await assert.rejects(f.client.send());
  await f.client.logout(); assert.equal(f.client.state.session, null); assert.match(f.client.state.notice, /未获确认/); assert.equal(f.calls.filter(c => c.route === '/mobile/send').length, 0);
});
test('a late original read cannot overwrite another selected session', async () => {
  const f = fixture({ holdRead: true }); await f.client.start(); const first = f.client.select('a'), releaseFirst = f.takeRead();
  const second = f.client.select('b'), releaseSecond = f.takeRead(); releaseSecond(); await second; releaseFirst(); await first;
  assert.equal(f.client.state.row.id, 'b'); assert.equal(f.client.state.selected, 'b');
});
test('text with a native terminal prefix is refused on the phone without a pending row or request', async () => {
  const f = fixture(); await f.client.start(); await f.client.select('a'); const before = f.values.get(KEY);
  // 11-09: also after invisible characters trim() keeps, and in full-width form.
  for (const text of ['!x', ' !x', '\n!x', '#x', '/x', '\u200B!x', '\u2060!x', '\u00AD!x', '\uFEFF#x', '！x', '＃x', '／x', '\u200B\u3000！x', '\u0085!x', '\u009F#x']) {
    f.client.setDraft(text); const saved = f.values.get(KEY); await f.client.send();
    assert.equal(f.client.state.pending.length, 0); assert.equal(f.client.state.draft, text); assert.equal(f.client.state.busy, false);
    assert.match(f.client.state.notice, /不发送以 !、# 或 \/ 开头/); assert.equal(f.values.get(KEY), saved, 'no pending row saved for ' + JSON.stringify(text));
  }
  assert.notEqual(before, f.values.get(KEY)); assert.equal(JSON.parse(f.values.get(KEY)).pending.length, 0);
  assert.equal(f.calls.filter(c => ['/mobile/send', '/mobile/answer', '/mobile/receipt'].includes(c.route)).length, 0);
  f.client.setDraft('ok! #1'); await f.client.send();
  assert.deepEqual(f.calls.filter(c => c.route === '/mobile/send').map(c => c.value.text), ['ok! #1']); assert.equal(f.client.state.pending[0].status, 'submitted');
});
test('malformed or oversized local storage is a visible blocker, not an input retry', async () => {
  const f = fixture({ stored: { version: 0, drafts: [], pending: [] } }); await f.client.start(); await f.client.select('a');
  assert.equal(f.client.state.storageError, true); await assert.rejects(f.client.send()); assert.equal(f.calls.filter(c => c.route === '/mobile/send').length, 0);
});
test('typing cannot overwrite unreadable pending storage and silently unlock sending', async () => {
  const f = fixture({ stored: { version: 0, drafts: [], pending: ['unknown original'] } }); const original = f.values.get(KEY);
  await f.client.start(); await f.client.select('a'); assert.equal(f.client.setDraft('Keep this edit'), false);
  assert.equal(f.values.get(KEY), original); await assert.rejects(f.client.send()); assert.equal(f.client.state.draft, 'Keep this edit');
});

// A bounded DOM contract exercises actual mount/event code. This is not Safari
// or Electron GUI acceptance; no browser, listener or provider is started.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.checked = false; }
  set innerHTML(_) { assert.fail('Native originals must never become HTML'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll(tag) { return this.children.flatMap(c => [c.tag === tag ? [c] : [], c.querySelectorAll(tag)].flat()); }
}
test('the actual phone mount shows the prefix refusal instead of a generic failure', async () => {
  const ids = ['logout', 'notice', 'sessions', 'member-title', 'refresh', 'member-state', 'messages', 'omissions', 'questions', 'compose', 'draft', 'draft-status', 'send', 'receipts'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)])), calls = [], disk = new Map();
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const client = mount(document, { hash: '', pathname: '/mobile/' }, { replaceState() {} },
    { getItem: key => disk.get(key) || null, setItem: (key, value) => disk.set(key, value) }, async (route, options) => {
      calls.push(route); let result;
      if (route === '/mobile/session') result = { deviceId, csrf: 'c'.repeat(43), sessions: [{ id: 'a', name: 'Original member', state: 'idle', actions: ['read', 'send'] }] };
      else if (route === '/mobile/read/a') result = { id: 'a', contextId: 'x'.repeat(43), canSend: true, messages: [], question: null };
      else assert.fail('unexpected route ' + route);
      return { ok: true, json: async () => result };
    }, { randomUUID });
  await client.ready; await client.select('a');
  elements.draft.value = '!echo'; elements.draft.listeners.input(); assert.equal(elements.send.disabled, false);
  elements.compose.listeners.submit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.notice.textContent, /不发送以 !、# 或 \/ 开头/); assert.deepEqual(calls, ['/mobile/session', '/mobile/read/a']);
  assert.equal(client.state.pending.length, 0); assert.equal(elements.draft.value, '!echo');
});
test('the actual phone mount clears the fragment before fetch, renders literal originals and uses native question keys', async () => {
  const ids = ['logout', 'notice', 'sessions', 'member-title', 'refresh', 'member-state', 'messages', 'omissions', 'questions', 'compose', 'draft', 'draft-status', 'send', 'receipts'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)])), calls = [], disk = new Map(); let cleared = false;
  const document = { getElementById: id => { assert.ok(elements[id], 'known static surface ' + id); return elements[id]; }, createElement: tag => new Element(tag) };
  const client = mount(document, { hash: '#pair=' + 'p'.repeat(43), pathname: '/mobile/' }, { replaceState(...args) { assert.deepEqual(args, [null, '', '/mobile/']); cleared = true; } },
    { getItem: key => disk.get(key) || null, setItem: (key, value) => disk.set(key, value) }, async (route, options) => {
      assert.equal(cleared, true); calls.push({ route, options }); assert.equal(options.credentials, 'same-origin'); assert.equal(options.headers['X-NAW-Mobile'], '1');
      let result;
      if (route === '/mobile/pair') result = { paired: true };
      else if (route === '/mobile/session') result = { deviceId, csrf: 'c'.repeat(43), sessions: [{ id: 'a', name: 'Original member', state: 'idle', actions: ['read', 'answer'] }] };
      else if (route === '/mobile/read/a') result = { id: 'a', contextId: 'x'.repeat(43), canSend: false, messages: [{ text: '<script>literal original</script>', kind: 'assistant', status: 'complete' }],
        question: { questions: [{ id: 'original-id', question: 'Original choice?', header: 'Do not use header', options: [{ label: 'Original choice' }] }] } };
      else if (route === '/mobile/answer') { const value = JSON.parse(options.body); assert.deepEqual(value.answers, { 'original-id': ['Original choice'] }); result = { requestId: value.requestId, sessionId: 'a', action: 'answer', status: 'reply-written' }; }
      else assert.fail('unexpected route ' + route);
      return { ok: true, json: async () => result };
    }, { randomUUID });
  await client.ready; await client.select('a');
  const original = elements.messages.children[0].children.find(n => n.className === 'original'); assert.equal(original.textContent, '<script>literal original</script>'); assert.equal(elements.send.disabled, true);
  const form = elements.questions.children[0], input = form.querySelectorAll('input')[0]; input.checked = true;
  form.listeners.submit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(c => c.route === '/mobile/answer').length, 1); assert.equal(client.state.pending[0].status, 'reply-written');
});

test('a queue-card answer keeps the original chat draft and binds its own input before posting', async () => {
  const f = fixture(); await f.client.start(); await f.client.select('a'); f.client.setDraft('Existing unsent chat draft');
  const target = { roomId: 'shared', itemId: 'task', questionId: 'question' };
  const result = await f.client.sendQueueAnswer('Explicit queue answer', target);
  assert.equal(result.status, 'submitted'); assert.equal(f.client.state.draft, 'Existing unsent chat draft');
  const sent = f.calls.find(c => c.route === '/mobile/send');
  assert.deepEqual(sent.value.queueTarget, target); assert.equal(sent.value.text, 'Explicit queue answer');
  assert.deepEqual(JSON.parse(f.values.get(KEY)).pending[0].queueTarget, target);
});

test('capacity refusal keeps draft and settles only this attempt as not sent', async () => {
  const f = fixture({ failSend: 'MOBILE_PAIR_LIMIT' });
  await f.client.start();
  await f.client.select('a');
  f.client.setDraft('Original draft');
  await assert.rejects(f.client.send(), { code: 'MOBILE_PAIR_LIMIT' });
  assert.equal(f.client.state.draft, 'Original draft');
  assert.equal(f.client.state.pending[0].status, 'not-sent');
  const { PAIR_LIMIT } = require('../mobile-web/client.js');
  assert.match(PAIR_LIMIT.zh, /回 Mac 撤销并重新配对/);
  assert.match(PAIR_LIMIT.en, /revoke and pair again on the Mac/);
});

test('700 settled sends can save a new original without a manual receipt cleanup', async () => {
  const f = fixture();
  await f.client.start();
  await f.client.select('a');
  for (let i = 0; i < 700; i++) {
    f.client.setDraft('Synthetic original ' + i);
    assert.equal((await f.client.send()).status, 'submitted');
  }
  assert.equal(f.client.state.pending.length, 16);
  assert.equal(f.calls.filter(call => call.route === '/mobile/send').length, 700);
});
