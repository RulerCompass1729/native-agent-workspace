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
  // Account scope belongs to the native connection, never to a turn or model guess.
  function codexAccountUsage(value, previous = null, now = Date.now()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const label = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined;
    const window = (v, kind) => {
      if (!v || typeof v !== 'object' || !amount(v.usedPercent)) return null;
      return { kind, usedPercent: v.usedPercent,
        ...(count(v.windowDurationMins) && v.windowDurationMins > 0 ? { windowDurationMins: v.windowDurationMins } : {}),
        ...(count(v.resetsAt) && v.resetsAt <= 8640000000000 ? { resetsAt: v.resetsAt } : {}) };
    };
    const mapped = value.rateLimitsByLimitId;
    const entries = mapped && typeof mapped === 'object' && !Array.isArray(mapped) && Object.keys(mapped).length
      ? Object.entries(mapped) : [['', value.rateLimits]];
    const buckets = new Map(previous?.source === 'codex-account-rate-limits' ? previous.buckets.map(b => [b.id || '', b]) : []);
    let accepted = false;
    for (const [key, v] of entries) {
      if (!v || typeof v !== 'object' || Array.isArray(v) || !['primary', 'secondary'].some(k => Object.hasOwn(v, k))) continue;
      const id = label(v.limitId) || label(key), name = label(v.limitName);
      if (label(key) && label(v.limitId) && key !== v.limitId) continue;
      const windows = ['primary', 'secondary'].flatMap(k => { const w = window(v[k], k); return w ? [w] : []; });
      const reached = label(v.rateLimitReachedType);
      // An anonymous native snapshot cannot be attributed to an older bucket.
      // Drop ambiguous old readings rather than display them as current too.
      if (!id) buckets.clear();
      else buckets.delete('');
      buckets.set(id || '', { ...(id ? { id } : {}), ...(name ? { name } : {}), windows,
        ...(reached ? { rateLimitReachedType: reached } : {}), reportedAt: now });
      accepted = true;
    }
    return accepted ? { source: 'codex-account-rate-limits', buckets: [...buckets.values()] } : null;
  }
  function codexQuotaError(error) {
    const kind = value => ['usageLimitExceeded', 'usage_limit_exceeded'].includes(value) ? 'usage_limit_exceeded' : null;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
    const camel = error.codexErrorInfo, snake = error.codex_error_info;
    if (camel !== undefined && snake !== undefined && (!kind(camel) || kind(camel) !== kind(snake))) return null;
    if (!kind(camel ?? snake)) return null;
    const reset = error.resetsAt ?? error.resets_at;
    return { kind: 'usage_limit_exceeded',
      ...(count(reset) && reset <= 8640000000000 && (error.resetsAt === undefined || error.resets_at === undefined || error.resetsAt === error.resets_at)
        ? { resetsAt: reset } : {}) };
  }
  // A model label alone cannot establish that a different quota bucket is usable.
  function codexQuotaBlock(session) {
    const q = session?.nativeQuota;
    return session?.provider === 'codex' && q?.kind === 'usage_limit_exceeded' &&
      typeof q.nativeId === 'string' && q.nativeId && q.nativeId === session.nativeId &&
      typeof q.turnId === 'string' && q.turnId && count(q.observedAt) &&
      (q.model === null || typeof q.model === 'string') ? q : null;
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
    } else if (provider === 'codex' && (usage?.total || usage?.account?.source === 'codex-account-rate-limits')) {
      const account = usage.account?.source === 'codex-account-rate-limits' ? usage.account : null;
      if (usage.total) {
        const t = usage.total, last = usage.last || {};
        lines.push(text('usage.total', { input: number(t.inputTokens), cached: number(t.cachedInputTokens), output: number(t.outputTokens) }));
        lines.push(text('usage.last', { input: number(last.inputTokens), output: number(last.outputTokens), window: number(usage.modelContextWindow) }));
      }
      lines.push(text(account ? 'usage.noCostOnly' : 'usage.noCosts'));
      if (usage.total) lines.push(count(usage.reportedAt) ? text('usage.timestamp', { time: new Date(usage.reportedAt).toLocaleString(language) }) : text('usage.noTimestamp'));
      for (const bucket of account?.buckets || []) {
        lines.push(text('usage.accountBucket', { name: bucket.name || bucket.id || text('usage.unreported') }));
        for (const w of bucket.windows) lines.push(text('usage.accountWindow', {
          duration: count(w.windowDurationMins) ? text('usage.minutes', { count: w.windowDurationMins }) : text('usage.unreported'),
          percent: w.usedPercent, reset: count(w.resetsAt) ? text('usage.reset', { time: new Date(w.resetsAt * 1000).toLocaleString(language) }) : '' }));
        if (!bucket.windows.length) lines.push(text('usage.noLimits'));
        if (bucket.rateLimitReachedType) lines.push(text('usage.nativeLimitState', { state: bucket.rateLimitReachedType }));
        lines.push(count(bucket.reportedAt) ? text('usage.accountTimestamp', { time: new Date(bucket.reportedAt).toLocaleString(language) }) : text('usage.noTimestamp'));
      }
      return lines;
    } else return [text('usage.noData')];
    lines.push(count(usage.reportedAt) ? text('usage.timestamp', { time: new Date(usage.reportedAt).toLocaleString(language) }) : text('usage.noTimestamp'));
    return lines;
  }
  const api = { claudeUsage, codexAccountUsage, codexQuotaError, codexQuotaBlock, usageLines };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceUsage = api;
})(typeof window === 'object' ? window : globalThis);
