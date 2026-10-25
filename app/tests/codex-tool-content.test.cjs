const test = require('node:test'), assert = require('node:assert/strict');
const { toolContent, fileChanges, toolStatus } = require('../codex-tool-content.cjs');
const { NativeHost } = require('../adapters.cjs');
const { applyCodexProgress } = require('../native-blocks.cjs');
test('native web search retains its literal query, action and complete result data', () => {
  const results = [{ title: 'A result', url: 'https://example.test/a', snippet: 'Full result text' }];
  const search = toolContent({ type: 'webSearch', query: 'original query', action: { type: 'search', query: null, queries: ['first query', 'second query'] }, results });
  assert.equal(search.title, 'Searching the web for first query, second query'); assert.equal(search.input, 'first query\nsecond query');
  assert.deepEqual(JSON.parse(search.text).results, results);
  assert.equal(toolContent({ type: 'webSearch', action: { type: 'findInPage', url: 'https://example.test', pattern: 'needle' } }).input, 'https://example.test\nneedle');
});
test('MCP and dynamic tools retain exact input/text, explicit unsupported media and native failures without private metadata', () => {
  const mcp = toolContent({ type: 'mcpToolCall', server: 'local', tool: 'read', arguments: { path: 'sample.txt' },
    result: { content: [{ type: 'text', text: '完整正文\nsecond line' }, { type: 'resource', resource: { uri: 'fixture://one', text: 'resource text', _meta: 'PRIVATE META' } }, { type: 'image', data: 'PRIVATE BYTES' }], structuredContent: { count: 2 }, _meta: { hidden: 'PRIVATE META' } }, error: { message: 'Native error' }, _meta: 'PRIVATE META' });
  assert.equal(mcp.input, '{\n  "path": "sample.txt"\n}'); assert.equal(mcp.title, 'local.read');
  assert.match(mcp.text, /完整正文\nsecond line/); assert.match(mcp.text, /resource text/); assert.match(mcp.text, /"count": 2/); assert.match(mcp.text, /Native error/);
  assert.equal(mcp.incomplete, true); assert.ok(!JSON.stringify(mcp).includes('PRIVATE'));
  const dynamic = toolContent({ type: 'dynamicToolCall', tool: 'run', arguments: { count: 0 }, contentItems: [{ type: 'inputText', text: 'dynamic result' }] });
  assert.equal(dynamic.text, 'dynamic result'); assert.equal(dynamic.incomplete, false);
});
test('file changes preserve paths, moves and diff text; function output preserves text and marks omitted binary', () => {
  const diff = '@@ -1 +1 @@\n-old\n+new\n';
  assert.equal(fileChanges([{ path: 'old.txt', kind: { type: 'update', move_path: 'new.txt' }, diff }]).text, 'update old.txt → new.txt\n' + diff);
  assert.equal(toolContent({ type: 'functionCallOutput', name: 'check', namespace: 'local', output: 'result\n' }).text, 'result\n');
  const result = toolContent({ type: 'functionCallOutput', name: 'check', output: [{ type: 'input_text', text: 'visible' }, { type: 'encrypted_content', encrypted_content: 'PRIVATE' }] });
  assert.equal(result.incomplete, true); assert.ok(!result.text.includes('PRIVATE')); assert.match(result.text, /visible/);
  assert.equal(toolContent({ type: 'reasoning', content: ['PRIVATE'] }), null);
});
test('native tool lifecycle updates the same complete reader block including replacement patch, rejection and final text', () => {
  const host = new NativeHost('/tmp'), s = { provider: 'codex', nativeId: 'test-native', messages: [] }, r = host.create(s);
  r.on('progress', item => applyCodexProgress(s, item));
  const emit = (method, params) => r.event({ method, params: { threadId: s.nativeId, turnId: 'turn', ...params } });
  emit('turn/started', { turn: { id: 'turn' } });
  emit('item/started', { item: { type: 'mcpToolCall', id: 'tool', tool: 'read', server: 'local', arguments: { a: 1 }, status: 'inProgress' } });
  const row = s.messages[0]; assert.equal(row.status, 'running'); assert.equal(row.input, '{\n  "a": 1\n}');
  emit('item/mcpToolCall/progress', { itemId: 'tool', message: 'loading' }); assert.equal(row.text, 'loading');
  emit('item/completed', { item: { type: 'mcpToolCall', id: 'tool', server: 'local', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: 'final complete output' }] } } });
  assert.equal(s.messages.length, 1); assert.equal(row.text, 'final complete output'); assert.equal(row.status, 'complete');
  emit('item/started', { item: { type: 'fileChange', id: 'patch', changes: [{ path: 'x', kind: { type: 'add' }, diff: '+one' }] } });
  const patch = s.messages[1]; emit('item/fileChange/patchUpdated', { itemId: 'patch', changes: [{ path: 'x', kind: { type: 'add' }, diff: '+two' }] });
  assert.equal(patch.text, 'add x\n+two');
  emit('item/completed', { item: { type: 'fileChange', id: 'patch', status: 'declined', changes: [{ path: 'x', kind: { type: 'add' }, diff: '+two' }] } });
  assert.equal(patch.status, 'declined'); assert.equal(s.messages.length, 2);
  assert.equal(toolStatus({ success: false }, true), 'failed');
});

test('native web search words follow native lifecycle rather than localized captions', () => {
  const {webSearchTitle}=require('../codex-tool-content.cjs');
  assert.equal(webSearchTitle(null,'',false),'Browsing the web');
  assert.equal(webSearchTitle(null,'',true),'Searched the web');
  assert.equal(webSearchTitle({type:'search',query:'Seattle weather'},'',true),'Searched the web for Seattle weather');
  assert.equal(webSearchTitle({type:'openPage',url:'https://example.test'},'',true),'Opened https://example.test');
  assert.equal(webSearchTitle({type:'findInPage',pattern:'needle',url:'https://example.test'},'',false),"Searching for 'needle' in https://example.test");
});
for (const cut of [null,'interrupted','failed']) test('history web search uses its exact native boundary and preserves earlier cut: '+cut,()=>{
  const {applyCodexTurnHistory}=require('../native-blocks.cjs');
  const row={id:'native:N:tool:search',kind:'tool',toolKind:'webSearch',nativeId:'N',turnId:'T',status:'running',input:'Seattle',text:JSON.stringify({action:{type:'search',query:'Seattle'}})};
  const other={...row,id:'native:N:tool:other',turnId:'OTHER'};
  const s={nativeId:'N',messages:[row,other,...(cut?[{id:'native:N:turn:T',nativeId:'N',kind:'turn',turnId:'T',status:cut,text:''}]:[])]};
  applyCodexTurnHistory(s,[{id:'T',status:'completed'}],{});
  assert.equal(row.status,cut?'unconfirmed':'complete');
  if(!cut)assert.equal(row.title,'Searched the web for Seattle');
  assert.equal(other.status,'running');
});
