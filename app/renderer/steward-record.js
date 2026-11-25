/* 「大管家的记录」: each step the butler the person talks to took through NAW, under its own name (steward step 2,
   batch 1; the person, 2026-11-11: 「我觉得你把任务放进队列这件事本身其实也需要有地方 log 下来」). Read through the
   person-only call stewardRecord(); nothing here changes anything. */
(function (global) {
  'use strict';
  const STATES = ['running', 'complete', 'received', 'awaiting-native', 'confirmation-required', 'cancelled', 'not-executed', 'unconfirmed'];
  const MESSAGES = ['staged', 'sending', 'consumed', 'submitted', 'unconfirmed', 'not-sent', 'cancelled'];
  const REASONS = ['another-operation-running', 'unknown-command', 'confirmation-limit', 'originating-session-unavailable', 'conversation-access-denied', 'conversation-target-unavailable', 'model-change-unavailable', 'space-file-membership-required', 'explicit-paths-required', 'standing-authorization-unavailable'];
  const ROLES = ['designated', 'revoked', 'followed', 'started'];
  // The butler's call on NAW's switch for waking it (steward-record.cjs view `wake`): turned on, off, or looked at.
  const WAKE_CALLS = Object.freeze({ __proto__: null, on: 'stewardRecord.step.wakeOn', off: 'stewardRecord.step.wakeOff', check: 'stewardRecord.step.wakeCheck' });
  const STANDING_CALLS = Object.freeze({ __proto__: null, on: 'stewardRecord.step.standingOn', off: 'stewardRecord.step.standingOff', check: 'stewardRecord.step.standingCheck' });
  // The intervals NAW's patrol of an idle butler may use (steward-wake.cjs PATROL_CHOICES); null is off.
  const PATROL = Object.freeze([null, 15, 30, 60]);
  function bind({ dialog, document, api, text, display, usageLines = null, language = () => 'zh' }) {
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const disclosure = global.nativeWorkspaceDisclosure || require('./disclosure-list.js');
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, typeof params === 'function' ? params() : params); return el; };
    const make = (tag, cls, key, params) => { const el = document.createElement(tag); if (cls) el.className = cls; if (key) say(el, key, params); return el; };
    const pad = n => String(n).padStart(2, '0');
    // Today's steps show the time; earlier ones the day too.
    const when = (at, now) => { const d = new Date(at), t = new Date(now); const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return d.toDateString() === t.toDateString() ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`; };
    const dash = value => value || '—';
    // A session archived now (steward-record.cjs flags it) is named with the marker, read when the line paints so it
    // follows the language; the stored name itself is unchanged.
    const marked = (entry, params) => () => {
      const name = value => format('session.archivedName', { name: value });
      const out = { ...params };
      if (entry.nameArchived && entry.name && Object.hasOwn(out, 'name')) out.name = name(entry.name);
      const target = entry.read ? entry.read.targetArchived && entry.read.target : entry.targetArchived && entry.target;
      if (target && Object.hasOwn(out, 'target')) out.target = name(target);
      return out;
    };
    // What it did, in a sentence: the few things a butler does most by name, anything else as its command.
    function what(entry, now = Date.now()) {
      if (entry.kind === 'wakeBlocked') return ['stewardRecord.step.wakeBlocked', {}];
      if (entry.kind === 'role') return [`stewardRecord.role.${ROLES.includes(entry.event) ? entry.event : 'started'}`, { name: dash(entry.name) }];
      // NAW's own step: it woke the butler of that time to read what it recorded.
      if (entry.kind === 'wake') return ['stewardRecord.step.wake', { target: dash(entry.target) }];
      if (entry.kind === 'patrol') return ['stewardRecord.step.patrol', { target: dash(entry.target), count: entry.sessions + entry.items }];
      // The person turned that off in their window.
      if (entry.kind === 'wakeSwitch') return ['stewardRecord.step.youWakeOff', {}];
      if (entry.kind === 'standingSwitch') return [entry.on ? 'stewardRecord.step.youStandingOn' : 'stewardRecord.step.youStandingOff', {}];
      if (entry.method === 'stewardStanding' && STANDING_CALLS[entry.standing]) return [STANDING_CALLS[entry.standing], {}];
      // The butler's own calls on that switch and on what NAW recorded for it, in words rather than as commands.
      if (entry.method === 'stewardWake' && WAKE_CALLS[entry.wake]) return [WAKE_CALLS[entry.wake], {}];
      if (entry.method === 'stewardPatrol' && entry.patrol === 'check') return ['stewardRecord.step.wakeCheck', {}];
      if (entry.method === 'stewardPatrol' && entry.patrol === null) return ['stewardRecord.step.patrolOff', {}];
      if (entry.method === 'stewardPatrol' && Number.isSafeInteger(entry.patrol)) return ['stewardRecord.step.patrolSet', { minutes: entry.patrol }];
      if (entry.method === 'stewardEvents') return ['stewardRecord.step.events', {}];
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
      if (entry.kind === 'wakeBlocked') return [`stewardWake.reason.${entry.reason}`, {}];
      if (['role', 'wakeSwitch', 'standingSwitch'].includes(entry.kind)) return null;
      if (entry.kind === 'message') return MESSAGES.includes(entry.state) ? [`stewardRecord.message.${entry.state}`, {}] : ['stewardRecord.result.other', { state: dash(entry.state) }];
      if (entry.kind === 'wake' || entry.kind === 'patrol') return entry.state === 'sent' ? ['stewardRecord.wake.sent', {}] : ['not-sent', 'unconfirmed'].includes(entry.state) ? [`stewardRecord.message.${entry.state}`, {}]
        : entry.state ? ['stewardRecord.result.other', { state: entry.state }] : ['stewardRecord.result.unrecorded', {}];
      if (!entry.state) return ['stewardRecord.result.unrecorded', {}];
      if (entry.duplicate) return ['stewardRecord.result.duplicate', {}];
      if (entry.state === 'not-executed') return REASONS.includes(entry.reason) ? [`stewardRecord.reason.${entry.reason}`, {}] : ['stewardRecord.result.refused', { reason: dash(entry.reason) }];
      return STATES.includes(entry.state) ? [`stewardRecord.result.${entry.state}`, {}] : ['stewardRecord.result.other', { state: entry.state }];
    }
    function line(entry, { row, time, text, end, body }, now) {
      if (attention(entry)) row.className += ' attention';
      row.dataset.kind = entry.kind;
      time.textContent = when(entry.at, now);
      const [key, params] = what(entry, now);
      say(text, key, marked(entry, params));
      const outcome = result(entry);
      if (outcome) say(end, ...outcome);
      // Opened: the whole sentence, and NAW's own words for a step that failed or was refused by a rule, as the agent was told them.
      body.append(say(make('p'), key, marked(entry, params)));
      if (entry.kind === 'patrol') body.append(say(make('p'), 'stewardRecord.step.patrolDetail', { sessions: entry.sessions, items: entry.items, minutes: entry.minutes }));
      if (entry.kind === 'wakeBlocked') body.append(say(make('p'), entry.minutes ? 'stewardWake.stalled' : 'stewardWake.notWoken', () => ({ minutes: entry.minutes, reason: format(`stewardWake.reason.${entry.reason}`) })));
      if (entry.error) { const why = make('p', 'steward-record-error'); why.textContent = entry.error; body.append(why); }
    }
    const attention = entry => ['confirmation-required', 'not-executed', 'unconfirmed', 'not-sent'].includes(entry.state) || !['role', 'message', 'wakeSwitch', 'standingSwitch'].includes(entry.kind) && !entry.state;
    // NAW's switch for waking the butler when it records something new: the person's to see and turn off here (the
    // approved words for the butler: 「看得见、能关」), off by default. Changed in place, so focus stays on it.
    async function standingSwitch() {
      const box = make('section', 'steward-record-wake'), label = make('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.action = 'steward-standing'; label.append(input, make('span', '', 'standing.switch'));
      const note = make('p', 'records-note', 'standing.scope'), status = make('p', 'records-note'); status.setAttribute('role', 'status');
      const show = value => {
        input.checked = value.on === true;
        let key = 'standing.off';
        if (value.unavailable) key = 'standing.unavailable';
        else if (value.on) key = value.by === 'butler' ? 'standing.onButler' : 'standing.on';
        // On for the previous butler: why it reads off (R118).
        else if (value.reason === 'other-designation') key = 'standing.offOther';
        else if (value.by === 'butler') key = 'standing.offButler';
        say(status, key, { time: value.by === 'butler' ? when(value.at, Date.now()) : '' });
      };
      try { show(await api.stewardStanding()); } catch { input.disabled = true; say(status, 'standing.unavailable'); }
      input.addEventListener('change', async () => {
        const previous = !input.checked; input.disabled = true;
        try { show(await api.stewardStanding(input.checked)); }
        catch (error) { input.checked = previous; status.textContent = String(error.message || error); }
        finally { input.disabled = false; }
      });
      box.append(label, note, status); return box;
    }
    function wakeSwitch(state, now) {
      const box = make('div', 'steward-record-wake'), label = make('label'), input = document.createElement('input'), words = make('span', '', 'stewardRecord.wake.switch');
      input.type = 'checkbox'; input.dataset.action = 'steward-wake'; label.append(input, words);
      const status = make('span', 'steward-record-wake-status'), failure = make('p', 'records-note'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      // Read out with the switch: whether it is on, and when NAW last tried to wake the butler (steward-wake.cjs view).
      status.id = `${dialog.id || 'steward-record-dialog'}-wake-status`; input.setAttribute('aria-describedby', status.id);
      // The patrol interval, on the line below: usable only while the switch above is on (it turns off with it).
      const patrol = make('div', 'steward-record-patrol'), patrolLabel = make('label'), choice = document.createElement('select'), patrolNote = make('p', 'quiet');
      choice.dataset.action = 'steward-patrol'; patrolLabel.append(make('span', '', 'stewardRecord.patrol.label'), choice);
      for (const minutes of PATROL) {
        const option = document.createElement('option'); option.value = minutes === null ? '' : String(minutes);
        say(option, minutes === null ? 'stewardRecord.patrol.off' : 'stewardRecord.patrol.minutes', { minutes }); choice.append(option);
      }
      patrol.append(patrolLabel, patrolNote);
      let usable = false;
      const show = (value, at) => {
        input.checked = value.on === true;
        usable = value.on === true && !value.failed;
        choice.value = usable && PATROL.includes(value.patrol) && value.patrol !== null ? String(value.patrol) : ''; choice.disabled = !usable;
        if (!usable) say(patrolNote, 'stewardRecord.patrol.needsWake');
        else if (value.patrol) say(patrolNote, 'stewardRecord.patrol.rule');
        patrolNote.hidden = usable && !value.patrol;
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
      choice.addEventListener('change', async () => {
        const want = choice.value === '' ? null : Number(choice.value); choice.disabled = true; failure.hidden = true;
        try { show(await api.stewardPatrol(want), Date.now()); }
        catch (error) {
          say(failure, 'stewardRecord.patrol.error', { reason: error?.message || '—' }); failure.hidden = false;
          try { show(await api.stewardWake(), Date.now()); } catch { /* Left as it was shown. */ }
        } finally { choice.disabled = !usable; }
      });
      const line = make('div', 'steward-record-wake-switch'); line.append(label, status);
      box.append(line, ...(typeof api.stewardPatrol === 'function' ? [patrol] : []), make('p', 'quiet', 'stewardRecord.wake.cost'), failure);
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
      if (current && typeof api.stewardStanding === 'function') standingSwitch().then(box => { if (dialog.open) dialog.querySelector('h2').after(box); });
      if (view?.writeFailed) dialog.append(make('p', 'records-note', 'stewardRecord.writeFailed'));
      dialog.append(make('h3', '', 'stewardRecord.heading'));
      const entries = view?.entries || [];
      if (!entries.length) dialog.append(make('p', 'quiet', 'stewardRecord.empty'));
      else {
        // One line a step, newest first; earlier steps are read from NAW a page at a time, so every one can be reached.
        let now = view.at;
        const steps = disclosure.create({ document, say, older: 'below', key: entry => `${entry.at}|${entry.kind}`,
          fill: (entry, parts) => line(entry, parts, now),
          load: async limit => { const next = await api.stewardRecord({ limit }); now = next?.at ?? now; return { items: next?.entries || [], total: next?.total || 0 }; } });
        steps.box.className += ' steward-record-steps';
        dialog.append(steps.box);
        steps.update(entries, view.total);
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
      try { view = await api.stewardRecord({ limit: disclosure.PAGE }); } catch (error) { failure = error; }
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
