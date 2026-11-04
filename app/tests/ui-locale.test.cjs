const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const messages = require('../ui-messages.js');
const locale = require('../ui-locale.js');

test('typed own notices require an explicit namespace and retain their original stored text', () => {
  const notice = locale.createNotice('notice.legacyOffline');
  assert.equal(notice.text, messages.zh['notice.legacyOffline']);
  assert.equal(locale.displayMessage(notice.uiMessage), null, 'Notice metadata must not be accepted as an error');
  assert.equal(locale.displayMessage(notice.uiMessage, 'notice.').key, 'notice.legacyOffline');
  assert.equal(locale.displayMessage({ version: 1, key: 'menu.copy', params: {} }, 'menu.'), null);
  assert.equal(locale.displayMessage({ ...notice.uiMessage, version: 2 }, 'notice.'), null);
  assert.throws(() => locale.createError('notice.legacyOffline')); assert.throws(() => locale.createNotice('error.sessionMissing'));
});

test('both catalogs contain the same string keys and interpolation parameters', () => {
  assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());
  for (const key of Object.keys(messages.en)) {
    assert.equal(typeof messages.zh[key], 'string');
    assert.equal(typeof messages.en[key], 'string');
    const params = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(params(messages.zh[key]), params(messages.en[key]), key);
  }
});

test('system priority and exact explicit preferences follow DSH language policy', () => {
  for (const [languages, preference, expected] of [
    [['ja', 'en-US', 'zh-Hans'], null, 'en'],
    [['ja', 'zh-TW', 'en'], null, 'zh'],
    [['zh'], 'en', 'en'], [['en'], 'ZH', 'zh'],
    [['en'], 'zh-CN', 'en'], [['zh'], 'en-US', 'zh'],
    [[], null, 'en'], [['ja'], null, 'en'],
  ]) assert.equal(locale.language({ languages, preference }), expected);
});

test('malformed and unavailable snapshots retain a detached valid last-known snapshot', () => {
  const old = { languages: ['en-US', 'zh'], preference: 'zh' };
  const baseline = locale.snapshot(old);
  old.languages[0] = 'changed';
  assert.deepEqual(baseline.languages, ['en-US', 'zh']);
  for (const bad of [undefined, null, {}, { languages: [1], preference: 'en' }, { languages: [], preference: 'not a tag' }, { languages: [] }]) {
    const fallback = locale.snapshot(bad, baseline);
    assert.deepEqual(fallback, baseline);
    assert.equal(locale.validSnapshot(fallback), true);
  }
});

test('formatting inserts native text once as plain text, without changing the original', () => {
  const original = '<native>& {app} 中文\nraw';
  const result = locale.format('en', 'menu.about', { app: original });
  assert.equal(result, `About ${original}`);
  assert.equal(original, '<native>& {app} 中文\nraw');
  assert.throws(() => locale.format('en', 'missing.key'));
});

test('the same catalog/formatter work in the startup browser without CommonJS or state', () => {
  const context = vm.createContext({});
  for (const name of ['ui-messages.js', 'ui-locale.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  const result = vm.runInContext("nativeWorkspaceLocale.format(nativeWorkspaceLocale.language({languages:['en-US'],preference:null}), 'startup.opening')", context);
  assert.equal(result, 'Opening your workspace');
  assert.equal(vm.runInContext('Object.isFrozen(nativeWorkspaceMessages.en)', context), true);
});

test('the shared browser data contract uses the same error formatter and retains its standalone fallback', () => {
  for (const localized of [false, true]) {
    const context = vm.createContext({});
    const names = localized ? ['ui-messages.js', 'ui-locale.js', 'collaboration-spaces.cjs'] : ['collaboration-spaces.cjs'];
    for (const name of names) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
    const error = vm.runInContext('try { nativeWorkspaceSpaces.roomIds(null) } catch (error) { error }', context);
    assert.equal(error.message, messages.zh['error.spaceMembershipUnverifiable']);
    if (localized) assert.equal(locale.errorText('en', error), messages.en['error.spaceMembershipUnverifiable']);
    else assert.equal(Object.hasOwn(error, 'uiMessage'), false);
  }
});

test('shared selection and all catalog formatting agree with the actual pinned DSH runtime', () => {
  let exported;
  const source = fs.readFileSync(path.join(path.dirname(require.resolve('@deepseek-ai/dsh-client-locale')), 'client.js'), 'utf8');
  const window = { __ModuleLoader__: { load(plugin) { exported = plugin.factory(() => ({})); } } };
  vm.runInNewContext(source, { window, console });
  for (const initial of [
    { languages: ['ja', 'zh-Hans', 'en'], preference: null },
    { languages: ['zh'], preference: 'en' },
    { languages: ['en'], preference: 'zh-CN' },
    { languages: [], preference: null },
    { languages: ['en'], preference: 'ZH' },
  ]) {
    const runtime = new exported.LocaleRuntime({ emit() {}, effect: fn => fn() }, undefined, initial);
    runtime.register('naw', messages);
    assert.equal(locale.language(initial), runtime.getSnapshot().active);
    const translate = runtime.bind('naw');
    for (const key of Object.keys(messages.en)) assert.equal(locale.format(locale.language(initial), key, { app: 'Synthetic <Name> {app}' }), translate(key, { app: 'Synthetic <Name> {app}' }), key);
  }
});

test('startup translation keeps the existing code-only privacy boundary in both languages', () => {
  const { startupMessage } = require('../ui-errors.cjs');
  for (const language of ['zh', 'en']) for (const code of ['NAW_VIEW_RECORD', 'NAW_UI_BUSY', '__proto__', 'SYNTHETIC_UPSTREAM_PRIVATE']) {
    const message = startupMessage({ code, message: 'http://localhost/?token=SYNTHETIC_UPSTREAM_PRIVATE' }, language);
    assert.doesNotMatch(message, /SYNTHETIC_UPSTREAM_PRIVATE|http:|token=/);
    assert.equal(typeof message, 'string');
  }
  assert.equal(locale.startupCode({ toString() { throw Error('Must not coerce upstream values'); } }), null);
});
