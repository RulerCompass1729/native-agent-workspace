const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });

test('direct renderer UI text uses display messages instead of unkeyed Chinese literals', () => {
  const directory = path.join(__dirname, '../renderer'), hits = [];
  // This guards explicit display sinks. Indirect/native/HTML text needs the
  // separate template/catalog checks and actual user-flow acceptance.
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    // renderer.js is embedded as a function body and returns its disposer.
    const ast = box.exports.parse(source, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true });
    const pending = [ast];
    while (pending.length) {
      const node = pending.pop(); if (!node || typeof node !== 'object') continue;
      let text;
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['node', 'button', 'toast'].includes(node.callee.name)) text = node.arguments[node.callee.name === 'node' ? 1 : 0];
      if (node.type === 'NewExpression' && node.callee.name === 'Error') text = node.arguments[0];
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'setAttribute' && ['aria-label', 'title', 'placeholder', 'aria-description'].includes(node.arguments[0]?.value)) text = node.arguments[1];
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && ['textContent', 'title', 'placeholder'].includes(node.left.property.name)) text = node.right;
      if (text?.type === 'Literal' && typeof text.value === 'string' && /\p{Script=Han}/u.test(text.value)) hits.push(`${file}:${node.loc.start.line}`);
      for (const value of Object.values(node)) if (value && typeof value === 'object') { if (Array.isArray(value)) pending.push(...value); else pending.push(value); }
    }
  }
  assert.deepEqual(hits, [], 'Own UI literals need a catalog key at their source; native/user data stays raw.');
});

test('the actual terminal font handler localizes its existing failure without applying or saving rejected values', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('const saveTerminalDisplay ='), end = source.indexOf("$('terminal-font-size').onchange", start);
  assert.ok(start > 0 && end > start);
  const elements = { 'terminal-display-dialog': { open: true }, 'terminal-font-size': { value: '12.5' }, 'terminal-palette': { value: 'dark' } }, calls = [];
  let failure;
  const original = { fontSize: 13, palette: 'light' }, context = vm.createContext({ $: id => elements[id], uiError: locale.createError, terminalDisplay: original,
    attempt: async action => { try { return await action(); } catch (error) { failure = error; } },
    applyTerminalDisplay: () => calls.push('apply'), persistView: async () => calls.push('save') });
  vm.runInContext(source.slice(start, end) + ';this.saveFont = saveTerminalDisplay;', context);
  for (const value of ['12.5', '9', '25']) {
    failure = null; elements['terminal-font-size'].value = value; await context.saveFont();
    assert.equal(failure?.message, '字号请设为 10–24。'); assert.equal(locale.errorText('en', failure), 'Set font size to 10–24.');
    assert.equal(context.terminalDisplay, original); assert.deepEqual(calls, []);
  }
  elements['terminal-display-dialog'].open = false; failure = null; await context.saveFont(); assert.equal(failure, null); assert.deepEqual(calls, []);
  elements['terminal-display-dialog'].open = true; elements['terminal-font-size'].value = '13'; await context.saveFont();
  assert.deepEqual(JSON.parse(JSON.stringify(context.terminalDisplay)), { fontSize: 13, palette: 'dark' }); assert.deepEqual(calls, ['apply', 'save']);
});


test('explicit backend notice, gap, own progress, fleet and room-event literal sinks carry paired display metadata', () => {
  const directory = path.join(__dirname, '..'), hits = [];
  const hasHan = node => { if (!node || typeof node !== 'object') return false; if (node.type === 'Literal' && typeof node.value === 'string' && /\p{Script=Han}/u.test(node.value)) return true; return Object.values(node).some(value => value && typeof value === 'object' && (Array.isArray(value) ? value.some(hasHan) : hasHan(value))); };
  const hasMeta = (object, name) => object.properties.some(p => p.key?.name === name || p.key?.value === name || p.type === 'SpreadElement' && p.argument?.type === 'CallExpression' && p.argument.callee.name === 'uiNotice' || p.type === 'SpreadElement' && hasProperty(p.argument, name));
  function hasProperty(node, name) { if (!node || typeof node !== 'object') return false; if (node.type === 'Property' && (node.key.name === name || node.key.value === name)) return true; return Object.values(node).some(value => value && typeof value === 'object' && (Array.isArray(value) ? value.some(v => hasProperty(v, name)) : hasProperty(value, name))); }
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8'), pending = [box.exports.parse(source, { ecmaVersion: 'latest', locations: true })];
    while (pending.length) {
      const node = pending.pop(); if (!node || typeof node !== 'object') continue;
      if (node.type === 'CallExpression' && node.callee?.property?.name === 'emit') {
        const event = node.arguments[0]?.value, object = node.arguments[1];
        if (object?.type === 'ObjectExpression') {
          const prop = key => object.properties.find(p => p.key?.name === key || p.key?.value === key)?.value, kind = prop('kind')?.value, origin = prop('source')?.value;
          const own = event === 'nativeBlock' && ['notice', 'gap'].includes(kind) || event === 'progress' && ['claude-hook', 'claude-native-message', 'codex-native'].includes(origin) || event === 'fleet';
          if (own) for (const [field, metadata] of [['title', 'uiTitleMessage'], ['text', 'uiMessage'], ['name', 'nameUiMessage']]) if (hasHan(prop(field)) && !hasMeta(object, metadata)) hits.push(`${file}:${node.loc.start.line}:${field}`);
        }
      }
      if (file === 'room-state.cjs' && node.type === 'CallExpression' && node.callee?.property?.name === 'update' && node.arguments[1]?.type === 'ObjectExpression') { const object = node.arguments[1], text = object.properties.find(p => p.key?.name === 'text')?.value; if (hasHan(text) && !hasMeta(object, 'uiMessage')) hits.push(`${file}:${node.loc.start.line}:room-event`); }
      for (const value of Object.values(node)) if (value && typeof value === 'object') { if (Array.isArray(value)) pending.push(...value); else pending.push(value); }
    }
  }
  // Deliberately bounded syntactic producer guard; indirect values, templates,
  // HTML and native content still require consumer tests and user-flow review.
  assert.deepEqual(hits, []);
});
