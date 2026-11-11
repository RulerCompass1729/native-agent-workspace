/* The butler's one sidebar row and its dialog. It draws the view the main process gives a person window and keeps
   no butler state of its own. With no view, which is every window of this version, the row stays hidden. */
(function (global) {
  'use strict';
  const STATE_KEYS = { empty: 'empty', ready: 'ready', recording: 'recording', held: 'held', 'blocked-build': 'blockedBuild', 'blocked-credential': 'blockedCredential', unknown: 'unknown' };
  const HOLD_KEYS = { 'daily-budget-reached': 'dailyBudgetReached', 'usage-cost-unknown': 'usageCostUnknown', 'next-batch-cost-unknown': 'nextBatchCostUnknown', other: 'other' };
  const FACTS = ['model', 'reads', 'never', 'sent', 'period', 'limit'];
  // Whole cents as cents, anything else at the fourth decimal, where one wake-up costs fractions of a cent. What
  // was spent is never shown lower than it is, and the line never higher.
  const amount = (micros, round) => '$' + (micros % 10000 === 0 ? (micros / 1e6).toFixed(2) : (round(micros / 100) / 10000).toFixed(4));
  const money = micros => amount(micros, Math.ceil), line = micros => amount(micros, Math.floor);
  // Text comes from the catalog (butler.*). The renderer passes its interface-language text and display bindings, so
  // a language switch repaints in place; without them (unit tests) the Chinese catalog text is used.
  function bind({ row, dialog, document, api, text, display, showError, openReview, openReads }) {
    const { entryView } = global.nativeWorkspaceButlerEntryView || require('../butler-entry-view.js');
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, params); return el; };
    const quiet = el => { if (display) display.unbind(el); el.textContent = ''; return el; };
    const make = (tag, cls, key, params) => { const el = document.createElement(tag); if (cls) el.className = cls; if (key) say(el, key, params); return el; };
    const control = (key, action, cls) => { const el = make('button', cls, key); el.type = 'button'; el.dataset.action = action; el.addEventListener('click', () => press(action)); return el; };
    // Both interface languages group digits the same way, so counts need no repaint on a language switch.
    const number = value => new Intl.NumberFormat('en-US').format(value);
    const unseen = el => { el.setAttribute('aria-hidden', 'true'); return el; };

    const rowText = make('span'), rowIcon = unseen(make('span', 'rail-icon')), rowState = make('span', 'butler-state');
    rowIcon.textContent = '◆'; rowState.append(unseen(make('span', 'butler-dot')), rowText);
    row.append(rowIcon, make('span', 'rail-label', 'butler.name'), rowState);

    const title = make('h2'), panel = make('div'), confirm = make('div'), revoke = make('div');
    title.id = (dialog.id || 'butler-dialog') + '-title'; dialog.setAttribute('aria-labelledby', title.id);
    const status = make('p', 'butler-status'), statusText = make('strong'); status.setAttribute('role', 'status'); status.append(unseen(make('span', 'butler-dot')), statusText);
    const note = make('p', 'butler-note'), more = make('p', 'butler-note'), model = make('p', 'quiet'), usage = make('p', 'quiet'), failure = make('p', 'butler-note');
    const actions = make('div', 'dialog-actions'); failure.setAttribute('role', 'alert'); failure.hidden = true;
    panel.append(status, note, more, model, usage, failure, actions);
    const facts = make('dl', 'butler-facts'), notYet = make('p', 'butler-not-yet'), confirmActions = make('div', 'dialog-actions');
    const confirmCancel = control('common.cancel', 'back'), confirmOk = control('butler.confirm.confirm', 'confirmDesignate', 'primary');
    confirmActions.append(confirmCancel, confirmOk); confirm.append(facts, notYet, confirmActions);
    const revokeActions = make('div', 'dialog-actions'), revokeCancel = control('common.cancel', 'back'), revokeOk = control('butler.revoke.confirm', 'confirmRevoke');
    revokeActions.append(revokeCancel, revokeOk); revoke.append(make('p', 'butler-note', 'butler.revoke.text'), revokeActions);
    dialog.append(title, panel, confirm, revoke);

    let view = { visible: false }, latest, page = 'panel', busy = false, calls = 0, drawn = '', asked = '', agreed = null, done = null;
    // An action is offered only when the main process names it and this window has the person-only entry to call.
    // Reading the log changes nothing and needs no butler: it is offered whenever this window was given a way to open it.
    const can = action => view.visible && (action === 'reads' ? typeof openReads === 'function' :
      view.actions.includes(action) && (action === 'review' ? typeof openReview === 'function' : typeof api?.butler === 'function'));
    // What a question was asked about. If it changes while the question is open, the person is taken back.
    const question = () => JSON.stringify([view.state, view.revision, view.offer ?? null, view.startable ?? null, view.choice ?? null, view.actions]);
    const focusDone = () => { if (dialog.open && page === 'panel' && done) done.focus(); };
    function show(next) {
      page = next; panel.hidden = page !== 'panel'; confirm.hidden = page !== 'confirm'; revoke.hidden = page !== 'revoke';
      say(title, page === 'confirm' ? 'butler.confirm.title' : page === 'revoke' ? 'butler.revoke.title' : 'butler.name');
      if (page === 'panel') { agreed = null; return; }
      asked = question();
      if (page !== 'confirm') return;
      const offer = view.offer;
      // What the page states is what the call carries, so the main process can refuse anything else.
      agreed = { profile: offer.profile, provider: offer.provider, model: offer.model, limitMicros: offer.limitMicros, dayBoundary: offer.dayBoundary, startable: view.startable };
      const params = { model: { name: offer.name, model: offer.model }, limit: { limit: line(offer.limitMicros) } };
      facts.replaceChildren(...FACTS.flatMap(key => [make('dt', '', `butler.confirm.${key}`), make('dd', '', `butler.confirm.${key}Value`, params[key])]));
      // Said before the person decides, not discovered afterwards.
      notYet.hidden = view.startable !== false; if (view.startable === false) say(notYet, 'butler.confirm.notYet'); else quiet(notYet);
    }
    function paint() {
      // The label keeps the state it was drawn for: a language repaint may come after the view has gone.
      const key = STATE_KEYS[view.state], label = () => format('butler.rowLabel', { state: format(`butler.row.${key}`) });
      row.dataset.butlerState = dialog.dataset.butlerState = view.state;
      say(rowText, `butler.row.${key}`);
      for (const slot of ['aria-label', 'title']) { if (display) display.computed(row, slot, label); else row.setAttribute(slot, label()); }
      say(statusText, `butler.status.${key}`);
      // A paused butler says the core's own recorded reason; a reason without a sentence gets the general one.
      say(note, view.state === 'held' ? `butler.hold.${HOLD_KEYS[view.holdReason]}` : `butler.note.${key}`);
      more.hidden = !view.alsoMissingKey; if (view.alsoMissingKey) say(more, 'butler.note.alsoMissingKey'); else quiet(more);
      const choice = view.choice, today = view.usage;
      model.hidden = usage.hidden = !choice;
      if (!choice) { quiet(model); quiet(usage); }
      else {
        say(model, 'butler.model', { name: choice.name, model: choice.model });
        const limit = line(choice.limitMicros);
        // No reading is "not verified", never zero; the line carries the reading's own day; sums that leave wake-ups
        // out say so, and the count of those is a lower bound.
        if (!today) say(usage, 'butler.usage.unverified', { limit });
        else if (!today.runs) say(usage, 'butler.usage.none', { day: today.day, limit });
        else if (today.unknown) say(usage, 'butler.usage.partial', { day: today.day, runs: number(today.runs), count: number(today.unknown), tokens: number(today.totalTokens), cost: money(today.costMicros), limit });
        else say(usage, 'butler.usage', { day: today.day, runs: number(today.runs), tokens: number(today.totalTokens), cost: money(today.costMicros), limit });
      }
      const held = document.activeElement && typeof actions.contains === 'function' && actions.contains(document.activeElement);
      // Revoking sits apart, first in the row; the everyday actions follow and Done is last.
      const offered = [...view.actions, 'reads'].filter(can).sort((a, b) => (b === 'revoke') - (a === 'revoke'));
      const buttons = offered.map(action => control(`butler.action.${action}`, action, action === 'designate' ? 'primary' : action === 'revoke' ? 'subtle butler-apart' : ''));
      for (const button of buttons) button.disabled = busy;
      done = control('common.done', 'done');
      actions.replaceChildren(...buttons, done);
      if (held) focusDone();
    }
    function render(entry) {
      latest = entry; view = entryView(entry); row.hidden = !view.visible;
      if (!view.visible) { drawn = ''; if (dialog.open) dialog.close(); if (page !== 'panel') show('panel'); return; }
      const signature = JSON.stringify([view, busy, typeof api?.butler === 'function', typeof openReview === 'function', typeof openReads === 'function']);
      if (signature === drawn) return;
      drawn = signature;
      const back = page !== 'panel' && asked !== question();
      if (back) show('panel');
      paint();
      if (back) focusDone();
    }
    async function run(action, confirmed) {
      if (!can(action)) return;
      const ticket = ++calls, revision = view.revision;
      busy = true; failure.hidden = true; quiet(failure); render(latest);
      try { await (confirmed ? api.butler(action, revision, confirmed) : api.butler(action, revision)); }
      catch (error) {
        if (ticket !== calls) return;
        failure.hidden = false;
        if (showError) showError(failure, error); else say(failure, 'error.operation');
      } finally { if (ticket === calls) { busy = false; render(latest); focusDone(); } }
    }
    function press(action) {
      if (action === 'done') { dialog.close(); return; }
      if (action === 'back') { show('panel'); focusDone(); return; }
      if (busy) return;
      // A confirmation counts only for the question still on the screen; render() takes a changed question away.
      if (action === 'confirmDesignate' || action === 'confirmRevoke') {
        const wanted = action === 'confirmDesignate' ? 'designate' : 'revoke', current = page === (wanted === 'designate' ? 'confirm' : 'revoke'), confirmed = agreed;
        show('panel'); focusDone();
        return current ? run(wanted, wanted === 'designate' ? confirmed : undefined) : undefined;
      }
      if (!can(action)) return;
      if (action === 'designate') { show('confirm'); confirmCancel.focus(); return; }
      if (action === 'revoke') { show('revoke'); revokeCancel.focus(); return; }
      if (action === 'review') { dialog.close(); openReview(); return; }
      if (action === 'reads') { dialog.close(); openReads(); return; }
      return run(action);
    }
    // Opening puts the focus on Done, never on an action that changes something.
    function open() {
      if (!view.visible) return;
      show('panel'); failure.hidden = true; quiet(failure);
      if (!dialog.open) dialog.showModal();
      focusDone();
    }
    const closed = () => { if (page !== 'panel') show('panel'); };
    row.addEventListener('click', open); dialog.addEventListener('close', closed);
    show('panel');
    return { render, open, press, dispose() {
      calls++; busy = false; row.removeEventListener('click', open); dialog.removeEventListener('close', closed);
      if (dialog.open) dialog.close();
      row.hidden = true; row.replaceChildren(); dialog.replaceChildren();
    } };
  }
  const value = { bind, money, line, STATE_KEYS, HOLD_KEYS, FACTS };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceButlerEntry = value;
})(globalThis);
