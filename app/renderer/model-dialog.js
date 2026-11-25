/* 「换模型…」 of one session (N5): its models as a list, one effort, and what still waits. Main makes the change. */
(function (global) {
  'use strict';
  const WAITS = ['applying', 'approval', 'backend', 'input', 'message', 'person', 'question', 'queue', 'relay', 'report', 'turn'];
  const valueOf = choice => choice === '' ? null : choice;
  const same = (a, b) => a.model === b.model && a.effort === b.effort;
  function valueText(value, text) {
    const none = text('standing.nativeDefault');
    return value.model === null && value.effort === null ? none : `${value.model ?? none} · ${value.effort ?? none}`;
  }
  const waitText = (reason, text) => text('model.wait.' + (WAITS.includes(reason) ? reason : 'turn'));
  // What happened to a change, in one line. `record`: the session, when the page still has it.
  function noticeText(notice, record, text, display) {
    const params = { name: record?.name || notice.sessionId, value: valueText(notice, text) };
    if (notice.waiting) return text('model.waiting', { ...params, reason: waitText(notice.waiting, text) });
    const line = notice.error ? text('model.failed', { ...params, reason: display(notice.error, notice.errorUiMessage) })
      : text(record?.provider === 'codex' ? 'model.doneCodex' : 'model.done', params);
    return notice.screen ? line + text('model.screen', { path: notice.screen }) : line;
  }
  function bind({ $, document, api, text, display, openDialog, currentTicket, session, pending, offline, notify, showError }) {
    const dialog = $('model-dialog'), list = $('model-list'), effort = $('model-effort');
    let opened = null;
    const live = held => opened === held && currentTicket(held.ticket);
    const chosen = () => list.querySelector('input:checked');
    const wanted = () => ({ model: valueOf(chosen().value), effort: valueOf(effort.value) });
    const option = (value, label) => { const el = document.createElement('option'); el.value = value; if (label) display.text(el, label); else el.textContent = value; return el; };
    function fillEfforts(keep) {
      const { choices } = opened, entry = choices.models.find(item => item.model === chosen()?.value) || (chosen()?.value === '' ? choices.models[0] : null);
      const efforts = entry?.efforts || [];
      effort.replaceChildren(...(choices.nativeDefault ? [option('', 'standing.nativeDefault')] : []), ...efforts.map(value => option(value)));
      const named = [...effort.options].map(item => item.value);
      effort.value = named.includes(keep) ? keep : named.includes(entry?.defaultEffort) ? entry.defaultEffort : named[0] ?? '';
    }
    function pick(value, label) {
      const row = document.createElement('label'), radio = document.createElement('input'), name = document.createElement('span');
      row.className = 'model-pick'; radio.type = 'radio'; radio.name = 'model-choice'; radio.value = value;
      radio.onchange = () => { fillEfforts(effort.value); refresh(); };
      const now = value !== '' && value === opened.choices.current.model;
      if (label) display.text(name, label); else display.computed(name, 'text', () => now ? text('model.now', { model: value }) : value);
      row.append(radio, name); return row;
    }
    function fill() {
      const { choices } = opened, start = pending(opened.id) || choices.current;
      list.replaceChildren(...(choices.nativeDefault ? [pick('', 'standing.nativeDefault')] : []), ...choices.models.map(item => pick(item.model)));
      const radio = [...list.querySelectorAll('input')].find(input => input.value === (start.model ?? (choices.nativeDefault && pending(opened.id) ? '' : null)));
      if (radio) radio.checked = true;
      fillEfforts(start.effort ?? '');
      $('model-effort-row').hidden = false;
      (radio || list.querySelector('input'))?.focus({ preventScroll: true });
    }
    function refresh() {
      if (!opened || !dialog.open) return;
      const record = session(opened.id), waiting = pending(opened.id);
      // Another conversation, or the change has been made meanwhile: what is shown is no longer what there is.
      if (!record || record.nativeId !== opened.nativeId || opened.waited && !waiting) return dialog.close();
      opened.waited = Boolean(waiting);
      const { choices, busy } = opened, value = choices && chosen() ? wanted() : null;
      const line = $('model-pending');
      line.hidden = !waiting;
      if (waiting) display.computed(line, 'text', () => text('model.pending', { value: valueText(waiting, text), reason: waitText(waiting.waiting, text) }));
      $('model-loading').hidden = Boolean(choices) || !$('model-error').hidden;
      const unchanged = value && same(value, waiting || (value.model !== null && value.effort !== null ? choices.current : {}));
      $('model-confirm').disabled = !value || unchanged || busy || offline() || Boolean(waiting?.applying);
      $('model-withdraw').hidden = !waiting;
      $('model-withdraw').disabled = busy || offline() || Boolean(waiting?.applying);
      for (const input of [...list.querySelectorAll('input'), effort]) input.disabled = busy || Boolean(waiting?.applying);
    }
    function fail(error) { $('model-error').hidden = false; showError($('model-error'), error); }
    function open(id) {
      const record = session(id);
      if (!record || offline() || dialog.open) return;
      const held = opened = { id, nativeId: record.nativeId, choices: null, busy: false, waited: false, ticket: null };
      display.computed($('model-title'), 'text', () => text('model.title', { name: session(id)?.name || record.name }));
      display.text($('model-note'), record.provider === 'codex' ? 'model.noteCodex' : 'model.noteBusy');
      list.replaceChildren(); effort.replaceChildren(); $('model-effort-row').hidden = $('model-error').hidden = true;
      held.ticket = openDialog('model-dialog');
      refresh();
      $('model-cancel').focus({ preventScroll: true });
      return api.modelChoices(id).then(choices => { if (live(held)) { held.choices = choices; fill(); refresh(); } },
        error => { if (live(held)) { fail(error); refresh(); } });
    }
    async function act(work) {
      const held = opened;
      held.busy = true; $('model-error').hidden = true; refresh();
      try {
        const notice = await work(held);
        if (live(held)) dialog.close();
        if (notice) notify(notice);
      } catch (error) {
        if (live(held)) fail(error); else throw error;
      } finally { held.busy = false; if (live(held)) refresh(); }
    }
    const confirm = () => act(async ({ id, nativeId }) => {
      const value = wanted(), result = await api.changeModel(id, value, nativeId);
      return result?.status === 'pending' ? { sessionId: id, ...value, waiting: result.waiting || 'applying' } : null;
    });
    const withdraw = () => act(async ({ id }) => { await api.cancelModelChange(id); });
    $('model-cancel').onclick = () => dialog.close();
    effort.onchange = refresh;
    dialog.addEventListener('close', () => { if (dialog.open) return; opened = null; list.replaceChildren(); effort.replaceChildren(); });
    return { open, refresh, confirm, withdraw };
  }
  global.nativeWorkspaceModelDialog = { bind, noticeText, valueText };
  if (typeof module !== 'undefined') module.exports = global.nativeWorkspaceModelDialog;
})(typeof window !== 'undefined' ? window : globalThis);
