/* Permanent bell for record retention and registered NAW test temporary files.
   All actions use the existing person-only records entry. Record export/deletion
   keeps its prior checked-export flow; temporary cleanup uses a displayed,
   window-bound ticket and reports confirmed results, including skipped folders. */
(function (global) {
  'use strict';
  function bind({ button, badge, dialog, document, api, text, display }) {
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, params); return el; };
    const make = (tag, cls, key, params) => { const el = document.createElement(tag); if (cls) el.className = cls; if (key) say(el, key, params); return el; };
    const control = (key, action, handler, params) => { const el = make('button', '', key, params); el.type = 'button'; el.dataset.action = action; el.addEventListener('click', handler); return el; };
    // Sizes: one decimal of MiB, never rounded down; past 1 GiB, two decimals of GiB.
    const size = bytes => bytes >= 1024 ** 3 ? `${(Math.ceil(bytes / 1024 ** 3 * 100) / 100).toFixed(2)} GiB` : (tenths => `${tenths % 10 ? (tenths / 10).toFixed(1) : tenths / 10} MiB`)(Math.ceil(bytes / 104857.6));
    const tempSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.floor(bytes / 1024)} KiB` : bytes < 1024 ** 3 ? `${(Math.floor(bytes / 1024 ** 2 * 10) / 10).toFixed(1)} MiB` : `${(Math.floor(bytes / 1024 ** 3 * 10) / 10).toFixed(1)} GiB`;
    let current = null, ticket = 0, lastResult = null, working = false, cleanupFailed = false;

    // The original bell position remains available even when no reminder is due.
    async function refresh(force = false) {
      const mine = ++ticket;
      let status; try { status = await (force ? api.records('status', true) : api.records('status')); } catch { status = null; }
      if (mine !== ticket) return current;
      current = status;
      const count = status && Number.isSafeInteger(status.count) ? status.count : 0;
      button.hidden = false; badge.textContent = count ? String(count) : '';
      button.className = 'subtle records-bell' + (count ? ' has-due' : '');
      const label = format('records.bellCount', { count }); button.setAttribute('aria-label', label); button.title = label;
      if (dialog.open && dialog.dataset.view === 'reminders') draw();
      return status;
    }
    function item(record, entry) {
      const total = record.blocks, oldest = record.oldestDay || '—', bytes = size(record.bytes);
      if (entry.kind === 'age') return ['records.item.age', { blocks: entry.blocks, oldest: entry.oldestDay || oldest, total, size: bytes }];
      if (entry.kind === 'size') return ['records.item.size', { size: size(entry.bytes), oldest, total }];
      if (entry.kind === 'unavailable') return [record.record === 'steward' ? (entry.cause === 'history' ? 'records.item.stewardUnavailable' : 'records.item.stewardUnavailableOther') : entry.cause === 'history' ? 'records.item.unavailable' : 'records.item.unavailableOther', {}];
      if (entry.manifest) return ['records.item.unreadableManifest', {}];
      return ['records.item.unreadable', { blocks: entry.blocks, from: entry.fromSequence, through: entry.throughSequence }];
    }
    // The reminders: one section per record with something due, in the order the records are listed.
    const registrationText = issue => issue === 'incomplete' ? 'records.temp.registrationIncomplete' : issue === 'metadata-unavailable' ? 'records.temp.registrationUnavailable' : null;
    function draw() {
      dialog.dataset.view = 'reminders'; dialog.replaceChildren();
      const title = make('h2', '', 'records.title'); title.id = (dialog.id || 'records-dialog') + '-title'; dialog.setAttribute('aria-labelledby', title.id);
      const head = make('div', 'records-panel-head'), number = make('span', 'records-panel-count');
      if (current?.count) say(number, current.count === 1 ? 'records.pendingOne' : 'records.pendingCount', { count: current.count });
      const close = control('records.close', 'close', () => dialog.close()); close.className = 'records-close';
      head.append(title, number, close); dialog.append(head);
      const due = (current?.records || []).map(record => ({ record, items: record.items.filter(entry => entry.shown) })).filter(group => group.items.length);
      if (!current) dialog.append(make('p', 'records-note', 'records.failed', { reason: '—' }));
      else if (!due.length && !current.temp?.shown && !lastResult) dialog.append(make('p', 'records-empty', 'records.nothing'));
      if (lastResult) {
        const result = make('section', 'records-temp-result'); result.setAttribute('role', 'status');
        result.append(make('h3', '', 'records.temp.result', { count: lastResult.cleaned }), make('p', '', 'records.temp.freed', { size: tempSize(lastResult.bytes) }));
        if (lastResult.skipped) result.append(make('p', '', registrationText(lastResult.registrationIssue) || (lastResult.reasons?.unverified ? 'records.temp.unverified' : lastResult.reasons?.busy === lastResult.skipped ? 'records.temp.keptBusy' : 'records.temp.kept'), { count: lastResult.skipped }));
        if (lastResult.bookkeepingFailed) result.append(make('p', '', 'records.temp.bookkeepingFailed'));
        dialog.append(result);
      }
      if (current?.temp?.shown) {
        const temp = current.temp, section = make('section', 'records-section records-temp');
        section.dataset.record = 'temp';
        section.append(make('h3', '', temp.anomaly ? 'records.temp.unavailable' : 'records.temp.title'));
        if (temp.directories) {
          const facts = make('div', 'records-temp-facts');
          for (const [value, label] of [[format('records.temp.directories', {count:temp.directories}), 'records.temp.unit'], [tempSize(temp.bytes), 'records.temp.size'], [temp.oldestDay || '—', 'records.temp.oldest']]) {
            const fact = make('div'), main = make('strong'); main.textContent = value; fact.append(main, make('small', '', label)); facts.append(fact);
          }
          section.append(facts);
        }
        section.append(make('p', '', registrationText(temp.registrationIssue) || (temp.anomaly ? 'records.temp.inspectionFailed' : 'records.temp.about')));
        const actions = make('div', 'records-actions'), clean = control('records.temp.clean', 'tempClean', async () => {
          if (working) return; working = true; cleanupFailed = false; clean.disabled = true;
          try { const done = await api.records('tempClean', temp.ticket); lastResult = done.result; current = done; }
          catch { cleanupFailed = true; }
          finally { working = false; await refresh(); draw(); }
        });
        clean.className = 'primary'; clean.disabled = working || !temp.directories || Boolean(temp.anomaly) || !temp.ticket;
        const acknowledge = control('records.acknowledge', 'tempAcknowledge', async () => {
          try { current = await api.records('tempAcknowledge', temp.ticket); } catch { cleanupFailed = true; }
          await refresh(); draw();
        }); acknowledge.className = 'records-text-action'; acknowledge.disabled = working || !temp.ticket;
        actions.append(clean, acknowledge); section.append(actions); dialog.append(section);
      }
      if (cleanupFailed) dialog.append(make('p', 'records-note', 'records.temp.failed'));
      for (const { record, items } of due) {
        const section = make('section', 'records-section'); section.dataset.record = record.record;
        section.append(make('h3', '', `records.name.${record.record}`));
        for (const entry of items) {
          const [key, params] = item(record, entry), row = make('div', 'records-item'), actions = make('div', 'records-actions');
          row.dataset.kind = entry.kind; row.append(make('p', '', key, params));
          if (entry.kind === 'unreadable' || entry.kind === 'unavailable') actions.append(control('records.reveal', 'reveal', () => api.records('reveal', record.record, null).catch(() => {})));
          else actions.append(control('records.export', 'export', () => exportView(record.record)));
          actions.append(control('records.acknowledge', 'acknowledge', async () => {
            try { current = await api.records('acknowledge', record.record, entry.kind, entry.level); } catch { /* Shown again next time; nothing is lost. */ }
            await refresh(); draw();
          }));
          row.append(actions); section.append(row);
        }
        dialog.append(section);
      }
      const foot = make('div', 'dialog-actions');
      if (current?.count) foot.append(make('span', 'records-person', 'records.temp.person'));
      foot.append(control('records.done', 'done', () => dialog.close())); dialog.append(foot);
    }
    // Export: the record's sealed blocks, the ones past 30 days chosen to start with, a folder, and the copy.
    async function exportView(record) {
      dialog.dataset.view = 'export'; dialog.replaceChildren();
      const title = make('h2', '', 'records.export.title', { name: format(`records.name.${record}`) }); title.id = (dialog.id || 'records-dialog') + '-title';
      const status = make('p', 'records-note'); status.setAttribute('role', 'status');
      dialog.append(title, make('p', 'quiet', 'records.export.intro'));
      let blocks = []; try { blocks = await api.records('blocks', record); } catch (error) { status.textContent = format('records.export.failed', { reason: error?.message || '—' }); }
      const list = make('div', 'records-blocks'), boxes = [], rows = new Map();
      for (const block of blocks) {
        const row = make('label', 'records-block'), box = make('input'), day = make('span', 'records-day'), about = make('span', 'records-about'), bytes = make('span', 'records-size');
        box.type = 'checkbox'; box.checked = block.old; box.value = block.name; boxes.push(box);
        day.textContent = block.first === block.last ? block.first : `${block.first} – ${block.last}`; if (block.old) day.className += ' records-old';
        about.textContent = format('records.export.count', { count: block.count }) + (block.old ? ' · ' + format('records.export.old') : '');
        bytes.textContent = size(block.bytes); row.append(box, day, about, bytes); list.append(row); rows.set(block.name, row);
      }
      if (!blocks.length && !status.textContent) say(status, 'records.export.none');
      const where = make('div', 'records-folder'), label = make('span', 'quiet', 'records.export.to'), folder = make('span', 'records-path', 'records.export.noFolder');
      const choose = control('records.export.choose', 'choose', async () => {
        try { const chosen = await api.records('chooseFolder'); if (chosen?.folder) { folder.textContent = chosen.folder; folder.dataset.chosen = 'true'; } } catch { /* The folder stays as it was. */ }
        update();
      });
      where.append(label, folder, choose);
      const actions = make('div', 'dialog-actions'), back = control('records.export.back', 'back', () => draw()), run = control('records.export.run', 'run', () => go(), { count: 0 });
      // Deleting comes only after a checked export of exactly these blocks; until then it is not there.
      let exported = [];
      const about = make('p', 'quiet', 'records.delete.about'), remove = control('records.delete.button', 'delete', async () => {
        remove.disabled = true;
        try {
          const done = await api.records('delete', record, exported);
          if (done?.deleted?.length) { for (const name of done.deleted) if (rows.has(name)) rows.get(name).hidden = true; say(status, 'records.delete.done', { count: done.deleted.length }); remove.hidden = true; about.hidden = true; await refresh(); }
          else remove.disabled = false;
        } catch (error) { say(status, 'records.delete.failed', { reason: error?.message || '—' }); remove.disabled = false; }
      }, { count: 0 });
      about.hidden = true; remove.hidden = true; remove.className = 'records-apart';
      run.className = 'primary'; actions.append(remove, back, run);
      const update = () => { const count = boxes.filter(box => box.checked).length; say(run, 'records.export.run', { count }); run.disabled = !count || folder.dataset.chosen !== 'true'; };
      for (const box of boxes) box.addEventListener('change', update);
      async function go() {
        const names = boxes.filter(box => box.checked).map(box => box.value); run.disabled = true;
        try {
          const result = await api.records('export', record, names);
          say(status, 'records.export.done', { count: result.exported.length, size: size(result.bytes), folder: result.folder });
          for (const box of boxes) box.disabled = true; choose.disabled = true; run.hidden = true;
          // Only now, and only these blocks: what deleting them keeps, then the button (the main process asks once more).
          exported = result.exported.map(item => item.name);
          say(remove, 'records.delete.button', { count: exported.length }); remove.hidden = false; about.hidden = false;
        } catch (error) { say(status, 'records.export.failed', { reason: error?.message || '—' }); update(); }
      }
      dialog.append(list, where, status, about, actions); update();
    }
    async function open() { await refresh(true); draw(); if (!dialog.open) dialog.showModal(); }
    button.addEventListener('click', () => { open(); });
    // Worked out again when the main process says a record changed (a block sealed or added, a record not loaded).
    if (typeof api.onRecordsChanged === 'function') api.onRecordsChanged(() => { refresh(); });
    dialog.addEventListener('close', () => { dialog.replaceChildren(); dialog.dataset.view = ''; lastResult = null; cleanupFailed = false; });
    return { refresh, open, size };
  }
  const value = { bind };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceRecordReminders = value;
})(globalThis);
