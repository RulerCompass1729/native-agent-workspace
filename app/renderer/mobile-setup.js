/* Explicit local setup, inside the existing setup dialog. Opening is read-only. */
(function (global) {
  'use strict';
  // Text comes from the catalog (mobile.*). The renderer passes its interface-language text and display bindings, so a
  // language switch repaints the panel in place; without them (unit tests) the Chinese catalog text is used.
  // remembered/remember carry the last checked address, Tailscale user and port across restarts. Never secrets or links.
  function bind({ container, document, api, getSessions, getRooms = () => [], now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, text, display, remembered = () => null, remember = () => {} }) {
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, params); return el; };
    const quiet = el => { if (display) display.unbind(el); el.textContent = ''; };
    const attribute = (el, name, key) => { if (display) display.attribute(el, name, key); else el.setAttribute(name, format(key)); };
    const node = (tag, key) => { const el = document.createElement(tag); if (key !== undefined) say(el, key); return el; };
    const raw = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
    // A label holding an input keeps its text in its own leaf, which the display bindings can repaint.
    const labelled = (key, input) => { const box = document.createElement('label'); box.append(node('span', key), input); return box; };
    // A checkbox sits left of its own text on one line, so it cannot look like it belongs to the row above.
    const checkbox = id => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      if (id) input.id = id;
      return input;
    };
    const checkRow = (input, words) => {
      const box = document.createElement('label');
      box.className = 'mobile-check';
      box.append(input, words);
      return box;
    };
    const section = node('details'), summary = node('summary', 'mobile.title'); section.append(summary);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    section.append(node('p', 'mobile.intro'));
    const hint = key => { const el = node('p', key); el.className = 'quiet'; section.append(el); };
    const check = (key, id) => { const input = checkbox(id); section.append(checkRow(input, node('span', key))); return input; };
    const field = (key, id, type = 'text') => { const input = document.createElement('input'); input.id = id; input.type = type; section.append(labelled(key, input)); return input; };
    const origin = field('mobile.origin', 'mobile-origin', 'url'); origin.placeholder = 'https://device.example.ts.net'; origin.autocomplete = 'off'; origin.maxLength = 2048;
    const actor = field('mobile.actor', 'mobile-actor'); actor.autocomplete = 'off'; actor.maxLength = 320;
    const port = field('mobile.port', 'mobile-port', 'number'); port.min = '0'; port.max = '65535'; port.value = '0';
    const carrier = check('mobile.carrier', 'mobile-carrier');
    // About 90 sessions: a search narrows the list, chosen sessions stay listed first, and each one's
    // send/answer choices appear only after it is chosen.
    const choices = document.createElement('fieldset'); choices.className = 'mobile-sessions'; section.append(choices);
    const search = document.createElement('input'); search.type = 'search'; search.id = 'mobile-session-filter'; search.autocomplete = 'off'; search.maxLength = 200;
    attribute(search, 'placeholder', 'mobile.sessionSearch'); attribute(search, 'aria-label', 'mobile.sessionSearch');
    const count = document.createElement('p'); count.className = 'quiet mobile-count'; count.setAttribute('aria-live', 'polite');
    const list = document.createElement('div'); list.className = 'mobile-session-list';
    const noMatch = node('p', 'mobile.noMatch'); noMatch.className = 'quiet'; noMatch.hidden = true;
    const spaces = document.createElement('fieldset'); spaces.className = 'mobile-spaces'; spaces.append(node('legend', 'mobile.spaces')); section.append(spaces);
    const records = check('mobile.allowRecords', 'mobile-records');
    hint('mobile.workspaceNote');
    const replace = check('mobile.replace', 'mobile-replace');
    hint('mobile.note');
    const prepare = node('button', 'mobile.prepare'), revoke = node('button', 'mobile.revoke'); prepare.type = revoke.type = 'button'; prepare.id = 'mobile-prepare'; revoke.id = 'mobile-revoke';
    const link = document.createElement('input'); link.id = 'mobile-pair-link'; link.readOnly = true; link.autocomplete = 'off';
    const linkBox = labelled('mobile.link', link); linkBox.hidden = true;
    section.append(prepare, revoke, linkBox, status); container.append(section);
    // Sensitive approvals start folded: they are off by default and come after pairing.
    const approval = document.createElement('details'), approvalTitle = document.createElement('summary'); approval.id = 'mobile-approval-section'; say(approvalTitle, 'mobile.approvalTitle'); approval.append(approvalTitle);
    const approvalInfo = document.createElement('p'), fingerprint = document.createElement('output'); fingerprint.id = 'mobile-approval-fingerprint';
    const approvalBegin = say(document.createElement('button'), 'mobile.approvalBegin'), approvalRefresh = say(document.createElement('button'), 'mobile.approvalRefresh'), approvalConfirm = say(document.createElement('button'), 'mobile.approvalConfirm'), approvalRevoke = say(document.createElement('button'), 'mobile.approvalRevoke');
    for (const [button, id] of [[approvalBegin, 'begin'], [approvalRefresh, 'refresh'], [approvalConfirm, 'confirm'], [approvalRevoke, 'revoke']]) { button.type = 'button'; button.id = 'mobile-approval-' + id; }
    const matched = checkbox('mobile-approval-matched'), enabled = checkbox('mobile-approval-enabled');
    approval.append(approvalInfo, labelled('mobile.approvalFingerprint', fingerprint), approvalBegin, approvalRefresh, checkRow(matched, node('span', 'mobile.approvalMatched')), approvalConfirm, checkRow(enabled, node('span', 'mobile.approvalEnable')), approvalRevoke); section.append(approval);
    let approvalValue = null;
    function showApproval(value) {
      approvalValue = value; matched.checked = false; enabled.indeterminate = false; enabled.checked = value?.enabled === true;
      enabled.disabled = !value?.registered; approvalConfirm.disabled = true; approvalBegin.disabled = !value?.paired;
      fingerprint.value = ((value?.pending?.fingerprint || value?.fingerprint || '').match(/.{1,8}/g) || []).join(' ');
      if (value?.pending) say(approvalInfo, 'mobile.approvalCode', { code: value.pending.code }); else say(approvalInfo, value?.paired ? 'mobile.approvalHelp' : 'mobile.approvalPairFirst');
    }
    async function approvalAction(method, value) {
      if (!opened || typeof api[method] !== 'function') return;
      const ticket = revision;
      try { await api[method](value); const next = await api.mobileApprovalStatus(); if (opened && revision === ticket) showApproval(next); }
      catch { if (opened && revision === ticket) { enabled.indeterminate = true; enabled.disabled = true; approvalConfirm.disabled = true; say(approvalInfo, 'mobile.approvalUnconfirmed'); } }
    }
    approvalBegin.addEventListener('click', () => approvalAction('mobileApprovalBegin'));
    approvalRefresh.addEventListener('click', () => approvalAction('mobileApprovalStatus'));
    approvalRevoke.addEventListener('click', () => approvalAction('mobileApprovalRevoke'));
    matched.addEventListener('change', () => { approvalConfirm.disabled = !(matched.checked && approvalValue?.pending?.ready); });
    approvalConfirm.addEventListener('click', () => {
      const pending = approvalValue?.pending;
      if (matched.checked && pending?.ready) approvalAction('mobileApprovalConfirm', { registrationId: pending.registrationId, fingerprint: pending.fingerprint });
    });
    enabled.addEventListener('change', () => approvalAction('mobileApprovalEnable', { enabled: enabled.checked, registrationId: approvalValue?.registrationId }));
    let revision = 0, timer, opened = false, busy = false, selections = [], roomSelections = [];
    const clearLink = () => { clearTimer(timer); timer = undefined; link.value = ''; linkBox.hidden = true; };
    function counted() {
      say(count, 'mobile.selectedCount', { count: selections.filter(s => s.read.checked).length, total: selections.length });
    }
    // Reorders only when the search changes, never under the pointer while a box is being ticked.
    function filter() {
      const query = search.value.trim().toLowerCase();
      const chosen = selections.filter(s => s.read.checked);
      const others = selections.filter(s => !s.read.checked);
      let shown = 0;
      for (const s of selections) {
        s.row.hidden = !s.read.checked && query !== '' && !s.words.includes(query);
        if (!s.row.hidden) shown++;
      }
      list.replaceChildren(...chosen.map(s => s.row), ...others.map(s => s.row));
      noMatch.hidden = shown > 0 || query === '';
      counted();
    }
    search.addEventListener('input', filter);
    function recall() {
      const saved = remembered();
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.origin === 'string' && !origin.value) origin.value = saved.origin;
      if (typeof saved.actor === 'string' && !actor.value) actor.value = saved.actor;
      if (typeof saved.port === 'string' && /^\d{1,5}$/.test(saved.port) && port.value === '0') port.value = saved.port;
    }
    function open() {
      revision++; opened = true; busy = false; prepare.disabled = false; clearLink(); selections = [];
      records.checked = false; search.value = ''; approval.open = false; recall();
      choices.replaceChildren(node('legend', 'mobile.sessions'), search, count, list, noMatch);
      roomSelections = []; spaces.replaceChildren(node('legend', 'mobile.spaces'));
      for (const room of getRooms()) {
        if (!room?.id || room.archived) continue;
        const input = checkbox();
        spaces.append(checkRow(input, raw('span', room.name || room.id))); roomSelections.push({ id: room.id, input });
      }
      for (const record of getSessions()) {
        if (record.archived || record.nativeContextPending || !record.nativeId) continue;
        const row = document.createElement('div'), actions = document.createElement('div');
        const read = checkbox(), send = checkbox(), answer = checkbox();
        const name = `${record.name || record.id} · ${record.id.slice(0, 6)}`;
        row.className = 'mobile-session'; actions.className = 'mobile-session-actions'; actions.hidden = true;
        actions.append(checkRow(send, node('span', 'mobile.allowSend')), checkRow(answer, node('span', 'mobile.allowAnswer')));
        row.append(checkRow(read, raw('span', name)), actions);
        // Unticking a session also clears its hidden send/answer choices, so no grant stays out of sight.
        read.addEventListener('change', () => {
          actions.hidden = !read.checked;
          if (!read.checked) send.checked = answer.checked = false;
          counted();
        });
        selections.push({ id: record.id, nativeId: record.nativeId, read, send, answer, row, words: name.toLowerCase() });
      }
      filter();
      say(status, 'mobile.idle');
      showApproval(null); approvalAction('mobileApprovalStatus');
    }
    async function pair() {
      if (!opened || busy) return;
      clearLink();
      const current = getSessions(), selected = selections.filter(s => s.read.checked);
      let site, listenPort;
      try {
        site = new URL(origin.value.trim()); listenPort = Number(port.value);
        if (site.protocol !== 'https:' || site.origin !== origin.value.trim() || site.username || site.password || !actor.value.trim() || !carrier.checked || !selected.length ||
            !/^\d+$/.test(port.value) || !Number.isInteger(listenPort) || listenPort > 65535 || listenPort !== 0 && listenPort < 1024 ||
            selected.some(s => !current.some(row => row.id === s.id && row.nativeId === s.nativeId && !row.archived && !row.nativeContextPending))) throw Error('invalid');
      } catch { say(status, 'mobile.invalid'); return; }
      try { remember({ origin: site.origin, actor: actor.value.trim(), port: String(listenPort) }); } catch {}
      const ticket = ++revision; busy = true; prepare.disabled = true; say(status, 'mobile.preparing');
      try {
        const result = await api.mobilePairing({ actor: actor.value.trim(), origin: site.origin, port: listenPort, carrierConfirmed: true, replace: replace.checked,
          ...(roomSelections.some(r => r.input.checked) || records.checked ? { workspace: { roomIds: roomSelections.filter(r => r.input.checked).map(r => r.id), records: records.checked } } : {}),
          selection: selected.map(s => ({ sessionId: s.id, actions: ['read', ...(s.send.checked ? ['send'] : []), ...(s.answer.checked ? ['answer'] : [])] })) });
        if (!opened || revision !== ticket) return;
        if (typeof result.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.secret) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) throw Error('unconfirmed');
        link.value = site.origin + '/mobile/#pair=' + result.secret; linkBox.hidden = false;
        if (result.localAddress) say(status, 'mobile.ready', { address: result.localAddress }); else say(status, 'mobile.readyUnconfirmed');
        timer = setTimer(() => { if (revision !== ticket) return; clearLink(); say(status, 'mobile.expired'); }, Math.min(120000, result.expiresAt - now()));
      } catch { if (opened && revision === ticket) say(status, 'mobile.unconfirmed'); }
      finally { if (opened && revision === ticket) { busy = false; prepare.disabled = false; } }
    }
    async function stop() {
      if (!opened) return;
      const ticket = ++revision; clearLink(); busy = false; prepare.disabled = false; say(status, 'mobile.revoking');
      try {
        const result = await api.mobileRevoke();
        if (opened && revision === ticket) say(status, result.authorizationRevoked ? 'mobile.revoked' : 'mobile.revokeUnconfirmed');
      } catch { if (opened && revision === ticket) say(status, 'mobile.revokeFailed'); }
    }
    function close() {
      revision++; opened = false; busy = false; clearLink(); origin.value = actor.value = search.value = ''; port.value = '0'; carrier.checked = replace.checked = false;
      selections = []; roomSelections = []; records.checked = false; spaces.replaceChildren(); choices.replaceChildren(); list.replaceChildren(); quiet(status); quiet(count); prepare.disabled = false; section.open = false; approval.open = false;
      showApproval(null);
    }
    prepare.addEventListener('click', pair); revoke.addEventListener('click', stop);
    return { open, close, dispose() { close(); section.remove(); } };
  }
  const value = { bind };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceMobileSetup = value;
})(globalThis);
