'use strict';
// Dedicated host only. Byte ceilings are not a tokenizer or a cost estimate.
const MAX_BATCH_INPUT_BYTES = 128 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 32 * 1024;
const encodedBatchBytes = input => Buffer.byteLength(JSON.stringify(JSON.stringify(input)));
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_BYTES = 128 * 1024;
const MAX_BATCH_TOOL_BYTES = 512 * 1024;
const MAX_REQUESTS = 8;
class ButlerInputBoundary {
  constructor(endpoint) { this.endpoint = endpoint; this.reset(); }
  reset() { this.failed = null; this.requests = 0; this.toolBytes = 0; }
  reject(code = 'input-boundary') {
    this.failed ||= code;
    throw Object.assign(Error(this.failed), { code: this.failed });
  }
  assertHealthy() { if (this.failed) this.reject(this.failed); }
  tool(result) {
    this.assertHealthy();
    // These are the fields the loop can insert into the next model context.
    // Raw value duplicates the content projection and is not sent separately.
    if (!Array.isArray(result.content) || result.content.some(b => b.type !== 'text')) this.reject();
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify({ content: result.content, additionalContexts: result.additionalContexts || [] })); }
    catch { this.reject(); }
    if (bytes > MAX_TOOL_RESULT_BYTES || this.toolBytes + bytes > MAX_BATCH_TOOL_BYTES) this.reject();
    this.toolBytes += bytes;
  }
  request(url, init) {
    this.assertHealthy();
    // Fail closed for Files/image paths and unexpected transport shapes. Never
    // inspect/copy headers: credential resolution stays entirely in DSH.
    if (url !== this.endpoint || init?.method !== 'POST' || typeof init.body !== 'string') this.reject();
    if (Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) this.reject();
    if (this.requests >= MAX_REQUESTS) this.reject('request-boundary');
    this.requests++;
  }
  wrapFetch(transport) {
    return (url, init) => {
      this.assertHealthy();
      if (url !== this.endpoint || init?.method !== 'POST' || typeof init.body !== 'string') this.reject();
      if (Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) this.reject();
      let body; try { body = JSON.parse(init.body); } catch { this.reject(); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) this.reject();
      if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system) || !Array.isArray(body.messages)) this.reject();
      // Append this host-owned advisory after all history, not in the system
      // prefix. It is regenerated per transmission, never kept in session history.
      // Its six-digit counter keeps serialization size fixed; it grants no power.
      const prefix = 'NAW_CAPACITY remaining_bytes=';
      const suffix = '; wire_limit_bytes=262144. This is remaining UTF-8 JSON space, not tokens. Every next request resends all history. Tool replies, escaping and your next reply consume it. Read fewer records; leave 65536 bytes for reply/envelopes. If a page will not fit, finish this batch and report the unread cursor; do not guess missing content.';
      const note = { type: 'text', text: prefix + '000000' + suffix };
      const last = body.messages.at(-1);
      if (last?.role === 'user') {
        const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
        if (!Array.isArray(content)) this.reject();
        last.content = [...content, note];
      } else body.messages.push({ role: 'user', content: [note] });
      const bytes = Buffer.byteLength(JSON.stringify(body));
      if (bytes > MAX_REQUEST_BYTES) this.reject();
      note.text = prefix + String(MAX_REQUEST_BYTES - bytes).padStart(6, '0') + suffix;
      init.body = JSON.stringify(body); // Preserve init/headers identity; never inspect auth.
      this.request(url, init);
      return transport(url, init);
    };
  }
}
module.exports = { MAX_BATCH_INPUT_BYTES, MAX_TOOL_SCHEMA_BYTES, encodedBatchBytes, ButlerInputBoundary, MAX_REQUEST_BYTES, MAX_TOOL_RESULT_BYTES, MAX_BATCH_TOOL_BYTES, MAX_REQUESTS };
