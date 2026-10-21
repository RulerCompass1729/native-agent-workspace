const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readPreview, saveCopy, MAX_BYTES } = require('../local-files.cjs');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-files-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return name => path.join(dir, name); }
test('explicit preview retains exact UTF-8 bytes; export uses the viewed snapshot without overwriting', async t => {
  const file = fixture(t), source = file('材料.csv'), bytes = Buffer.from('\ufeff项目,成本\r\n书,12\r\n'); fs.writeFileSync(source, bytes);
  const preview = await readPreview(source); assert.equal(preview.name, '材料.csv'); assert.ok(preview.text.includes('书,12')); assert.deepEqual(preview.bytes, bytes);
  fs.writeFileSync(source, 'Changed after preview'); await saveCopy(preview, file('copy.csv'));
  assert.deepEqual(fs.readFileSync(file('copy.csv')), bytes); assert.equal(fs.statSync(file('copy.csv')).mode & 0o077, 0);
  await assert.rejects(saveCopy(preview, source), /已存在/); assert.equal(fs.readFileSync(source, 'utf8'), 'Changed after preview');
  fs.symlinkSync(source, file('export.csv')); await assert.rejects(saveCopy(preview, file('export.csv')), /已存在/);
});
test('bounded preview rejects binary, invalid encoding, oversize, symlink, directory and FIFO without hanging', async t => {
  const file = fixture(t);
  for (const [name, bytes] of [['binary.txt', Buffer.from([0,1])], ['invalid.md', Buffer.from([0xc3, 0x28])], ['large.csv', Buffer.alloc(MAX_BYTES + 1, 65)]]) {
    fs.writeFileSync(file(name), bytes); await assert.rejects(readPreview(file(name)), /无法预览/);
  }
  fs.writeFileSync(file('ok.txt'), 'text'); fs.symlinkSync(file('ok.txt'), file('link.txt')); fs.mkdirSync(file('directory.txt'));
  for (const name of ['link.txt', 'directory.txt']) await assert.rejects(readPreview(file(name)), /无法预览/);
  if (process.platform !== 'win32') { execFileSync('mkfifo', [file('pipe.txt')]); await assert.rejects(readPreview(file('pipe.txt')), /无法预览/); }
  await assert.rejects(readPreview(file('hidden.exe')), /请选择/); await assert.rejects(readPreview(file('bad\nname.txt')), /控制字符/);
  assert.equal((await readPreview(file('ok.txt'))).text, 'text');
});

test('a failed copy removes only its own partial output and permits a clean retry', async t => {
  const file = fixture(t); fs.writeFileSync(file('source.txt'), 'complete text'); const preview = await readPreview(file('source.txt'));
  const open = fs.promises.open;
  const mock = t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') { const write = handle.writeFile.bind(handle); handle.writeFile = async () => { await write('partial'); throw Error('disk full'); }; }
    return handle;
  });
  await assert.rejects(saveCopy(preview, file('copy.txt')), /未能保存/); assert.equal(fs.existsSync(file('copy.txt')), false);
  mock.mock.restore(); await saveCopy(preview, file('copy.txt')); assert.equal(fs.readFileSync(file('copy.txt'), 'utf8'), 'complete text');
});
