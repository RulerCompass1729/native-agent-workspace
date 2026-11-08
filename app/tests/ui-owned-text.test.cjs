const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });

const han = /\p{Script=Han}/u;
function ownsHan(expression) {
  if (!expression) return false;
  if (expression.type === 'Literal') return typeof expression.value === 'string' && han.test(expression.value);
  if (expression.type === 'TemplateLiteral') return expression.quasis.some(part => han.test(part.value.cooked || '')) || expression.expressions.some(ownsHan);
  if (expression.type === 'ConditionalExpression') return ownsHan(expression.consequent) || ownsHan(expression.alternate);
  if (expression.type === 'LogicalExpression' || expression.type === 'BinaryExpression' && expression.operator === '+') return ownsHan(expression.left) || ownsHan(expression.right);
  // Calls/identifiers may contain raw user or native values. Do not descend into
  // uiText parameters or pretend this bounded check resolves arbitrary dataflow.
  return false;
}
function jsDisplayHits(source, { renderer = false, module = false, elementTextIndex = 1, bootstrap = false } = {}) {
  if (bootstrap) for (const name of ['SIDEBAR_TEMPLATE', 'MAIN_TEMPLATE', 'LOCAL_STYLES']) {
    const marker = '/* ' + name + ' */';
    if (source.split(marker).length !== 2) throw Error('Requalify the DSH source template markers before scanning.');
    // These are build-time value holes, not JavaScript until build-ui fills them.
    // Empty values preserve offsets; renderer/HTML sources are scanned separately.
    source = source.replace(marker, '""'.padEnd(marker.length));
  }
  const ast = box.exports.parse(source, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true, sourceType: module ? 'module' : 'script' });
  const pending = [ast], hits = [], pairedFallbacks = new WeakSet();
  while (pending.length) {
    const node = pending.pop(); if (!node || typeof node !== 'object') continue;
    // Shared data contracts retain a standalone error when no UI formatter is
    // present. Permit only the exact zero-parameter catalog pair, not a baseline
    // exemption for an unkeyed error or a mismatched fallback.
    if (node.type === 'ConditionalExpression' && node.test.type === 'Identifier' && node.test.name === 'uiError' &&
        node.consequent.type === 'CallExpression' && node.consequent.callee.name === 'uiError' && node.consequent.arguments.length === 1 &&
        ['CallExpression', 'NewExpression'].includes(node.alternate.type) && node.alternate.callee.name === 'Error' && node.alternate.arguments.length === 1) {
      const key = node.consequent.arguments[0]?.value, fallback = node.alternate.arguments[0];
      if (typeof key === 'string' && key.startsWith('error.') && fallback?.type === 'Literal' && typeof fallback.value === 'string') {
        try { if (locale.displayMessage({ version: 1, key, params: {} }) && locale.format('zh', key) === fallback.value) pairedFallbacks.add(node.alternate); } catch {}
      }
    }
    let text, sink;
    if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier' && node.callee.name === 'Error') { text = node.arguments[0]; sink = 'Error'; }
    if (renderer) {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['node', 'el', 'element', 'button', 'control', 'toast'].includes(node.callee.name)) { text = node.arguments[node.callee.name === 'element' ? elementTextIndex : ['node', 'el'].includes(node.callee.name) ? 1 : 0]; sink = node.callee.name; }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'setAttribute' && ['aria-label', 'title', 'placeholder', 'aria-description'].includes(node.arguments[0]?.value)) { text = node.arguments[1]; sink = node.arguments[0].value; }
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && ['textContent', 'innerText', 'innerHTML', 'title', 'placeholder'].includes(node.left.property.name)) { text = node.right; sink = node.left.property.name; }
    }
    if (ownsHan(text) && !pairedFallbacks.has(node)) hits.push({ line: node.loc.start.line, sink });
    for (const value of Object.values(node)) if (value && typeof value === 'object') { if (Array.isArray(value)) pending.push(...value); else pending.push(value); }
  }
  return hits.sort((a, b) => a.line - b.line || a.sink.localeCompare(b.sink));
}
function htmlDisplayHits(source) {
  // Mask non-display contents without changing source offsets or line numbers.
  const html = source.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, part => part.replace(/[^\n]/g, ' '));
  const hits = [], line = offset => source.slice(0, offset).split('\n').length;
  const decoded = value => value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, digits) => {
    const code = digits[0].toLowerCase() === 'x' ? parseInt(digits.slice(1), 16) : Number(digits);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
  for (const match of html.matchAll(/<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+/g)) {
    if (match[0].startsWith('<')) {
      // Consume every attribute's complete quoted value, including raw data-*;
      // an apparent title= inside that value is data, not another attribute.
      for (const attr of match[0].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g)) {
        if (['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label'].includes(attr[1].toLowerCase()) && han.test(decoded(attr[2] || attr[3] || attr[4] || ''))) hits.push({ line: line(match.index + attr.index), sink: attr[1].toLowerCase() });
      }
    } else if (han.test(decoded(match[0]))) hits.push({ line: line(match.index + match[0].search(/\S/)), sink: 'HTML text' });
  }
  return hits;
}

