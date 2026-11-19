const test = require('node:test'), assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const source = require('../regular-popup-source.cjs'), pricing = require('../regular-popup-dsh.cjs');
const { RegularPopup, emptyState } = require('../regular-popup.cjs');
const html = '<article class="Box-row"><h2><a href="/example/tool">tool</a></h2><p>Public description</p></article>';
function boundedParse(kind) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const { EventEmitter } = require('node:events'), s = require(workerData.file), start = performance.now();
      const unit = '<article class="Box-row">', broken = unit.repeat(Math.floor(s.MAX_BYTES / unit.length));
      const body = workerData.kind === 'description' ? '<article class="Box-row"><h2><a href="/example/tool">x</a></h2><p>' + '<'.repeat(s.MAX_BYTES - 200) + '</p></article>' : broken;
      const done = outcome => parentPort.postMessage({ outcome, elapsed: performance.now() - start });
      if (workerData.kind !== 'read') { try { s.parseTrending(body); done('accepted'); } catch { done('rejected'); } }
      else { const get = (_, options, callback) => { const req = new EventEmitter(); req.destroy = () => {};
        queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'text/html' }; res.destroy = () => {}; callback(res); res.emit('data', Buffer.from(body)); res.emit('end'); }); return req; };
        s.readSource({}, { get }).then(() => done('accepted'), () => done('rejected')); }
    `, { eval: true, workerData: { kind, file: require.resolve('../regular-popup-source.cjs') }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    let settled = false;
    const timer = setTimeout(async () => { if (settled) return; settled = true; await worker.terminate(); resolve({ outcome: 'deadline-exceeded' }); }, 1500);
    worker.once('message', async result => { if (settled) return; settled = true; clearTimeout(timer); await worker.terminate(); resolve(result); });
    worker.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
  });
}
for (const kind of ['parse', 'read', 'description']) test('F1: bounded rejection of adversarial source ' + kind, async () => {
  const result = await boundedParse(kind); assert.equal(result.outcome, 'rejected'); assert.ok(result.elapsed < 1000);
});
test('F1: parsing cannot succeed after its monotonic deadline', () => {
  assert.throws(() => source.parseTrending(html, { deadline: performance.now() - 1 }));
});
test('F1: bounded scanner retains candidates while ignoring comments and raw script/style contents', () => {
  const deceptive = '<!-- <article class="Box-row"> -->' + '<script>const x="<article class=Box-row>";</script><style>p{content:"<"}</style>';
  assert.deepEqual(source.parseTrending(deceptive + html), [{ id: 'repo-0', title: 'example/tool', description: 'Public description', url: 'https://github.com/example/tool' }]);
  for (const malformed of [html + '<article class="Box-row">', html + html, html.replace('Public description', '<script>unterminated')]) assert.throws(() => source.parseTrending(malformed));
  assert.equal(source.parseTrending(html.replace('Public description', 'İ<script>ignored</ScRiPt>public'))[0].description, 'İ public');
});
test('F1: real production 15-second deadline closes a stalled HTTP response', async () => {
  let requests = 0, destroyed = 0;
  const get = (_, options, callback) => { requests++; const req = new EventEmitter(); req.destroy = () => { destroyed++; };
    queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'text/html' }; res.destroy = () => {}; callback(res); res.emit('data', Buffer.from(html)); }); return req; };
  const start = performance.now(); await assert.rejects(source.readSource({}, { get }));
  assert.ok(performance.now() - start >= 14000); assert.ok(performance.now() - start < 18000); assert.equal(requests, 1); assert.equal(destroyed, 1);
});
const usage = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 100, totalTokens: 1200, providerAt: Date.parse('2027-01-01T00:00:00Z'), tier: 'peak-bound' };
test('F2: valid dates without a qualified calendar use the qualified peak upper bound', () => {
  for (const date of ['2027-01-01T00:00:00Z', '2027-11-21T12:00:00Z', '2026-11-18T04:00:00Z']) {
    const providerAt = Date.parse(date); assert.equal(pricing.tariff(providerAt), 'peak-bound'); assert.equal(pricing.priceUsage({ ...usage, providerAt }), 421);
  }
  assert.equal(pricing.priceUsage({ ...usage, inputTokens: 16000, cachedInputTokens: 0, outputTokens: 1200, totalTokens: 17200 }), 6240);
  for (const invalid of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) assert.equal(pricing.tariff(invalid), 'unknown');
  assert.equal(pricing.priceUsage({ ...usage, providerAt: Date.parse('2026-11-18T12:00:00Z') }), 421);
  assert.equal(pricing.priceUsage(usage, { model: pricing.MODEL, qualified: false, input: 300, cached: 6, output: 1200 }), null);
});
test('F2: 2027 reaches the credential seam instead of the former year refusal, with no real key or worker', async () => {
  const OriginalDate = global.Date; let credentialCalls = 0;
  global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2027-01-01T00:00:00Z'])); } };
  try {
    await assert.rejects(require('../regular-popup-transport.cjs').runWorker({ concern: 'tools', candidates: [] }, { signal: new AbortController().signal }, { readKey: async () => { credentialCalls++; throw Error('synthetic stop before egress'); } }));
    assert.equal(credentialCalls, 1);
  } finally { global.Date = OriginalDate; }
});
test('F2: unqualified rates pause explicitly before credentials and release the unspent reservation', async () => {
  const previous = pricing.pricingQualified; let credentialCalls = 0, saved = null;
  pricing.pricingQualified = () => false;
  const e = new RegularPopup({ store: { read: () => saved, write: value => saved = structuredClone(value) }, permitted: true,
    readSource: async () => [{ id: 'x', title: 'Public tool', description: 'public', url: 'https://github.com/example/tool' }],
    select: (input, options) => require('../regular-popup-transport.cjs').runWorker(input, { signal: options.signal, authorize: options.authorize }, { readKey: async () => { credentialCalls++; throw Error('must not read a key'); } }) });
  try {
    e.configure({ enabled: true, concern: 'tools', time: '00:00' }); await e.tick(); await e.tick();
    assert.equal(credentialCalls, 0); assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].state, 'pricing-paused');
    assert.equal(saved.runs[0].attempted, false); assert.equal(saved.runs[0].chargedMicros, 0);
  } finally { e.dispose(); if (previous === undefined) delete pricing.pricingQualified; else pricing.pricingQualified = previous; }
});
test('F2: historical confirmed cost and old unknown-date usage are not recalculated', () => {
  const state = emptyState(), at = Date.parse('2026-11-18T12:00:00Z');
  state.runs = [{ id: 'confirmed', day: '2026-11-18', budgetDay: '2026-11-18', at, state: 'ready', chargedMicros: 211, costKnown: true,
    usage: { ...usage, providerAt: at, tier: 'offpeak' }, attempted: true, items: [] },
  { id: 'legacy-unknown', day: '2027-01-01', budgetDay: '2027-01-01', at: usage.providerAt, state: 'unconfirmed', chargedMicros: 7000, costKnown: false,
    usage: { ...usage, tier: 'unknown' }, attempted: true, items: [] }];
  const e = new RegularPopup({ store: { read: () => state, write: () => assert.fail('History must not be rewritten') } });
  assert.equal(e.status().error, null); assert.deepEqual(e.status().runs, state.runs); e.dispose();
});
test('F2: a forged pricing error or a refusal after dispatch cannot erase reserved cost', async () => {
  for (const dispatched of [false, true]) {
    const previous = pricing.pricingQualified;
    const e = new RegularPopup({ store: { read: () => null, write() {} }, permitted: true,
      readSource: async () => [{ id: 'x', title: 'Public tool', description: 'public', url: 'https://github.com/example/tool' }],
      select: async (_, { authorize }) => {
        if (!dispatched) throw Object.assign(Error('pricing-unqualified'), { code: 'pricing-unqualified' });
        authorize(); pricing.pricingQualified = () => false; pricing.assertPricingQualified();
      } });
    try {
      e.configure({ enabled: true, concern: 'tools', time: '00:00' }); await e.tick();
      assert.equal(e.status().runs[0].state, 'unconfirmed'); assert.equal(e.status().runs[0].chargedMicros, 7000); assert.equal(e.status().runs[0].attempted, true);
    } finally { e.dispose(); pricing.pricingQualified = previous; }
  }
});
