const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../renderer/butler-review.js');
const locale = require('../ui-locale.js');

// Minimal DOM operations only. All decisions, row grouping and asynchronous
// lifecycle behavior under test come from the production component.
class Element {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = [];
    this._text = ''; this.className = ''; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.hidden = false; this.open = false; this.disabled = false;
    this.checked = false; this.scrollTop = 0;
    this.classList = {
      add: name => this.classList.toggle(name, true),
      toggle: (name, force) => { const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const add = force === undefined ? !names.has(name) : force;
        if (add) names.add(name); else names.delete(name); this.className = [...names].join(' '); return add; },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type) { return Promise.all([...(this.listeners.get(type) || [])].map(callback => callback({ target: this, preventDefault() {} }))); }
  click() { return this.disabled ? Promise.resolve() : this.dispatch('click'); }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatch('close'); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolledIntoView = true; }
}
class Document {
  constructor() { this.roots = []; this.activeElement = null; }
  createElement(tag) { return new Element(this, tag); }
  getElementById(id) { return this.roots.flatMap(walk).find(el => el.id === id) || null; }
}
const walk = element => [element, ...element.children.flatMap(walk)];
const byClass = (element, name) => walk(element).filter(el => el.className.split(/\s+/).includes(name));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const suggestion = (id, suggestionId, patch = {}) => ({ id, suggestionId, kind: 'queue', suspended: false, assessable: true, text: 'Proposal ' + id, sources: [{ sourceRef: 'task:sample', eventId: 'event-' + id, payload: { title: 'Original request', text: 'Keep this source.' } }], ...patch });
function snapshot(patch = {}) {
  return { token: 'frozen-one', synthetic: false, sampleKind: patch.synthetic ? 'synthetic' : 'real', confirmation: null,
    repeatedQuestionsToPerson: { complete: true, count: 0 }, blockedRepeatQuestionCandidates: 1, failed: [],
    rows: [suggestion('queue-first', 'queue'), suggestion('report', 'report', { kind: 'report' }),
      suggestion('question-first', 'question', { kind: 'question' }),
      suggestion('paused', null, { suspended: true, candidateId: 'candidate-one', reason: 'ERR_BUTLER_AMBIGUOUS_SPACE' }),
      suggestion('question-repeat', 'question', { kind: 'question' }), suggestion('queue-repeat', 'queue'),
      suggestion('unknown', null, { suspended: true, candidateId: 'candidate-two', assessable: false, text: null, sources: [] })], ...patch };
}
function saved(view, draft) { const revision = (view.confirmation?.revision || 0) + 1; return { ...structuredClone(view), token: view.token + ':revision:' + revision, confirmation: { allRead: true, marks: [...draft.marks], revision } }; }
function fixture({ data = snapshot(), read, confirm, readNew, language = 'zh', railEntry = false, withEntry = true } = {}) {
  let stored = structuredClone(data); const versions = new Map([[stored.token, stored]]);
  const loader = async callback => { const value = await (callback ? callback() : stored); if (value) versions.set(value.token, structuredClone(value)); return value; };
  const saver = confirm || (async draft => { stored = saved(versions.get(draft.token), draft); versions.set(stored.token, stored); return stored; });
  const document = new Document(), entry = withEntry ? document.createElement('button') : null, dialog = document.createElement('dialog');
  dialog.id = 'review-fixture'; document.roots = entry ? [entry, dialog] : [dialog];
  if (railEntry && entry) { const icon = document.createElement('span'), label = document.createElement('span'); icon.className = 'rail-icon'; icon.textContent = '◎'; label.className = 'rail-label'; entry.append(icon, label); entry.querySelector = selector => selector === '.rail-label' ? label : null; }
  const calls = [], component = create({ entry, dialog, read: () => loader(read), readNew: readNew ? () => loader(readNew) : undefined,
    confirm: draft => { calls.push(draft); return saver(draft); },
    text: (key, params) => locale.format(language, key, params), language: () => language });
  const one = name => { const values = byClass(dialog, name); assert.equal(values.length, 1, name); return values[0]; };
  const row = id => byClass(dialog, 'record').find(el => el.dataset.rowId === id);
  const input = id => walk(row(id)).find(el => el.tagName === 'INPUT');
  const check = async (el, checked) => { el.checked = checked; await el.dispatch('change'); };
  return { component, document, entry, dialog, calls, one, row, input, check,
    setLanguage(value) { language = value; component.refresh(); },
    attest: () => walk(one('attest')).find(el => el.tagName === 'INPUT'), accept: () => one('primary'),
    readings: () => one('acceptance'), message: key => locale.format(language, 'butlerReview.' + key) };
}
async function attest(f) { await f.check(f.attest(), true); }
async function confirmAll(f) { await attest(f); await f.accept().click(); }