test('owned-text scanner catches templates, conditions and both Error forms without treating raw parameters as owned text', () => {
  const cases = [
    ['node("p", `调整 ${name} 的高度`)', 'node'], ['button(ready ? "继续" : "")', 'button'],
    ['el.textContent = value && "未报告"', 'textContent'], ['el.title = prefix + "连接已变化"', 'title'],
    ['el.setAttribute("aria-label", ready ? `打开 ${name}` : "")', 'aria-label'],
    ['throw Error(`会话 ${id} 未接回`)', 'Error'], ['throw new Error(ok ? "" : "未确认")', 'Error'],
    ['element("span", "没有读数")', 'element'], ['control("完成", done)', 'control'],
  ];
  for (const [source, sink] of cases) assert.deepEqual(jsDisplayHits(source, { renderer: true }), [{ line: 1, sink }], source);
  assert.deepEqual(jsDisplayHits('throw Error(`原会话 ${name} 已变化`)', { module: true }), [{ line: 1, sink: 'Error' }]);
  const raw = 'const name = "用户中文"; node("p", uiText("member.name", { name: "用户中文" })); el.textContent = native.text; throw uiError("error.changed", { raw: "原生中文" });';
  assert.deepEqual(jsDisplayHits(raw, { renderer: true }), []);
  // native-images uses element(tag, cls, text); panorama uses (tag, text, cls).
  assert.deepEqual(jsDisplayHits('element("p", "class", "未报告")', { renderer: true, elementTextIndex: 2 }), [{ line: 1, sink: 'element' }]);
  assert.deepEqual(jsDisplayHits('element("p", "原生中文 class", undefined)', { renderer: true, elementTextIndex: 2 }), []);
  const bridge = 'const templates = { sidebar: /* SIDEBAR_TEMPLATE */, main: /* MAIN_TEMPLATE */ }; const css = /* LOCAL_STYLES */; throw Error("本机结果未确认");';
  assert.deepEqual(jsDisplayHits(bridge, { bootstrap: true }), [{ line: 1, sink: 'Error' }]);
  assert.throws(() => jsDisplayHits('throw Error("本机结果未确认")', { bootstrap: true }), /Requalify the DSH source template/);
  const key = 'error.spaceMembershipUnverifiable', fallback = JSON.stringify(locale.format('zh', key));
  assert.deepEqual(jsDisplayHits('const invalid = () => uiError ? uiError(' + JSON.stringify(key) + ') : Error(' + fallback + ');'), []);
  assert.deepEqual(jsDisplayHits('const invalid = () => uiError ? uiError(' + JSON.stringify(key) + ') : Error("不同的中文错误");'), [{ line: 1, sink: 'Error' }]);
  assert.deepEqual(jsDisplayHits('const invalid = () => uiError ? uiError("error.unknownFutureKey") : Error(' + fallback + ');'), [{ line: 1, sink: 'Error' }]);
  const missingParameterKey = 'error.backendSwitchSessionChanged';
  assert.equal(locale.createError(missingParameterKey).uiMessage, undefined, 'The actual factory cannot attach metadata without its name parameter');
  assert.deepEqual(jsDisplayHits('const invalid = () => uiError ? uiError(' + JSON.stringify(missingParameterKey) + ') : Error(' + JSON.stringify(locale.format('zh', missingParameterKey)) + ');'), [{ line: 1, sink: 'Error' }]);
  assert.deepEqual(jsDisplayHits('const invalid = () => enabled ? unknown() : Error(' + fallback + ');'), [{ line: 1, sink: 'Error' }]);
});

