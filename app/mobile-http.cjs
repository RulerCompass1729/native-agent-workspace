// Fixed HTTP adaptation only. This factory never creates or starts a server.
const fs = require('node:fs'), path = require('node:path');
const { randomBytes } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { SESSION_MS } = require('./mobile-access.cjs');
const COOKIE = '__Host-naw-mobile';
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const HTTP_ERROR = Symbol('mobile-transport-error');
const reject = (status, code) => Object.assign(new Error(code), { status, code, [HTTP_ERROR]: true });
const types = { '/mobile/': ['index.html', 'text/html; charset=utf-8'], '/mobile/client.js': ['client.js', 'text/javascript; charset=utf-8'], '/mobile/workspace.js': ['workspace.js', 'text/javascript; charset=utf-8'], '/mobile/push.js': ['push.js', 'text/javascript; charset=utf-8'], '/mobile/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/mobile/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/mobile/style.css': ['style.css', 'text/css; charset=utf-8'] };
types['/mobile/passkeys.js'] = ['passkeys.js', 'text/javascript; charset=utf-8'];
const consentRoutes = { '/mobile/consent/registration/options': 'registrationOptions', '/mobile/consent/register': 'registerPasskey',
  '/mobile/consent/registration/proof': 'registrationProof', '/mobile/consent/options': 'decisionOptions', '/mobile/consent/decide': 'decide', '/mobile/consent/receipt': 'decisionReceipt' };
