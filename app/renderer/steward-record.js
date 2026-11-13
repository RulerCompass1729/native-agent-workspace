/* 「大管家的记录」: each step the butler the person talks to took through NAW, under its own name (steward step 2,
   batch 1; the person, 2026-11-11: 「我觉得你把任务放进队列这件事本身其实也需要有地方 log 下来」). Read through the
   person-only call stewardRecord(); nothing here changes anything. */
(function (global) {
  'use strict';
  const STATES = ['running', 'complete', 'received', 'awaiting-native', 'confirmation-required', 'cancelled', 'not-executed', 'unconfirmed'];
  const MESSAGES = ['staged', 'sending', 'consumed', 'submitted', 'unconfirmed', 'not-sent', 'cancelled'];
  const REASONS = ['another-operation-running', 'unknown-command', 'confirmation-limit', 'originating-session-unavailable', 'conversation-access-denied', 'conversation-target-unavailable', 'space-file-membership-required', 'explicit-paths-required'];
  const ROLES = ['designated', 'revoked', 'followed', 'started'];
  function bind({ dialog, document, api, text, display, usageLines = null, language = () => 'zh' }) {
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, params); return el; };
    const make = (tag, cls, key, params) => { const el = document.createElement(tag); if (cls) el.className = cls; if (key) say(el, key, params); return el; };
    const pad = n => String(n).padStart(2, '0');
    // Today's steps show the time; earlier ones the day too.
    const when = (at, now) => { const d = new Date(at), t = new Date(now); const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return d.toDateString() === t.toDateString() ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`; };
    const dash = value => value || '—';
    // What it did, in a sentence: the few things a butler does most by name, anything else as its command.
    function what(entry, now = Date.now()) {
      if (entry.kind === 'role') return [`stewardRecord.role.${ROLES.includes(entry.event) ? entry.event : 'started'}`, { name: dash(entry.name) }];
      // NAW's own step: it woke the butler of that time to read what it recorded.
      if (entry.kind === 'wake') return ['stewardRecord.step.wake', { target: dash(entry.target) }];
      // A read of another session's conversation: whom, and how far when NAW knows it.
      if (entry.read) {
        if (entry.read.gone) return [entry.read.image ? 'stewardRecord.step.readImageGone' : 'stewardRecord.step.readGone', {}];
        if (entry.read.image) return ['stewardRecord.step.readImage', { target: dash(entry.read.target) }];
        if (entry.read.messages !== null && entry.read.messages !== undefined && entry.read.through) return ['stewardRecord.step.readThrough', { target: dash(entry.read.target), count: entry.read.messages, through: when(entry.read.through, now) }];
        return ['stewardRecord.step.read', { target: dash(entry.read.target) }];
      }
      if (entry.kind === 'snapshot') return ['stewardRecord.step.snapshot', {}];
      if (entry.kind === 'message') return ['stewardRecord.step.message', { target: dash(entry.target), text: entry.text || '' }];
      if (entry.method === 'spaceAction' && entry.spaceAction === 'queueAdd') return [entry.target ? 'stewardRecord.step.queueAddTo' : 'stewardRecord.step.queueAdd', { text: entry.text || '', space: dash(entry.space), target: dash(entry.target) }];
      if (entry.method === 'spaceAction' && ['queueCancel', 'queueResolve'].includes(entry.spaceAction)) return [`stewardRecord.step.${entry.spaceAction}`, { space: dash(entry.space) }];
      if (entry.method === 'spaceAction') return ['stewardRecord.step.space', { space: dash(entry.space), action: dash(entry.spaceAction) }];
      return entry.target ? ['stewardRecord.step.methodTarget', { method: dash(entry.method), target: entry.target }] : ['stewardRecord.step.method', { method: dash(entry.method) }];
    }
    // How it ended, as far as NAW knows now.
    function result(entry) {
      if (entry.kind === 'role') return null;
      if (entry.kind === 'message') return MESSAGES.includes(entry.state) ? [`stewardRecord.message.${entry.state}`, {}] : ['stewardRecord.result.other', { state: dash(entry.state) }];
      if (entry.kind === 'wake') return entry.state === 'sent' ? ['stewardRecord.wake.sent', {}] : ['not-sent', 'unconfirmed'].includes(entry.state) ? [`stewardRecord.message.${entry.state}`, {}]
        : entry.state ? ['stewardRecord.result.other', { state: entry.state }] : ['stewardRecord.result.unrecorded', {}];
      if (!entry.state) return ['stewardRecord.result.unrecorded', {}];
      if (entry.duplicate) return ['stewardRecord.result.duplicate', {}];
      if (entry.state === 'not-executed') return REASONS.includes(entry.reason) ? [`stewardRecord.reason.${entry.reason}`, {}] : ['stewardRecord.result.refused', { reason: dash(entry.reason) }];
      return STATES.includes(entry.state) ? [`stewardRecord.result.${entry.state}`, {}] : ['stewardRecord.result.other', { state: entry.state }];
    }
    const attention = entry => ['confirmation-required', 'not-executed', 'unconfirmed', 'not-sent'].includes(entry.state) || entry.kind !== 'role' && entry.kind !== 'message' && !entry.state;
    // NAW's switch for waking the butler when it records something new: the person's to see and turn off here (the
    // approved words for the butler: 「看得见、能关」), off by default. Changed in place, so focus stays on it.
    function wakeSwitch(state, now) {
      const box = make('div', 'steward-record-wake'), label = make('label'), input = document.createElement('input'), words = make('span', '', 'stewardRecord.wake.switch');
      input.type = 'checkbox'; input.dataset.action = 'steward-wake'; label.append(input, words);
      const status = make('span', 'steward-record-wake-status'), failure = make('p', 'records-note'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      // Read out with the switch: whether it is on, and when NAW last tried to wake the butler (steward-wake.cjs view).
      status.id = `${dialog.id || 'steward-record-dialog'}-wake-status`; input.setAttribute('aria-describedby', status.id);
      const show = (value, at) => {
        input.checked = value.on === true;
        if (value.failed) say(status, 'stewardRecord.wake.failed');
        else if (!value.on) say(status, 'stewardRecord.wake.off');
        else if (value.at) say(status, 'stewardRecord.wake.last', { time: when(value.at, at) });
        else say(status, 'stewardRecord.wake.never');
      };
      show(state, now);
      input.addEventListener('change', async () => {
        const want = input.checked; input.disabled = true; failure.hidden = true;
        try { show(await api.stewardWake(want), Date.now()); }
        catch (error) {
          // Not changed as asked: say why, and show how it stands now.
          say(failure, 'stewardRecord.wake.error', { reason: error?.message || '—' }); failure.hidden = false;
          try { show(await api.stewardWake(), Date.now()); } catch { input.checked = !want; }
        } finally { input.disabled = false; }
      });
      const line = make('div', 'steward-record-wake-switch'); line.append(label, status);
      box.append(line, make('p', 'quiet', 'stewardRecord.wake.cost'), failure);
      return box;
    }
    function draw(view) {
      dialog.replaceChildren();
      const title = make('h2', '', 'stewardRecord.title'); title.id = (dialog.id || 'steward-record-dialog') + '-title'; dialog.setAttribute('aria-labelledby', title.id);
      dialog.append(title);
      const current = view?.current;
      dialog.append(make('p', 'quiet', current ? 'stewardRecord.current' : 'stewardRecord.none', { name: dash(current?.name) }));
      // Messages held for it under its 60-second limit: how many, and how long the oldest has waited.
      if (current && view.waiting?.count > 0) { const minutes = Math.floor(Math.max(0, view.at - view.waiting.since) / 60000);
        dialog.append(make('p', 'steward-record-waiting', minutes ? 'stewardRecord.waiting' : 'stewardRecord.waitingNew', { count: view.waiting.count, minutes })); }
      if (current && view.wake) dialog.append(wakeSwitch(view.wake, view.at));
      if (view?.writeFailed) dialog.append(make('p', 'records-note', 'stewardRecord.writeFailed'));
      dialog.append(make('h3', '', 'stewardRecord.heading'));
      const entries = view?.entries || [];
      if (!entries.length) dialog.append(make('p', 'quiet', 'stewardRecord.empty'));
      else {
        const table = make('table', 'steward-record-steps'), head = make('thead'), row = make('tr'), body = make('tbody');
        for (const key of ['stewardRecord.col.time', 'stewardRecord.col.what', 'stewardRecord.col.result']) { const th = make('th', '', key); th.scope = 'col'; row.append(th); }
        head.append(row); table.append(head, body);
        for (const entry of entries) {
          const tr = make('tr', attention(entry) ? 'attention' : ''), time = make('td', 'steward-record-time'), step = make('td'), end = make('td', 'steward-record-result');
          tr.dataset.kind = entry.kind; time.textContent = when(entry.at, view.at);
          const [key, params] = what(entry, view.at); say(step, key, params);
          const outcome = result(entry); if (outcome) say(end, ...outcome);
          // NAW's own words for a step that failed or was refused by a rule, as the agent was told them.
          if (entry.error) { const why = make('small', 'steward-record-error'); why.textContent = entry.error; end.append(document.createElement('br'), why); }
          tr.append(time, step, end); body.append(tr);
        }
        dialog.append(table);
        if (view.total > entries.length) dialog.append(make('p', 'quiet', 'stewardRecord.more', { shown: entries.length, total: view.total }));
      }
      dialog.append(make('p', 'quiet', 'stewardRecord.note'));
      // The provider's own numbers for the butler's session, as the session shows them; NAW sets no limit.
      if (current) {
        const usage = make('div', 'steward-record-usage'), label = make('strong', '', 'stewardRecord.usage'), lines = make('div');
        const shown = current.usage && usageLines ? usageLines(current.provider, current.usage, language()) : [];
        if (shown.length) for (const line of shown) { const p = make('p'); p.textContent = line; lines.append(p); }
        else lines.append(make('p', 'quiet', 'stewardRecord.usageNone'));
        lines.append(make('p', 'quiet', 'stewardRecord.usageLimit'));
        usage.append(label, lines); dialog.append(usage);
      }
      const foot = make('div', 'dialog-actions'), done = make('button', 'primary', 'common.done'); done.type = 'button'; done.dataset.action = 'done';
      done.addEventListener('click', () => dialog.close()); foot.append(done); dialog.append(foot);
    }
    async function open() {
      let view = null, failure = null;
      try { view = await api.stewardRecord(); } catch (error) { failure = error; }
      if (failure) { dialog.replaceChildren(make('h2', '', 'stewardRecord.title'), make('p', 'records-note', 'stewardRecord.failed', { reason: failure?.message || '—' })); const foot = make('div', 'dialog-actions'), done = make('button', 'primary', 'common.done'); done.type = 'button'; done.addEventListener('click', () => dialog.close()); foot.append(done); dialog.append(foot); }
      else draw(view);
      if (!dialog.open) dialog.showModal();
      return view;
    }
    dialog.addEventListener('close', () => { dialog.replaceChildren(); });
    return { open, what, result };
  }
  const value = { bind };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceStewardRecord = value;
})(globalThis);
