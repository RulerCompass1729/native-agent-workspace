'use strict';
// Dedicated host only. Byte ceilings are not a tokenizer or a cost estimate.
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
    return (url, init) => { this.request(url, init); return transport(url, init); };
  }
}
module.exports = { ButlerInputBoundary, MAX_REQUEST_BYTES, MAX_TOOL_RESULT_BYTES, MAX_BATCH_TOOL_BYTES, MAX_REQUESTS };