function createMobileHandler({ broker, origin, actor, expectedHost, bodyTimeoutMs = 3000 }) {
  const site = new URL(origin);
  if (site.protocol !== 'https:' || site.origin !== origin || site.username || site.password || typeof actor !== 'string' || !actor || actor.length > 320 || /[\x00-\x1f\x7f]/.test(actor) ||
      !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 5000) throw Error('Invalid mobile transport configuration');
  expectedHost ??= site.host;
  if (typeof expectedHost !== 'string' || !expectedHost || /[^A-Za-z0-9.:[\]-]/.test(expectedHost)) throw Error('Invalid mobile transport host');
  for (const method of ['pair', 'session', 'read', 'send', 'answer', 'receipt', 'logout']) if (typeof broker?.[method] !== 'function') throw Error('Incomplete app-local mobile broker');
  const assets = new Map(Object.entries(types).map(([url, [file, type]]) => [url, { type, body: fs.readFileSync(path.join(__dirname, 'mobile-web', file)) }]));
  let active = 0;
  function headers(request) {
    if (!Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 || Buffer.byteLength(request.rawHeaders.join('\r\n')) > 8192) throw reject(400, 'MOBILE_BAD_REQUEST');
    const result = Object.create(null), unique = new Set(['host', 'origin', 'cookie', 'tailscale-user-login', 'x-naw-mobile', 'x-naw-csrf', 'content-type', 'content-length', 'transfer-encoding', 'sec-fetch-site']);
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i], value = request.rawHeaders[i + 1];
      if (typeof name !== 'string' || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw reject(400, 'MOBILE_BAD_REQUEST');
      const key = name.toLowerCase();
      if (unique.has(key) && Object.hasOwn(result, key)) throw reject(400, 'MOBILE_BAD_REQUEST');
      result[key] = value;
    }
    if (result['content-length'] !== undefined && result['transfer-encoding'] !== undefined) throw reject(400, 'MOBILE_BAD_REQUEST');
    return result;
  }
  function auth(values) {
    const cookies = (values.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(COOKIE + '='));
    if (cookies.length !== 1 || !secret(cookies[0].slice(COOKIE.length + 1))) throw reject(401, 'MOBILE_AUTH_REQUIRED');
    return { token: cookies[0].slice(COOKIE.length + 1), actor: values['tailscale-user-login'], origin: values.origin, csrf: values['x-naw-csrf'] };
  }
  async function body(request, values, max) {
    if (values['content-type'] !== 'application/json') throw reject(415, 'MOBILE_JSON_REQUIRED');
    const length = values['content-length'];
    if (length !== undefined && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > max)) throw reject(413, 'MOBILE_BODY_LIMIT');
    let bytes = 0; const chunks = [];
    const timer = setTimeout(() => request.destroy(reject(408, 'MOBILE_BODY_TIMEOUT')), bodyTimeoutMs); timer.unref();
    try {
      for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); bytes += chunk.length;
        if (bytes > max) throw reject(413, 'MOBILE_BODY_LIMIT');
        chunks.push(chunk);
      }
      if (length !== undefined && Number(length) !== bytes) throw reject(400, 'MOBILE_BAD_REQUEST');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw reject(400, 'MOBILE_BAD_REQUEST');
      return value;
    } catch (error) { if (error.status) throw error; throw reject(400, 'MOBILE_BAD_REQUEST'); }
    finally { clearTimeout(timer); }
  }
  function respond(response, status, value, type = 'application/json; charset=utf-8') {
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status; response.setHeader('Content-Type', type);
    response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
  function publicReceipt(value) {
    if (!value || typeof value.status !== 'string') throw reject(409, 'MOBILE_REQUEST_UNCONFIRMED');
    return { requestId: value.requestId, sessionId: value.sessionId, action: value.action, status: value.status,
      error: value.error ? 'MOBILE_ACTION_FAILED' : null, storageWarning: value.storageWarning ? 'MOBILE_STORAGE_UNCONFIRMED' : null };
  }
  return async function mobileHTTP(request, response) {
    const nonce = randomBytes(18).toString('base64url');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types naw-mobile-worker`);
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (active >= 8) return respond(response, 429, { error: 'MOBILE_BUSY' });
    active++;
    let dispatch = false;
    try {
      const values = headers(request), peer = request.socket?.remoteAddress;
      if (values['sec-fetch-site'] === 'cross-site') throw reject(403, 'MOBILE_DENIED');
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) || values.host?.toLowerCase() !== expectedHost.toLowerCase() || values['tailscale-user-login'] !== actor) throw reject(403, 'MOBILE_DENIED');
      if (values.origin !== undefined && values.origin !== origin) throw reject(403, 'MOBILE_DENIED');
      if (request.method === 'GET' && assets.has(request.url)) {
        const asset = assets.get(request.url), body = request.url === '/mobile/'
          ? Buffer.from(asset.body.toString('utf8').replaceAll('__NAW_SCRIPT_NONCE__', nonce)) : asset.body;
        return respond(response, 200, body, asset.type);
      }
      if (typeof request.url !== 'string' || request.url.includes('?') || request.url.includes('#') || values['x-naw-mobile'] !== '1') throw reject(403, 'MOBILE_DENIED');
      if (request.method === 'GET' && request.url === '/mobile/session') return respond(response, 200, await (typeof broker.refreshSession === 'function' ? broker.refreshSession(auth(values)) : broker.session(auth(values))));
      if (request.method === 'GET' && request.url === '/mobile/push') {
        if (typeof broker.pushInfo !== 'function') throw reject(403, 'MOBILE_DENIED');
        return respond(response, 200, broker.pushInfo(auth(values)));
      }
      if (request.method === 'GET' && request.url === '/mobile/workspace') {
        const credentials = auth(values);
        if (typeof broker.workspaceRead !== 'function') throw reject(403, 'MOBILE_DENIED');
        return respond(response, 200, await broker.workspaceRead(credentials));
      }
      const reading = request.method === 'GET' && request.url.match(/^\/mobile\/read\/([A-Za-z0-9_-]{1,100})$/);
      if (reading) return respond(response, 200, await broker.read(auth(values), reading[1]));
      if (request.method !== 'POST' || !['/mobile/pair', '/mobile/pair/activate', '/mobile/send', '/mobile/answer', '/mobile/receipt', '/mobile/logout', '/mobile/workspace/action', '/mobile/push', ...Object.keys(consentRoutes)].includes(request.url)) throw reject(404, 'MOBILE_NOT_FOUND');
      if (values.origin !== origin) throw reject(403, 'MOBILE_DENIED');
      const value = await body(request, values, request.url === '/mobile/pair' ? 4096 : 65536);
      if (request.url === '/mobile/pair') {
        if (!exact(value, ['secret']) || !secret(value.secret)) throw reject(400, 'MOBILE_BAD_REQUEST');
        const paired = await broker.pair({ secret: value.secret, actor, origin });
        if (!secret(paired.cookieValue) || !Number.isSafeInteger(paired.expiresAt)) throw reject(401, 'MOBILE_DENIED');
        const maxAge = Math.min(SESSION_MS / 1000, Math.max(0, Math.floor((paired.expiresAt - Date.now()) / 1000)));
        response.setHeader('Set-Cookie', `${COOKIE}=${paired.cookieValue}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
        return respond(response, 200, { paired: paired.candidate!==true,...(paired.candidate?{candidate:true}:{}), deviceId: paired.deviceId, expiresAt: paired.expiresAt });
      }
      const credentials = auth(values);
      if (!secret(credentials.csrf)) throw reject(403, 'MOBILE_DENIED');
      if(request.url==='/mobile/pair/activate') {
        if(!exact(value,['mode']) || !['verified','basic'].includes(value.mode) || typeof broker.activateCandidate!=='function')throw reject(403,'MOBILE_DENIED');
        dispatch=true;return respond(response,200,await broker.activateCandidate(credentials,value));
      }
      if (request.url === '/mobile/push') {
        if (typeof broker.pushAction !== 'function') throw reject(403, 'MOBILE_DENIED');
        return respond(response, 200, broker.pushAction(credentials, value));
      }
      if (Object.hasOwn(consentRoutes, request.url)) {
        const method = consentRoutes[request.url];
        if (typeof broker[method] !== 'function') throw reject(403, 'MOBILE_DENIED');
        dispatch = true; return respond(response, 200, await broker[method](credentials, value));
      }
      if (request.url === '/mobile/workspace/action') {
        if (typeof broker.workspaceAction !== 'function' || !['queueAdd', 'queueCancel', 'queueResolve', 'recordAcknowledge', 'receipt'].includes(value.action)) throw reject(403, 'MOBILE_DENIED');
        dispatch = true;
        const result = await broker.workspaceAction(credentials, value);
        if (!result || !['complete', 'not-sent', 'unconfirmed'].includes(result.status)) throw reject(409, 'MOBILE_REQUEST_UNCONFIRMED');
        return respond(response, 200, { requestId: result.requestId, status: result.status,
          ...(typeof result.itemId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(result.itemId) ? { itemId: result.itemId } : {}) });
      }
      if (request.url === '/mobile/receipt') {
        if (!exact(value, ['requestId'])) throw reject(400, 'MOBILE_BAD_REQUEST');
        // Broker verifies full session-bound CSRF before looking up an ID.
        dispatch = true;
        return respond(response, 200, publicReceipt(await broker.receipt(credentials, value.requestId)));
      }
      if (request.url === '/mobile/logout') {
        if (!exact(value, [])) throw reject(400, 'MOBILE_BAD_REQUEST');
        const result = broker.logout(credentials);
        // Keep phone drafts and unresolved request IDs for checking on the Mac.
        // Revoke server-side authority and expire only this bearer cookie;
        // a browser-wide storage wipe would destroy recovery evidence.
        response.setHeader('Set-Cookie', `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return respond(response, result.authorizationRevoked ? 200 : 409, result);
      }
      dispatch = true;
      const result = request.url === '/mobile/send' ? await broker.send(credentials, value) : await broker.answer(credentials, value);
      return respond(response, 200, publicReceipt(result));
    } catch (error) {
      // Neither thrown errors nor receipt diagnostics may expose local paths,
      // provider details or another backend's pause error through transport.
      const allowed = new Set(['MOBILE_REQUEST_CONFLICT', 'MOBILE_PAIR_LIMIT', 'MOBILE_CONTEXT_UNAVAILABLE', 'MOBILE_RECEIPT_UNKNOWN']);
      const code = dispatch ? allowed.has(error.code) ? error.code : 'MOBILE_REQUEST_UNCONFIRMED' : error[HTTP_ERROR] ? error.code : 'MOBILE_DENIED';
      return respond(response, dispatch ? 409 : error[HTTP_ERROR] ? error.status : 403, { error: code });
    } finally { active--; }
  };
}
module.exports = { createMobileHandler, COOKIE };
