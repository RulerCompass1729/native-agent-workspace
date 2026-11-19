const { isDeepStrictEqual } = require('node:util');
const { confirmationExpiresAt } = require('./background-control.cjs');
const { roomIds } = require('./collaboration-spaces.cjs');
const label = value => typeof value === 'string' && value === value.trim() && value.length > 0 && [...value].length <= 24 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\\/]/u.test(value) ? value : null;
const providers = { claude: 'Claude', codex: 'Codex' };
const shortMethods = new Set(['rename', 'roomRename', 'spaceAction', 'join', 'spaceCreate', 'archiveSession', 'restoreSession']);
const sameBinding = (a, b) => ['sessionId', 'nativeId', 'operationId', 'expiresAt', 'version', 'presentation'].every(key => a?.[key] === b?.[key]);
const sameCard = (a, b) => ['actor', 'at', 'command', 'confirmation', 'guard', 'terminalConsent', 'handlerStarted'].every(key => isDeepStrictEqual(a?.[key], b?.[key]));
function deadlineText(expiresAt, now, format) {
  const date = new Date(expiresAt), deadline = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return format('notification.deadline', { minutes: Math.ceil((expiresAt - now) / 60000), deadline });
}
function shortPresentation(record, { state, archives = {} }, format, now) {
  try {
    const command = record.command, args = command.arguments, options = record.confirmation?.options;
    if (record.state !== 'confirmation-required' || record.handlerStarted || record.confirmation?.kind !== 'message' ||
        options?.buttons?.length !== 2 || (options.cancelId ?? 0) !== 0 || command.paths !== undefined || !Array.isArray(args) ||
        state?.unavailable || state?.roomStorageWarning || !label(record.actor.name) || !providers[record.actor.provider]) return null;
    const actor = state.sessions?.find(s => s.id === record.actor.id);
    if (!actor || actor.nativeId !== record.actor.nativeId || actor.provider !== record.actor.provider || actor.name !== record.actor.name || state.sessions.filter(s => s.name === actor.name && s.provider === actor.provider).length !== 1 || actor.archived || actor.transportDisconnected || actor.backendUnavailable || actor.nativeContextPending) return null;
    const room = id => { const value = state.rooms?.find(r => r.id === id); if (!value || value.archived || !label(value.name) || state.rooms.filter(r => r.name === value.name).length !== 1) throw Error('Unclear space'); return value.name; };
    const home = session => { const ids = roomIds(session); if (ids.length > 1) throw Error('Unclear home'); return ids.length ? room(ids[0]) : format('notification.standalone'); };
    const session = id => { const value = state.sessions?.find(s => s.id === id); if (typeof value?.nativeId !== 'string' || !value.nativeId || !label(value.name) || !providers[value.provider] || state.sessions.filter(s => s.name === value.name && s.provider === value.provider).length !== 1) throw Error('Unclear session'); return value; };
    let method = command.method, values = args, roomId = 'shared', description;
    if (method === 'spaceAction') {
      if (args.length !== 3 || !Array.isArray(args[2]) || !['rename', 'join'].includes(args[1])) return null;
      roomId = args[0]; method = args[1] === 'rename' ? 'roomRename' : 'join'; values = args[2];
    }
    if (method === 'roomRename' && values.length === 1 && label(values[0])) description = format('notification.renameSpace', { from: room(roomId), to: values[0] });
    else if (method === 'spaceCreate' && values.length === 1 && label(values[0])) description = format('notification.createSpace', { name: values[0] });
    else if (method === 'rename' && values.length === 2 && label(values[1])) {
      const target = session(values[0]); description = format('notification.renameSession', { target: target.name, provider: providers[target.provider], room: home(target), name: values[1] });
    } else if (method === 'join' && values.length === 2 && typeof values[1] === 'boolean') {
      const target = session(values[0]), from = home(target), ids = roomIds(target);
      if (target.archived || !values[1] && !ids.includes(roomId)) return null;
      description = format('notification.moveSession', { target: target.name, provider: providers[target.provider], from, to: values[1] ? room(roomId) : format('notification.standalone') });
    } else if (['archiveSession', 'restoreSession'].includes(method) && values.length === 1) {
      const target = session(values[0]); let place;
      if (method === 'archiveSession') { if (target.archived) return null; place = home(target); }
      else {
        const saved = archives[target.id];
        if (!target.archived || !saved?.detached || saved.nativeId !== target.nativeId || !Array.isArray(saved.rooms) || saved.rooms.length > 1 || roomIds(target).length) return null;
        place = saved.rooms.length ? room(saved.rooms[0].id) : format('notification.standalone');
      }
      description = format('notification.' + method, { target: target.name, provider: providers[target.provider], room: place });
    }
    if (!description) return null;
    const expiresAt = confirmationExpiresAt(record);
    if (!Number.isSafeInteger(expiresAt) || now < record.at || now >= expiresAt) return null;
    const title = format('notification.actor', { name: record.actor.name, provider: providers[record.actor.provider] });
    const body = description + '\n' + deadlineText(expiresAt, now, format);
    // No ellipsis: a missing fact removes the quick approval instead.
    if ([...title].length > 56 || [...description].length > 80 || [...body].length > 120) return null;
    return { title, body };
  } catch { return null; }
}
class ConfirmationNotifications {
  constructor({ Notification, control, snapshot, format, reveal, active = () => true, now = Date.now, schedule = setTimeout, cancel = clearTimeout, seen = new Set() }) {
    Object.assign(this, { Notification, control, snapshot, format, reveal, active, now, schedule, cancel, seen });
    this.entries = new Map(); this.disposed = false;
  }
  async notify(record) {
    const key = `background:${record.actor.nativeId}:${record.id}`, expiresAt = confirmationExpiresAt(record);
    if (this.disposed || !this.active() || this.seen.has(key) || this.entries.has(key) || record.state !== 'confirmation-required' || !expiresAt || this.now() < record.at || this.now() >= expiresAt) return;
    this.seen.add(key); if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value);
    if (!this.Notification.isSupported()) return;
    let presentation, binding;
    if (shortMethods.has(record.command.method) && !record.handlerStarted) try {
      if (!sameCard(record, this.control.receipt(record.actor, record.id))) throw Error('Changed card');
      binding = this.control.mobileBinding(record.actor.id, record.actor.nativeId, record.id, 1);
      if (binding?.sessionId !== record.actor.id || binding.nativeId !== record.actor.nativeId || binding.operationId !== record.id || binding.expiresAt !== expiresAt ||
          typeof binding.version !== 'string' || !binding.version || typeof binding.presentation !== 'string' || !binding.presentation) throw Error('Incomplete binding');
      const metadata = await this.snapshot(record);
      if (!sameCard(record, this.control.receipt(record.actor, record.id))) throw Error('Changed card');
      presentation = shortPresentation(record, metadata, this.format, this.now());
      if (!presentation || !sameBinding(binding, this.control.mobileBinding(record.actor.id, record.actor.nativeId, record.id, 1))) binding = null;
    } catch { binding = null; }
    if (this.disposed || !this.active() || this.now() >= expiresAt) return;
    const options = binding ? { ...presentation, actions: [{ type: 'button', text: this.format('notification.confirm') }, { type: 'button', text: this.format('notification.reject') }] }
      : { title: this.format('os.decisionTitle'), body: this.format('notification.openFull') + '\n' + deadlineText(expiresAt, this.now(), this.format) };
    const notification = new this.Notification(options);
    const entry = { key, notification, binding: binding && Object.freeze({ ...binding }), actor: { id: record.actor.id, nativeId: record.actor.nativeId, provider: record.actor.provider }, id: record.id, at: record.at, expiresAt, claimed: false };
    this.entries.set(key, entry);
    entry.timer = this.schedule(() => this.remove(entry), Math.max(0, expiresAt - this.now())); entry.timer?.unref?.();
    notification.on('action', (event, index) => { void this.action(entry, event, index); });
    notification.once('click', () => { this.remove(entry); this.revealRecord(entry); });
    notification.once('close', () => { if (!entry.claimed) this.remove(entry, false); });
    notification.once('failed', () => this.remove(entry));
    while (this.entries.size > 50) this.remove(this.entries.values().next().value);
    try { notification.show(); } catch { this.remove(entry); }
  }
  assertCurrent(entry, response) {
    if (this.disposed || !this.active() || this.entries.get(entry.key) !== entry || !entry.binding || this.now() < entry.at || this.now() >= entry.expiresAt ||
        !sameBinding(entry.binding, this.control.mobileBinding(entry.actor.id, entry.actor.nativeId, entry.id, response, entry.claimed))) throw Error('Notification decision is no longer current');
  }
  async action(entry, event, legacyIndex) {
    if (this.disposed || this.entries.get(entry.key) !== entry || !entry.binding) return;
    const index = event?.actionIndex ?? legacyIndex;
    if (!Number.isSafeInteger(index) || ![0, 1].includes(index) || event?.actionIndex !== undefined && legacyIndex !== undefined && legacyIndex !== index || entry.claimed) return;
    const response = index === 0 ? 1 : 0;
    try {
      this.assertCurrent(entry, response); entry.claimed = true;
      try { entry.notification.close(); } catch { /* The decision still rechecks its binding. */ }
      await this.control.decide(entry.actor.id, entry.actor.nativeId, entry.id, response, () => this.assertCurrent(entry, response));
    } catch { this.revealRecord(entry); }
    finally { this.remove(entry); }
  }
  revealRecord(entry) { try { this.reveal({ sessionId: entry.actor.id, nativeId: entry.actor.nativeId, messageId: entry.key }); } catch { /* The original card stays in records. */ } }
  remove(entry, close = true) {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key); this.cancel(entry.timer);
    if (close) try { entry.notification.close(); } catch { /* OS removal is best effort. */ }
  }
  sync() {
    for (const entry of this.entries.values()) try {
      if (entry.binding) this.assertCurrent(entry, 1);
      else if (this.now() >= entry.expiresAt || this.control.receipt(entry.actor, entry.id)?.state !== 'confirmation-required') this.remove(entry);
    } catch { this.remove(entry); }
  }

  dispose() { this.disposed = true; for (const entry of this.entries.values()) this.remove(entry); }
}
module.exports = { shortPresentation, ConfirmationNotifications };