test('owned incomplete-measurement reasons repaint locally while marks and saved revision remain unchanged', async () => {
  const key = 'questionMetricUnknown', count = 1;
  const f = fixture({ language: 'zh', data: snapshot({ repeatedQuestionsToPerson: { complete: false, count: null,
    reason: locale.format('zh', 'butlerReview.' + key, { count }), reasonParts: [{ key, params: { count } }] } }) });
  await f.component.open(); await f.check(f.input('queue-first'), true); await confirmAll(f);
  const before = f.calls.length;
  f.setLanguage('en');
  assert.ok(f.readings().textContent.includes(locale.format('en', 'butlerReview.' + key, { count })));
  assert.ok(!f.readings().textContent.includes(locale.format('zh', 'butlerReview.' + key, { count })));
  assert.equal(f.input('queue-first').checked, true); assert.equal(f.calls.length, before);
  assert.ok(f.one('receipt').textContent.includes('revision 1'));
});

test('entry starts hidden and no data opens no review', async () => {
  const f = fixture({ data: snapshot({ rows: [] }) }); assert.equal(f.entry.hidden, true);
  f.component.available(true); assert.equal(f.entry.hidden, false);
  await f.component.open(); assert.equal(f.dialog.open, false); assert.equal(f.entry.hidden, true);
  assert.equal(f.component.stats().denominator, 0);
});

test('opening or attesting alone never creates agreement', async () => {
  const f = fixture(); await f.component.open();
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.readings().hidden, true); assert.equal(f.accept().disabled, true);
  await attest(f); assert.equal(f.component.stats().agreed, 0); assert.equal(f.accept().disabled, false);
  assert.equal(f.calls.length, 0);
});

test('reopening the same frozen token preserves disagreement without inventing agreement', async () => {
  let reads = 0;
  const f = fixture({ read: async () => { reads++; return snapshot(); } });
  await f.component.open(); await f.check(f.input('queue-first'), true);
  f.dialog.close(); await f.component.open();
  assert.equal(reads, 2); assert.equal(f.input('queue-first').checked, true); assert.equal(f.input('queue-repeat').checked, true);
  assert.equal(f.component.stats().disagreed, 0); assert.equal(f.component.stats().markedSuggestions, 1); assert.equal(f.component.stats().agreed, 0); assert.equal(f.calls.length, 0);
});

test('reopening the same confirmed token retains the accepted review without a second host write', async () => {
  const f = fixture(); await f.component.open(); await f.check(f.input('queue-first'), true); await confirmAll(f);
  assert.equal(f.component.stats().agreed, 2); assert.equal(f.calls.length, 1);
  f.dialog.close(); await f.component.open();
  assert.equal(f.component.stats().agreed, 2); assert.equal(f.component.stats().disagreed, 1);
  assert.equal(f.input('queue-first').checked, true); assert.equal(f.input('queue-repeat').checked, true);
  assert.equal(f.attest().checked, true); assert.equal(f.accept().disabled, true); assert.equal(f.readings().hidden, false);
  assert.equal(f.calls.length, 1);
});

test('a different frozen token resets prior marks, attestation and confirmation', async () => {
  let reads = 0;
  const f = fixture({ read: async () => snapshot({ token: ++reads === 1 ? 'first' : 'second' }) });
  await f.component.open(); await f.check(f.input('queue-first'), true); await confirmAll(f);
  f.dialog.close(); await f.component.open();
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.component.stats().disagreed, 0);
  assert.equal(f.input('queue-first').checked, false); assert.equal(f.input('queue-repeat').checked, false);
  assert.equal(f.attest().checked, false); assert.equal(f.accept().disabled, true); assert.equal(f.readings().hidden, true);
});

test('duplicate disagreement synchronizes both directions without replacing controls or focused input', async () => {
  const f = fixture(); await f.component.open(); const first = f.input('queue-first'), repeat = f.input('queue-repeat'); first.focus();
  await f.check(first, true); assert.equal(repeat.checked, true); assert.equal(f.component.stats().disagreed, 0); assert.equal(f.component.stats().markedSuggestions, 1);
  assert.equal(f.input('queue-first'), first); assert.equal(f.input('queue-repeat'), repeat); assert.equal(f.document.activeElement, first);
  await f.check(repeat, false); assert.equal(first.checked, false); assert.equal(f.component.stats().disagreed, 0);
  assert.equal(f.input('queue-first'), first); assert.equal(f.input('queue-repeat'), repeat);
  await f.check(repeat, true); assert.equal(first.checked, true); assert.equal(f.component.stats().pendingOccurrences, 5);
});

