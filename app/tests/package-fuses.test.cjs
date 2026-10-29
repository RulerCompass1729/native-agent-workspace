const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { afterExtractFuses, verifyPackageFuses, inspectVendorFuses, packageFuseOptions } = require('../../scripts/package-fuses.cjs');
const marker = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
function fixture(t, bits = '101100011', version = 1, copies = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-fuses-')), app = path.join(root, 'Electron.app');
  const file = path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = Buffer.concat([Buffer.from('synthetic-prefix'), ...Array.from({ length: copies }, () => Buffer.concat([marker, Buffer.from([version, bits.length]), Buffer.from(bits)])), Buffer.from('synthetic-tail')]); fs.writeFileSync(file, data);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, app, file, data, apply: () => afterExtractFuses({ buildPath: root, platform: 'darwin' }) };
}
test('vendor byte fixture closes only NODE_OPTIONS and Node CLI inspector, retaining RunAsNode', async t => {
  const f = fixture(t); await assert.rejects(verifyPackageFuses(f.app), /did not verify/); await f.apply();
  const wire = await verifyPackageFuses(f.app); assert.equal(wire[0], 49); assert.equal(wire[2], 48); assert.equal(wire[3], 48);
  const expected = Buffer.from(f.data), offset = expected.indexOf(marker) + marker.length + 2;
  expected[offset + 2] = expected[offset + 3] = 48; assert.deepEqual(fs.readFileSync(f.file), expected);
});
test('unrelated cookie, ASAR and snapshot states stay exactly as supplied', async t => {
  const f = fixture(t, '111111101'); await f.apply(); const wire = await verifyPackageFuses(f.app);
  assert.equal(wire[1], 49); assert.equal(wire[4], 49); assert.equal(wire[5], 49); assert.equal(wire[6], 49); assert.equal(wire[7], 48); assert.equal(wire[8], 49);
});
test('removed, missing and already-disabled critical vendor fuses fail without writes', async t => {
  for (const bits of ['101r00011', '101', '001100011', '100100011']) {
    const f = fixture(t, bits); await assert.rejects(f.apply(), /supported, enabled vendor fuses/); assert.deepEqual(fs.readFileSync(f.file), f.data);
  }
});
test('unknown, absent or multiple fuse wires fail before any write', async t => {
  for (const [version, copies] of [[2, 1], [1, 0], [1, 2]]) {
    const f = fixture(t, '101100011', version, copies); await assert.rejects(f.apply()); assert.deepEqual(fs.readFileSync(f.file), f.data);
  }
});
test('post-package verification catches tampering and disabled RunAsNode', async t => {
  const f = fixture(t); await f.apply(); const bytes = fs.readFileSync(f.file), offset = bytes.indexOf(marker) + marker.length + 2;
  for (const index of [0, 2, 3]) {
    const bad = Buffer.from(bytes); bad[offset + index] = index === 0 ? 48 : 49; fs.writeFileSync(f.file, bad); await assert.rejects(verifyPackageFuses(f.app), /did not verify/);
  }
});
test('extract hook rejects wrong platform or missing app', async t => {
  const f = fixture(t); await assert.rejects(afterExtractFuses({ buildPath: f.root, platform: 'linux' }), /macOS/);
  await assert.rejects(afterExtractFuses({ buildPath: path.join(f.root, 'missing'), platform: 'darwin' })); assert.deepEqual(fs.readFileSync(f.file), f.data);
});
test('the real packager hook runner invokes the configured extraction array', async t => {
  const { runHooks } = await import('../../node_modules/@electron/packager/dist/hooks.js');
  assert.equal(Array.isArray(packageFuseOptions.afterExtract), true);
  const f = fixture(t); await runHooks(packageFuseOptions.afterExtract, { buildPath: f.root, platform: 'darwin', arch: 'arm64', electronVersion: '44.9.0' }); await verifyPackageFuses(f.app);
});
if (process.env.NAW_VENDOR_FRAMEWORK) test('actual vendor Framework stays read-only while a scratch copy receives the fuse policy', async t => {
  const { current } = await inspectVendorFuses(process.env.NAW_VENDOR_FRAMEWORK);
  assert.equal(current[0], 49); assert.equal(current[2], 49); assert.equal(current[3], 49);
  console.log('READONLY_VENDOR_WIRE', Object.entries(current).filter(([k]) => k !== 'version').map(([, v]) => String.fromCharCode(v)).join(''));
  const f = fixture(t); fs.copyFileSync(process.env.NAW_VENDOR_FRAMEWORK, f.file); await f.apply();
  const changed = await verifyPackageFuses(f.app);
  console.log('SCRATCH_FRAMEWORK_WIRE', Object.entries(changed).filter(([k]) => k !== 'version').map(([, v]) => String.fromCharCode(v)).join(''));
});
