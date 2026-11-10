// The one loopback model fixture for real-CLI tests (task board B11): 127.0.0.1,
// a random port, started and stopped by the test, fixed responses from the
// test, no real model and no outside network.
//
// "No outside network" is enforced by the OS, not requested of the CLI: the
// native CLI runs under sandbox-exec with a policy that allows IP traffic only
// to this fixture's own loopback port (so a local proxy cannot relay it out),
// keeps local Unix sockets, and blocks the system resolver's socket and the
// keychain. Proxy variables and real provider keys are removed from the CLI
// environment. preflight() proves these under the same policy on every run
// before any CLI starts. Not covered: files under the real home stay readable,
// so callers give the CLI private config directories (CODEX_HOME,
// CLAUDE_CONFIG_DIR). macOS logs no sandbox denials for these rules, so a run
// cannot count blocked attempts; the claim rests on the enforced policy, the
// per-run preflight and this server's own request log.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net');
const { spawnSync } = require('node:child_process');

const SANDBOX = '/usr/bin/sandbox-exec';
const policy = port => {
  if (!Number.isInteger(port) || port <= 0) throw Error('The sandbox policy needs the fixture port');
  return [
  '(version 1)', '(allow default)',
  // Last matching rule wins: deny every IP destination, then allow only this fixture's loopback port.
  '(deny network-outbound (remote ip "*:*"))', `(allow network-outbound (remote ip "localhost:${port}"))`,
  // The system resolver's socket is unreachable (probed); its mach service is denied too (not probed).
  '(deny mach-lookup (global-name "com.apple.mDNSResponder"))',
  '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
  // The keychain holds the person's real logins.
  '(deny mach-lookup (global-name "com.apple.securityd"))', '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
  ].join('');
};
// A local proxy would relay traffic out; its variables never reach the CLI.
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].flatMap(name => [name, name.toLowerCase()]);
// Codex's own non-model traffic stays off (precedent: test-native-codex-idle-checkpoint.cjs).
const CODEX_ARGS = ['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false'];

// Real provider credentials never reach the fixture CLI; values are never read.
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS'];
const FIXTURE_KEY = 'local-fixture';

const PROBE = `const net=require('net'),dns=require('dns'),cp=require('child_process');const [port,other,sock]=process.argv.slice(1);
const tcp=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:+p});const t=setTimeout(()=>{s.destroy();r('timeout')},1500);s.on('connect',()=>{clearTimeout(t);s.destroy();r('connected')});s.on('error',e=>{clearTimeout(t);r(e.code)})});
const unix=p=>new Promise(r=>{const s=net.connect(p);s.on('connect',()=>{s.destroy();r('connected')});s.on('error',e=>r(e.code))});
(async()=>{const o={};o.loopback=await tcp('127.0.0.1',port);o.loopbackV6=await tcp('::1',port);o.otherLoopbackPort=await tcp('127.0.0.1',other);
o.proxyPorts=(await Promise.all([1080,6152,6153,7890,7891,7897,8118,10808,10809].map(p=>tcp('127.0.0.1',p)))).every(c=>c==='EPERM')?'EPERM':'reachable';
o.unixSocket=await unix(sock);o.testNet=await tcp('192.0.2.1',443);o.testNetV6=await tcp('2001:db8::1',443);
o.resolverSocket=await unix('/private/var/run/mDNSResponder');
o.dns=await new Promise(r=>new dns.Resolver({timeout:1500,tries:1}).resolve4('naw-preflight.example',e=>r(e?e.code:'answered')));
const k=cp.spawnSync('/usr/bin/security',['find-generic-password','-s','naw-preflight-nonexistent-item'],{encoding:'utf8',timeout:5000});
o.keychain=/SecKeychainSearchCreateFromAttributes/.test(k.stderr||'')?'unreachable':'searched';console.log(JSON.stringify(o))})();`;
// Without the sandbox, security reaches the keychain and only reports CopyNext "not found";
// with securityd denied it cannot even create the search (CreateFromAttributes).

