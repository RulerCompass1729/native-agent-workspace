// A separate, headless browser owns only this one local composer. It never
// attaches to NAW, Chrome's ordinary profile, or an application debug endpoint.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

function outboxHTML(model, nonce) {
  const encoded = JSON.stringify(model).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'"><title>NAW outbox</title>
<main id="room-composer"><p id="recipient-label"></p><label for="shared-input">本次任务</label><textarea id="shared-input"></textarea><button id="forward-button">发送</button><pre id="receipt" role="status"></pre></main>
<script nonce="${nonce}">const model=${encoded};let pending=false;const input=document.getElementById('shared-input'),button=document.getElementById('forward-button');document.getElementById('recipient-label').textContent='收件人：'+model.recipient.label;input.value=model.text;button.onclick=()=>{if(button.disabled)return;button.disabled=true;input.readOnly=true;pending=true};window.outboxFacts=()=>({recipientId:model.recipient.id,body:input.value,ready:!button.disabled,revision:JSON.stringify([input.value,input.readOnly,button.disabled])});window.takeOutboxSend=()=>{const value=pending;pending=false;return value};window.showOutboxReceipt=value=>{document.getElementById('receipt').textContent=JSON.stringify(value)};</script>`;
}
function projectOutboxFacts(model, grant, facts, owner) {
  // A textarea renders CRLF as LF. Keep the approved transport bytes when
  // its displayed value is exactly that body, with browser line endings.
  const body = facts.body === model.text.replace(/\r\n?/g, '\n') ? model.text : facts.body;
  return { ...grant, recipientId: facts.recipientId, body, revision: facts.revision,
    ready: grant.ready === true, owner, spaceId: model.spaceId, selected: 'room', surface: 'records' };
}
async function createStockOutboxView(model, actions, { inspectGrant, browser = 'chrome' } = {}) {
  if (typeof inspectGrant !== 'function' || typeof actions?.send !== 'function' || browser !== 'chrome') throw Error('Outbox owner is unavailable');
  // Stock MCP also opens a Unix socket under TMPDIR. Darwin's per-user temp
  // path can exhaust the socket limit before Chrome ever opens a page.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'naw-outbox-'));
  fs.chmodSync(dir, 0o700);
  const identity = fs.lstatSync(dir), owner = randomUUID();
  const file = path.join(dir, 'outbox.html');
  const html = outboxHTML(model, randomBytes(16).toString('hex'));
  fs.writeFileSync(file, html, { mode: 0o600, flag: 'wx' });
  let child, transport, spawnFailed = false, closed = false, closing, tail = Promise.resolve();
  const raw = (name, args) => {
    const operation = tail.then(async () => {
      if (closed) throw Error('Outbox view closed');
      const result = await transport.request('tools/call', { name, arguments: args }, AbortSignal.timeout(10000));
      if (result.isError) throw Error('Outbox operation unconfirmed');
      return result;
    });
    tail = operation.catch(() => {}); return operation;
  };
  const evaluate = async expression => {
    const result = await raw('browser_evaluate', { function: `() => 'OUTBOX_'+btoa(unescape(encodeURIComponent(JSON.stringify(${expression}))))` });
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const matches = [...text.matchAll(/OUTBOX_([A-Za-z0-9+/=]+)/g)];
    if (matches.length !== 1) throw Error('Outbox observation unavailable');
    return JSON.parse(Buffer.from(matches[0][1], 'base64').toString('utf8'));
  };
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      if (transport && !closed) await raw('browser_close', {}).catch(() => {});
      closed = true; transport?.close(); child?.stdin.end();
      if (child && !(spawnFailed && !child.pid) && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => { const timer = setTimeout(resolve, 8000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await new Promise(resolve => { const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
        }
        if (child.exitCode === null && child.signalCode === null) throw Error('Owned outbox browser cleanup is unconfirmed');
      }
      const current = fs.lstatSync(dir);
      if (current.ino !== identity.ino || current.dev !== identity.dev) throw Error('Outbox directory changed');
      fs.rmSync(dir, { recursive: true });
    })();
    return closing;
  }
  try {
    const core = path.dirname(require.resolve('playwright-core/package.json'));
    const entry = path.join(core, 'lib/entry/mcp.js');
    // Existing pinned runtime. Never install a browser or discover another app
    // endpoint as a fallback. Missing Chrome is a concrete refusal.
    if (require(path.join(core, 'package.json')).version !== '1.64.1') throw Error('Outbox browser runtime changed');
    child = spawn(process.execPath, [entry, '--headless', '--isolated', '--browser', browser,
      '--output-dir', dir, '--codegen', 'none', '--no-webmcp'], {
      env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1' },
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.once('error', () => { spawnFailed = true; transport?.close(); });
    let diagnosticBytes = 0;
    const diagnostic = path.join(dir, 'mcp-stderr.log');
    fs.writeFileSync(diagnostic, '', { mode: 0o600, flag: 'wx' });
    child.stderr.on('data', part => { if (diagnosticBytes < 32768) { const value = part.subarray(0, 32768 - diagnosticBytes); fs.appendFileSync(diagnostic, value); diagnosticBytes += value.length; } });
    const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
    transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    transport.onRequest(method => {
      if (method === 'roots/list') return { roots: [{ uri: pathToFileURL(dir).href, name: 'Authorized outbox only' }] };
      throw Error('Unexpected outbox server request');
    });
    transport.start();
    await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: {} },
      clientInfo: { name: 'naw-owned-outbox', version: '1' } }, AbortSignal.timeout(5000));
    transport.notify('notifications/initialized');
    const catalog = await transport.request('tools/list', {}, AbortSignal.timeout(5000));
    for (const name of ['browser_navigate', 'browser_evaluate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_close']) {
      if (!catalog.tools?.some(tool => tool.name === name)) throw Error('The outbox browser contract is unavailable');
    }
    // Keep stock MCP's file: access block. Main installs this exact trusted
    // document over its private stdio into the only owned blank page; callers
    // never receive evaluate, navigation or a browser endpoint. No server-side
    // code execution capability is needed or enabled.
    await raw('browser_navigate', { url: 'about:blank' });
    await raw('browser_evaluate', { function: '() => { document.open(); document.write(' + JSON.stringify(html) + '); document.close(); return true; }' });
    return { owner,
      async inspect() {
        if (closed) return { closed: true };
        const facts = await evaluate('window.outboxFacts()');
        const grant = await inspectGrant();
        return projectOutboxFacts(model, grant, facts, owner);
      },
      async target(ref) {
        const result = await raw('browser_evaluate', { target: ref, function: "element => 'OUTBOX_'+btoa(JSON.stringify({id:element.id,kind:element.id==='forward-button'?'send':'other',visible:!!element.getClientRects().length,disabled:!!element.disabled,readOnly:!!element.readOnly}))" });
        const matches = [...result.content.filter(b => b.type === 'text').map(b => b.text).join('\n').matchAll(/OUTBOX_([A-Za-z0-9+/=]+)/g)];
        if (matches.length !== 1) throw Error('Outbox target unavailable');
        return JSON.parse(Buffer.from(matches[0][1], 'base64').toString('utf8'));
      },
      async invoke(name, args) {
        const result = await raw(name, args);
        if (name === 'browser_click' && await evaluate('window.takeOutboxSend()')) await actions.send();
        return result;
      },
      showReceipt(value) { return evaluate(`window.showOutboxReceipt(${JSON.stringify(value).replace(/</g, '\\u003c')}) ?? null`); },
      close,
    };
  } catch (cause) { await close(); throw Error('Independent outbox could not open; no alternative route was used', { cause }); }
}

module.exports = { outboxHTML, projectOutboxFacts, createStockOutboxView };
