'use strict';
// One approved synthetic experiment, not a general proxy or product adapter.
// Credentials are never obtained from environment/config here. The native
// client's Authorization line crosses as opaque bytes; its value is never
// decoded, inspected, formatted, logged or retained in a receipt.
const net = require('node:net'), tls = require('node:tls'), crypto = require('node:crypto');
const TOOL = 'b4_fixture_echo', RESULT = 'B4_FIXED_RESULT', ANSWER = 'B4_DONE';
const PROMPT = 'Call b4_fixture_echo once with {}. After its result, reply B4_DONE.';
const MODEL = 'deepseek-v4-pro';
const LIMITS = Object.freeze({ requests: 2, outputTokens: 1024, inputTokens: 2000, usdMicros: 1000000, seconds: 120 });
const fail = code => Object.assign(Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
function nativeFrame(buffer, route) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) { if (buffer.length > 16384) throw fail('header-too-large'); return null; }
  if (end > 16384) throw fail('header-too-large');
  let pos = buffer.indexOf('\r\n');
  if (buffer.subarray(0, pos).toString('ascii') !== `POST ${route} HTTP/1.1`) throw fail('unexpected-route');
  pos += 2; let length = null, authorization = null;
  while (pos < end) {
    const next = buffer.indexOf('\r\n', pos), colon = buffer.indexOf(':', pos);
    if (colon < pos || colon >= next) throw fail('invalid-header');
    const name = buffer.subarray(pos, colon).toString('ascii').toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) throw fail('invalid-header-name');
    if (name === 'content-length') {
      if (length !== null) throw fail('duplicate-length');
      const text = buffer.subarray(colon + 1, next).toString('ascii').trim();
      if (!/^\d{1,5}$/.test(text)) throw fail('invalid-length');
      length = Number(text);
    } else if (name === 'authorization') {
      if (authorization !== null) throw fail('duplicate-authorization');
      authorization = buffer.subarray(pos, next); // Opaque native transport bytes.
    } else if (['transfer-encoding', 'upgrade', 'content-encoding'].includes(name)) throw fail('unsupported-encoding');
    pos = next + 2;
  }
  if (!length || length > 32768) throw fail('body-too-large');
  const total = end + 4 + length;
  if (buffer.length < total) return null;
  if (buffer.length !== total) throw fail('pipelining-forbidden');
  let body; try { body = JSON.parse(buffer.subarray(end + 4).toString('utf8')); } catch { throw fail('invalid-json'); }
  return { body, authorization };
}
function requestBody(index, previousCall) {
  const body = { model: MODEL, stream: true, store: false, max_output_tokens: LIMITS.outputTokens,
    reasoning: { effort: 'none' }, input: [{ type: 'message', role: 'user', content: PROMPT }],
    tools: [], tool_choice: 'none' };
  if (index === 1) {
    body.tools = [{ type: 'function', name: TOOL, description: 'Return the fixed synthetic result; no side effects.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }];
    body.tool_choice = { type: 'function', name: TOOL };
  } else {
    if (!previousCall) throw fail('missing-first-call');
    body.input.push(previousCall, { type: 'function_call_output', call_id: previousCall.call_id, output: RESULT });
  }
  // Only fixed ASCII text, fixed tool schema and a bounded provider call ID can
  // reach inference. No native instruction/history/file/metadata is forwarded.
  const bytes = Buffer.from(JSON.stringify(body));
  if (bytes.length > 1600) throw fail('synthetic-input-too-large');
  return bytes;
}
function rawUsage(response) {
  const u = response?.usage, count = value => integer(value) ? value : null;
  return { inputTokens: count(u?.input_tokens), cachedInputTokens: count(u?.input_tokens_details?.cached_tokens),
    outputTokens: count(u?.output_tokens), reasoningTokens: count(u?.output_tokens_details?.reasoning_tokens),
    serverSearches: count(u?.server_tool_use?.tool_search), serverFetches: count(u?.server_tool_use?.tool_fetch) };
}
function checkUsageLimits(measured) {
  if (measured.inputTokens > LIMITS.inputTokens || measured.outputTokens > LIMITS.outputTokens) throw fail('provider-usage-exceeded-limit');
  if (measured.serverSearches !== 0 || measured.serverFetches !== 0) throw fail('unexpected-server-tool');
}
function usage(response, enforceLimits = true) {
  const raw = rawUsage(response), { inputTokens: input, outputTokens: output, cachedInputTokens: cached } = raw;
  if (![input, output, cached].every(integer) || cached > input) throw fail('usage-unknown');
  const search = response.usage.server_tool_use === undefined ? 0 : raw.serverSearches;
  const fetch = response.usage.server_tool_use === undefined ? 0 : raw.serverFetches;
  if (![search, fetch].every(integer)) throw fail('usage-unknown');
  // Peak USD/1M snapshot 2026-11-11, plus reported server operations; estimate,
  // not an invoice. Preserve this before enforcing usage or completion limits.
  const estimatedMicros = Math.ceil(cached * .044 + (input - cached) * 1.32 + output * 3.96 + (search + fetch) * 750);
  if (!integer(estimatedMicros)) throw fail('usage-unknown');
  const measured = { ...raw, serverSearches: search, serverFetches: fetch, estimatedMicros, estimated: true,
    priceBasis: '2026-11-11 peak USD: hit .044 / miss 1.32 / output 3.96 per 1M; server operation .00075', actualAmount: null };
  if (enforceLimits) checkUsageLimits(measured);
  return measured;
}
function terminalEvent(body) {
  const events = body.toString('utf8').split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data) return [];
    try { return [JSON.parse(data)]; } catch { throw fail('invalid-sse'); }
  });
  const terminal = events.filter(e => ['response.completed', 'response.failed', 'response.incomplete'].includes(e.type));
  if (terminal.length !== 1 || !terminal[0].response) throw fail('provider-terminal-missing');
  return terminal[0];
}
function completedResponse(event) {
  if (event.type !== 'response.completed' || event.response.status !== 'completed') throw fail('provider-not-completed');
  if (event.response.model !== MODEL) throw fail('provider-model-or-status-mismatch');
  return event.response;
}
function responseEvent(body) { return completedResponse(terminalEvent(body)); }
function decodeHttp(buffer) {
  const split = buffer.indexOf('\r\n\r\n'); if (split < 0 || split > 16384) throw fail('invalid-upstream-http');
  const lines = buffer.subarray(0, split).toString('ascii').split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})\b/.exec(lines.shift());
  if (!status || status[1] !== '200') throw fail('upstream-http-' + (status?.[1] || 'invalid'));
  const headers = Object.fromEntries(lines.map(l => { const i = l.indexOf(':'); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim().toLowerCase()]; }));
  if (!headers['content-type']?.startsWith('text/event-stream') || headers['content-encoding']) throw fail('unexpected-upstream-content');
  let body = buffer.subarray(split + 4);
  if (headers['transfer-encoding'] === 'chunked') {
    let offset = 0; const chunks = [];
    while (true) {
      const e = body.indexOf('\r\n', offset); if (e < 0) throw fail('invalid-chunk');
      const h = body.subarray(offset, e).toString('ascii'); if (!/^[0-9a-fA-F]+$/.test(h)) throw fail('invalid-chunk-size');
      const size = parseInt(h, 16); offset = e + 2;
      if (size === 0) { if (body.subarray(offset).toString('ascii') !== '\r\n') throw fail('unexpected-trailer'); break; }
      if (offset + size + 2 > body.length || body.subarray(offset + size, offset + size + 2).toString('ascii') !== '\r\n') throw fail('truncated-chunk');
      chunks.push(body.subarray(offset, offset + size)); offset += size + 2;
    }
    body = Buffer.concat(chunks);
  } else if (headers['transfer-encoding'] || (headers['content-length'] && Number(headers['content-length']) !== body.length)) throw fail('invalid-upstream-framing');
  return body;
}
function liveTransport(body, authorization, registerSocket, written = () => {}) {
  if (!authorization) return Promise.reject(fail('native-auth-presence-missing'));
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: 'api.deepseek.com', port: 443, servername: 'api.deepseek.com',
      rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    registerSocket(socket); const chunks = []; let bytes = 0;
    socket.setTimeout(45000, () => { socket.destroy(); reject(fail('upstream-timeout')); });
    socket.once('secureConnect', () => socket.write(Buffer.concat([
      Buffer.from('POST /responses HTTP/1.1\r\nHost: api.deepseek.com\r\n'), authorization,
      Buffer.from(`\r\nContent-Type: application/json\r\nAccept: text/event-stream\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`), body,
    ]), error => { if (!error) written(); }));
    socket.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) { socket.destroy(); reject(fail('upstream-too-large')); } else chunks.push(chunk); });
    socket.once('error', () => reject(fail('upstream-transport-error')));
    socket.once('close', () => reject(fail('upstream-closed')));
    socket.once('end', () => { try { resolve(decodeHttp(Buffer.concat(chunks))); } catch (e) { reject(e); } });
  });
}
function createGateway({ transport, record = () => {}, now = Date.now }) {
  const route = '/trial/' + crypto.randomBytes(24).toString('hex') + '/responses';
  const sockets = new Set(), records = []; let server, requests = 0, busy = false, stopped = false, previousCall = null, toolHandled = false;
  const started = now(), registerSocket = s => { sockets.add(s); s.once('close', () => sockets.delete(s)); };
  const write = row => { records.push(row); record(row); };
  function stop(code) {
    if (stopped) return;
    stopped = true;
    try { write({ state: 'stopped', code }); } catch { records.push({ state: 'receipt-write-failed' }); }
    finally { for (const s of sockets) s.destroy(); }
  }
  const timer = setTimeout(() => stop('trial-timeout'), LIMITS.seconds * 1000); timer.unref();
  return {
    get endpoint() { return `http://127.0.0.1:${server.address().port}` + route.slice(0, -'/responses'.length); },
    get port() { return server.address().port; }, get records() { return records; }, get requestCount() { return requests; },
    handleTool(params) {
      if (stopped || toolHandled || !previousCall || params.tool !== TOOL || params.namespace || params.callId !== previousCall.call_id || JSON.stringify(params.arguments) !== '{}') throw fail('unexpected-native-tool');
      toolHandled = true; write({ state: 'fixed-tool-result', tool: TOOL });
      return { contentItems: [{ type: 'inputText', text: RESULT }], success: true };
    },
    async start(port = 0) {
      server = net.createServer(socket => {
        if (stopped) { socket.destroy(); return; }
        registerSocket(socket); let bytes = Buffer.alloc(0), handling = false;
        socket.setTimeout(15000, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('data', async chunk => {
          if (handling) return stop('pipelining-forbidden');
          try {
            bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 49152) throw fail('request-too-large');
            const frame = nativeFrame(bytes, route); if (!frame) return;
            handling = true; socket.setTimeout(55000, () => stop('native-request-timeout'));
            if (stopped || busy || requests >= LIMITS.requests || now() - started >= LIMITS.seconds * 1000) throw fail('trial-request-limit');
            if (frame.body.model !== MODEL || frame.body.stream !== true) throw fail('native-model-mismatch');
            if (!Array.isArray(frame.body.tools) || frame.body.tools.length !== 1 || frame.body.tools[0].type !== 'function' || frame.body.tools[0].name !== TOOL) throw fail('native-tool-set-mismatch');
            if (requests === 1 && !toolHandled) throw fail('missing-native-tool-result');
            busy = true; const index = ++requests, body = requestBody(index, previousCall);
            if (records.filter(r => r.state === 'request-reserved').reduce((n, r) => n + r.outgoingBytes, body.length) > 1600) throw fail('trial-total-input-bytes');
            // Persist the attempt BEFORE any inference socket is opened; no retries.
            write({ state: 'request-reserved', index, maxOutputTokens: LIMITS.outputTokens, outgoingBytes: body.length });
            const responseBytes = await transport(body, frame.authorization, registerSocket, () => write({ state: 'upstream-request-written', index }));
            frame.authorization = null; bytes = Buffer.alloc(0);
            const event = terminalEvent(responseBytes), response = event.response;
            write({ state: 'provider-usage-raw', index, ...rawUsage(response) });
            if (response.model !== MODEL) throw fail('provider-model-or-status-mismatch');
            const measured = usage(response, false);
            write({ state: 'provider-usage', index, ...measured });
            checkUsageLimits(measured);
            completedResponse(event);
            if (records.filter(r => r.state === 'provider-usage').reduce((n, r) => n + r.inputTokens, 0) > LIMITS.inputTokens) throw fail('trial-total-input-limit');
            if (records.filter(r => r.state === 'provider-usage').reduce((n, r) => n + r.estimatedMicros, 0) > LIMITS.usdMicros) throw fail('trial-cost-limit');
            const calls = response.output?.filter(i => i.type === 'function_call') || [];
            if (index === 1) {
              if (calls.length !== 1 || calls[0].name !== TOOL || calls[0].arguments !== '{}' || !/^[A-Za-z0-9_-]{1,128}$/.test(calls[0].call_id)) throw fail('unexpected-provider-tool');
              previousCall = { type: 'function_call', name: TOOL, call_id: calls[0].call_id, arguments: '{}' };
            } else {
              const text = (response.output || []).flatMap(i => i.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('').trim();
              if (calls.length || text !== ANSWER) throw fail('unexpected-final-answer');
            }
            socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${responseBytes.length}\r\nConnection: close\r\n\r\n`), responseBytes]));
            busy = false; write({ state: 'native-response', index });
          } catch (e) { stop(e.code || 'trial-invalid'); }
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    },
    async close() { clearTimeout(timer); for (const s of sockets) s.destroy(); if (server) await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { TOOL, RESULT, ANSWER, PROMPT, MODEL, LIMITS, nativeFrame, requestBody, usage, responseEvent, decodeHttp, liveTransport, createGateway };
