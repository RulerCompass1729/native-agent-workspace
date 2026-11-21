'use strict';
// A count and fixed alert codes only. Authority, keys and subscription are memory-only and die
// with the existing paired-device generation. Importing starts no I/O or timer.
const https = require('node:https'), dns = require('node:dns'), net = require('node:net');
const crypto = require('node:crypto');
const HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
// RFC 6068 permits an empty recipient. No contact identity; provider acceptance is unverified.
const SUBJECT = 'mailto:';
// The whole alert vocabulary, most urgent first. The phone holds the wording; nothing else is ever sent.
const ALERTS = ['service-disconnected', 'steward-wake-stalled', 'token-anomaly', 'decision-waiting'];
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
  constructor({ authority, count, alerts = () => ({ alerts: [] }), transport = sendRequest, now = Date.now }) {
    if (typeof authority !== 'function' || typeof count !== 'function' || typeof alerts !== 'function') throw denied();
    Object.assign(this, { authority, count, alerts, transport, now }); this.close();
  }
  // The listed codes in fixed order, and the latest moment one of them began. That moment is never sent.
  // The source answers { alerts, unknown }. Unknown is never "no problems": a code already said stays while its
  // source cannot be read, and all of them stay when the answer itself cannot be read.
  read() {
    let value; try { value = this.alerts(); } catch { value = null; }
    const ok = Boolean(value) && Array.isArray(value.alerts);
    const found = ok ? value.alerts.filter(v => v && typeof v === 'object' && ALERTS.includes(v.code)) : [];
    const held = !ok ? this.said : Array.isArray(value.unknown) ? this.said.filter(code => value.unknown.includes(code)) : [];
    return { codes: ALERTS.filter(code => held.includes(code) || found.some(v => v.code === code)), at: Math.max(0, ...found.map(v => Number.isSafeInteger(v.at) ? v.at : 0)) };
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
    this.subscription = sub; this.lastCount = undefined; this.said = []; this.at = 0; this.ending = false; this.lastSubmittedAt = null; this.state = 'subscribed';
  }
  // Says the current state once more, retrying until it is accepted, and then ends: for a source that will not return.
  end() { this.ending = true; return this.subscription ? this.refresh() : this.close(); }
  async refresh() {
    if (this.current() !== this.stamp) { this.close(); return; }
    if (!this.subscription || this.running) return;
    clearTimeout(this.timer); this.timer = null;
    const stamp = this.stamp, sub = this.subscription, abort = new AbortController(), last = this.ending;
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
      // A null count may not be read now (no reminders permission, or the source is lost). One that fails or is
      // malformed holds back only itself: alerts still leave, and it alone is no reason to speak.
      let count = null, failed = false;
      try { count = this.count(); } catch { failed = true; }
      if (count !== null && (!Number.isSafeInteger(count) || count < 0)) { count = null; failed = true; }
      const { codes, at } = this.read();
      const same = String(codes) === String(this.said) && (failed || count === this.lastCount);
      // An unchanged alert is said again only when a newer case of it began, such as a second question.
      if (same && at <= this.at || count === null && !codes.length && !this.said.length) {
        if (last) this.close(); else if (failed) this.state = 'delayed';
        return;
      }
      // An empty list is sent once after an alert, so the phone can say it has cleared.
      const payload = { ...(count === null ? {} : { count }), ...(codes.length || this.said.length ? { alerts: codes } : {}) };
      // An alert must outlast a phone that is briefly unreachable; the shared topic lets a later state replace it.
      const details = library().generateRequestDetails(sub, JSON.stringify(payload), {
        TTL: codes.length ? 3600 : 60, topic: 'naw-count', urgency: codes.length ? 'high' : 'normal', contentEncoding: 'aes128gcm',
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
      else if (status === 201 || status === 202) {
        if (!failed) this.lastCount = count;
        this.said = codes; this.at = Math.max(this.at, at); this.lastSubmittedAt = this.now(); this.state = 'accepted';
        if (last) this.close();
      }
      else this.state = 'delayed';
    } catch { if (valid()) this.state = 'delayed'; }
    finally {
      this.running = false;
      if (this.abort === abort) this.abort = null;
      if (this.subscription && this.current() === this.stamp) {
        this.timer = setTimeout(() => this.refresh(), this.subscription === sub && last === this.ending ? 60000 : 0); this.timer.unref();
      }
    }
  }
  close() {
    clearTimeout(this.timer); this.abort?.abort(); this.abort = null; this.timer = null;
    this.subscription = null; this.keys = null; this.stamp = null; this.lastCount = undefined; this.said = []; this.at = 0; this.ending = false;
    this.authorization = new Map();
    this.lastSubmittedAt = null; this.state = 'off';
  }
}
module.exports = { MobilePush, ALERTS, subscriptionValue, publicAddress, sendRequest };
