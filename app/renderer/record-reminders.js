/* The bell: reminders about records kept whole (the person, 2026-11-11: 「超过 30 天/或者整个记录大小超过 0.5G 这样的，
   界面有个小铃铛弹提醒，看如何处理」). The bell is there only while something is due. Its dialog says, for each
   record, what reached a line, and offers what the person approved: "知道了", export (blocks copied as they are and
   checked), and for a block that cannot be read, showing it in Finder. Only through the person-only call
   records(…); nothing here deletes anything. */
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
    let current = null, ticket = 0;

    // The bell follows the reminders that are due; with none it is not there at all.
    async function refresh() {
      const mine = ++ticket;
      let status; try { status = await api.records('status'); } catch { status = null; }
      if (mine !== ticket) return current;
      current = status;
      const count = status && Number.isSafeInteger(status.count) ? status.count : 0;
      button.hidden = count === 0; badge.textContent = count ? String(count) : '';
      const label = format('records.bellCount', { count }); button.setAttribute('aria-label', label); button.title = label;
      if (dialog.open && dialog.dataset.view === 'reminders') draw();
      return status;
    }
    function item(record, entry) {
      const total = record.blocks, oldest = record.oldestDay || '—', bytes = size(record.bytes);
      if (entry.kind === 'age') return ['records.item.age', { blocks: entry.blocks, oldest: entry.oldestDay || oldest, total, size: bytes }];
      if (entry.kind === 'size') return ['records.item.size', { size: size(entry.bytes), oldest, total }];
      if (entry.manifest) return ['records.item.unreadableManifest', {}];
      if (!entry.blocks) return ['records.item.unavailable', {}];
      return ['records.item.unreadable', { blocks: entry.blocks, from: entry.fromSequence, through: entry.throughSequence }];
    }
    // The reminders: one section per record with something due, in the order the records are listed.
    function draw() {
      dialog.dataset.view = 'reminders'; dialog.replaceChildren();
      const title = make('h2', '', 'records.title'); title.id = (dialog.id || 'records-dialog') + '-title'; dialog.setAttribute('aria-labelledby', title.id);
      dialog.append(title, make('p', 'quiet', 'records.intro'));
      const due = (current?.records || []).map(record => ({ record, items: record.items.filter(entry => entry.shown) })).filter(group => group.items.length);
      if (!current) dialog.append(make('p', 'records-note', 'records.failed', { reason: '—' }));
      else if (!due.length) dialog.append(make('p', 'records-note', 'records.nothing'));
      for (const { record, items } of due) {
        const section = make('section', 'records-section'); section.dataset.record = record.record;
        section.append(make('h3', '', `records.name.${record.record}`));
        for (const entry of items) {
          const [key, params] = item(record, entry), row = make('div', 'records-item'), actions = make('div', 'records-actions');
          row.dataset.kind = entry.kind; row.append(make('p', '', key, params));
          if (entry.kind === 'unreadable') actions.append(control('records.reveal', 'reveal', () => api.records('reveal', record.record, null).catch(() => {})));
          else actions.append(control('records.export', 'export', () => exportView(record.record)));
          actions.append(control('records.acknowledge', 'acknowledge', async () => {
            try { current = await api.records('acknowledge', record.record, entry.kind, entry.level); } catch { /* Shown again next time; nothing is lost. */ }
            await refresh(); draw();
          }));
          row.append(actions); section.append(row);
        }
        dialog.append(section);
      }
      const foot = make('div', 'dialog-actions'); foot.append(control('records.done', 'done', () => dialog.close())); dialog.append(foot);
    }
    // Export: the record's sealed blocks, the ones past 30 days chosen to start with, a folder, and the copy.
    async function exportView(record) {
      dialog.dataset.view = 'export'; dialog.replaceChildren();
      const title = make('h2', '', 'records.export.title', { name: format(`records.name.${record}`) }); title.id = (dialog.id || 'records-dialog') + '-title';
      const status = make('p', 'records-note'); status.setAttribute('role', 'status');
      dialog.append(title, make('p', 'quiet', 'records.export.intro'));
      let blocks = []; try { blocks = await api.records('blocks', record); } catch (error) { status.textContent = format('records.export.failed', { reason: error?.message || '—' }); }
      const list = make('div', 'records-blocks'), boxes = [];
      for (const block of blocks) {
        const row = make('label', 'records-block'), box = make('input'), day = make('span', 'records-day'), about = make('span', 'records-about'), bytes = make('span', 'records-size');
        box.type = 'checkbox'; box.checked = block.old; box.value = block.name; boxes.push(box);
        day.textContent = block.first === block.last ? block.first : `${block.first} – ${block.last}`; if (block.old) day.className += ' records-old';
        about.textContent = format('records.export.count', { count: block.count }) + (block.old ? ' · ' + format('records.export.old') : '');
        bytes.textContent = size(block.bytes); row.append(box, day, about, bytes); list.append(row);
      }
      if (!blocks.length && !status.textContent) say(status, 'records.export.none');
      const where = make('div', 'records-folder'), label = make('span', 'quiet', 'records.export.to'), folder = make('span', 'records-path', 'records.export.noFolder');
      const choose = control('records.export.choose', 'choose', async () => {
        try { const chosen = await api.records('chooseFolder'); if (chosen?.folder) { folder.textContent = chosen.folder; folder.dataset.chosen = 'true'; } } catch { /* The folder stays as it was. */ }
        update();
      });
      where.append(label, folder, choose);
      const actions = make('div', 'dialog-actions'), back = control('records.export.back', 'back', () => draw()), run = control('records.export.run', 'run', () => go(), { count: 0 });
      run.className = 'primary'; actions.append(back, run);
      const update = () => { const count = boxes.filter(box => box.checked).length; say(run, 'records.export.run', { count }); run.disabled = !count || folder.dataset.chosen !== 'true'; };
      for (const box of boxes) box.addEventListener('change', update);
      async function go() {
        const names = boxes.filter(box => box.checked).map(box => box.value); run.disabled = true;
        try {
          const result = await api.records('export', record, names);
          say(status, 'records.export.done', { count: result.exported.length, size: size(result.bytes), folder: result.folder });
          for (const box of boxes) box.disabled = true; choose.disabled = true; run.hidden = true;
        } catch (error) { say(status, 'records.export.failed', { reason: error?.message || '—' }); update(); }
      }
      dialog.append(list, where, status, actions); update();
    }
    async function open() { await refresh(); draw(); if (!dialog.open) dialog.showModal(); }
    button.addEventListener('click', () => { open(); });
    dialog.addEventListener('close', () => { dialog.replaceChildren(); dialog.dataset.view = ''; });
    return { refresh, open, size };
  }
  const value = { bind };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceRecordReminders = value;
})(globalThis);
