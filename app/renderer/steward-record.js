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
    function what(entry) {
      if (entry.kind === 'role') return [`stewardRecord.role.${ROLES.includes(entry.event) ? entry.event : 'started'}`, { name: dash(entry.name) }];
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
      if (!entry.state) return ['stewardRecord.result.unrecorded', {}];
      if (entry.state === 'not-executed') return REASONS.includes(entry.reason) ? [`stewardRecord.reason.${entry.reason}`, {}] : ['stewardRecord.result.refused', { reason: dash(entry.reason) }];
      return STATES.includes(entry.state) ? [`stewardRecord.result.${entry.state}`, {}] : ['stewardRecord.result.other', { state: entry.state }];
    }
    const attention = entry => ['confirmation-required', 'not-executed', 'unconfirmed', 'not-sent'].includes(entry.state) || entry.kind !== 'role' && entry.kind !== 'message' && !entry.state;
    function draw(view) {
      dialog.replaceChildren();
      const title = make('h2', '', 'stewardRecord.title'); title.id = (dialog.id || 'steward-record-dialog') + '-title'; dialog.setAttribute('aria-labelledby', title.id);
      dialog.append(title);
      const current = view?.current;
      dialog.append(make('p', 'quiet', current ? 'stewardRecord.current' : 'stewardRecord.none', { name: dash(current?.name) }));
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
          const [key, params] = what(entry); say(step, key, params);
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