test('each disagreement checkbox describes its own complete proposal rather than only the generic label', async () => {
  const data = snapshot(); data.rows[0].text = 'Retain the complete <proposal> & its original words.';
  const f = fixture({ data }); await f.component.open(); const descriptions = new Set();
  for (const row of data.rows) {
    const input = f.input(row.id), id = input.attributes.get('aria-describedby');
    assert.ok(id, 'Each checkbox must reference its row proposal');
    assert.ok(!descriptions.has(id), 'Different occurrences need their own proposal description'); descriptions.add(id);
    const proposal = f.document.getElementById(id);
    assert.equal(proposal, byClass(f.row(row.id), 'proposal')[0]);
    assert.equal(proposal.textContent, row.text || f.message('redacted'));
  }
  const first = f.input('queue-first'), originalDescription = f.document.getElementById(first.attributes.get('aria-describedby'));
  await f.check(f.input('queue-repeat'), true);
  assert.equal(f.document.getElementById(first.attributes.get('aria-describedby')), originalDescription);
});

test('only a verified host confirmation VM permits agreement; payload carries one mark per suggestion', async () => {
  const reply = deferred(), f = fixture({ confirm: () => reply.promise }); await f.component.open();
  await f.check(f.input('queue-first'), true); await attest(f); const save = f.accept().click();
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.accept().disabled, true); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { token: 'frozen-one', marks: ['suggestion:queue'], allRead: true });
  reply.resolve(saved(snapshot(), f.calls[0])); await save;
  assert.equal(f.component.stats().agreed, 2); assert.equal(f.component.stats().denominator, 3); assert.equal(f.readings().hidden, false);
  assert.match(f.readings().textContent, /2 \/ 3/);
});

for (const outcome of ['false', 'reject']) test(`host confirmation ${outcome} never becomes agreement`, async () => {
  const f = fixture({ confirm: async () => { if (outcome === 'reject') throw Error('Host refused'); return false; } });
  await f.component.open(); await confirmAll(f);
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.readings().hidden, true);
  assert.equal(f.one('review-error').hidden, false); assert.equal(f.one('review-error').textContent, outcome === 'reject' ? 'Host refused' : f.message('confirmFailed'));
  assert.equal(f.accept().disabled, false);
});

test('a paused assessable row says agreement is excluded rather than included', async () => {
  const f = fixture(); await f.component.open(); await confirmAll(f);
  assert.equal(byClass(f.row('paused'), 'judgment')[0].textContent, f.message('pausedAgree'));
  assert.equal(byClass(f.row('unknown'), 'judgment')[0].textContent, f.message('unable'));
  assert.equal(f.component.stats().suspended, 2); assert.equal(f.component.stats().denominator, 3);
});

test('closing and reopening invalidates a late read from the previous opening', async () => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const f = fixture({ read: () => ++calls === 1 ? old.promise : fresh.promise });
  const earlier = f.component.open(); f.dialog.close(); const later = f.component.open();
  fresh.resolve(snapshot({ token: 'frozen-new', rows: [suggestion('new', 'new')] })); await later;
  old.resolve(snapshot()); await earlier;
  assert.equal(f.dialog.open, true); assert.equal(f.component.stats().total, 1); assert.ok(f.row('new')); assert.equal(f.row('queue-first'), undefined);
  await confirmAll(f); assert.equal(f.calls[0].token, 'frozen-new'); assert.equal(f.component.stats().agreed, 1);
});

test('a late old confirmation cannot confirm or show an error on a new opening', async () => {
  const old = deferred(); let reads = 0;
  const f = fixture({ read: async () => ++reads === 1 ? snapshot() : snapshot({ token: 'new', rows: [suggestion('new', 'new')] }), confirm: () => old.promise });
  await f.component.open(); await attest(f); const previousSave = f.accept().click(); f.dialog.close(); await f.component.open();
  old.resolve(true); await previousSave;
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.readings().hidden, true); assert.equal(f.component.stats().total, 1);
  assert.equal(f.attest().checked, false); assert.equal(f.one('review-error').hidden, true);
});

for (const outcome of ['false', 'reject']) test(`late ${outcome} from an old confirmation leaves the next review untouched`, async () => {
  const old = deferred(); let reads = 0;
  const f = fixture({ read: async () => ++reads === 1 ? snapshot() : snapshot({ token: 'new', rows: [suggestion('new', 'new')] }), confirm: () => old.promise });
  await f.component.open(); await attest(f); const previousSave = f.accept().click(); f.dialog.close(); await f.component.open();
  if (outcome === 'reject') old.reject(Error('Old confirmation failed')); else old.resolve(false);
  await previousSave;
  assert.equal(f.component.stats().total, 1); assert.equal(f.component.stats().agreed, 0);
  assert.equal(f.one('review-error').hidden, true); assert.equal(f.attest().checked, false);
});

