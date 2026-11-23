'use strict';
// After the daily GUI changed version or restarted, the designated butler and the queue secretary (项目经理) are told
// once: the versions, when it restarted, which backends are still on an old version and what each waits for; then
// once more each time a backend finished or failed its move (the person, 2026-11-23: 「装机结束了你和 NAW 的项目经理貌似
// 都呆住了啥都没发出来(这也是 bug)」). Versions, times, counts, session names and reason codes only; nothing of any
// conversation. The butler gets an event in its record (butler-ingress.cjs), which steward-wake.cjs wakes it for; the
// secretary a NAW message the queue dispatcher sends once it is idle and settled, under the person's automatic-message
// switch, like answer-notices.cjs. NAW adds no queue item and opens no other channel.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const FILE = 'version-seen.json', RECORD_MAX = 1024, MAX_BACKENDS = 20, MAX_NAMES = 4, MAX_OWED = 20;
const RETRY_MS = 60 * 1000, MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONTROL = /[\u0000-\u001f\u007f]/gu;
const clean = (value, limit) => typeof value === 'string' ? value.replace(CONTROL, ' ').trim().slice(0, limit) : '';
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = at => new Date(at).toISOString().replace(/\.\d{3}Z$/u, 'Z');
// services.json keys: '.' or backends/<20 hex>.
const short = key => key === '.' ? 'root' : clean(String(key).split('/').pop(), 7) || 'unknown';

// What each code of queue-dispatch.cjs moveWait (and main.cjs observeVersion) says.
const WAITS = Object.freeze({
  moving: () => '正在迁',
  next: () => '排队自动迁（每分钟迁一个后台）',
  'quiet-10m': b => `${b.count} 个会话里 ${b.wait.waiting} 个还没连续安静 10 分钟，安静后自动迁`,
  'quiet-30m': b => `${b.count} 个会话里 ${b.wait.waiting} 个还没安静够（有队友、子 agent 或后台活的要连续安静 30 分钟），之后自动迁`,
  busy: b => `${b.count} 个会话里 ${b.wait.waiting} 个在干活或等人回答，都停下并连续安静 10 分钟（有队友、子 agent 或后台活的 30 分钟）后自动迁`,
  'busy-auto': b => `${b.count} 个会话里 ${b.wait.waiting} 个在干活或等人回答；停下后能证明不丢东西的自动迁，否则要人点更新`,
  'needs-person': () => '自动迁移没开，要人点更新',
  blocked: () => '有会话挡着，NAW 不自己迁，要人在后台更新里看原因',
  'not-movable': () => 'NAW 不能自己迁（版本无法比较、会话没确认结束或连接正在更新）',
  'session-missing': () => '有会话暂时不在列表里，等它回来再迁',
  failed: () => '自动迁移失败，这次运行不再自动试，要人点更新',
});

function backendLine(b) {
  const names = b.sessions.slice(0, MAX_NAMES).map(s => clean(s.name, 40) || s.id).join('、');
  const more = b.sessions.length > MAX_NAMES ? ` 等 ${b.sessions.length} 个` : '';
  const wait = (WAITS[b.wait.code] || WAITS['not-movable'])(b);
  return `- ${short(b.key)}（${b.version || '版本未知'}；${names}${more}）：${wait}`;
}
function behindText(version, backends) {
  if (!backends.length) return `后台都已在 ${version}。`;
  const listed = backends.slice(0, MAX_BACKENDS).map(backendLine);
  if (backends.length > MAX_BACKENDS) listed.push(`- 另有 ${backends.length - MAX_BACKENDS} 个`);
  return `还有 ${backends.length} 个后台不在 ${version}：\n${listed.join('\n')}\n迁完或失败时再发一条。`;
}

