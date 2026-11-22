const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { carrySettings } = require('../queue-dispatch.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resume-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = path.join(dir, 'home', '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'claude-fable-5-2' }));
  const output = path.join(dir, 'argv.json'), binary = path.join(dir, 'claude');
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'), argv = process.argv.slice(2);
const defaults = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, 'utf8'));
const index = argv.indexOf('--model');
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ argv, model: index < 0 ? defaults.model : argv[index + 1] }));
`, { mode: 0o700 });
  const host = { binaries: { claude: binary }, privateDir: dir, hookTargets: new Map(),
    hookSocket: path.join(dir, 'hook.sock'), submitSocket: path.join(dir, 'submit.sock') };
  return async values => {
    fs.rmSync(output, { force: true });
    const record = { id: randomUUID(), nativeId: randomUUID(), name: 'Synthetic session', cwd: dir, ...values };
    const runtime = new Claude(record, host);
    try { await once(runtime.terminal, 'closed'); }
    finally { runtime.submission.close(); }
    return { ...JSON.parse(fs.readFileSync(output, 'utf8')), record };
  };
}

test('resume keeps the requested model over a different last report and global default', async t => {
  const launch = fixture(t), nativeId = randomUUID();
  const result = await launch({ nativeId, recovering: true, model: 'claude-sonnet-5-5',
    requestedSettings: { model: 'claude-opus-5-5' }, nativePermissionMode: 'bypassPermissions', nativeEffort: 'xhigh' });
  assert.deepEqual(result.argv.slice(0, 2), ['--resume', nativeId]);
  assert.equal(result.argv.filter(value => value === '--model').length, 1);
  assert.equal(result.argv[result.argv.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(result.model, 'claude-opus-5-5');
  assert.equal(result.argv[result.argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(result.argv[result.argv.indexOf('--effort') + 1], 'xhigh');
  assert.equal(result.argv.includes('--session-id'), false);
});

for (const requestedSettings of [undefined, {}, { model: '' }]) {
  test(`resume falls back to its reported model with requested settings ${JSON.stringify(requestedSettings)}`, async t => {
    const launch = fixture(t);
    const result = await launch({ recovering: true, requestedSettings, model: 'claude-opus-5-5', nativePermissionMode: 'auto' });
    assert.equal(result.argv[result.argv.indexOf('--model') + 1], 'claude-opus-5-5');
    assert.equal(result.model, 'claude-opus-5-5');
    assert.equal(result.argv.includes('--permission-mode'), false, 'Recovery must not add a permission override');
  });
}

test('missing or placeholder model reports leave native resume defaults unchanged', async t => {
  const launch = fixture(t);
  for (const model of [undefined, null, '', '原生默认', '原生未报告', 'Native default', 123]) {
    const result = await launch({ recovering: true, model });
    assert.equal(result.argv.includes('--model'), false, `No model override for ${JSON.stringify(model)}`);
    assert.equal(result.model, 'claude-fable-5-2');
  }
});

test('a rotated successor keeps the carried model on creation and later resume', async t => {
  const launch = fixture(t), nativeId = randomUUID();
  const carry = carrySettings({ provider: 'claude', roomIds: ['shared'], model: 'claude-opus-5-5', nativeEffort: 'xhigh', nativePermissionMode: 'auto' });
  assert.deepEqual(carry.settings, { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' });
  const fresh = await launch({ nativeId, requestedSettings: carry.settings, model: '原生默认' });
  assert.deepEqual(fresh.argv.slice(0, 2), ['--session-id', nativeId]);
  assert.equal(fresh.model, 'claude-opus-5-5');
  assert.equal(fresh.argv[fresh.argv.indexOf('--effort') + 1], 'xhigh');
  assert.equal(fresh.argv[fresh.argv.indexOf('--permission-mode') + 1], 'auto');
  const resumed = await launch({ ...fresh.record, recovering: true, model: 'claude-opus-5-5', nativeEffort: 'xhigh', nativePermissionMode: 'auto' });
  assert.deepEqual(resumed.argv.slice(0, 2), ['--resume', nativeId]);
  assert.equal(resumed.model, 'claude-opus-5-5');
  assert.equal(resumed.argv[resumed.argv.indexOf('--effort') + 1], 'xhigh');
  assert.equal(resumed.argv.includes('--permission-mode'), false);
});

test('new sessions without a requested model still use native defaults', async t => {
  const launch = fixture(t), result = await launch({ model: 'claude-opus-5-5' });
  assert.equal(result.argv.includes('--model'), false);
  assert.equal(result.model, 'claude-fable-5-2');
});