for (const language of ['zh', 'en']) {
  test(`${language} replaces pure internal codes or absent details with a readable explanation`, async () => {
    for (const [value, blockedReasonKey] of [
      ['ERR_BUTLER_COUNTER_UNAVAILABLE', 'reasonUnavailable'], ['BUTLER_RECORDS_MISSING', 'reasonUnavailable'],
      [undefined, 'blockedMissingReason'], [null, 'blockedMissingReason'], ['', 'blockedMissingReason'],
    ]) {
      const f = fixture({ language, data: snapshot({ blockedRepeatQuestionCandidates: null,
        blockedRepeatQuestionCandidatesReason: value, failed: [{ failure: value }] }) });
      await f.component.open();
      const fallback = f.message('reasonUnavailable'), failureText = f.one('batch-failure').textContent;
      assert.ok(failureText.includes(fallback), 'Failed batch needs a readable fallback');
      assert.ok(!failureText.includes('ERR_BUTLER_COUNTER_UNAVAILABLE')); assert.ok(!failureText.includes('BUTLER_RECORDS_MISSING'));
      await confirmAll(f);
      const prefix = language === 'zh' ? '被拦下的重复提问候选' : 'Blocked repeat-question candidates';
      const line = walk(f.readings()).find(el => el.tagName === 'P' && el.textContent.startsWith(prefix));
      assert.ok(line); assert.ok(line.textContent.includes(f.message(blockedReasonKey)));
      assert.ok(!line.textContent.includes('ERR_BUTLER_COUNTER_UNAVAILABLE')); assert.ok(!line.textContent.includes('BUTLER_RECORDS_MISSING'));
    }
  });
  test(`${language} preserves ordinary detail text including an inline diagnostic reference`, async () => {
    const detail = language === 'zh' ? '此前记录缺了一段；请核对包含 ERR_BUTLER_COUNTER_UNAVAILABLE 的原始说明。' : 'Earlier records are missing; inspect the note containing ERR_BUTLER_COUNTER_UNAVAILABLE.';
    const f = fixture({ language, data: snapshot({ blockedRepeatQuestionCandidates: null,
      blockedRepeatQuestionCandidatesReason: detail, failed: [{ failure: detail }] }) });
    await f.component.open(); assert.ok(f.one('batch-failure').textContent.includes(detail)); await confirmAll(f);
    assert.ok(f.readings().textContent.includes(detail));
  });
  for (const count of [0, 2]) test(`${language} shows measured repeated-question count ${count} as a number`, async () => {
    const f = fixture({ language, data: snapshot({ repeatedQuestionsToPerson: { complete: true, count } }) });
    await f.component.open(); await confirmAll(f);
    assert.ok(f.readings().textContent.includes(locale.format(language, 'butlerReview.repeatMeasured', { count })));
    assert.ok(!f.readings().textContent.includes(locale.format(language, 'butlerReview.repeatIncomplete', { reason: 'missing' })));
    assert.equal(f.component.stats().measurement.count, count);
  });
  test(`${language} preserves an incomplete-measurement explanation`, async () => {
    const reason = language === 'zh' ? '记录期开始时的投递记录缺失。' : 'Delivery records from the beginning of this period are missing.';
    const f = fixture({ language, data: snapshot({ repeatedQuestionsToPerson: { complete: false, count: null, reason } }) });
    await f.component.open(); await confirmAll(f);
    assert.ok(f.readings().textContent.includes(locale.format(language, 'butlerReview.repeatIncomplete', { reason })));
    assert.equal(f.component.stats().measurement.reason, reason);
  });
  test(`${language} keeps an unavailable blocked-candidate count visible with an explanation`, async () => {
    const data = snapshot(); delete data.blockedRepeatQuestionCandidates;
    const f = fixture({ language, data }); await f.component.open(); await confirmAll(f);
    const prefix = language === 'zh' ? '被拦下的重复提问候选' : 'Blocked repeat-question candidates';
    const line = walk(f.readings()).find(el => el.tagName === 'P' && el.textContent.startsWith(prefix));
    assert.ok(line, 'Missing blocked-candidate records must not hide the reading');
    assert.match(line.textContent, language === 'zh' ? /未核实/ : /not verified/i);
    assert.match(line.textContent, language === 'zh' ? /记录|计数.*(?:缺失|不可用|不完整)/ : /records|measurement|counter.*(?:unavailable|missing|incomplete)/i);
    assert.ok(!line.textContent.includes(locale.format(language, 'butlerReview.blocked', { count: 0 })));
  });
  for (const synthetic of [false, true]) test(`${language} counts real suggestions as N and conditionally labels synthetic=${synthetic}`, async () => {
    const f = fixture({ language, data: snapshot({ synthetic }) }); await f.component.open(); await confirmAll(f);
    const s = f.component.stats(); assert.equal(s.denominator, 3); assert.equal(s.realSamples, synthetic ? 0 : 3);
    assert.ok(f.readings().textContent.includes(locale.format(language, 'butlerReview.samples', { count: synthetic ? 0 : 3 })));
    assert.equal(f.readings().textContent.includes(f.message('synthetic')), synthetic);
    assert.ok(f.readings().textContent.includes(locale.format(language, 'butlerReview.sampleInsufficient', { count: synthetic ? 0 : 3, minimum: 10 })));
  });
}

