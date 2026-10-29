// Private Unix-socket transport for Claude's native prompt.submit API.
// No terminal writes, TCP listener, model calls, or automatic send retries.
const http = require('node:http');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

class SubmissionChannel extends EventEmitter {
  constructor(timeout = 15000) { super(); this.timeout = timeout; this.poll = null; this.pending = null; this.connected = false; }
  status(connected) { if (this.connected !== connected) { this.connected = connected; this.emit('change'); } }
  receive(response) {
    // The native listener asks for another command only after the previous
    // submit/result attempt has settled. If its result was lost, end this
    // uncertain wait; never redeliver the already-authorized native input.
    if (this.pending?.waitForNativeTurn && this.pending.delivered && this.pending.authorized) this.finish(new Error('原生等待输入的结果未确认；不会重发，请核对原生会话，草稿保留。'));
    if (this.poll) this.poll.end(JSON.stringify({ idle: true }));
    this.poll = response; this.status(true);
    const timer = setTimeout(() => { if (this.poll === response) { this.poll = null; response.end(JSON.stringify({ idle: true })); } }, 20000);
    response.once('close', () => { clearTimeout(timer); if (this.poll === response) { this.poll = null; this.status(false); } });
    this.flush();
  }
  request(text, tag, guard, waitForNativeTurn = false) {
    if (!this.connected) return Promise.reject(Object.assign(new Error('安全发送连接尚未就绪；请在原生终端继续，草稿已保留。'), { notSent: true }));
    if (this.pending) return Promise.reject(Object.assign(new Error('上一条发送仍待原生确认。'), { notSent: true }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(new Error('原生提交未确认；不会自动重发，请检查原生会话。')), this.timeout);
      this.pending = { text, tag, guard, resolve, reject, timer, delivered: false, authorized: false, waitForNativeTurn, deadline: Date.now() + this.timeout };
      this.flush();
    });
  }
  flush() {
    const p = this.pending, response = this.poll;
    if (!p || !response || p.delivered) return;
    if (!p.guard()) return this.finish(new Error('真人操作或协作变更已撤销这次发送；草稿已保留。'));
    p.delivered = true; this.poll = null;
    response.end(JSON.stringify({ id: p.tag, text: p.text }));
  }
  authorize(message) {
    const p = this.pending;
    if (!p || p.tag !== message.id || p.text !== message.text || !p.delivered || p.authorized || Date.now() >= p.deadline || !p.guard()) return false;
    p.authorized = true;
    // Claude's own submit promise may wait until its queued turn starts. Once
    // authorized, a wall-clock timeout would invite a duplicate of native work
    // that is still queued. Connection/context closure still rejects the wait.
    if (p.waitForNativeTurn) clearTimeout(p.timer);
    return true;
  }
  result(message) {
    const p = this.pending;
    if (!p || p.tag !== message.id) return false;
    if (message.status === 'accepted' && p.authorized) this.finish(null, {
      turnId: typeof message.turnId === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(message.turnId) ? message.turnId : null,
      promptId: typeof message.promptId === 'string' && /^[a-f0-9-]{36}$/i.test(message.promptId) ? message.promptId : null,
    });
    else {
      const notSent = message.status === 'draft' || message.status === 'blocked';
      this.finish(Object.assign(new Error(message.status === 'draft' ? '原生终端里还有未发送的草稿。请先在那里处理；两边草稿均已保留。' : notSent ? '原生未接受这次发送；草稿已保留，请查看原生会话。' : '原生提交结果未确认；不会自动重发，请查看原生会话。'), { notSent }));
    }
    return true;
  }
  finish(error, receipt) {
    const p = this.pending; if (!p) return;
    // The mod authorizes right before its native submit: until then native
    // cannot hold this prompt. After it, a failure leaves the outcome uncertain.
    if (error) error.notSent ??= !p.authorized;
    this.pending = null; clearTimeout(p.timer); error ? p.reject(error) : p.resolve(receipt);
  }
  close() { this.status(false); this.finish(new Error('安全发送连接已关闭；不会自动重发。')); this.poll?.end(JSON.stringify({ closed: true })); this.poll = null; }
}

