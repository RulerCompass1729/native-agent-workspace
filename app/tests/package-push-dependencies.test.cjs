const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRequire } = require('node:module');
test('package-mac includes the pinned push dependency closure and unmodified license/source files', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-push-payload-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const result = require('../../scripts/list-phone-push-payload.cjs').stagePushPayload(path.join(temporary, 'stage.noindex'));
  assert.equal(result.dependencies.length, 17);
  for (const name of ['web-push@3.6.7', 'http_ece@1.2.0', 'jws@4.0.1']) assert.ok(result.dependencies.includes(name));
  const requireStage = createRequire(path.join(result.app, 'package.json'));
  assert.equal(requireStage('web-push').generateVAPIDKeys().publicKey.length, 87);
  assert.equal(typeof requireStage('./app/mobile-push.cjs').MobilePush, 'function');
  assert.ok(result.files.some(f => f.endsWith('node_modules/web-push/LICENSE')));
  assert.ok(result.files.some(f => f.endsWith('node_modules/web-push/src/encryption-helper.js')));
});
test('importing web-push opens no network, process, timer or writable file', () => {
  const { execFileSync } = require('node:child_process');
  const probe = `
    const fail = () => { throw Error('Import I/O'); };
    for (const [name, methods] of Object.entries({ https:['request','get'], http:['request','get'], net:['connect','createConnection','createServer'], tls:['connect'], dns:['lookup','resolve'], child_process:['spawn','exec','execFile','fork'], fs:['writeFile','writeFileSync','appendFile','appendFileSync','createWriteStream','mkdir','mkdirSync','open','openSync'] })) {
      const m = require('node:' + name); for (const k of methods) m[k] = fail;
    }
    global.setTimeout = global.setInterval = fail;
    console.warn = console.error = fail;
    require('web-push'); process.stdout.write('IMPORT_NO_IO_PASS');
  `;
  assert.equal(execFileSync(process.execPath, ['-e', probe], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', env: { PATH: process.env.PATH } }), 'IMPORT_NO_IO_PASS');
});