test('dispose clears frozen rows and draft state, unbinds close, and makes old component entry points inert', async () => {
  let reads = 0;
  const f = fixture({ read: async () => { reads++; return snapshot(); } });
  await f.component.open(); await f.check(f.input('queue-first'), true); await confirmAll(f);
  const first = f.row('queue-first'), recordContainer = walk(f.dialog).find(el => el.children.includes(first));
  assert.equal(recordContainer.children.length, 7); assert.ok(f.dialog.listeners.get('close')?.size);
  f.component.dispose();
  assert.equal(f.dialog.open, false); assert.equal(f.dialog.children.length, 0);
  assert.equal(recordContainer.children.length, 0, 'Detached table must not retain the previous frozen rows');
  assert.equal(f.dialog.listeners.get('close')?.size || 0, 0); assert.equal(f.entry.listeners.get('click')?.size || 0, 0);
  const s = f.component.stats(); assert.equal(s.total, 0); assert.equal(s.disagreed, 0); assert.equal(s.agreed, 0);
  await f.component.open(); await f.entry.click(); f.component.refresh(); f.component.available(true);
  assert.equal(reads, 1); assert.equal(f.dialog.open, false); assert.equal(f.dialog.children.length, 0); assert.equal(f.entry.hidden, true);
});

test('dispose invalidates pending reads so late snapshots cannot restore the cleared table', async () => {
  const pendingRead = deferred(); const f = fixture({ read: () => pendingRead.promise });
  const opening = f.component.open(); f.component.dispose(); pendingRead.resolve(snapshot()); await opening;
  assert.equal(f.dialog.open, false); assert.equal(f.dialog.children.length, 0); assert.equal(f.component.stats().total, 0);
  assert.equal(f.dialog.listeners.get('close')?.size || 0, 0);
});

test('editing an accepted review clears agreement and requires a new attestation', async () => {
  const f = fixture(); await f.component.open(); await confirmAll(f); assert.equal(f.component.stats().agreed, 3);
  const edit = walk(f.dialog).find(el => el.tagName === 'BUTTON' && el.textContent === f.message('edit')); await edit.click();
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.attest().checked, false); assert.equal(f.accept().disabled, true);
});

for (const count of [9, 10]) test(`${count} real distinct suggestions show the chosen sample boundary without a pass stamp`, async () => {
  const f = fixture({ language: 'en', data: snapshot({ rows: Array.from({ length: count }, (_, index) => suggestion('row-' + index, 'proposal-' + index)) }) });
  await f.component.open(); await confirmAll(f);
  assert.equal(f.component.stats().realSamples, count); assert.equal(f.component.stats().denominator, count);
  const expected = count < 10 ? locale.format('en', 'butlerReview.sampleInsufficient', { count, minimum: 10 }) : locale.format('en', 'butlerReview.sampleMinimum', { count: 10 });
  assert.ok(f.readings().textContent.includes(expected));
  assert.equal(/\b(?:pass|fail|passed|failed)\b/i.test(f.readings().textContent), false);
});


test('the approved header retains occurrence/pending reads and distinct confirmed counts', async () => {
  const f = fixture({ language: 'en' }); await f.component.open();
  assert.match(f.one('summary').textContent, /7Occurrences7Pending occurrences/);
  assert.equal(f.one('summary').textContent.includes('Distinct agree'), false);
  await f.check(f.input('queue-first'), true);
  assert.match(f.one('summary').textContent, /7Occurrences5Pending occurrences/);
  await confirmAll(f); assert.match(f.one('summary').textContent, /7Occurrences1Distinct disagree2Distinct agree/);
});

