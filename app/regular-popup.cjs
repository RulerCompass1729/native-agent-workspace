'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const DAILY_MICROS = 10000, RESERVE_MICROS = 7000, MAX_BYTES = 1024 * 1024;
const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const SOURCE = 'https://github.com/trending';
const STATES = ['fetching', 'generating', 'ready', 'source-failed', 'unconfirmed', 'budget', 'daily-limit', 'cancelled'];
const copy = value => structuredClone(value);
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const known = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
const text = (v, max) => typeof v === 'string' && v.length <= max;
function validUrl(value) {
  try { const u = new URL(value); return u.href === value && u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && !u.port && !u.search && !u.hash && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(u.pathname) && u.pathname.split('/').every(p => !['.', '..'].includes(p)); }
  catch { return false; }
}
function emptyState() { return { version: 1, revision: 0, config: { enabled: false, concern: '', time: '09:00' }, runs: [] }; }
function validConfig(c) { return known(c, ['enabled', 'concern', 'time']) && typeof c.enabled === 'boolean' && text(c.concern, 200) && typeof c.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c.time) && (!c.enabled || c.concern.trim().length > 0); }
function validState(s) {
  return known(s, ['version', 'revision', 'config', 'runs']) && s.version === 1 && Number.isSafeInteger(s.revision) && s.revision >= 0 && validConfig(s.config) && Array.isArray(s.runs) && s.runs.every(r =>
    known(r, ['id', 'day', 'budgetDay', 'budgetAt', 'budgetMonoMs', 'at', 'state', 'chargedMicros', 'attempted', 'items']) && text(r.id, 80) && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && /^\d{4}-\d{2}-\d{2}$/.test(r.budgetDay) && ['budgetAt', 'budgetMonoMs'].every(k => r[k] === undefined || Number.isSafeInteger(r[k]) && r[k] >= 0) && Number.isSafeInteger(r.at) && STATES.includes(r.state) && Number.isSafeInteger(r.chargedMicros) && r.chargedMicros >= 0 && r.chargedMicros <= DAILY_MICROS && typeof r.attempted === 'boolean' && Array.isArray(r.items) && r.items.length <= 3 && r.items.every(i =>
      known(i, ['id', 'title', 'url', 'why', 'read', 'ignored']) && text(i.id, 60) && text(i.title, 140) && validUrl(i.url) && text(i.why, 240) && typeof i.read === 'boolean' && typeof i.ignored === 'boolean'));
}
class FileStore {
  constructor(directory) { this.file = path.join(directory, 'regular-popup.json'); }
  read() {
    let fd;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > MAX_BYTES) throw Error('storage-unavailable'); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw Error('storage-unavailable'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  write(value) {
    const body = JSON.stringify(value); if (Buffer.byteLength(body) > MAX_BYTES) throw Error('storage-unavailable');
    const temporary = `${this.file}.${randomUUID()}.tmp`; let fd;
    try { fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, this.file); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
  }
}
class RegularPopup {
  constructor({ directory, store, now = Date.now, monotonicNow = () => Number(process.hrtime.bigint() / 1000000n), permitted = false, readSource, select, notify = () => {}, changed = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.store = store || new FileStore(directory); this.now = now; this.permitted = permitted === true && typeof readSource === 'function' && typeof select === 'function';
    this.readSource = readSource; this.select = select; this.notify = notify; this.changed = changed; this.setTimer = setTimer; this.clearTimer = clearTimer; this.monotonicNow = monotonicNow;
    this.active = false; this.closed = false; this.timer = null; this.flight = null; this.abort = null; this.error = null;
    try {
      const loaded = this.store.read(); this.data = loaded === null ? emptyState() : loaded; if (!validState(this.data)) throw Error('storage-unavailable'); this.data = copy(this.data);
      const mono = this.monotonicNow(); if (!Number.isSafeInteger(mono) || mono < 0) throw Error();
      // Legacy or reset clocks cannot prove debt expiry; retain it for another full elapsed day.
      for (const r of this.data.runs) if (r.chargedMicros > 0 && (r.budgetMonoMs === undefined || r.budgetMonoMs > mono)) r.budgetMonoMs = mono;
    }
    catch { this.data = emptyState(); this.error = 'storage-unavailable'; }
  }
  status() {
    const s = copy(this.data);
    for (const r of s.runs) if (['fetching', 'generating'].includes(r.state) && !this.flight) r.state = r.attempted ? 'unconfirmed' : 'cancelled';
    return { ...s, source: SOURCE, allowed: this.permitted, error: this.error, dailyMicros: DAILY_MICROS,
      unread: s.runs.reduce((n, r) => n + r.items.filter(i => !i.read && !i.ignored).length, 0) };
  }
  save(next, popup = false) {
    if (this.error) throw Error(this.error);
    try { if (!validState(next)) throw Error(); this.store.write(next); }
    catch { this.error = 'storage-unavailable'; throw Error(this.error); }
    this.data = next;
    if (!this.closed) try { this.changed(this.status(), popup); } catch {}
  }
  configure(config) {
    if (!validConfig(config)) throw Error('invalid-config');
    if (config.enabled && !this.permitted) throw Error('approval-required');
    if (this.closed) throw Error('closed');
    const next = copy(this.data); next.config = copy(config); next.revision++; this.save(next); this.abort?.abort(); this.arm(); return this.status();
  }
  mark(runId, itemId, action) {
    if (!['read', 'ignored'].includes(action)) throw Error('invalid-action');
    const next = copy(this.data), item = next.runs.find(r => r.id === runId)?.items.find(i => i.id === itemId);
    if (!item) throw Error('item-missing'); item[action] = true; this.save(next); return this.status();
  }
  due(at) {
    const date = new Date(at), [h, m] = this.data.config.time.split(':').map(Number), scheduled = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
    if (scheduled.getTime() > at) scheduled.setDate(scheduled.getDate() - 1);
    return dateKey(scheduled);
  }
  start() { if (!this.closed) { this.active = true; this.arm(); } }
  arm() {
    if (this.timer !== null) this.clearTimer(this.timer); this.timer = null;
    if (!this.active || this.closed || this.error || !this.permitted || !this.data.config.enabled) return;
    const at = this.now(), date = new Date(at), [h, m] = this.data.config.time.split(':').map(Number), next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
    if (next.getTime() <= at) next.setDate(next.getDate() + 1);
    const missed = !this.data.runs.some(r => r.day === this.due(at));
    this.timer = this.setTimer(() => { this.timer = null; this.tick().catch(() => {}).finally(() => this.arm()); }, missed ? 0 : Math.max(1, next.getTime() - at));
    this.timer?.unref?.();
  }
  tick() {
    if (this.flight) return this.flight;
    if (this.closed || this.error || !this.permitted || !this.data.config.enabled) return Promise.resolve(this.status());
    let resolve, reject; const flight = new Promise((a, b) => { resolve = a; reject = b; }); this.flight = flight;
    this.run().then(value => { this.flight = null; resolve(value); }, error => { this.flight = null; reject(error); }); return flight;
  }
  budgetWindow(at = this.now()) {
    const mono = this.monotonicNow();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(mono) || mono < 0) throw Error('clock-unavailable');
    // Local calendar day for accounting; elapsed 24h additionally prevents timezone/wall-clock resets.
    const budgetDay = dateKey(new Date(at)), recent = this.data.runs.filter(r => r.budgetDay === budgetDay || r.chargedMicros > 0 && (r.budgetMonoMs === undefined || mono - r.budgetMonoMs < BUDGET_WINDOW_MS));
    const spent = recent.reduce((n, r) => n + r.chargedMicros, 0);
    const limited = spent + RESERVE_MICROS > DAILY_MICROS ? 'budget' : recent.some(r => r.budgetDay === budgetDay && r.attempted) ? 'daily-limit' : null;
    return { budgetDay, budgetAt: at, budgetMonoMs: mono, limited };
  }
  async run() {
    const at = this.now(), day = this.due(at);
    if (this.data.runs.some(r => r.day === day)) return this.status();
    const { budgetDay, limited } = this.budgetWindow(at);
    const record = { id: randomUUID(), day, budgetDay, at, state: limited || 'fetching', chargedMicros: 0, attempted: false, items: [] };
    const next = copy(this.data); next.runs.unshift(record); this.save(next);
    if (limited) return this.status();
    const revision = this.data.revision, concern = this.data.config.concern; this.abort = new AbortController();
    const current = () => !this.closed && !this.error && this.data.config.enabled && this.data.revision === revision;
    const finish = (state, extra = {}, popup = false) => { const next = copy(this.data), r = next.runs.find(r => r.id === record.id); Object.assign(r, extra, { state }); this.save(next, popup); return this.status(); };
    let source;
    try {
      source = await this.readSource({ url: SOURCE, signal: this.abort.signal });
      if (!Array.isArray(source) || source.length > 30 || !source.every(i => known(i, ['id', 'title', 'description', 'url']) && typeof i.id === 'string' && /^[a-z0-9-]{1,60}$/.test(i.id) && text(i.title, 140) && text(i.description, 400) && validUrl(i.url)) || new Set(source.map(i => i.id)).size !== source.length || Buffer.byteLength(JSON.stringify(source)) > 15000) throw Error();
    } catch { return finish(current() ? 'source-failed' : 'cancelled'); }
    if (!current()) return finish('cancelled');
    source = copy(source);
    if (!source.length) return finish('ready');
    const payload = { concern, candidates: source.map(i => ({ id: i.id, title: i.title, description: i.description })) };
    if (Buffer.byteLength(JSON.stringify(payload)) > 16384) return finish('source-failed');
    const budget = this.budgetWindow(), { limited: blocked, ...stamp } = budget;
    if (blocked) return finish(blocked, stamp);
    finish('generating', { ...stamp, chargedMicros: RESERVE_MICROS, attempted: true });
    if (!current()) return finish('cancelled');
    let result;
    try { result = await this.select(copy(payload), { signal: this.abort.signal }); }
    catch { return finish(current() ? 'unconfirmed' : 'cancelled'); }
    if (!current()) return finish('cancelled');
    if (!known(result, ['picks', 'costMicros']) || !Number.isSafeInteger(result.costMicros) || result.costMicros < 0 || result.costMicros > RESERVE_MICROS || !Array.isArray(result.picks) || result.picks.length > 3 || new Set(result.picks.map(i => i?.id)).size !== result.picks.length || !result.picks.every(i => known(i, ['id', 'why']) && source.some(s => s.id === i.id) && text(i.why, 240) && i.why.length > 0)) return finish('unconfirmed');
    const items = result.picks.map(i => { const original = source.find(s => s.id === i.id); return { id: original.id, title: original.title, url: original.url, why: i.why, read: false, ignored: false }; });
    const status = finish('ready', { items, chargedMicros: result.costMicros }, items.length > 0);
    if (current() && items.length) try { this.notify({ count: items.length }); } catch {}
    return status;
  }
  dispose() { this.closed = true; this.active = false; this.abort?.abort(); if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
}
// Approval is deliberately absent in the shipped composition; fixtures inject their own transports.
function create({ directory, store, changed, notify } = {}) { return new RegularPopup({ directory, store, changed, notify }); }
module.exports = { RegularPopup, create, emptyState, DAILY_MICROS, SOURCE, FileStore };
