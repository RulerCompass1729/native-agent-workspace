// T-146: every name a GUI script looks up must be one the interface can show, so a renamed control
// fails here, in the unit suite, instead of silently stopping a GUI script at that step.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { check, literals } = require('../../scripts/check-gui-names.cjs');

test('every name the GUI scripts look up exists in the interface source', () => {
  const result = check();
  assert.ok(result.checked > 400, `only ${result.checked} lookups found; the scan itself may be broken`);
  assert.deepEqual(result.missing, [], 'Rename the lookup to the current interface text (node scripts/check-gui-names.cjs lists them)');
});

function repository(t, app, script, fixture = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-gui-names-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['app/renderer', 'scripts/fixtures']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app/renderer/r.js'), app.join('\n'));
  fs.writeFileSync(path.join(dir, 'app/renderer/index.html'), '<button id="privacy" aria-label="查看隐私与用量"><span>隐私</span>与用量</button>');
  fs.writeFileSync(path.join(dir, 'scripts/fixtures/emit.cjs'), fixture);
  fs.writeFileSync(path.join(dir, 'scripts/test-a.cjs'), script.join('\n'));
  return check(dir);
}
const APP = [
  "const join = '加入此空间';",
  "const one = s => `加入 ${s.name}`;",
  "const outcome = (status, n) => `${{ failed: '失败', interrupted: '已中断' }[status]} ${n}`;",
  "const membership = (c, r) => `${c ? '离开' : '加入'}「${r.name}」`;",
  "const copy = text => '复制：' + text;",
  "notice('加入协作不会自动分享私人历史。');",
  "menu({ items: [{ id: 'detach', label: '脱出协作' }] });",
  "const send = { kind: 'none', label: '暂不可发送', hint: '…' };",
];

test('exact names need a whole string or a template with words; data, counts, holes and concatenations are understood', t => {
  const result = repository(t, APP, [
    "await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();",
    "await page.getByRole('button', { name: '加入 共同工作', exact: true }).click();",
    "await page.locator('summary', { hasText: '已中断 1' }).waitFor();", // a choice inside a hole, plus a count
    "await page.getByRole('menuitem', { name: '离开「共同工作」', exact: true }).click();",
    "await page.getByRole('menuitem', { name: `${join ? '加入' : '离开'}「${space}」`, exact: true }).click();", // both choices exist
    "await page.getByText('复制：' + text, { exact: true }).click();",
    "await page.getByRole('button', { name: /^复制：/ }).click();", // a regular expression's fixed start
    "await page.getByRole('button', { name: '查看隐私与用量', exact: true }).click();",
    "await page.getByText('隐私与用量', { exact: true }).waitFor();", // an element's whole text over its children
    "await create('Session X'); await page.getByText('Session X', { exact: true }).click();", // the test's own data
    "await page.getByText('Fixture said hi', { exact: true }).waitFor();", // a fixture's data
    "await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click();",
    "await page.getByRole('button', { name: '暂不可发送', exact: true }).waitFor();", // a label, but not of a menu item
    "await page.getByRole('button', { name: /任何|名字/ }).click();", // no fixed start: not checked
    "await page.getByRole('button', { name: label, exact: true }).click();", // a variable: not checked
  ], "send({ text: 'Fixture said hi' });");
  assert.deepEqual(result.missing, []);
  assert.equal(result.checked, 11, 'the two lines of data are not lookups');
});

test('renamed names are reported wherever and however a script looks them up', t => {
  const result = repository(t, APP, [
    "await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();", // a sentence contains it
    "await page.getByRole('button', { name: '加入共同工作', exact: true }).click();", // the template has a space
    "await page.getByRole('menuitem', { name: '脱出「共同工作」', exact: true }).click();", // 「…」 alone is not enough
    "await page.getByRole('menuitem', { name: `${join ? '加入' : '脱出'}「${space}」`, exact: true }).click();", // one choice is gone
    "await page.getByRole('button', { name: '加入协作' + suffix, exact: true }).click();", // a hole does not make it a substring
    "await page.getByRole('button', { name: '脱出协作', exact: true }).click();", // only a menu item has it
    "await page.getByRole('button', { name: /^旧名：/ }).click();",
    "const item = name => page.getByRole('menuitem', { name, exact: true }); await item('退出协作').click();", // through a helper
    "for (const name of ['移出协作']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 1);", // a loop
    "assert.ok(text.includes('请先点退回协作再继续')); await page.getByRole('button', { name: '退回协作', exact: true }).click();", // data mentions it
  ], "send({ text: '加入协作的旧说明' });"); // so does a fixture
  assert.deepEqual(result.missing.map(m => m.name), ['加入协作', '加入共同工作', '脱出「共同工作」', '脱出「…」', '加入协作…', '脱出协作', '/^旧名：/', '退出协作', '移出协作', '退回协作']);
});

test('a name a fixture both looks up and passes along is still checked, there and in every script', t => {
  const fixture = "async function wait(page, label) { await page.waitForFunction(text => document.title === text, label); }\n" +
    "async function join(page) { await page.getByRole('menuitem', { name: '入伙', exact: true }).click(); await wait(page, '入伙'); }";
  const result = repository(t, APP, ["await page.getByRole('menuitem', { name: '入伙', exact: true }).click();"], fixture);
  assert.deepEqual(result.missing.map(m => [m.file, m.name]), [[path.join('scripts', 'test-a.cjs'), '入伙'], [path.join('scripts', 'fixtures', 'emit.cjs'), '入伙']]);
});

test('a regular expression name is checked by the text it always starts with', () => {
  const { rawLookups } = require('../../scripts/check-gui-names.cjs');
  const starts = body => rawLookups(`page.getByRole('button', { name: /${body}/ })`).map(l => l.name);
  assert.deepEqual(starts('^复制：'), ['复制：']);
  assert.deepEqual(starts('^原生\\s+状态'), ['原生']);
  assert.deepEqual(starts('^复制图?片'), ['复制']);
  assert.deepEqual(starts('^已\\d+项'), []);
  assert.deepEqual(starts('复制'), []);
});

test('the source reader skips comments and reads strings, template holes and regular expressions', () => {
  const found = literals("// '注释'\n/* '也是注释' */ const r = /'不是字符串'/g; const a = 'yes', b = `x ${f('inner')} y`;\nconst c = 1 / 2 / 'z'.length;");
  assert.deepEqual(found.map(l => [l.kind, l.text]), [['regex', "'不是字符串'"], ['string', 'yes'], ['template', 'x  y'], ['string', 'inner'], ['string', 'z']]);
});