test('the complete source title remains visible before expanding its source', async () => {
  const f = fixture(); await f.component.open();
  const source = byClass(f.row('queue-first'), 'source')[0];
  assert.ok(source.children[0].textContent.includes('Original request'));
  assert.equal(source.open, false);
});

test('a persisted confirmation restores its revision, opinions and attestation without saving again', async () => {
  const data = snapshot({ token: 'persisted-revision-2', confirmation: { allRead: true, revision: 2, marks: ['suggestion:queue', 'candidate:candidate-one'] } });
  const f = fixture({ data }); await f.component.open();
  assert.equal(f.component.stats().agreed, 2); assert.equal(f.input('queue-first').checked, true); assert.equal(f.input('queue-repeat').checked, true);
  assert.equal(f.input('paused').checked, true); assert.equal(f.attest().checked, true); assert.equal(f.accept().disabled, true);
  assert.ok(f.one('receipt').textContent.includes('2')); assert.equal(f.calls.length, 0);
  const edit = walk(f.dialog).find(el => el.tagName === 'BUTTON' && el.textContent === f.message('edit')); await edit.click();
  await f.check(f.input('queue-first'), false); await f.check(f.input('report'), true); await confirmAll(f);
  assert.equal(f.calls[0].token, 'persisted-revision-2'); assert.equal(f.component.stats().agreed, 2);
  assert.ok(f.one('receipt').textContent.includes('3')); assert.equal(f.input('report').checked, true);
});

test('a localized conflict keeps the draft and full sources instead of displaying a false save', async () => {
  const message = 'Another window saved this review. Your draft has been retained.';
  const f = fixture({ confirm: async () => { throw Error(message); } }); await f.component.open();
  await f.check(f.input('queue-first'), true); const input = f.input('queue-first'), source = byClass(f.row('queue-first'), 'source')[0]; await confirmAll(f);
  assert.equal(f.input('queue-first'), input); assert.equal(f.input('queue-repeat').checked, true); assert.equal(f.attest().checked, true);
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.readings().hidden, true); assert.equal(f.one('receipt').hidden, true);
  assert.equal(f.one('review-error').textContent, message); assert.ok(source.textContent.includes('Keep this source.'));
});

test('a legacy boolean result cannot be mistaken for the adapter’s saved VM', async () => {
  const f = fixture({ confirm: async () => true }); await f.component.open(); await confirmAll(f);
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.one('receipt').hidden, true); assert.equal(f.one('review-error').hidden, false);
});

test('an unknown marked suggestion stays unable while its explicit disagreement mark is retained', async () => {
  const data = snapshot(); data.rows[5].assessable = false;
  const f = fixture({ data }); await f.component.open(); await f.check(f.input('queue-first'), true); await confirmAll(f);
  const s = f.component.stats(); assert.equal(s.denominator, 3); assert.equal(s.agreed, 2); assert.equal(s.unable, 1); assert.equal(s.disagreed, 0); assert.equal(s.markedSuggestions, 1);
  assert.equal(f.input('queue-first').checked, true); assert.equal(f.input('queue-repeat').checked, true);
  assert.equal(byClass(f.row('queue-first'), 'judgment')[0].textContent, f.message('unable'));
  assert.deepEqual(f.calls[0].marks, ['suggestion:queue']);
});

test('audit records are not called synthetic and have zero real working-day samples', async () => {
  const f = fixture({ language: 'en', data: snapshot({ sampleKind: 'audit', synthetic: false }) }); await f.component.open(); await confirmAll(f);
  assert.equal(f.component.stats().denominator, 3); assert.equal(f.component.stats().realSamples, 0);
  assert.ok(f.one('chips').textContent.includes(f.message('audit'))); assert.ok(!f.one('chips').textContent.includes(f.message('synthetic')));
  assert.ok(f.readings().textContent.includes(f.message('auditSamples')));
});

test('all direct and additional source evidence, including missing event ids, remains readable', async () => {
  const data = snapshot(); data.rows[0].supplementalSources = [{ eventId: 'later-fact', sourceRef: 'task:extra', payload: { title: 'Complete additional evidence', text: 'The complete additional source body.' } }];
  data.rows[0].missingSourceEventIds = ['missing-event-one', 'missing-event-two'];
  const f = fixture({ data }); await f.component.open(); const source = byClass(f.row('queue-first'), 'source')[0];
  for (const original of ['Keep this source.', 'Complete additional evidence', 'The complete additional source body.', 'task:extra · later-fact', 'missing-event-one', 'missing-event-two']) assert.ok(source.textContent.includes(original));
});

