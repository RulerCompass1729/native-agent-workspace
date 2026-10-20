// Private Unix-socket transport for Claude's native prompt.submit API.
// No terminal writes, TCP listener, model calls, or automatic send retries.
const http = require('node:http');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

class SubmissionChannel extends EventEmitter {
  constructor(timeout = 15000) { super(); this.timeout = timeout; this.poll = null; this.pending = null; this.connected = false; }
  status(connected) { if (this.connected !== connected) { this.connected = connected; this.emit('change'); } }
  receive(response) {
    if (this.poll) this.poll.end(JSON.stringify({ idle: true }));
    this.poll = response; this.status(true);
    const timer = setTimeout(() => { if (this.poll === response) { this.poll = null; response.end(JSON.stringify({ idle: true })); } }, 20000);
    response.once('close', () => { clearTimeout(timer); if (this.poll === response) { this.poll = null; this.status(false); } });
    this.flush();
  }
  request(text, tag, guard) {
    if (!this.connected) return Promise.reject(new Error('安全发送连接尚未就绪；请在原生终端继续，草稿已保留。'));
    if (this.pending) return Promise.reject(new Error('上一条发送仍待原生确认。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(new Error('原生提交未确认；不会自动重发，请检查原生会话。')), this.timeout);
      this.pending = { text, tag, guard, resolve, reject, timer, delivered: false, authorized: false, deadline: Date.now() + this.timeout };
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
    p.authorized = true; return true;
  }
  result(message) {
    const p = this.pending;
    if (!p || p.tag !== message.id) return false;
    if (message.status === 'accepted' && p.authorized) this.finish(null, {
      promptId: typeof message.promptId === 'string' && /^[a-f0-9-]{36}$/i.test(message.promptId) ? message.promptId : null,
    });
    else this.finish(new Error(message.status === 'draft' ? '原生终端里还有未发送的草稿。请先在那里处理；两边草稿均已保留。' : '原生未接受这次发送；草稿已保留，请查看原生会话。'));
    return true;
  }
  finish(error, receipt) {
    const p = this.pending; if (!p) return;
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
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', async () => {
      let message;
      try { message = JSON.parse(body); } catch { res.writeHead(400); res.end('{}'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { res.writeHead(400); res.end('{}'); return; }
      if (message.sessionId !== target.record.nativeId) { res.writeHead(409); res.end('{}'); return; }
      if (req.url === '/next') return target.submission.receive(res);
      if (req.url === '/authorize') {
        try { if (target.beforeAuthorize) await target.beforeAuthorize(); }
        catch { return res.end(JSON.stringify({ allowed: false })); }
        return res.end(JSON.stringify({ allowed: target.submission.authorize(message) }));
      }
      if (req.url === '/result') return res.end(JSON.stringify({ received: target.submission.result(message) }));
      res.writeHead(404); res.end('{}');
    });
  });
  server.requestTimeout = 5000;
  return { server, async start() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, resolve); }); fs.chmodSync(filename, 0o600); } };
}
module.exports = { SubmissionChannel, createSubmissionServer };
