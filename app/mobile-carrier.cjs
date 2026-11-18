'use strict';
// Read existing Tailscale state only. No Serve/Funnel/ACL/DNS writer is exposed.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { validActor } = require('./mobile-identity.js');
const fail = (code = 'MOBILE_CARRIER_UNAVAILABLE') => Object.assign(Error('The private mobile entry could not be verified.'), { code });
function inspect(status, serve, { port = 48765, sharedHostConfirmed = false } = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || typeof sharedHostConfirmed !== 'boolean' || status?.BackendState !== 'Running') throw fail();
  const name = status.Self?.DNSName, actor = status.User?.[String(status.Self?.UserID)]?.LoginName;
  if (!/^[1-9][0-9]*$/.test(String(status.Self?.UserID)) || typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net\.?$/i.test(name) || !validActor(actor) || status.Self?.Online === false || status.Self?.Tags !== undefined && (!Array.isArray(status.Self.Tags) || status.Self.Tags.length)) throw fail();
  const host = name.replace(/\.$/, '').toLowerCase(), matches = [], peers = [];
  if (!serve || typeof serve !== 'object' || !serve.Web || !serve.TCP || serve.AllowFunnel && Object.values(serve.AllowFunnel).some(v => typeof v !== 'boolean')) throw fail();
  for (const [endpoint, web] of Object.entries(serve.Web)) {
    const site = new URL('https://' + endpoint);
    if (![site.host, host + ':' + (site.port || '443')].includes(endpoint.toLowerCase()) || site.hostname !== host || site.pathname !== '/' || site.username || site.password) continue;
    peers.push(endpoint);
    const p = Number(site.port || 443), handlers = web?.Handlers;
    if (serve.TCP[String(p)]?.HTTPS !== true || serve.AllowFunnel?.[endpoint] === true || !handlers || Object.keys(handlers).length !== 1 || !handlers['/']) continue;
    if (Object.keys(handlers['/']).length === 1 && handlers['/'].Proxy === 'http://127.0.0.1:' + port) matches.push(site.origin);
  }
  if (matches.length !== 1) throw fail();
  if (peers.length !== 1 && !sharedHostConfirmed) throw fail('MOBILE_SHARED_HOST');
  return Object.freeze({ origin: matches[0], actor, port });
}
function binary(io = fs) {
  for (const name of ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) {
    // Use an existing CLI entry, not the GUI bundle executable. Validate its
    // canonical file without replacing the wrapper/symlink used to enter CLI mode.
    try { const target = io.realpathSync(name), s = io.statSync(target); if (s.isFile() && !(s.mode & 0o022) && (s.uid === 0 || s.uid === process.getuid())) return name; } catch {}
  }
  throw fail();
}
async function detect(options = {}, { run = execFile, executable = binary } = {}) {
  const program = executable();
  const read = args => new Promise((resolve, reject) => run(program, args, { timeout: 4000, maxBuffer: 512 * 1024, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } }, (error, stdout) => {
    if (error) return reject(fail());
    try { resolve(JSON.parse(stdout)); } catch { reject(fail()); }
  }));
  const status = await read(['status', '--json']), serve = await read(['serve', 'status', '--json']);
  return inspect(status, serve, options);
}
module.exports = { inspect, detect, findExecutable: binary };