test('the rail entry keeps its icon and gets an accessible localized name', async () => {
  const f = fixture({ language: 'en', railEntry: true }); const icon = f.entry.children[0];
  await f.component.open(); f.component.refresh();
  assert.equal(f.entry.children[0], icon); assert.equal(icon.textContent, '◎');
  assert.equal(f.entry.children[1].textContent, f.message('entry')); assert.equal(f.entry.attributes.get('aria-label'), f.message('entry')); assert.equal(f.entry.title, f.message('entry'));
});

test('only an explicit new-audit click invokes readNew; dirty drafts and pending work block it', async () => {
  let calls = 0; const reply = deferred(); const f = fixture({ readNew: () => { calls++; return reply.promise; } });
  await f.component.open(); const newest = f.one('new-audit'); assert.equal(calls, 0); assert.equal(newest.disabled, false);
  await f.check(f.input('queue-first'), true); assert.equal(newest.disabled, true); assert.equal(f.one('new-audit-note').hidden, false); await newest.click(); assert.equal(calls, 0);
  await f.check(f.input('queue-first'), false); await attest(f); assert.equal(newest.disabled, true);
  await f.check(f.attest(), false); const loading = newest.click(); assert.equal(calls, 1); assert.equal(newest.disabled, true);
  reply.resolve(snapshot({ token: 'new-audit-token' })); await loading;
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.attest().checked, false); assert.equal(newest.disabled, false);
});

test('a reused confirmed new-audit receipt preserves confirmation rather than forcing a reset', async () => {
  const data = snapshot({ token: 'saved-one', confirmation: { allRead: true, revision: 1, marks: ['suggestion:queue'] } }); let calls = 0;
  const f = fixture({ data, readNew: async () => { calls++; return structuredClone(data); } }); await f.component.open();
  assert.equal(f.one('new-audit').disabled, false); await f.one('new-audit').click();
  assert.equal(calls, 1); assert.equal(f.component.stats().agreed, 2); assert.equal(f.input('queue-repeat').checked, true); assert.equal(f.accept().disabled, true);
});

test('failure-only audit stays visible, cannot be confirmed, and can explicitly load a new audit', async () => {
  let calls = 0; const f = fixture({ data: snapshot({ rows: [], failed: [{ failure: 'No proposals were produced.' }] }), readNew: async () => { calls++; return snapshot({ token: 'after-failure' }); } });
  f.component.available(true); await f.component.open(); assert.equal(f.dialog.open, true); assert.equal(f.one('batch-failure').hidden, false);
  assert.equal(f.attest().disabled, true); assert.equal(f.accept().disabled, true); assert.equal(f.component.stats().agreed, 0);
  await f.check(f.attest(), true); await f.accept().dispatch('click'); assert.equal(f.calls.length, 0); await f.check(f.attest(), false);
  await f.one('new-audit').click(); assert.equal(calls, 1); assert.equal(f.component.stats().total, 7); assert.equal(f.component.stats().agreed, 0);
});

test('the real ledger and official adapter persist and restore a widget review without qualifying audit samples', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { ButlerLedger } = require('../butler-ledger.cjs'), adapterFactory = require('../renderer/butler-review-adapter.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-widget-review-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('person'); let serial = 0;
  const open = () => new ButlerLedger(directory, { authorizePerson: actor => actor === person, id: () => 'widget-' + ++serial });
  const ledger = open(); ledger.openQuestionMetricEpoch('widget-epoch');
  ledger.ingest({ eventId: 'source', kind: 'request', sourceRef: 'task:source', payload: { text: 'Complete original request.' } });
  const selection = { selectionRevision: 1, identity: { sessionId: 'butler', nativeId: 'native' }, runnerRef: 'runner' }, batch = ledger.beginBatch(selection);
  ledger.completeBatch(batch.batchId, selection, { actions: ['First task', 'Second task'].map(text => ({ kind: 'queue', sourceRef: 'task:source', spaceId: 'space', text })) });
  const adapterFor = instance => adapterFactory.create({ api: { butlerReview: async (action, payload) => {
    if (action === 'latest') return instance.latestReview(person);
    if (action === 'freeze') return instance.freezeReview({}, person);
    if (action === 'confirm') { const { reviewId, ...request } = payload; return instance.confirmReview(reviewId, request, person); }
    throw Error('Unexpected operation');
  } }, text: (key, params) => locale.format('en', key, params) });
  const adapter = adapterFor(ledger), f = fixture({ language: 'en', read: adapter.open, confirm: adapter.confirm });
  await f.component.open(); const id = byClass(f.dialog, 'record')[0].dataset.rowId;
  await f.check(f.input(id), true); await confirmAll(f);
  assert.equal(f.component.stats().denominator, 2); assert.equal(f.component.stats().agreed, 1); assert.equal(f.component.stats().realSamples, 0);
  assert.equal(ledger.latestReview(person).revision, 1); assert.deepEqual(ledger.latestReview(person).provenance, { kind: 'audit', activation: 'off', recordPeriod: 'off' });
  const bytes = fs.readFileSync(path.join(directory, 'butler-ledger.jsonl')); f.component.dispose(); adapter.dispose();
  const recovered = adapterFor(open()), next = fixture({ language: 'en', read: recovered.open, confirm: recovered.confirm });
  await next.component.open(); assert.equal(next.input(id).checked, true); assert.equal(next.component.stats().agreed, 1); assert.equal(next.accept().disabled, true);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'butler-ledger.jsonl')), bytes);
  next.component.dispose(); recovered.dispose();
});

