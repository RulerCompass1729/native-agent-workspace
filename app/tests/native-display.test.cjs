const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');
const nativeCompletionText = vm.runInNewContext('(' + source.match(/function nativeCompletionText\([\s\S]*?\n}/)[0] + ')');
test('native completion text is not translated or rebuilt from duration and local time', () => {
  const original = '✻ Cooked for 3s · done 4:55 PM';
  assert.equal(nativeCompletionText({kind:'turn',status:'complete',text:original,nativeDurationMs:3500,nativeCompletedAt:1700000000000}),original);
  assert.equal(nativeCompletionText({kind:'response',text:'程序准备好了。'}),'程序准备好了。');
});
test('obsolete app-authored completion captions disappear without hiding native failure or interruption', () => {
  assert.equal(nativeCompletionText({kind:'turn',status:'complete',text:'原生本轮已结束 · 3.5 秒'}),'');
  assert.equal(nativeCompletionText({kind:'turn',status:'interrupted',text:''}),'interrupted');
  assert.equal(nativeCompletionText({kind:'turn',status:'failed',text:'原生本轮未正常完成 · 3.5 秒\nOriginal native error'}),'Original native error');
  assert.equal(nativeCompletionText({kind:'turn',status:'failed',text:''}),'failed');
});

test('whitespace cannot hide the native abnormal boundary',()=>{
 for(const status of ['interrupted','failed'])for(const text of [' \n','原生本轮已结束 · 1 秒\n\n'])assert.equal(nativeCompletionText({kind:'turn',status,text}),status);
});