test('owned-text scanner catches static HTML text and accessibility labels, retaining original line numbers and ignoring raw data', () => {
  const source = '<!-- 中文注释 -->\n<script>const text = "原生中文";</script>\n<style>/* 中文 */</style>\n<button title="打开">继续</button>\n<input value="用户中文" data-native="原生中文" placeholder=请输入>\n<img alt=图片><p data-naw-text="empty"></p>';
  assert.deepEqual(htmlDisplayHits(source), [{ line: 4, sink: 'title' }, { line: 4, sink: 'HTML text' }, { line: 5, sink: 'placeholder' }, { line: 6, sink: 'alt' }]);
  assert.deepEqual(htmlDisplayHits('<input value="用户中文" data-raw-label="原生中文"><span data-naw-text="member.name"></span>'), []);
  assert.deepEqual(htmlDisplayHits('<p data-raw=" title=\'原生中文\'" data-other=\' aria-label="用户中文"\'></p>'), []);
  assert.deepEqual(htmlDisplayHits('<p>\n  &#x4e2d;&#25991;\n</p>'), [{ line: 2, sink: 'HTML text' }]);
});

test('renderer, static HTML and backend Error displays use catalog messages instead of unkeyed Chinese', () => {
  const app = path.join(__dirname, '..'), hits = [];
  const scripts = fs.readdirSync(app).filter(name => /\.(cjs|mjs|js)$/.test(name)).map(name => ({ file: name, renderer: false }));
  scripts.push(...fs.readdirSync(path.join(app, 'renderer')).filter(name => name.endsWith('.js')).map(name => ({ file: 'renderer/' + name, renderer: true })));
  scripts.push({ file: 'dsh/bootstrap.js', renderer: true, bootstrap: true });
  for (const { file, renderer, bootstrap } of scripts) for (const hit of jsDisplayHits(fs.readFileSync(path.join(app, file), 'utf8'), { renderer, module: file.endsWith('.mjs'), elementTextIndex: file === 'renderer/native-images.js' ? 2 : 1, bootstrap })) hits.push(`${file}:${hit.line}:${hit.sink}`);
  for (const hit of htmlDisplayHits(fs.readFileSync(path.join(app, 'renderer/index.html'), 'utf8'))) hits.push(`renderer/index.html:${hit.line}:${hit.sink}`);
  assert.deepEqual(hits, [], 'Own static display fragments need catalog keys; native/user values remain raw. Indirect values still need the inventory and user-flow review.');
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
  const hasHan = node => { if (!node || typeof node !== 'object') return false; if (node.type === 'Literal' && typeof node.value === 'string' && han.test(node.value) || node.type === 'TemplateElement' && han.test(node.value.cooked || '')) return true; return Object.values(node).some(value => value && typeof value === 'object' && (Array.isArray(value) ? value.some(hasHan) : hasHan(value))); };
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
  // Deliberately bounded syntactic producer guard; indirect values and native
  // content still require consumer tests and user-flow review.
  assert.deepEqual(hits, []);
});