test('with entry null a callback can open, save, reopen the receipt, close and dispose the review', async () => {
  const f = fixture({ withEntry: false }); assert.equal(f.entry, null); assert.deepEqual(f.document.roots, [f.dialog]);
  assert.doesNotThrow(() => { f.component.available(true); f.component.refresh(); });
  await f.component.open(); assert.equal(f.dialog.open, true); assert.equal(f.component.stats().agreed, 0);
  await f.check(f.input('queue-first'), true); await confirmAll(f);
  assert.equal(f.calls.length, 1); assert.equal(f.component.stats().agreed, 2); assert.equal(f.component.stats().denominator, 3);
  await f.one('close').click(); assert.equal(f.dialog.open, false);
  await f.component.open(); assert.equal(f.dialog.open, true); assert.equal(f.input('queue-first').checked, true);
  assert.equal(f.component.stats().agreed, 2); assert.equal(f.one('receipt').hidden, false); assert.equal(f.accept().disabled, true);
  f.component.dispose(); assert.equal(f.dialog.open, false); assert.equal(f.dialog.children.length, 0); assert.equal(f.component.stats().total, 0);
  assert.equal(f.dialog.listeners.get('close')?.size || 0, 0);
  assert.doesNotThrow(() => { f.component.refresh(); f.component.available(true); f.component.dispose(); });
  await f.component.open(); assert.equal(f.dialog.open, false); assert.equal(f.dialog.children.length, 0);
});

test('omitting entry creates no external button and still supports direct opening', async () => {
  const document = new Document(), dialog = document.createElement('dialog'); dialog.id = 'review-without-entry'; document.roots = [dialog];
  const component = create({ dialog, text: (key, params) => locale.format('en', key, params), read: async () => snapshot(), confirm: async () => false });
  assert.deepEqual(document.roots, [dialog]); await component.open(); assert.equal(dialog.open, true); assert.equal(component.stats().total, 7);
  dialog.close(); assert.equal(dialog.open, false); component.dispose(); assert.equal(dialog.children.length, 0);
});

test('without entry a null or empty read closes cleanly, while a failure-only review remains readable', async () => {
  for (const value of [null, snapshot({ rows: [] })]) {
    const f = fixture({ withEntry: false, read: async () => value }); await f.component.open();
    assert.equal(f.dialog.open, false); assert.equal(f.component.stats().total, 0); f.component.dispose();
  }
  const f = fixture({ withEntry: false, data: snapshot({ rows: [], failed: [{ failure: 'No proposals were produced.' }] }) });
  await f.component.open(); assert.equal(f.dialog.open, true); assert.equal(f.one('batch-failure').hidden, false); assert.equal(f.accept().disabled, true);
  await f.one('close').click(); f.component.dispose(); assert.equal(f.dialog.open, false);
});

test('without entry a late save after close cannot confirm the reopened draft', async () => {
  const response = deferred(), f = fixture({ withEntry: false, confirm: () => response.promise }); await f.component.open();
  await f.check(f.input('queue-first'), true); await attest(f); const pending = f.accept().click();
  f.dialog.close(); await f.component.open(); response.resolve(saved(snapshot(), f.calls[0])); await pending;
  assert.equal(f.dialog.open, true); assert.equal(f.input('queue-first').checked, true); assert.equal(f.input('queue-repeat').checked, true);
  assert.equal(f.component.stats().agreed, 0); assert.equal(f.one('receipt').hidden, true); f.component.dispose();
});

test('without entry dispose invalidates a pending read and clears the table', async () => {
  const response = deferred(), f = fixture({ withEntry: false, read: () => response.promise });
  const pending = f.component.open(); f.component.dispose(); response.resolve(snapshot()); await pending;
  assert.equal(f.dialog.open, false); assert.equal(f.dialog.children.length, 0); assert.equal(f.component.stats().total, 0);
});
