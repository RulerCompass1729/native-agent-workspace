// Native metadata only: never infer a bill, quota or context percentage.
(function (root) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function claudeUsage(value, now = Date.now()) {
    if (!value || !count(value.context?.window) || !value.context.window) return null;
    const context = { window: value.context.window };
    if (count(value.context.tokens)) context.tokens = value.context.tokens;
    if (amount(value.context.percent) && value.context.percent <= 100) context.percent = value.context.percent;
    const result = { source: 'claude-session-usage', reportedAt: now, context };
    if (amount(value.cost?.usd)) result.costUsd = value.cost.usd;
    result.rateLimits = (Array.isArray(value.rateLimits) ? value.rateLimits : []).slice(0, 8).flatMap(r => {
      if (!['five_hour', 'seven_day', 'spend_limit'].includes(r?.kind) || !amount(r.percentUsed)) return [];
      return [{ kind: r.kind, percentUsed: r.percentUsed,
        ...(typeof r.resetsAt === 'string' && r.resetsAt.length <= 40 && Number.isFinite(Date.parse(r.resetsAt)) ? { resetsAt: r.resetsAt } : {}) }];
    });
    return result;
  }
  function usageLines(provider, usage, language = 'zh') {
    const formatter = typeof module === 'object' && module.exports ? require('./ui-locale.js') : root.nativeWorkspaceLocale;
    const text = (key, params) => formatter.format(language, key, params);
    const number = n => count(n) ? n.toLocaleString(language) : text('usage.unreported');
    const lines = [];
    if (provider === 'claude' && usage?.source === 'claude-session-usage') {
      const c = usage.context || {};
      lines.push(text('usage.context', { tokens: number(c.tokens), window: number(c.window), percent: amount(c.percent) && c.percent <= 100 ? ` · ${c.percent}%` : '' }));
      const usd = amount(usage.costUsd) ? usage.costUsd > 0 && usage.costUsd < 0.0001 ? '<$0.0001' : '$' + usage.costUsd.toFixed(4) : text('usage.unreported');
      lines.push(text('usage.cost', { usd }));
      for (const r of Array.isArray(usage.rateLimits) ? usage.rateLimits : []) {
        const key = { five_hour: 'usage.fiveHour', seven_day: 'usage.sevenDay', spend_limit: 'usage.spend' }[r.kind];
        if (key && amount(r.percentUsed)) lines.push(text('usage.window', { label: text(key), percent: r.percentUsed, reset: r.resetsAt && Number.isFinite(Date.parse(r.resetsAt)) ? text('usage.reset', { time: new Date(r.resetsAt).toLocaleString(language) }) : '' }));
      }
      if (!usage.rateLimits?.length) lines.push(text('usage.noLimits'));
    } else if (provider === 'codex' && usage?.total) {
      const t = usage.total, last = usage.last || {};
      lines.push(text('usage.total', { input: number(t.inputTokens), cached: number(t.cachedInputTokens), output: number(t.outputTokens) }));
      lines.push(text('usage.last', { input: number(last.inputTokens), output: number(last.outputTokens), window: number(usage.modelContextWindow) }));
      lines.push(text('usage.noCosts'));
    } else return [text('usage.noData')];
    lines.push(count(usage.reportedAt) ? text('usage.timestamp', { time: new Date(usage.reportedAt).toLocaleString(language) }) : text('usage.noTimestamp'));
    return lines;
  }
  const api = { claudeUsage, usageLines };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceUsage = api;
})(typeof window === 'object' ? window : globalThis);