function createSubmissionServer(filename, targets) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const target = targets.get(req.headers['x-workspace-token']);
    if (req.method !== 'POST' || !target?.submission) { res.writeHead(403); res.end('{}'); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('error', () => {});
    req.on('data', chunk => { body += chunk; if (body.length > (req.url === '/observation' ? target.nativeMedia === true ? 2 * 1024 * 1024 : 600000 : 100000)) req.destroy(); });
    req.on('end', async () => {
      let message;
      try { message = JSON.parse(body); } catch { res.writeHead(400); res.end('{}'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { res.writeHead(400); res.end('{}'); return; }
      if (['/root-bind', '/root-end', '/root-clear'].includes(req.url)) {
        const method = { '/root-bind': 'bindRoot', '/root-end': 'endRoot', '/root-clear': 'clearRoot' }[req.url];
        try {
          if (typeof target[method] !== 'function') throw Error('Unavailable');
          return res.end(JSON.stringify(await target[method](message)));
        } catch { res.writeHead(409); res.end('{}'); return; }
      }
      if (target.rootLease && !target.validRootBinding(message)) { res.writeHead(409); res.end('{}'); return; }
      if (message.sessionId !== target.record.nativeId) { res.writeHead(409); res.end('{}'); return; }
      if (req.url === '/addressed-capability') {
        if (!target.validRootBinding(message) || typeof message.available !== 'boolean') { res.writeHead(409); res.end('{}'); return; }
        target.addressedSendAvailable = message.available && target.nativeBlocks === true && !target.retainedReader;
        target.emit('capability'); return res.end(JSON.stringify({ received: true }));
      }
      if (req.url === '/addressed-message' || req.url === '/addressed-failed') {
        try {
          if (!target.addressedSendAvailable || !target.validRootBinding(message) || message.epoch !== target.observationEpoch || !target.addressedCall) throw Error('当前原生连接不支持定向协作。');
          const identity = { nativeId: message.sessionId, turnId: message.turnId, promptId: message.promptId, callId: message.callId };
          return res.end(JSON.stringify(req.url === '/addressed-failed' ? target.addressedFailed(identity) : target.addressedCall(identity, message.arguments)));
        } catch (error) {
          try { target.addressedFailed?.({ nativeId: message.sessionId, turnId: message.turnId, promptId: message.promptId, callId: message.callId }); } catch { /* Not the authorized root. */ }
          return res.end(JSON.stringify({ status: 'not-sent', message: error.message }));
        }
      }
      if (req.url === '/observation') {
        try { const observed = target.observeRoot(message); return res.end(JSON.stringify({ ...observed, abort: target.nativeAbortCommand?.() || undefined })); }
        catch { res.writeHead(409); res.end('{}'); return; }
      }
      if (req.url === '/abort-result') {
        try { return res.end(JSON.stringify(target.nativeAbortResult(message))); }
        catch { res.writeHead(409); res.end('{}'); return; }
      }
      if (req.url === '/next') {
        if (message.observationGap === true && target.observeRootGap) {
          try { target.observeRootGap(message); }
          catch { res.writeHead(409); res.end('{}'); return; }
        }
        return target.submission.receive(res);
      }
      if (req.url === '/authorize') {
        try { if (target.beforeAuthorize) await target.beforeAuthorize(); }
        catch { return res.end(JSON.stringify({ allowed: false })); }
        return res.end(JSON.stringify({ allowed: target.submission.authorize(message) }));
      }
      if (req.url === '/result') {
        const received = target.submission.result(message); target.completeNativeAbort?.();
        return res.end(JSON.stringify({ received }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  server.requestTimeout = 5000;
  return { server, async start() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, resolve); }); fs.chmodSync(filename, 0o600); } };
}
module.exports = { SubmissionChannel, createSubmissionServer };