// Backend records the renderer shows as a name or body (rows with a role, or a name with a text), direct
// .text/.activity writes, and pause/revoke/activity reasons. Chinese there needs a catalog message beside it:
// in the same object (or a spread of uiNotice/uiError), as a later `<same variable>.uiMessage =` /
// `.uiNameMessage =` in the same block, or as a message argument after the reason. The original Chinese stays,
// so old records and the text-must-match rule keep working. Bounded: values built in other variables and text
// for native agents (prompts, tool results) are not followed; those need consumer tests and flow review.
const recordReasonCalls = { pause: 0, pauseRoom: 1, pauseAll: 0, pauseParticipant: 1, revoke: 0, nativeWorkObserved: 1, setActivity: 1 };
const propertyName = p => p.type === 'Property' && !p.computed ? (p.key.name ?? p.key.value) : null;
function spreadKeys(expression, keys) {
  if (!expression) return keys;
  if (expression.type === 'ObjectExpression') for (const p of expression.properties) { const k = propertyName(p); if (k) keys.add(k); else if (p.type === 'SpreadElement') spreadKeys(p.argument, keys); }
  if (expression.type === 'ConditionalExpression') { spreadKeys(expression.consequent, keys); spreadKeys(expression.alternate, keys); }
  if (expression.type === 'LogicalExpression') spreadKeys(expression.right, keys);
  if (expression.type === 'CallExpression' && ['uiNotice', 'uiError'].includes(expression.callee.name)) { keys.add('text'); keys.add('uiMessage'); }
  return keys;
}
function messageArgument(e) {
  if (!e) return false;
  if (e.type === 'Identifier') return /uimessage/i.test(e.name);
  if (e.type === 'ObjectExpression') { const keys = e.properties.map(propertyName); return keys.includes('version') && keys.includes('key'); }
  if (e.type === 'MemberExpression') return !e.computed && /uimessage$/i.test(e.property.name || '') || e.object.type === 'CallExpression' && ['uiActivity', 'uiNotice', 'uiError'].includes(e.object.callee.name);
  if (e.type === 'CallExpression') return ['uiActivity', 'uiNotice', 'uiError', 'displayMessage'].includes(e.callee.name) || e.callee.property?.name === 'displayMessage';
  if (e.type === 'ConditionalExpression') return messageArgument(e.consequent) && (messageArgument(e.alternate) || e.alternate.type === 'Identifier' && e.alternate.name === 'undefined');
  if (e.type === 'LogicalExpression') return messageArgument(e.left) || messageArgument(e.right);
  return false;
}
function recordFieldHits(source) {
  const ast = box.exports.parse(source, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true });
  const hits = [], pending = [{ node: ast, blocks: [] }];
  const variable = parent => parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name
    : parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier' ? parent.left.name : null;
  // A later `<name>.<field> =` in the innermost enclosing block pairs the record.
  // Text match, bounded to the rest of that block: `<name>.<field> =`, not `x.<name>.` nor a `==`/`===` comparison.
  const pairedLater = (blocks, name, field, after) => !!name && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\.${field}\\s*=(?!=)`).test(source.slice(after, blocks.at(-1)?.end ?? source.length));
  while (pending.length) {
    const { node, parent, blocks } = pending.pop(); if (!node || typeof node !== 'object') continue;
    if (node.type === 'ObjectExpression') {
      const keys = new Set(), values = {};
      for (const p of node.properties) { const k = propertyName(p); if (k) { keys.add(k); values[k] = p.value; } else if (p.type === 'SpreadElement') spreadKeys(p.argument, keys); }
      if (keys.has('role') || keys.has('name') && keys.has('text')) {
        // Object.assign(row, { … }) adds to `row`; otherwise the variable the record is stored in.
        const name = parent?.type === 'CallExpression' && parent.callee.property?.name === 'assign' && parent.arguments[0]?.type === 'Identifier' ? parent.arguments[0].name : variable(parent);
        if (ownsHan(values.name) && !keys.has('uiNameMessage') && !pairedLater(blocks, name, 'uiNameMessage', node.end)) hits.push({ line: values.name.loc.start.line, sink: 'record name' });
        if (ownsHan(values.text) && !keys.has('uiMessage') && !pairedLater(blocks, name, 'uiMessage', node.end)) hits.push({ line: values.text.loc.start.line, sink: 'record text' });
      }
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed && ['text', 'activity'].includes(node.left.property.name) && ownsHan(node.right)) {
      const name = node.left.object.type === 'Identifier' ? node.left.object.name : null, field = node.left.property.name === 'text' ? 'uiMessage' : 'activityUiMessage';
      if (!pairedLater(blocks, name, field, node.end)) hits.push({ line: node.loc.start.line, sink: node.left.property.name });
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee.type === 'MemberExpression' ? node.callee.property.name : node.callee.name, at = recordReasonCalls[callee];
      if (at !== undefined && ownsHan(node.arguments[at]) && !node.arguments.slice(at + 1).some(messageArgument)) hits.push({ line: node.loc.start.line, sink: callee + ' reason' });
    }
    const inner = ['BlockStatement', 'Program'].includes(node.type) ? [...blocks, node] : blocks;
    for (const value of Object.values(node)) if (value && typeof value === 'object') for (const child of Array.isArray(value) ? value : [value]) pending.push({ node: child, parent: node, blocks: inner });
  }
  return hits.sort((a, b) => a.line - b.line || a.sink.localeCompare(b.sink));
}

test('record scanner catches unpaired names, bodies, direct writes and reasons, and accepts every pairing form', () => {
  const caught = [
    ["m.push({ role: 'system', name: '自动消息', text: body });", 'record name'],
    ["const row = { role: 'user', text: `发给 ${name}` };", 'record text'],
    ["Object.assign(row, { text, name: `你 → ${n}` });", 'record name'],
    ["row.text = '没有发出';", 'text'],
    ["s.activity = '正在连接';", 'activity'],
    ["this.pause('协作已被替换');", 'pause reason'],
    ["this.peerLeases.revoke('边界已变化：' + reason, id);", 'revoke reason'],
    ["setActivity(s, '正在恢复');", 'setActivity reason'],
  ];
  for (const [source, sink] of caught) assert.deepEqual(recordFieldHits(source), [{ line: 1, sink }], source);
  const paired = [
    "m.push({ role: 'system', name: '协作', uiNameMessage: n, text: '已暂停', uiMessage: u });",
    "m.push({ role: 'system', name, ...uiNotice('notice.x') });",
    "m.push({ role: 'system', name: '甲', ...(nm ? { uiNameMessage: nm } : {}), text: x });",
    "{ const row = { role: 'system', name: '自动消息', text: `发给 ${a}` }; row.uiMessage = m; row.uiNameMessage = n; }",
    "{ row.text = `没有发出`; row.uiMessage = m; }",
    "this.pause('协作已被替换', uiActivity('notice.x')[1]);",
    "this.pause(lease.reason || '授权已变化', lease.reason ? lease.reasonUiMessage : uiActivity('notice.y')[1]);",
    "revoke('边界已变化：' + r, id, undefined, { version: 1, key: 'notice.z', params: {} });",
    "const room = { id: 'shared', name: '共同工作', revision: 0 };",
  ];
  for (const source of paired) assert.deepEqual(recordFieldHits(source), [], source);
  // Comparisons and another object's field are not a pairing; `$` in a name is matched literally.
  assert.deepEqual(recordFieldHits("{ const row = { role: 'system', name: '自动消息' }; if (row.uiNameMessage === n) f(); }"), [{ line: 1, sink: 'record name' }]);
  assert.deepEqual(recordFieldHits("{ const row = { role: 'system', name: '自动消息' }; x.row.uiNameMessage = n; }"), [{ line: 1, sink: 'record name' }]);
  assert.deepEqual(recordFieldHits("{ const $row = { role: 'system', name: '自动消息' }; $row.uiNameMessage = n; }"), []);
  // A pairing in another block does not count.
  assert.deepEqual(recordFieldHits("{ const row = { role: 'system', name: '自动消息' }; } row.uiNameMessage = n;"), [{ line: 1, sink: 'record name' }]);
});

test('backend records shown to people carry catalog messages beside their Chinese', () => {
  // Each exception names the exact source text and why it stays raw.
  const allowed = [
    { file: 'workspace.cjs', sink: 'record name', source: "kind: 'agent-wake', name: `${s.name || '会话'} → ${target?.name || '会话'}`",
      why: 'The space view labels live wake rows by participant ID (renderer roomMessageLabel, wake branch); merged copies drop `wake` (space-merge.cjs fields) and show this stored name. ' +
        'The "A → B" has no Chinese of its own: sessions are named at creation (workspace.cjs create: Claude N / Codex N), so 会话 appears only for a record without a name.' },
  ];
  const app = path.join(__dirname, '..'), hits = [], used = new Set();
  for (const file of fs.readdirSync(app).filter(name => /\.(cjs|js)$/.test(name) && name !== 'ui-messages.js')) {
    const source = fs.readFileSync(path.join(app, file), 'utf8'), lines = source.split('\n');
    for (const hit of recordFieldHits(source)) {
      const rule = allowed.find(a => a.file === file && a.sink === hit.sink && lines[hit.line - 1].includes(a.source));
      if (rule) used.add(rule); else hits.push(`${file}:${hit.line}:${hit.sink}: ${lines[hit.line - 1].trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, []);
  assert.deepEqual(allowed.filter(rule => !used.has(rule)), [], 'Remove exceptions that no longer match source.');
});
