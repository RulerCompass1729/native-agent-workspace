'use strict';
// Text-only projection of one unfinished DSH step. The prior request is the
// actual adapter-produced JSON, not a reconstructed prompt/history.
const { MAX_REQUEST_BYTES } = require('./butler-dsh-input.cjs');
const HEADROOM = 64 * 1024;
const FEEDBACK = 'NAW_READ_BUDGET_EXHAUSTED: this page was not delivered. No records were truncated. Keep the same query and cursor for a later batch; do not mark this page processed. Further reads in this batch are refused. Finish using only pages already received.';
const refusal = () => ({ content: [{ type: 'text', text: FEEDBACK }], isError: true });
class ButlerReadBudget {
  constructor(boundary) { this.boundary = boundary; this.reset(); }
  reset() {
    this.blocked = false; this.prefix = null; this.results = new Map();
    this.accepted = 0; this.withheld = 0; this.skipped = 0;
  }
  beginStep(messages) { this.prefix = messages.map(m => m.id); this.results.clear(); }
  fail() { this.boundary.reject(); }
  text(content) {
    if (!Array.isArray(content) || content.some(b => b.type !== 'text' || typeof b.text !== 'string')) this.fail();
    return content.filter(b => b.text.length).map(b => ({ type: 'text', text: b.text }));
  }
  preview(exec, messages, candidate) {
    if (!this.prefix || !Array.isArray(messages) || messages.length <= this.prefix.length ||
        this.prefix.some((id, i) => messages[i]?.id !== id)) this.fail();
    const delta = messages.slice(this.prefix.length), assistant = delta[0];
    if (assistant.role !== 'assistant' || !Array.isArray(assistant.content) || delta.slice(1).some(m => m.role !== 'tool')) this.fail();
    const calls = [], content = assistant.content.flatMap(b => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text ? [{ type: 'text', text: b.text }] : [];
      if (b.type !== 'tool-call' || typeof b.id !== 'string' || typeof b.name !== 'string' || typeof b.arguments !== 'string') this.fail();
      let input; try { input = JSON.parse(b.arguments); } catch { input = {}; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
      calls.push(b.id);
      return [{ type: 'tool_use', id: b.id, name: b.name, input }];
    });
    if (new Set(calls).size !== calls.length || !calls.includes(exec.callId)) this.fail();
    const results = new Map(this.results);
    for (const m of delta.slice(1)) {
      if (!calls.includes(m.toolCallId)) this.fail();
      if (!results.has(m.toolCallId)) results.set(m.toolCallId, { content: m.content, isError: m.isError });
    }
    results.set(exec.callId, candidate);
    const projected = [{ role: 'assistant', content }], contexts = [];
    for (const id of calls) {
      const result = results.get(id) || refusal();
      projected.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
        content: this.text(result.content), ...(result.isError === undefined ? {} : { is_error: result.isError }) }] });
      for (const m of result.additionalContexts || []) {
        if (m.role !== 'user') this.fail();
        contexts.push({ role: 'user', content: this.text(m.content) });
      }
    }
    return this.boundary.previewBytes([...projected, ...contexts]);
  }
  before(exec, messages) {
    this.boundary.assertHealthy();
    if (!this.blocked && this.preview(exec, messages, refusal()) + HEADROOM > MAX_REQUEST_BYTES) this.blocked = true;
    if (!this.blocked) return null;
    this.skipped++; return FEEDBACK;
  }
  after(exec, result, messages) {
    // Keep the old hard projection ceilings, including errors and contexts.
    this.boundary.checkTool(result);
    if (!this.blocked && this.preview(exec, messages, result) + HEADROOM <= MAX_REQUEST_BYTES) {
      this.results.set(exec.callId, result); this.accepted++; return null;
    }
    if (!this.blocked) { this.blocked = true; this.withheld++; }
    this.results.set(exec.callId, refusal());
    return { kind: 'block', feedback: refusal().content };
  }
  summary() { return { acceptedResults: this.accepted, withheldResults: this.withheld, skippedReads: this.skipped, exhausted: this.blocked }; }
}
module.exports = { ButlerReadBudget, HEADROOM, FEEDBACK };