function readSeen(file) {
  let fd;
  try {
    // Open first, then judge what was opened: a link is refused.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > RECORD_MAX || stat.uid !== process.getuid()) return null;
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return data && data.format === 1 && token(data.version) ? data.version : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeSeen(file, version, at) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, JSON.stringify({ format: 1, version, at }), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

class VersionEvents {
  // `record(event)`: into the butler's event record. `owe(text)`: to the secretary; nothing when none is designated.
  constructor(directory, { version, now = Date.now, record, owe }) {
    this.file = path.join(directory, FILE);
    Object.assign(this, { version, now, record, owe });
    this.at = now();
    // The last version a start announced; 「已装」 once per version, 「重启完成」 on every other start.
    this.previous = readSeen(this.file);
    this.announced = false; this.watch = new Map(); this.sequence = 0;
  }
  // Something is left to tell: this start, or a backend still on an old version.
  pending() { return !this.announced || this.watch.size > 0; }
  // `behind`: the backends not on this version, as main.cjs observeVersion lists them ({ key, version, sessions:
  // [{ id, name }], wait: { code, waiting? } }); `placed(id)`: the version of the backend a session is on now.
  observe(behind, placed) {
    const list = (Array.isArray(behind) ? behind : []).filter(b => b && token(b.key) && Array.isArray(b.sessions))
      .map(b => ({ ...b, version: clean(b.version, 60), count: b.sessions.length, wait: b.wait && typeof b.wait === 'object' ? b.wait : { code: 'not-movable' } }));
    if (!this.announced) {
      this.announced = true;
      const installed = this.previous !== this.version;
      const head = installed ? `已装 ${this.version}（原来是 ${this.previous || '没有记录'}），${iso(this.at)} 重启完成。`
        : `重启完成：${this.version}，${iso(this.at)}。`;
      for (const b of list) this.watch.set(b.key, { ...b, failed: b.wait.code === 'failed' });
      this.emit(installed ? 'version-installed' : 'version-restarted', `【NAW 版本】${head}\n${behindText(this.version, list)}`,
        `${this.previous || 'unknown'}->${this.version}`);
      try { writeSeen(this.file, this.version, this.at); } catch { /* The next start says 「已装」 again. */ }
      return;
    }
    const current = new Map(list.map(b => [b.key, b])), lines = [];
    let moved = 0, gone = 0, failed = 0;
    for (const [key, was] of this.watch) {
      const b = current.get(key);
      if (!b) {
        const there = was.sessions.filter(s => placed(s.id) === this.version).length;
        // Gone from the list is not proof of a move: its sessions may have been archived or hidden.
        lines.push(`- ${short(key)} ${there === was.count ? '迁完' : '不在待迁列表里了'}：${was.count} 个会话里 ${there} 个已在 ${this.version}`);
        this.watch.delete(key);
        if (there === was.count) moved++; else gone++;
        continue;
      }
      const failedNow = b.wait.code === 'failed' && !was.failed;
      if (failedNow) { lines.push(`- ${short(key)}：${WAITS.failed()}`); failed++; }
      this.watch.set(key, { ...b, failed: was.failed || failedNow });
    }
    // A backend that came back later is told with the next change.
    for (const b of list) if (!this.watch.has(b.key)) this.watch.set(b.key, { ...b, failed: b.wait.code === 'failed' });
    if (!lines.length) return;
    const rest = behindText(this.version, [...this.watch.values()]);
    this.emit(failed && !moved && !gone ? 'backend-move-failed' : 'backend-moved', `【NAW 版本】后台迁移（${this.version}）：\n${lines.join('\n')}\n${rest}`,
      `moved:${moved},gone:${gone},failed:${failed},behind:${this.watch.size}`);
  }
  // A migration's quiet window (quiet-windows.cjs) reached its deadline before the move: dispatch and automatic
  // messages there resume, and NAW opens none for that backend for two hours.
  quietWindowTimedOut(window) {
    const key = typeof window?.scope === 'string' ? window.scope.replace(/^backend:/u, '') : '';
    const waited = token(window?.waited) ? window.waited : 'unknown';
    const at = Number.isSafeInteger(window?.deadline) ? iso(window.deadline) : iso(this.now());
    this.emit('quiet-window-timeout', `【NAW 版本】后台 ${short(key)} 迁移前的安静窗口到了截止时间（${at}），还没迁成：已恢复派活和自动消息；2 小时内不再为它开窗。`,
      `backend:${short(key)},waited:${waited}`);
  }
  emit(reason, text, outcome) {
    const at = this.now(), eventId = `version-change:${hash([this.version, this.at, this.sequence++])}`;
    try {
      this.record({ eventId, sourceRef: `version-change:${this.version}`, kind: reason === 'backend-move-failed' ? 'failure' : 'blocked',
        payload: { reason, outcome, title: iso(at), text } });
    } catch { /* The secretary may still be told. */ }
    try { this.owe(`${text}\nNAW 只通知，不加任务。`); } catch { /* No secretary, or its notice could not be kept. */ }
  }
}

// What is owed to the secretary, for the queue dispatcher (queue-dispatch.cjs notifyOwed), in the shape of
// answer-notices.cjs. Kept in memory: a restart before it was sent makes that start's own notice.
class VersionNotices {
  constructor({ now = Date.now, retryMs = RETRY_MS, maxAgeMs = MAX_AGE_MS } = {}) {
    Object.assign(this, { now, retryMs, maxAgeMs });
    this.owed = new Map(); this.sequence = 0;
  }
  add(target, text) {
    if (!token(target?.sessionId) || !token(target?.nativeId) || typeof text !== 'string' || !text) return false;
    const k = JSON.stringify([target.sessionId, target.nativeId]);
    const entry = this.owed.get(k) || { sessionId: target.sessionId, nativeId: target.nativeId, notices: [], retryAt: 0 };
    entry.notices.push({ id: ++this.sequence, text, at: this.now() });
    entry.notices.splice(0, Math.max(0, entry.notices.length - MAX_OWED));
    this.owed.set(k, entry);
    return true;
  }
  waiting() { return this.owed.size > 0; }
  endingSoon() { return false; }
  due(now = this.now()) {
    return [...this.owed.values()].filter(entry => now >= entry.retryAt).map(entry => ({ sessionId: entry.sessionId, nativeId: entry.nativeId }));
  }
  take(target) { return [...(this.owed.get(JSON.stringify([target.sessionId, target.nativeId]))?.notices || [])]; }
  sent(target, notices) {
    const k = JSON.stringify([target.sessionId, target.nativeId]), entry = this.owed.get(k);
    if (!entry) return;
    const told = new Set(notices.map(n => n.id));
    entry.notices = entry.notices.filter(n => !told.has(n.id));
    if (!entry.notices.length) this.owed.delete(k);
  }
  failed(target) {
    const entry = this.owed.get(JSON.stringify([target.sessionId, target.nativeId]));
    if (entry) entry.retryAt = this.now() + this.retryMs;
  }
  prune(sessions, now = this.now()) {
    const listed = new Map((Array.isArray(sessions) ? sessions : []).map(s => [s?.id, s]));
    for (const [k, entry] of this.owed) {
      const session = listed.get(entry.sessionId);
      entry.notices = entry.notices.filter(n => now - n.at <= this.maxAgeMs);
      if (!entry.notices.length || session && (session.archived || session.nativeId !== entry.nativeId)) this.owed.delete(k);
    }
  }
  text(notices) { return notices.map(n => n.text).join('\n\n'); }
}

module.exports = Object.freeze({ VersionEvents, VersionNotices, FILE, WAITS });
