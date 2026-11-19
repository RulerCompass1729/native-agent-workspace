const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process'), path = require('node:path');
const { messages, defaultShape, THRESHOLDS, validateShape } = require('../../scripts/phone-acceptance.cjs');
test('synthetic workload retains every role and text length without copying original bodies', () => {
  const profile = { messages: 4, distribution: [{ role: 'tool', kind: 'tool', length: 3, count: 2 }, { role: 'assistant', kind: 'other', length: 25, count: 2 }] };
  const rows = messages(profile, 0);
  assert.equal(rows.length, 6); assert.deepEqual(rows.slice(0, 4).map(r => [r.role, r.text.length]), [['tool', 3], ['tool', 3], ['assistant', 25], ['assistant', 25]]);
  assert.equal(rows.at(-1).text, 'SYNTHETIC_LATEST_REPLY_0');
});
test('default reproducer has large per-thread history and a bounded phone network', () => {
  const shape = defaultShape(); assert.equal(shape.sessions.length, 120); assert.equal(shape.sessions[0].messages, 309);
  assert.equal(shape.sessions[0].distribution.reduce((n, d) => n + d.count, 0), 309);
  assert.equal(THRESHOLDS.rttMs, 80); assert.equal(THRESHOLDS.bytesPerSecond, 262144); assert.equal(THRESHOLDS.backMs, 500);
});
test('shape reader discards names, paths, bodies and unknown role/kind values', () => {
  const input = { sessions: [{ name: 'PRIVATE_SENTINEL_NAME', cwd: 'PRIVATE_SENTINEL_PATH', messages: [
    { role: 'assistant', kind: 'text', text: 'PRIVATE_SENTINEL_BODY' },
    { role: 'PRIVATE_SENTINEL_ROLE', kind: 'PRIVATE_SENTINEL_KIND', text: '字\n😀' }] }], rooms: [{ queue: [{ text: 'PRIVATE_SENTINEL_QUEUE' }] }] };
  const code = `import importlib.util,json,sys;spec=importlib.util.spec_from_file_location('shape',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print(json.dumps(m.shape(sys.stdin.buffer.read())))`;
  const r = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', code, path.resolve(__dirname, '../../scripts/phone-shape.py')], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /PRIVATE_SENTINEL/);
  const result = JSON.parse(r.stdout); assert.equal(result.sessions[0].messages, 2); assert.equal(result.rooms, 1); assert.deepEqual(result.queues, [1]);
  assert.ok(result.sessions[0].distribution.some(d => d.role === 'assistant' && d.length === 21));
  assert.ok(result.sessions[0].distribution.some(d => d.role === 'other' && d.length === 4));
});
test('only bounded metadata distributions may become a fixture', () => {
  assert.equal(validateShape(defaultShape()).sessions.length, 120);
  for (const mutate of [s => { s.sessions[0].text = 'PRIVATE_BODY'; }, s => { s.sessions[0].messages++; },
    s => { s.sessions[0].distribution[0].role = 'PRIVATE_NAME'; }, s => { s.sessions[0].distribution[0].length = 2 ** 30; }]) {
    const s = defaultShape(); mutate(s); assert.throws(() => validateShape(s));
  }
});
