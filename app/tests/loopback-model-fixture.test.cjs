// The B11 loopback fixture itself: no CLI, no model, no outside network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { create, CREDENTIAL_ENV } = require('../../scripts/fixtures/loopback-model.cjs');

const post = (port, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages?beta=true', method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end('{}');
});

test('the fixture binds 127.0.0.1 on a random port, proves the sandbox, and counts only fixture-credential requests', { skip: process.platform !== 'darwin' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-loopback-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = create({ directory, provider: 'claude', respond: (req, res) => { res.writeHead(200); res.end('{}'); } });
  t.after(() => fixture.stop());
  await fixture.start();
  assert.match(fixture.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.throws(() => fixture.wrapper('/bin/true', { file: path.join(directory, 'early') }), /preflight/);
  const preflight = await fixture.preflight();
  assert.deepEqual(preflight, { loopback: 'connected', unixSocket: 'connected', testNet: 'EPERM', dns: 'ECONNREFUSED', keychain: 'unreachable' });

  assert.equal(await post(fixture.port, { 'x-api-key': 'local-fixture' }), 200);
  assert.equal(await post(fixture.port, { 'x-api-key': 'local-fixture', authorization: 'Bearer something-else' }), 403);
  assert.equal(await post(fixture.port, { 'x-api-key': 'another-key' }), 403);
  const summary = fixture.summary();
  assert.equal(summary.requests, 1); assert.deepEqual(summary.paths, ['/v1/messages']);
  assert.equal(summary.credentialViolations, 2);
  assert.ok(!JSON.stringify(fixture.violations).includes('something-else'), 'Rejected credential values are not stored');

  const shim = fixture.wrapper('/usr/bin/true', { file: path.join(directory, 'claude-local'), env: { CLAUDE_CONFIG_DIR: directory }, args: ['--model', 'haiku'] });
  const text = fs.readFileSync(shim, 'utf8');
  assert.match(text, /os\.execv\("\/usr\/bin\/sandbox-exec"/);
  for (const key of CREDENTIAL_ENV) assert.ok(text.includes(JSON.stringify(key)), `${key} is removed before launch`);
  assert.match(text, /"ANTHROPIC_API_KEY":"local-fixture"/);
  assert.throws(() => fixture.wrapper('/usr/bin/true', { file: path.join(directory, 'bad'), env: { OPENAI_API_KEY: 'x' } }), /not configurable/);

  await fixture.stop();
  assert.equal(fixture.summary().stopped, true);
  await assert.rejects(post(summary.port, { 'x-api-key': 'local-fixture' }), /ECONNREFUSED/);
});
