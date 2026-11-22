(function (global) {
  function bind({ host, button, badge, document: doc, api, text, subscribe = () => () => {} }) {
    const f = (key, params) => text('discoveries.' + key, params), make = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
    const set = (e, value) => { if (e.textContent !== value) e.textContent = value; };
    const control = (key, action) => { const b = make('button'); b.type = 'button'; b.onclick = action; b.dataset.label = key; return b; };
    let current = null, disposed = false, dirty = false, draftSerial = 0, pending = false, saving = false, returnFocus = null;
    const popup = make('section', 'discoveries-popup'), heading = make('header'), titleBlock = make('div'), title = make('h2'), subtitle = make('p', 'discoveries-source'), close = control('close', () => popup.hidePopover());
    popup.setAttribute('popover', 'manual'); popup.setAttribute('aria-labelledby', 'discoveries-popup-title'); title.id = 'discoveries-popup-title';
    const body = make('div', 'discoveries-items'), tail = make('footer'), later = make('span'), historyButton = control('history', open);
    titleBlock.append(title, subtitle); heading.append(titleBlock, close); tail.append(later, historyButton); popup.append(heading, body, tail);
    const dialog = make('dialog', 'discoveries-dialog'), dialogHeading = make('header'), dialogTitle = make('h2'), dismiss = control('close', () => dialog.close());
    dialog.setAttribute('aria-labelledby', 'discoveries-dialog-title'); dialogTitle.id = 'discoveries-dialog-title'; dialogHeading.append(dialogTitle, dismiss);
    const activation = make('div', 'discoveries-activation'), activationCopy = make('div'), activationTitle = make('strong'), activationHelp = make('p'), activate = control('activate', () => configure(!current.config.enabled, true));
    activate.className = 'discoveries-activate'; activate.disabled = true; activationCopy.append(activationTitle, activationHelp); activation.append(activationCopy, activate);
    const location = make('p', 'discoveries-location'), retention = make('p', 'discoveries-retention'), status = make('p', 'discoveries-notice'), form = make('form'), sourceLabel = make('label'), source = make('select'), concernLabel = make('label'), concern = make('textarea'), localHint = make('p', 'discoveries-local-hint'), timeLabel = make('label'), time = make('input'), privacy = make('p', 'discoveries-privacy'), budget = make('p'), save = control('save', () => {});
    form.setAttribute('aria-labelledby', 'discoveries-dialog-title'); status.setAttribute('role', 'status'); localHint.id = 'discoveries-local-hint'; concern.setAttribute('aria-describedby', localHint.id);
    for (const [index, key] of ['sourceDaily', 'sourceWeekly', 'sourceMonthly'].entries()) { const option = make('option'); option.dataset.label = key; option.value = ['https://github.com/trending', 'https://github.com/trending?since=weekly', 'https://github.com/trending?since=monthly'][index]; source.append(option); }
    for (const [label, input, id] of [[sourceLabel, source, 'source'], [concernLabel, concern, 'concern'], [timeLabel, time, 'time']]) { input.id = 'discoveries-' + id; label.htmlFor = input.id; }
    concern.maxLength = 200; time.type = 'time'; time.required = true;
    sourceLabel.append(make('span'), source); concernLabel.append(make('span'), concern); timeLabel.append(make('span'), time);
    for (const input of [source, concern, time]) input.addEventListener('input', () => { dirty = true; draftSerial++; concern.required = Boolean(current?.config.enabled); });
    save.type = 'submit'; form.append(sourceLabel, concernLabel, localHint, timeLabel, privacy, budget, save);
    const historyTitle = make('h3'), historyStatus = make('p', 'discoveries-run-note'), list = make('div', 'discoveries-history'), empty = make('p');
    dialog.append(dialogHeading, activation, location, status, form, historyTitle, retention, historyStatus, list, empty); host.append(popup, dialog);
    const popupRows = new Map(), historyRows = new Map();
    async function call(action, ...args) {
      try { const value = await api.discoveries(action, ...args); if (!disposed) render(value); return value; }
      catch { if (!disposed) set(status, f('failed')); return null; }
    }
    async function configure(wanted, toggle = false) {
      if (saving || !current) return;
      const pausing = toggle && !wanted, keepDraft = pausing && dirty;
      concern.required = wanted; if (!pausing && !form.reportValidity()) return;
      const config = pausing ? { ...current.config, enabled: false } : { enabled: wanted, concern: concern.value, time: time.value, source: source.value };
      const activated = doc.activeElement === activate, serial = draftSerial; saving = true; activate.disabled = save.disabled = true;
      const result = await call('configure', config);
      saving = false; save.disabled = false; concern.required = Boolean(current.config.enabled);
      if (result) { if (serial === draftSerial && !keepDraft) dirty = false; render(result); if (activated && serial === draftSerial) activate.focus(); }
      else activate.disabled = !current.allowed || Boolean(current.error);
    }
    form.onsubmit = event => { event.preventDefault(); configure(Boolean(current?.config.enabled)); };
    function row(run, item, cache) {
      const key = JSON.stringify([run.id, item.id]); let r = cache.get(key);
      if (!r) {
        const node = make('article'), name = make('h3'), why = make('p', 'discoveries-why'), link = make('a'), actions = make('footer');
        const read = control('read', () => call('mark', run.id, item.id, 'read')), ignore = control('ignore', () => call('mark', run.id, item.id, 'ignored'));
        link.onclick = e => { e.preventDefault(); api.openExternal(link.href).catch(() => set(status, f('failed'))); }; actions.append(read, ignore); node.append(name, why, link, actions);
        r = { node, name, why, link, read, ignore }; cache.set(key, r);
      }
      set(r.name, item.title); set(r.why, f('why', { reason: item.why })); r.link.href = item.url; set(r.link, item.url.replace('https://', '') + ' ↗');
      set(r.read, f(item.read ? 'readDone' : 'read')); set(r.ignore, f(item.ignored ? 'ignored' : 'ignore')); r.node.dataset.read = String(item.read); r.node.dataset.ignored = String(item.ignored);
      return r.node;
    }
    function fill(parent, nodes, cache) {
      for (const [i, node] of nodes.entries()) if (parent.children[i] !== node) { if (parent.moveBefore && node.isConnected) parent.moveBefore(node, parent.children[i] || null); else parent.insertBefore(node, parent.children[i] || null); }
      for (const child of [...parent.children]) if (!nodes.includes(child)) child.remove();
      for (const [key, value] of cache) if (!nodes.includes(value.node)) cache.delete(key);
    }
    function translate() {
      activate.dataset.label = current?.config.enabled ? 'deactivate' : 'activate';
      for (const b of host.querySelectorAll('[data-label]')) set(b, f(b.dataset.label));
      set(title, f('title')); set(dialogTitle, f('title')); set(later, f('later')); set(historyTitle, f('history'));
      set(sourceLabel.firstChild, f('source')); set(concernLabel.firstChild, f('concern')); set(timeLabel.firstChild, f('time'));
      set(location, f('location')); set(retention, f('retention')); set(privacy, f('privacy')); set(budget, f('budget')); set(empty, f('empty'));
      set(activationTitle, f(current?.suggestion ? 'prefilled' : 'activateTitle')); set(activationHelp, f('activateHelp')); set(localHint, f(current?.suggestion === 'generic' ? 'genericHint' : current?.suggestion === 'local' ? 'localHint' : 'customHint'));
    }
    function render(value) {
      current = { ...value, popup: false }; translate();
      badge.textContent = value.unread ? String(value.unread) : ''; button.setAttribute('aria-label', f('entry', { count: value.unread })); button.title = f('entry', { count: value.unread });
      const latestRun = value.runs[0], runKey = run => run.skipReason === 'usage-unconfirmed' ? 'run.budget-unconfirmed' : 'run.' + run.state;
      set(status, value.error && value.errorFile ? f('storageFile', { file: value.errorFile }) : f(value.error ? 'storage' : !value.allowed ? 'approval' : !value.config.enabled ? 'off' : latestRun && latestRun.state !== 'ready' ? runKey(latestRun) : 'on'));
      historyStatus.hidden = !latestRun;
      const total = latestRun ? value.runs.filter(r => r.budgetDay === latestRun.budgetDay).reduce((n, r) => n + r.chargedMicros, 0) : 0;
      const uncertain = latestRun && value.runs.some(r => r.budgetDay === latestRun.budgetDay && r.attempted && r.costKnown !== true && r.state !== 'ready');
      const upper = latestRun && value.runs.some(r => r.budgetDay === latestRun.budgetDay && r.usage?.tier === 'peak-bound');
      set(historyStatus, latestRun ? latestRun.budgetDay + ' · ' + (latestRun.state === 'ready' ? '' : f(runKey(latestRun)) + ' · ') + f(uncertain ? 'reserved' : upper ? 'spentUpper' : 'spent', { cost: (total / 1000000).toFixed(6) }) : '');
      activate.setAttribute('aria-describedby', 'discoveries-status'); status.id = 'discoveries-status';
      concern.required = Boolean(value.config.enabled); activate.disabled = saving || !value.allowed || Boolean(value.error);
      if (!dirty) { source.value = value.source; concern.value = value.config.concern; time.value = value.config.time; }
      const all = value.runs.flatMap(run => run.items.map(item => ({ run, item }))), latest = value.runs.find(r => r.state === 'ready' && r.items.some(i => !i.read && !i.ignored));
      set(title, f('picked', { count: latest?.items.length || 0 })); set(subtitle, 'GitHub Trending'); set(later, f('remaining', { count: value.unread }));
      fill(body, latest ? latest.items.filter(i => !i.read && !i.ignored).map(i => row(latest, i, popupRows)) : [], popupRows);
      fill(list, all.map(({ run, item }) => row(run, item, historyRows)), historyRows); empty.hidden = all.length > 0;
      if (!body.children.length && popup.matches(':popover-open')) popup.hidePopover();
      if (value.popup && body.children.length) { pending = true; showPending(); }
    }
    function showPending() {
      if (!pending || disposed || doc.querySelector('dialog[open]')) return;
      pending = false; returnFocus = doc.activeElement; popup.showPopover();
    }
    async function open() {
      pending = false; if (popup.matches(':popover-open')) popup.hidePopover();
      dirty = false; const value = await call('status'); if (value && !disposed && !dialog.open) { dialog.showModal(); if (!activate.disabled) activate.focus(); }
    }
    const toggled = () => showPending(), key = event => { if (event.key === 'Escape' && popup.matches(':popover-open')) { const inside = popup.contains(doc.activeElement); popup.hidePopover(); if (inside && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); } };
    doc.addEventListener('toggle', toggled, true); doc.addEventListener('keydown', key);
    button.onclick = open;
    const off = api.onDiscoveries(value => { if (!disposed) render(value); }), languageOff = subscribe(() => { if (current) render(current); else translate(); });
    translate(); call('status');
    return { refresh: () => call('status'), dispose() { disposed = true; off?.(); languageOff?.(); button.onclick = null; doc.removeEventListener('toggle', toggled, true); doc.removeEventListener('keydown', key); popup.remove(); dialog.remove(); } };
  }
  global.nativeWorkspaceRegularPopup = { bind };
})(globalThis);
