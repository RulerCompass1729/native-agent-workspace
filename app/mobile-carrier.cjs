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
  const host = name.replace(/\.$/, '').toLowerCase(), matches = [], peers = new Set();
  const map = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!map(serve) || serve.Foreground !== undefined && !map(serve.Foreground)) throw fail();
  const configs = [serve, ...Object.values(serve.Foreground || {})];
  if (configs.slice(1).some(c => !map(c) || c.Foreground !== undefined)) throw fail();
  let unproven = false;
  for (const config of configs) {
   if (!map(config) || ['TCP','Web','AllowFunnel','Services'].some(k => config[k] !== undefined && !map(config[k])) || Object.values(config.AllowFunnel || {}).some(v => typeof v !== 'boolean')) throw fail();
   for (const [endpoint, enabled] of Object.entries(config.AllowFunnel || {})) {
    if (enabled && new URL('https://' + endpoint).hostname === host) throw fail();
   }
   // Unknown service/topology forms cannot establish exclusive cookie trust.
   if (Object.keys(config.Services || {}).length || Object.keys(config).some(k => !['TCP','Web','AllowFunnel','Foreground','Services','ETag'].includes(k))) unproven = true;
   for (const [endpoint, web] of Object.entries(config.Web || {})) {
    const site = new URL('https://' + endpoint);
    if (![site.host, host + ':' + (site.port || '443')].includes(endpoint.toLowerCase()) || site.hostname !== host || site.pathname !== '/' || site.username || site.password) continue;
    if (peers.has(site.origin)) throw fail();
    peers.add(site.origin);
    const p = Number(site.port || 443), handlers = web?.Handlers;
    const tcp = config.TCP?.[String(p)];
    if (config.AllowFunnel?.[endpoint] === true) throw fail();
    if (tcp?.HTTPS !== true || tcp.HTTP || tcp.TCPForward || tcp.TerminateTLS || !handlers || Object.keys(handlers).length !== 1 || !handlers['/']) continue;
    if (Object.keys(handlers['/']).length === 1 && handlers['/'].Proxy === 'http://127.0.0.1:' + port) matches.push(site.origin);
   }
   for (const [p, tcp] of Object.entries(config.TCP || {})) {
    if (!/^[1-9][0-9]*$/.test(p) || Number(p) > 65535 || !map(tcp)) throw fail();
    if (['HTTPS','HTTP'].some(k => tcp[k] !== undefined && typeof tcp[k] !== 'boolean') || tcp.HTTPS && tcp.HTTP ||
        tcp.TerminateTLS && !tcp.TCPForward || tcp.TCPForward && (tcp.HTTPS || tcp.HTTP)) throw fail();
    if (Object.keys(tcp).some(k => !['HTTPS','HTTP','TCPForward','TerminateTLS','ProxyProtocol'].includes(k))) unproven = true;
    if (!tcp.TCPForward) continue;
    if (typeof tcp.TCPForward !== 'string' || tcp.TerminateTLS !== undefined && typeof tcp.TerminateTLS !== 'string') throw fail();
    if (!tcp.TerminateTLS) unproven = true;
    else if (tcp.TerminateTLS.replace(/\.$/, '').toLowerCase() === host) {
      const site = new URL('https://' + host + ':' + p).origin;
      if (peers.has(site)) throw fail();
      peers.add(site);
    }
   }
  }
  if (matches.length !== 1) throw fail();
  if ((peers.size !== 1 || unproven) && !sharedHostConfirmed) throw fail('MOBILE_SHARED_HOST');
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
