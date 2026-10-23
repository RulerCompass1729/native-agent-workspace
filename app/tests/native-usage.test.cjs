const test = require('node:test'), assert = require('node:assert/strict');
const { claudeUsage, usageLines } = require('../native-usage.js');

test('native usage keeps zero, strips unrelated/private fields and never invents missing counts', () => {
  const value = claudeUsage({ context: { window: 200000, tokens: 0, percent: 0, breakdown: 'PRIVATE' },
    cost: { usd: 0 }, token: 'PRIVATE', rateLimits: [{ kind: 'seven_day', percentUsed: 100 }, { kind: 'private-account', percentUsed: 10 }] }, 1234);
  assert.equal(value.costUsd, 0); assert.equal(value.context.tokens, 0);
  assert.equal(value.rateLimits.length, 1); assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.match(usageLines('claude', value).join('\n'), /\$0\.0000/);
  assert.match(usageLines('claude', null).join('\n'), /未报告.*不能据此判断为零/);
  assert.equal(claudeUsage({ context: { window: -1 } }), null);
  const missing = claudeUsage({ context: { window: 100, tokens: NaN, percent: 150 }, cost: { usd: -1 }, rateLimits: [{ kind: 'spend_limit', percentUsed: Infinity }] });
  assert.equal(missing.context.tokens, undefined); assert.equal(missing.costUsd, undefined);
  assert.ok(!usageLines('claude', missing).join('\n').includes('150%'));
  for (const costUsd of [0.000048, 0.000032, 1e-10]) {
    const text = usageLines('claude', { ...value, costUsd }).join('\n');
    assert.match(text, /<\$0\.0001/); assert.ok(!text.includes('$0.0000'));
  }
});

test('Codex cumulative usage is not summed with cache or called context occupancy / billed USD', () => {
  const text = usageLines('codex', { total: { inputTokens: 900000, cachedInputTokens: 800000, outputTokens: 0 },
    last: { inputTokens: 12, outputTokens: 0 }, modelContextWindow: 200000 }).join('\n');
  assert.match(text, /其中缓存输入/); assert.match(text, /最近一次请求：输入 12/);
  assert.ok(!text.includes('%') && !text.includes('$') && !text.includes('1,700,000'));
  assert.match(text, /金额与额度窗口：此接口未报告/);
});
