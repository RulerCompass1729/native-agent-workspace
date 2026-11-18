'use strict';
// Count-only wakeup. Authority, keys and subscription are memory-only and die
// with the existing paired-device generation. Importing starts no I/O or timer.
const https = require('node:https'), dns = require('node:dns'), net = require('node:net');
const crypto = require('node:crypto');
const HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
// RFC 6068 permits an empty recipient. No contact identity; provider acceptance is unverified.
const SUBJECT = 'mailto:';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const denied = () => Object.assign(Error('Mobile push unavailable'), { code: 'MOBILE_PUSH_DENIED' });
function library() {
  // http_ece captures this flag at import. Never load or use it in key-log mode.
  if (process.env.ECE_KEYLOG === '1') throw denied();
  return require('web-push');
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw denied();
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.href !== value || u.username || u.password || u.port || u.search || u.hash ||
      !HOSTS.has(u.hostname) || !/^\/[A-Za-z0-9_.:~\-/=]+$/.test(u.pathname)) throw denied();
  return value;
}
function key(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw denied();
  const b = Buffer.from(value, 'base64url');
  if (b.length !== bytes || b.toString('base64url') !== value) throw denied();
  return b;
}
function subscriptionValue(s, now = Date.now()) {
  if (!exact(s, ['endpoint', 'expirationTime', 'keys']) || !exact(s.keys, ['p256dh', 'auth']) ||
      s.expirationTime !== null && (!Number.isSafeInteger(s.expirationTime) || s.expirationTime <= now)) throw denied();
  endpoint(s.endpoint); const publicKey = key(s.keys.p256dh, 65); key(s.keys.auth, 16);
  if (publicKey[0] !== 4) throw denied();
  try { crypto.ECDH.convertKey(publicKey, 'prime256v1'); } catch { throw denied(); }
  return { endpoint: s.endpoint, expirationTime: s.expirationTime, keys: { ...s.keys } };
}
function publicAddress(address) {
  if (net.isIP(address) === 6) return /^[23]/.test(address) && !address.toLowerCase().startsWith('2001:db8:');
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && [0, 2].includes(c)) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
function publicLookup(host, options, callback) {
  if (!HOSTS.has(host)) return callback(denied());
  dns.lookup(host, { all: true, verbatim: true }, (error, rows) => {
    if (error || !rows?.length || rows.some(r => !publicAddress(r.address))) return callback(denied());
    const row = rows.find(r => !options.family || r.family === options.family);
    if (!row) return callback(denied());
    callback(null, options.all ? [row] : row.address, row.family);
  });
}
function sendRequest(details, { signal, valid }, request = https.request) {
  endpoint(details.endpoint);
  return new Promise((resolve, reject) => {
    if (signal.aborted || !valid()) return reject(denied());
    let req, timer;
    const fail = () => { req?.destroy(); reject(denied()); };
    try {
      req = request(details.endpoint, { method: 'POST', headers: details.headers, agent: false, lookup: publicLookup,
        signal, maxHeaderSize: 8192 }, res => {
        let bytes = 0;
        res.on('data', b => { bytes += b.length; if (bytes > 4096) fail(); });
        res.once('error', fail); res.once('end', () => resolve(res.statusCode)); res.resume();
      });
      // DNS/TLS may have taken time. Recheck the generation before any HTTP
      // headers/body leave; close() also aborts DNS/connect/in-flight requests.
      req.once('socket', socket => socket.once('secureConnect', () => {
        if (signal.aborted || !valid()) return fail();
        req.end(details.body);
      }));
      req.once('error', () => reject(denied()));
      timer = setTimeout(fail, 10000); timer.unref();
      req.once('close', () => clearTimeout(timer));
    } catch { clearTimeout(timer); fail(); }
  });
}
class MobilePush {
  constructor({ authority, count, transport = sendRequest, now = Date.now }) {
    if (typeof authority !== 'function' || typeof count !== 'function') throw denied();
    Object.assign(this, { authority, count, transport, now }); this.close();
  }
  current() { try { return this.authority() || null; } catch { return null; } }
  configuration() {
    const stamp = this.current(); if (!stamp) throw denied();
    if (stamp !== this.stamp) this.close();
    this.stamp = stamp; this.keys ||= library().generateVAPIDKeys();
    return { ...this.status(), publicKey: this.keys.publicKey };
  }
  status() {
    if (this.stamp && this.current() !== this.stamp) this.close();
    return { enabled: Boolean(this.subscription), state: this.state, lastSubmittedAt: this.lastSubmittedAt };
  }
  subscribe(value) {
    if (!this.keys || !this.stamp || this.current() !== this.stamp) throw denied();
    const sub = subscriptionValue(value, this.now());
    // Replacing a browser subscription also cancels any old in-flight request.
    this.abort?.abort(); clearTimeout(this.timer); this.timer = null;
    this.subscription = sub; this.lastCount = null; this.lastSubmittedAt = null; this.state = 'subscribed';
  }
  async refresh() {
    if (this.current() !== this.stamp) { this.close(); return; }
    if (!this.subscription || this.running) return;
    clearTimeout(this.timer); this.timer = null;
    const stamp = this.stamp, sub = this.subscription, abort = new AbortController();
    const valid = () => {
      if (abort.signal.aborted || this.current() !== stamp || this.subscription !== sub) return false;
      if (sub.expirationTime !== null && sub.expirationTime <= this.now()) {
        this.subscription = null; this.state = 'expired'; abort.abort(); return false;
      }
      return true;
    };
    this.abort = abort; this.running = true;
    try {
      if (!valid()) return;
      const count = this.count();
      if (!Number.isSafeInteger(count) || count < 0) throw denied();
      if (count === this.lastCount) return;
      const details = library().generateRequestDetails(sub, JSON.stringify({ count }), {
        TTL: 60, topic: 'naw-count', urgency: 'normal', contentEncoding: 'aes128gcm',
        vapidDetails: { subject: SUBJECT, ...this.keys },
      });
      // APNs requires a JWT to be reused for at least an hour. Keep it per
      // push-service origin, never per private carrier URL or reminder body.
      const origin = new URL(sub.endpoint).origin, cached = this.authorization.get(origin);
      if (cached && this.now() - cached.at < 3600000) details.headers.Authorization = cached.value;
      else this.authorization.set(origin, { at: this.now(), value: details.headers.Authorization });
      if (!valid()) return;
      const status = await this.transport(details, { signal: abort.signal, valid });
      if (!valid()) return;
      if (status === 404 || status === 410) { this.subscription = null; this.state = 'expired'; }
      else if (status === 201 || status === 202) { this.lastCount = count; this.lastSubmittedAt = this.now(); this.state = 'accepted'; }
      else this.state = 'delayed';
    } catch { if (valid()) this.state = 'delayed'; }
    finally {
      this.running = false;
      if (this.abort === abort) this.abort = null;
      if (this.subscription && this.current() === this.stamp) {
        this.timer = setTimeout(() => this.refresh(), this.subscription === sub ? 60000 : 0); this.timer.unref();
      }
    }
  }
  close() {
    clearTimeout(this.timer); this.abort?.abort(); this.abort = null; this.timer = null;
    this.subscription = null; this.keys = null; this.stamp = null; this.lastCount = null;
    this.authorization = new Map();
    this.lastSubmittedAt = null; this.state = 'off';
  }
}
module.exports = { MobilePush, subscriptionValue, publicAddress, sendRequest };
