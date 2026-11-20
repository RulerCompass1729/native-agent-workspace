'use strict';
// Read existing Tailscale state only. No Serve/Funnel/ACL/DNS writer is exposed.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { validActor } = require('./mobile-identity.js');
const fail = (code = 'MOBILE_CARRIER_UNAVAILABLE') => Object.assign(Error('The private mobile entry could not be verified.'), { code });
const bindings = new WeakMap();
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
function validBinding(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== 'actor,origin,port,topologyHash,userId,version' ||
      v.version !== 1 || !validActor(v.actor) || typeof v.userId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(v.userId) ||
      !Number.isSafeInteger(v.port) || v.port < 1024 || v.port > 65535 || typeof v.topologyHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.topologyHash)) return false;
  try { const u = new URL(v.origin); return u.protocol === 'https:' && u.origin === v.origin && !u.username && !u.password; } catch { return false; }
}
function knownTopology(configs) {
  return configs.every(c => !Object.values(c.AllowFunnel || {}).some(Boolean) &&
    Object.entries(c.Web || {}).every(([endpoint, web]) => {
      try {
        const u = new URL('https://' + endpoint);
        if (u.pathname !== '/' || u.username || u.password || !web || Object.keys(web).join() !== 'Handlers' ||
            !web.Handlers || typeof web.Handlers !== 'object' || Array.isArray(web.Handlers)) return false;
        return Object.entries(web.Handlers).every(([route, handler]) => route.startsWith('/') && handler &&
          Object.keys(handler).length === 1 && ['Proxy', 'Path', 'Text'].includes(Object.keys(handler)[0]) && typeof Object.values(handler)[0] === 'string');
      } catch { return false; }
    }) && Object.entries(c.TCP || {}).every(([port, tcp]) =>
      (tcp.ProxyProtocol === undefined || [1, 2].includes(tcp.ProxyProtocol)) &&
      (!tcp.HTTPS || Object.keys(c.Web || {}).some(endpoint => Number(new URL('https://' + endpoint).port || 443) === Number(port)))));
}
function binding(carrier) { return structuredClone(bindings.get(carrier) || null); }
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
  if ((peers.size !== 1 || unproven) && !sharedHostConfirmed) throw Object.assign(fail('MOBILE_SHARED_HOST'), { otherPorts: [...peers].filter(site => site !== matches[0]).map(site => Number(new URL(site).port || 443)).sort((a,b)=>a-b) });
  const result = Object.freeze({ origin: matches[0], actor, port });
  if (!unproven && knownTopology(configs) && (typeof status.Self.UserID !== 'number' || Number.isSafeInteger(status.Self.UserID))) {
    const topology = [serve, ...Object.keys(serve.Foreground || {}).sort().map(key => serve.Foreground[key])]
      .map((c, index) => ({ scope: index ? Object.keys(serve.Foreground).sort()[index - 1] : null, TCP: c.TCP || {}, Web: c.Web || {} }));
    bindings.set(result, Object.freeze({ version: 1, origin: result.origin, actor, port, userId: String(status.Self.UserID),
      topologyHash: createHash('sha256').update(JSON.stringify(ordered(topology))).digest('hex') }));
  }
  return result;
}
function inspectRestored(status, serve, expected) {
  if (!validBinding(expected)) throw fail();
  const carrier = inspect(status, serve, { port: expected.port, sharedHostConfirmed: true }), actual = binding(carrier);
  if (!actual || JSON.stringify(ordered(actual)) !== JSON.stringify(ordered(expected))) throw fail();
  return carrier;
}
function binary(io = fs) {
  for (const name of ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) {
    // Use an existing CLI entry, not the GUI bundle executable. Validate its
    // canonical file without replacing the wrapper/symlink used to enter CLI mode.
    try { const target = io.realpathSync(name), s = io.statSync(target); if (s.isFile() && !(s.mode & 0o022) && (s.uid === 0 || s.uid === process.getuid())) return name; } catch {}
  }
  throw fail();
}
async function read({ run = execFile, executable = binary } = {}) {
  const program = executable();
  const read = args => new Promise((resolve, reject) => run(program, args, { timeout: 4000, maxBuffer: 512 * 1024, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } }, (error, stdout) => {
    if (error) return reject(fail());
    try { resolve(JSON.parse(stdout)); } catch { reject(fail()); }
  }));
  const status = await read(['status', '--json']), serve = await read(['serve', 'status', '--json']);
  return { status, serve };
}
async function detect(options = {}, dependencies) { const { status, serve } = await read(dependencies); return inspect(status, serve, options); }
async function detectRestored(expected, dependencies) {
  if (!validBinding(expected)) throw fail();
  const { status, serve } = await read(dependencies); return inspectRestored(status, serve, expected);
}
module.exports = { inspect, detect, binding, validBinding, inspectRestored, detectRestored, findExecutable: binary };
