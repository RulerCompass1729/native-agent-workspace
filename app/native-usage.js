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
  function usageLines(provider, usage) {
    const number = n => count(n) ? n.toLocaleString() : '未报告';
    const lines = [];
    if (provider === 'claude' && usage?.source === 'claude-session-usage') {
      const c = usage.context || {};
      lines.push(`上下文：${number(c.tokens)} / ${number(c.window)} token${amount(c.percent) && c.percent <= 100 ? ` · ${c.percent}%` : ''}（最近一次请求，非累计）`);
      const usd = amount(usage.costUsd) ? usage.costUsd > 0 && usage.costUsd < 0.0001 ? '<$0.0001' : '$' + usage.costUsd.toFixed(4) : '未报告';
      lines.push(`原生 /cost 累计金额：${usd}；不是账户实际账单`);
      for (const r of Array.isArray(usage.rateLimits) ? usage.rateLimits : []) {
        const label = { five_hour: '5 小时', seven_day: '7 天', spend_limit: '支出' }[r.kind];
        if (label && amount(r.percentUsed)) lines.push(`原生${label}额度窗口：已用 ${r.percentUsed}%${r.resetsAt && Number.isFinite(Date.parse(r.resetsAt)) ? ' · 重置 ' + new Date(r.resetsAt).toLocaleString() : ''}（不可跨会话相加）`);
      }
      if (!usage.rateLimits?.length) lines.push('原生额度窗口：未报告');
    } else if (provider === 'codex' && usage?.total) {
      const t = usage.total, last = usage.last || {};
      lines.push(`累计 token：输入 ${number(t.inputTokens)} · 其中缓存输入 ${number(t.cachedInputTokens)} · 输出 ${number(t.outputTokens)}`);
      lines.push(`最近一次请求：输入 ${number(last.inputTokens)} · 输出 ${number(last.outputTokens)} · 模型窗口 ${number(usage.modelContextWindow)}`);
      lines.push('金额与额度窗口：此接口未报告');
    } else return ['原生用量未报告；不能据此判断为零。'];
    lines.push(count(usage.reportedAt) ? '本机读数时间：' + new Date(usage.reportedAt).toLocaleString() : '本机读数时间未报告');
    return lines;
  }
  const api = { claudeUsage, usageLines };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceUsage = api;
})(typeof window === 'object' ? window : globalThis);
