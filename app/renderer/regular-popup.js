(function (global) {
  function bind({ host, button, badge, document: doc, api, text, subscribe = () => () => {} }) {
    const f = (key, params) => text('discoveries.' + key, params), make = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
    const set = (e, value) => { if (e.textContent !== value) e.textContent = value; };
    const control = (key, action) => { const b = make('button'); b.type = 'button'; b.onclick = action; b.dataset.label = key; return b; };
    let current = null, disposed = false, dirty = false, draftSerial = 0, pending = false, saving = false, returnFocus = null, settingsOpen = false;
    const popup = make('section', 'discoveries-popup'), heading = make('header'), titleBlock = make('div'), title = make('h2'), subtitle = make('p', 'discoveries-source'), close = make('button', 'discoveries-x');
    close.type = 'button'; close.onclick = () => popup.hidePopover(); close.textContent = '×';
    popup.setAttribute('popover', 'manual'); popup.setAttribute('aria-labelledby', 'discoveries-popup-title'); title.id = 'discoveries-popup-title';
    const body = make('div', 'discoveries-items'), tail = make('footer'), later = make('span'), historyButton = control('history', open);
    titleBlock.append(title, subtitle); heading.append(titleBlock, close); tail.append(later, historyButton); popup.append(heading, body, tail);
    // Clicking outside closes it (R252 ①); the unsaved settings draft stays for the next opening (E).
    const dialog = make('dialog', 'discoveries-dialog'), dialogHeading = make('header'), dialogTitles = make('div'), dialogTitle = make('h2'), summary = make('p', 'discoveries-summary');
    const summaryText = make('span'), status = make('span', 'discoveries-notice'), tools = make('div', 'discoveries-tools');
    const settingsButton = make('button', 'discoveries-settings-toggle'), settingsWord = make('span'), unsaved = make('span', 'discoveries-unsaved'), dismiss = make('button', 'discoveries-x');
    settingsButton.type = 'button'; settingsButton.setAttribute('aria-controls', 'discoveries-settings'); settingsButton.onclick = () => { settingsOpen = !settingsOpen; drawSettings(); };
    settingsButton.append(settingsWord, unsaved); dismiss.type = 'button'; dismiss.onclick = () => dialog.close(); dismiss.textContent = '×';
    dialog.setAttribute('closedby', 'any'); dialog.setAttribute('aria-labelledby', 'discoveries-dialog-title'); dialogTitle.id = 'discoveries-dialog-title';
    summary.append(summaryText, status); dialogTitles.append(dialogTitle, summary); tools.append(settingsButton, dismiss); dialogHeading.append(dialogTitles, tools);
    const settings = make('section', 'discoveries-settings'); settings.id = 'discoveries-settings'; settings.hidden = true;
    const activation = make('div', 'discoveries-activation'), activationTitle = make('strong'), activate = control('activate', () => configure(!current.config.enabled, true));
    activate.className = 'discoveries-activate'; activate.disabled = true; activation.append(activationTitle, activate);
    const terms = make('p', 'discoveries-privacy'), form = make('form'), sourceLabel = make('label'), source = make('select'), concernLabel = make('label'), concern = make('textarea'), localHint = make('p', 'discoveries-local-hint'), timeLabel = make('label'), time = make('input'), save = control('save', () => {});
    form.setAttribute('aria-labelledby', 'discoveries-dialog-title'); status.setAttribute('role', 'status'); localHint.id = 'discoveries-local-hint'; concern.setAttribute('aria-describedby', localHint.id);
    for (const [index, key] of ['sourceDaily', 'sourceWeekly', 'sourceMonthly'].entries()) { const option = make('option'); option.dataset.label = key; option.value = ['https://github.com/trending', 'https://github.com/trending?since=weekly', 'https://github.com/trending?since=monthly'][index]; source.append(option); }
    for (const [label, input, id] of [[sourceLabel, source, 'source'], [concernLabel, concern, 'concern'], [timeLabel, time, 'time']]) { input.id = 'discoveries-' + id; label.htmlFor = input.id; }
    concern.maxLength = 200; time.type = 'time'; time.required = true;
    sourceLabel.append(make('span'), source); concernLabel.append(make('span'), concern); timeLabel.append(make('span'), time);
    for (const input of [source, concern, time]) input.addEventListener('input', () => { dirty = true; draftSerial++; concern.required = Boolean(current?.config.enabled); drawSettings(); });
    save.type = 'submit'; form.append(sourceLabel, timeLabel, concernLabel, localHint, save); settings.append(activation, terms, form);
    const content = make('div', 'discoveries-content'), todayTitle = make('h3', 'discoveries-day-title'), list = make('div', 'discoveries-history'), earlierTitle = make('h3', 'discoveries-day-title'), earlier = make('div', 'discoveries-earlier'), empty = make('p', 'discoveries-empty');
    content.append(todayTitle, list, earlierTitle, earlier, empty);
    const footer = make('footer', 'discoveries-footer'), historyStatus = make('p', 'discoveries-run-note'), retention = make('p', 'discoveries-retention');
    footer.append(historyStatus, retention);
    dialog.append(dialogHeading, settings, content, footer); host.append(popup, dialog);
    const popupRows = new Map(), historyRows = new Map(), days = new Map();
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
    function fill(parent, nodes) {
      for (const [i, node] of nodes.entries()) if (parent.children[i] !== node) { if (parent.moveBefore && node.isConnected) parent.moveBefore(node, parent.children[i] || null); else parent.insertBefore(node, parent.children[i] || null); }
      for (const child of [...parent.children]) if (!nodes.includes(child)) child.remove();
    }
    function prune(cache, nodes) { for (const [key, value] of cache) if (!nodes.includes(value.node)) cache.delete(key); }
    function drawSettings() {
      settings.hidden = !settingsOpen; settingsButton.setAttribute('aria-expanded', String(settingsOpen));
      set(settingsWord, f('settings') + (settingsOpen ? ' ⌃' : ' ⌄')); set(unsaved, dirty ? f('unsaved') : ''); unsaved.hidden = !dirty;
    }
    function translate() {
      activate.dataset.label = current?.config.enabled ? 'deactivate' : 'activate';
      for (const b of host.querySelectorAll('[data-label]')) set(b, f(b.dataset.label));
      set(title, f('title')); set(dialogTitle, f('title')); set(later, f('later'));
      close.setAttribute('aria-label', f('close')); dismiss.setAttribute('aria-label', f('closeLabel'));
      set(sourceLabel.firstChild, f('source')); set(concernLabel.firstChild, f('concern')); set(timeLabel.firstChild, f('time'));
      set(retention, f('retention')); set(terms, f('terms')); set(earlierTitle, f('earlier'));
      set(activationTitle, f(current?.config.enabled ? 'on' : current?.suggestion ? 'prefilled' : 'activateTitle')); set(localHint, f(current?.suggestion === 'generic' ? 'genericHint' : current?.suggestion === 'local' ? 'localHint' : 'customHint'));
      drawSettings();
    }
    const localDay = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const runDay = run => typeof run.day === 'string' && run.day ? run.day : run.budgetDay;
    function render(value) {
      current = { ...value, popup: false }; translate();
      badge.textContent = value.unread ? String(value.unread) : ''; button.setAttribute('aria-label', f('entry', { count: value.unread })); button.title = f('entry', { count: value.unread });
      const latestRun = value.runs[0], runKey = run => run.skipReason === 'usage-unconfirmed' ? 'run.budget-unconfirmed' : 'run.' + run.state;
      set(status, value.error && value.errorFile ? f('storageFile', { file: value.errorFile }) : f(value.error ? 'storage' : !value.allowed ? 'approval' : !value.config.enabled ? 'off' : latestRun && latestRun.state !== 'ready' ? runKey(latestRun) : 'on'));
      const chosen = [...source.options].find(o => o.value === value.source);
      set(summaryText, [chosen ? f(chosen.dataset.label) : 'GitHub Trending', f('dailyAt', { time: value.config.time }), ''].join(' · '));
      historyStatus.hidden = !latestRun;
      const total = latestRun ? value.runs.filter(r => r.budgetDay === latestRun.budgetDay).reduce((n, r) => n + r.chargedMicros, 0) : 0;
      const uncertain = latestRun && value.runs.some(r => r.budgetDay === latestRun.budgetDay && r.attempted && r.costKnown !== true && r.state !== 'ready');
      const upper = latestRun && value.runs.some(r => r.budgetDay === latestRun.budgetDay && r.usage?.tier === 'peak-bound');
      set(historyStatus, latestRun ? latestRun.budgetDay + ' · ' + (latestRun.state === 'ready' ? '' : f(runKey(latestRun)) + ' · ') + f(uncertain ? 'reserved' : upper ? 'spentUpper' : 'spent', { cost: (total / 1000000).toFixed(6) }) : '');
      activate.setAttribute('aria-describedby', 'discoveries-status'); status.id = 'discoveries-status';
      concern.required = Boolean(value.config.enabled); activate.disabled = saving || !value.allowed || Boolean(value.error);
      if (!dirty) { source.value = value.source; concern.value = value.config.concern; time.value = value.config.time; }
      const latest = value.runs.find(r => r.state === 'ready' && r.items.some(i => !i.read && !i.ignored));
      set(title, f('picked', { count: latest?.items.length || 0 })); set(subtitle, 'GitHub Trending'); set(later, f('remaining', { count: value.unread }));
      const popupNodes = latest ? latest.items.filter(i => !i.read && !i.ignored).map(i => row(latest, i, popupRows)) : [];
      fill(body, popupNodes); prune(popupRows, popupNodes);
      // Today's picks first; earlier days stay folded, one per day (R252).
      const today = localDay(Date.now()), byDay = new Map();
      for (const run of value.runs) for (const item of run.items) { const key = runDay(run); if (!byDay.has(key)) byDay.set(key, []); byDay.get(key).push({ run, item }); }
      const todays = byDay.get(today) || [], shown = todays.map(({ run, item }) => row(run, item, historyRows));
      set(todayTitle, f('today', { count: todays.length })); todayTitle.hidden = list.hidden = !todays.length; fill(list, shown);
      const dayNodes = [];
      for (const [key, entries] of byDay) {
        if (key === today) continue;
        let d = days.get(key);
        if (!d) { const node = make('details', 'discoveries-day'), head = make('summary'), name = make('span'), count = make('small'), items = make('div', 'discoveries-history'); head.append(name, count); node.append(head, items); d = { node, name, count, items }; days.set(key, d); }
        const nodes = entries.map(({ run, item }) => row(run, item, historyRows)), unread = entries.filter(({ item }) => !item.read && !item.ignored).length;
        set(d.name, key); set(d.count, unread ? f('dayUnread', { count: entries.length, unread }) : f('dayCount', { count: entries.length }));
        fill(d.items, nodes); shown.push(...nodes); dayNodes.push(d.node);
      }
      for (const key of [...days.keys()]) if (!byDay.has(key) || key === today) days.delete(key);
      fill(earlier, dayNodes); earlierTitle.hidden = earlier.hidden = !dayNodes.length; prune(historyRows, shown);
      set(empty, f('empty')); empty.hidden = byDay.size > 0;
      if (!body.children.length && popup.matches(':popover-open')) popup.hidePopover();
      if (value.popup && body.children.length) { pending = true; showPending(); }
    }
    function showPending() {
      if (!pending || disposed || doc.querySelector('dialog[open]')) return;
      pending = false; returnFocus = doc.activeElement; popup.showPopover();
    }
    async function open() {
      pending = false; if (popup.matches(':popover-open')) popup.hidePopover();
      const value = await call('status');
      if (!value || disposed || dialog.open) return;
      // Content comes first; settings open for a draft left by an outside click (marked unsaved) or while the source is off.
      settingsOpen = dirty || !value.config.enabled; drawSettings(); dialog.showModal();
      if (dirty) concern.focus(); else if (settingsOpen && !activate.disabled) activate.focus();
    }
    // The arrival card stays manual: an automatic popover would close an open task board (R252 ②).
    const outside = event => { if (popup.matches(':popover-open') && !popup.contains(event.target) && event.target !== button && !button.contains?.(event.target)) popup.hidePopover(); };
    const toggled = event => {
      if (event.target === popup) { if (popup.matches(':popover-open')) doc.addEventListener('pointerdown', outside, true); else doc.removeEventListener('pointerdown', outside, true); }
      showPending();
    };
    const key = event => { if (event.key === 'Escape' && popup.matches(':popover-open')) { const inside = popup.contains(doc.activeElement); popup.hidePopover(); if (inside && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); } };
    doc.addEventListener('toggle', toggled, true); doc.addEventListener('keydown', key);
    button.onclick = open;
    const off = api.onDiscoveries(value => { if (!disposed) render(value); }), languageOff = subscribe(() => { if (current) render(current); else translate(); });
    translate(); call('status');
    return { refresh: () => call('status'), dispose() { disposed = true; off?.(); languageOff?.(); button.onclick = null; doc.removeEventListener('toggle', toggled, true); doc.removeEventListener('keydown', key); doc.removeEventListener('pointerdown', outside, true); popup.remove(); dialog.remove(); } };
  }
  global.nativeWorkspaceRegularPopup = { bind };
})(globalThis);