function create({ directory, provider, respond }) {
  if (!['claude', 'codex'].includes(provider)) throw Error('provider must be claude or codex');
  if (typeof respond !== 'function') throw Error('respond(req, res, body) supplies the fixed responses');
  const requests = [], violations = [], handlerErrors = [];
  let server, preflightResult = null, portAttempts = 0, stopped = false;
  // Only the fixture credential may arrive; any other value stops the trial and is not stored.
  const credentialOk = req => provider === 'claude'
    ? req.headers['x-api-key'] === FIXTURE_KEY && !req.headers.authorization
    : !req.headers.authorization || req.headers.authorization === `Bearer ${FIXTURE_KEY}`;
  const fixture = {
    get policy() { return policy(fixture.port); },
    get port() { return server?.address()?.port; },
    get endpoint() { return `http://127.0.0.1:${fixture.port}`; },
    requests, violations,
    async start() {
      server = http.createServer((req, res) => {
        let body = ''; req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const row = { method: req.method, path: req.url.split('?')[0] };
          if (!credentialOk(req)) { violations.push(row); res.writeHead(403); res.end(); return; }
          requests.push(row);
          Promise.resolve().then(() => respond(req, res, body)).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(); handlerErrors.push({ ...row, error: error.message }); });
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (address.address !== '127.0.0.1' || !(address.port > 0)) throw Error('Fixture must bind 127.0.0.1 on a random port');
      return fixture;
    },
    // Run under the exact policy the CLI gets; abort before any CLI starts unless every probe holds.
    // sandbox-exec's per-port rule deterministically refuses some port numbers (measured: 60000,
    // 64092, 64137, 64500, 65000), so a refused fixture port is replaced by a new random one.
    async preflight() {
      // Read fixture.port / fixture.endpoint after this resolves: the port may have changed.
      for (let attempt = 1; ; attempt++) {
        portAttempts = attempt;
        const result = await fixture.probe();
        if (result.loopback !== 'EPERM' || attempt >= 8) return fixture.verify(result);
        await new Promise(resolve => server.close(resolve));
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      }
    },
    async probe() {
      const socket = path.join(directory, `preflight-${process.pid}.sock`);
      // A second loopback listener stands in for a local proxy: it must be refused.
      const local = net.createServer(c => c.end()), other = net.createServer(c => c.end());
      await new Promise(resolve => local.listen(socket, resolve));
      await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
      try {
        const run = spawnSync(SANDBOX, ['-p', fixture.policy, process.execPath, '-e', PROBE, String(fixture.port), String(other.address().port), socket], { encoding: 'utf8', timeout: 15000 });
        return JSON.parse(run.stdout || '{}');
      } finally { await new Promise(resolve => local.close(resolve)); await new Promise(resolve => other.close(resolve)); fs.rmSync(socket, { force: true }); }
    },
    verify(result) {
      // ::1 on the fixture port is allowed but has no listener (ECONNREFUSED); everything else is denied (EPERM).
      const expected = { loopback: 'connected', loopbackV6: 'ECONNREFUSED', otherLoopbackPort: 'EPERM', proxyPorts: 'EPERM', unixSocket: 'connected', testNet: 'EPERM', testNetV6: 'EPERM', resolverSocket: 'EPERM', dns: 'ECONNREFUSED', keychain: 'unreachable' };
      for (const [key, value] of Object.entries(expected)) {
        if (result[key] !== value) throw Error(`Sandbox preflight failed: ${key}=${result[key]} (expected ${value}); no CLI started`);
      }
      return (preflightResult = result);
    },
    // A shim NAW launches in place of the native CLI. sandbox-exec replaces itself with the
    // CLI under the same pid, so NAW's recorded native identity is the CLI's.
    wrapper(binary, { file, env = {}, args = [] }) {
      if (!preflightResult) throw Error('Run preflight() before writing the CLI wrapper');
      const fixed = provider === 'claude'
        ? { ANTHROPIC_BASE_URL: fixture.endpoint, ANTHROPIC_API_KEY: FIXTURE_KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1' }
        : {};
      for (const key of Object.keys(env)) if (CREDENTIAL_ENV.includes(key) || PROXY_ENV.includes(key)) throw Error(`Credential and proxy variables are not configurable: ${key}`);
      if (provider === 'codex') args = [...CODEX_ARGS, ...args];
      fs.writeFileSync(file, '#!/usr/bin/python3\nimport os,sys\n' +
        `for key in ${JSON.stringify([...CREDENTIAL_ENV, ...PROXY_ENV])}: os.environ.pop(key,None)\n` +
        `os.environ.update(${JSON.stringify({ ...env, ...fixed })})\n` +
        `os.execv(${JSON.stringify(SANDBOX)},["sandbox-exec","-p",${JSON.stringify(fixture.policy)},${JSON.stringify(binary)}]+${JSON.stringify(args)}+sys.argv[1:])\n`, { mode: 0o700 });
      return file;
    },
    // Every script ends with this: any non-fixture credential or failed fixed response fails the run.
    assertClean() {
      if (violations.length || handlerErrors.length) throw Error(`Loopback fixture saw ${violations.length} credential violation(s) and ${handlerErrors.length} failed fixed response(s): ${JSON.stringify(handlerErrors.map(e => e.error))}`);
    },
    summary() {
      return { bind: '127.0.0.1', randomPort: true, port: fixture.port, portAttempts, sandbox: SANDBOX, preflight: preflightResult,
        requests: requests.length, paths: [...new Set(requests.map(r => r.path))], credentialViolations: violations.length, handlerErrors: handlerErrors.length, stopped, responder: 'fixed responses from the test' };
    },
    async stop() {
      if (stopped || !server) { stopped = true; return; }
      stopped = true; server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
  return fixture;
}

module.exports = { create, policy, CREDENTIAL_ENV, PROXY_ENV, FIXTURE_KEY };
