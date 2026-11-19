const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process'), path = require('node:path');
const { messages, defaultShape, THRESHOLDS, validateShape, assertCheckpointChanged, receiptAssociations, messageVisibility } = require('../../scripts/phone-acceptance.cjs');
test('send feedback requires an on-screen message with unobscured hit targets, not merely DOM text', () => {
  function sample(rect, blocked = false, opacity = '1') {
    const element = { isConnected: true, parentElement: null, getBoundingClientRect: () => rect, contains: hit => hit === element };
    element.ownerDocument = { defaultView: { innerWidth: 390, innerHeight: 844, visualViewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 844 },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity }) }, elementFromPoint: () => blocked ? {} : element };
    return messageVisibility(element);
  }
  const rect = { left: 20, right: 370, top: 200, bottom: 250, width: 350, height: 50 };
  assert.equal(sample(rect).visible, true);
  assert.equal(sample({ ...rect, top: 1000, bottom: 1050 }).visible, false, 'the same DOM message below the viewport must fail');
  assert.equal(sample({ ...rect, left: 400, right: 750 }).visible, false);
  assert.equal(sample(rect, true).visible, false, 'an overlay may hide otherwise valid geometry');
  assert.equal(sample(rect, false, '0').visible, false);
});
test('a claimed visible transition rejects byte-identical screenshots without rejecting metadata-only checks', () => {
  const before = Buffer.from('synthetic screenshot');
  assert.throws(() => assertCheckpointChanged(before, Buffer.from(before), true), { code: 'HARNESS_DUPLICATE_CHECKPOINT' });
  assert.doesNotThrow(() => assertCheckpointChanged(before, Buffer.from('changed frame'), true));
  assert.doesNotThrow(() => assertCheckpointChanged(null, before, true));
  assert.doesNotThrow(() => assertCheckpointChanged(before, Buffer.from(before), false));
});
test('each receipt must identify its original input or action, independently of its generic outcome', () => {
  const original = [['SYNTHETIC_INPUT_ONE'], ['SYNTHETIC_INPUT_TWO'], ['Operations record', 'Got it']];
  assert.equal(receiptAssociations(['The session received it', 'The session received it', 'Action completed'], original).pass, false);
  const readable = ['The session received it: SYNTHETIC_INPUT_ONE', 'The session received it: SYNTHETIC_INPUT_TWO', 'Operations record: Got it. Action completed'];
  assert.equal(receiptAssociations(readable, original).pass, true);
  assert.equal(receiptAssociations([readable.join('\n')], original).pass, false, 'one combined receipt does not identify three separate outcomes');
  assert.equal(receiptAssociations([...readable, readable[0]], original).pass, false, 'ambiguous duplicate outcomes remain ambiguous');
});
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
