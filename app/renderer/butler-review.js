// The adapter supplies a frozen presentation model. This component does not
// read raw ledgers, derive semantic IDs, authorize a person or execute proposals.
(function (root) {
  const model = root.nativeWorkspaceButlerReviewModel ||
    (typeof module === 'object' && module.exports ? require('./butler-review-model.js') : null);

  function create({ entry = null, dialog, text, read, confirm, readNew, language = () => undefined }) {
    const document = dialog.ownerDocument;
    const node = (tag, value, className) => {
      const el = document.createElement(tag);
      if (value !== undefined) el.textContent = value;
      if (className) el.className = className;
      return el;
    };
    const t = (key, params) => text('butlerReview.' + key, params);
    let frozen = null, confirmed = false, pending = false, generation = 0;
    let marks = new Set(), attested = false, disposed = false;
    const expanded = new Set(), controls = new Map();
    dialog.classList.add('butler-review-dialog');
    const layout = node('div', undefined, 'review-layout');
    const header = node('header', undefined, 'review-header');
    const heading = node('div', undefined, 'heading');
    const title = node('h2'), close = node('button', '×', 'close'); close.type = 'button';
    title.id = dialog.id + '-title'; dialog.setAttribute('aria-labelledby', title.id);
    heading.append(title, close);
    const intro = node('p', undefined, 'intro'), chips = node('div', undefined, 'chips'), summary = node('div', undefined, 'summary');
    header.append(heading, intro, chips);
    const scroll = node('div', undefined, 'review-scroll');
    const tableHead = node('div', undefined, 'table-head');
    const readings = node('section', undefined, 'acceptance'), records = node('div');
    const failure = node('details', undefined, 'batch-failure');
    const error = node('p', undefined, 'review-error'); error.setAttribute('role', 'alert');
    scroll.append(tableHead, readings, records, failure, error);
    const footer = node('footer', undefined, 'review-footer');
    const attestLabel = node('label', undefined, 'attest'), attest = node('input'), attestText = node('span');
    attest.type = 'checkbox'; attestLabel.append(attest, attestText);
    const line = node('div', undefined, 'footer-line'), note = node('p', undefined, 'footnote');
    const actions = node('div', undefined, 'footer-actions');
    const newest = node('button', undefined, 'new-audit'), edit = node('button'), accept = node('button', undefined, 'primary'); newest.type = edit.type = accept.type = 'button';
    const newHint = node('p', undefined, 'new-audit-note footnote');
    actions.append(newest, edit, accept); line.append(note, actions);
    const receipt = node('p', undefined, 'receipt'); receipt.setAttribute('role', 'status');
    footer.append(attestLabel, newHint, line, receipt); layout.append(header, scroll, footer);
    dialog.replaceChildren(layout); if (entry) entry.hidden = true;

    function stats() {
      return model.summarize(frozen?.rows || [], marks, {
        confirmed, sampleKind: frozen?.sampleKind || 'audit', synthetic: frozen?.synthetic === true,
        repeatedQuestionsToPerson: frozen?.repeatedQuestionsToPerson ||
          { complete: false, count: null, reason: t('loadFailed') },
      });
    }
    function reason(value) {
      return t(value === 'ERR_BUTLER_AMBIGUOUS_SPACE' ? 'reasonSpace' :
        value === 'ERR_BUTLER_BUSINESS_DATA' ? 'reasonData' : 'reasonUnknown');
    }
    function humanDetail(value) {
      return typeof value === 'string' && value.trim() && !/^(?:ERR|BUTLER)_[A-Z0-9_]+$/.test(value.trim()) ? value : t('reasonUnavailable');
    }
    function rowDecision(row) {
      const peers = frozen.rows.filter(other => model.rowKey(other) === model.rowKey(row));
      if (!peers.every(other => other.assessable)) return 'unable';
      if (marks.has(model.rowKey(row))) return 'negative';
      return confirmed ? row.suspended ? 'pausedAgree' : 'positive' : 'waiting';
    }
    function renderReadings(s) {
      readings.hidden = !confirmed; readings.replaceChildren(); if (!confirmed) return;
      readings.append(node('h3', t('reads') + (frozen.synthetic ? ' · ' + t('synthetic') : '')));
      readings.append(node('p', s.denominator ? t('ratio', { agreed: s.agreed, count: s.denominator }) : t('emptyRate'), 'agreement-reading'));
      for (const [key, count] of [['denominator', s.denominator], ['unknownRead', s.unable],
        ['suspendedRead', s.suspended], ['allUnknown', s.unknownOccurrences]]) readings.append(node('p', t(count === 1 && ['denominator', 'unknownRead'].includes(key) ? key + 'One' : key, { count })));
      const m = s.measurement;
      const explanation = m.reasonParts ? m.reasonParts.map(part => t(part.key, part.params)).join(' ') : m.reason;
      readings.append(node('p', m.complete ? t('repeatMeasured', { count: m.count }) : t('repeatIncomplete', { reason: explanation })));
      // A blocked candidate is not proof that any question reached the person.
      if (Number.isSafeInteger(frozen.blockedRepeatQuestionCandidates) && frozen.blockedRepeatQuestionCandidates >= 0) {
        readings.append(node('p', t('blocked', { count: frozen.blockedRepeatQuestionCandidates })), node('p', t('blockedNote')));
      } else readings.append(node('p', t('blockedUnknown', { reason: humanDetail(frozen.blockedRepeatQuestionCandidatesReason || t('blockedMissingReason')) })));
      readings.append(node('p', t('samples', { count: s.realSamples })), node('p', t('sampleDefinition')));
      if (frozen.sampleKind === 'synthetic') readings.append(node('p', t('syntheticSamples')));
      if (frozen.sampleKind === 'audit') readings.append(node('p', t('auditSamples')));
      const minimum = s.minimumSamples;
      readings.append(node('p', minimum === null ? t('sampleUndecided', { count: s.realSamples }) :
        s.realSamples < minimum ? t('sampleInsufficient', { count: s.realSamples, minimum }) : t('sampleMinimum', { count: minimum })));
    }
    function renderRows() {
      records.replaceChildren(); controls.clear(); const first = new Map(), positions = new Map();
      frozen?.rows.forEach((row, index) => {
        const key = model.rowKey(row); if (!first.has(key)) first.set(key, index);
        if (!positions.has(key)) positions.set(key, []); positions.get(key).push(index);
      });
      frozen?.rows.forEach((row, index) => {
        const key = model.rowKey(row), origin = first.get(key);
        const article = node('article', undefined, 'record' + (!row.assessable ? ' unavailable' : '') + (marks.has(key) ? ' disagreed' : ''));
        article.dataset.rowId = row.id; article.id = dialog.id + '-row-' + index; article.tabIndex = -1;
        const meta = node('div', undefined, 'meta');
        meta.append(node('span', t('row', { count: index + 1 }), 'row-number'), node('span', t(['queue', 'report', 'question'].includes(row.kind) ? row.kind : 'unknown'), 'kind'));
        if (Number.isFinite(row.time)) meta.append(node('span', new Intl.DateTimeFormat(language(), { hour: '2-digit', minute: '2-digit' }).format(row.time)));
        meta.append(node('span', t(row.suspended ? 'suspended' : 'recorded'), 'status ' + (row.suspended ? 'suspended' : 'recorded')));
        const jump = (label, targetIndex) => {
          const link = node('a', label, 'repeat-link'); link.href = '#' + dialog.id + '-row-' + targetIndex;
          link.addEventListener('click', event => { event.preventDefault(); const target = document.getElementById(dialog.id + '-row-' + targetIndex); target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true }); });
          meta.append(link);
        };
        if (origin !== index) jump(t('repeat', { count: origin + 1 }), origin);
        else for (const repeated of positions.get(key).slice(1)) jump(t('repeatForward', { rows: String(repeated + 1) }), repeated);
        const body = node('div'), proposal = node('p', row.text || t('redacted'), 'proposal'); proposal.id = dialog.id + '-text-' + index; body.append(proposal);
        const source = node('details', undefined, 'source'); source.open = expanded.has(row.id);
        const sourceTitle = row.sources?.[0]?.payload?.title || row.sources?.[0]?.sourceRef || row.sourceRef;
        source.append(node('summary', row.assessable ? t('source') + (typeof sourceTitle === 'string' && sourceTitle ? ' · ' + sourceTitle : '') : t('sourceUnknown')));
        source.addEventListener('toggle', () => { if (source.open) expanded.add(row.id); else expanded.delete(row.id); });
        const detail = node('div', undefined, 'source-body');
        if (!row.assessable) detail.append(node('p', t('batchContext')));
        const appendSources = events => {
          for (const event of events) {
            if (event.payload?.title) detail.append(node('p', event.payload.title));
            if (event.payload?.text) detail.append(node('p', event.payload.text));
            if (event.payload?.reason) detail.append(node('p', humanDetail(event.payload.reason)));
            detail.append(node('code', [event.sourceRef, event.eventId].filter(Boolean).join(' · ')));
          }
        };
        appendSources(row.sources?.length ? row.sources : row.batchSources || []);
        if (row.supplementalSources?.length) { detail.append(node('p', t('supplementalSource'))); appendSources(row.supplementalSources); }
        if (row.missingSourceEventIds?.length) detail.append(node('p', t('missingSources', { ids: row.missingSourceEventIds.join(', ') })));
        if (row.reason) detail.append(node('p', t('reason') + ': ' + reason(row.reason), 'suspension-reason'));
        source.append(detail); body.append(source);
        const decision = node('div', undefined, 'decision'), label = node('label'), input = node('input');
        input.type = 'checkbox'; input.setAttribute('aria-describedby', proposal.id); input.id = dialog.id + '-mark-' + index; input.checked = marks.has(key); input.disabled = confirmed || pending;
        input.addEventListener('change', () => { if (input.checked) marks.add(key); else marks.delete(key); refresh(false); });
        label.append(input, node('span', t('disagreed'))); const judgment = node('span', t(rowDecision(row)), 'judgment'); decision.append(label, judgment); controls.set(row.id, { row, input, article, judgment });
        article.append(meta, body, decision); records.append(article);
      });
    }
    function refresh(rebuild = true) {
      if (disposed) return;
      const focused = document.activeElement?.id;
      const offset = scroll.scrollTop, s = stats();
      title.textContent = t('title'); close.setAttribute('aria-label', t('close'));
      if (entry) {
        const entryLabel = entry.querySelector?.('.rail-label'); if (entryLabel) entryLabel.textContent = t('entry'); else entry.textContent = t('entry');
        entry.setAttribute('aria-label', t('entry')); entry.title = t('entry');
      }
      intro.textContent = pending ? t('loading') : t(s.total === 1 ? 'introOne' : 'intro', { count: s.total });
      chips.replaceChildren(node('span', t('off'), 'chip'), node('span', t(confirmed ? 'confirmed' : 'pending'), 'chip ' + (confirmed ? 'confirmed' : 'pending')));
      if (frozen?.sampleKind === 'synthetic') chips.append(node('span', t('synthetic'), 'chip'));
      if (frozen?.sampleKind === 'audit') chips.append(node('span', t('audit'), 'chip'));
      summary.replaceChildren();
      for (const [label, count] of confirmed ? [['total', s.total], ['distinctDisagreed', s.disagreed], ['distinctAgreed', s.agreed]] : [['total', s.total], ['unreviewed', s.pendingOccurrences]]) {
        const item = node('span'); item.append(node('b', String(count)), node('span', t(label))); summary.append(item);
      }
      chips.append(summary);
      tableHead.replaceChildren(...['time', 'proposal', 'mark'].map(key => node('span', t(key))));
      if (rebuild) renderRows();
      for (const { row, input, article, judgment } of controls.values()) { input.checked = marks.has(model.rowKey(row)); input.disabled = confirmed || pending; article.classList.toggle('disagreed', input.checked); judgment.textContent = t(rowDecision(row)); }
      renderReadings(s);
      failure.hidden = !frozen?.failed?.length; failure.replaceChildren(node('summary', t('failure', { count: frozen?.failed?.length || 0 })), node('p', t('failureHelp')));
      for (const item of frozen?.failed || []) failure.append(node('p', humanDetail(item.failure)));
      attest.checked = attested; attest.disabled = confirmed || pending || !s.total;
      attestText.textContent = t(s.total === 1 ? 'attestOne' : 'attest', { count: s.total }); note.textContent = t('note');
      accept.textContent = t(confirmed ? 'done' : 'confirm'); accept.disabled = confirmed || pending || !attested || !s.total;
      newest.hidden = typeof readNew !== 'function'; newest.textContent = t('newAudit'); newest.disabled = pending || !canReadNew();
      newHint.hidden = newest.hidden || canReadNew(); newHint.textContent = t('newAuditDraftHint');
      edit.hidden = !confirmed; edit.textContent = t('edit'); receipt.hidden = !confirmed; receipt.textContent = confirmed ? t('receipt') + ' · ' + t('savedRevision', { revision: frozen.confirmation.revision }) : t('receipt');
      scroll.scrollTop = offset;
      if (rebuild && focused) document.getElementById(focused)?.focus({ preventScroll: true });
    }
    function checkedView(value, failureKey = 'loadFailed') {
      if (!value || typeof value.token !== 'string' || !value.token) throw Error(t(failureKey));
      const allowed = new Set(value.rows.map(row => model.rowKey(row)));
      model.summarize(value.rows, new Set(), { confirmed: false, sampleKind: value.sampleKind, synthetic: value.synthetic, repeatedQuestionsToPerson: value.repeatedQuestionsToPerson });
      if (value.confirmation !== null) {
        const saved = value.confirmation;
        if (!saved || saved.allRead !== true || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || !Array.isArray(saved.marks) ||
          new Set(saved.marks).size !== saved.marks.length || !saved.marks.every(mark => allowed.has(mark))) throw Error(t('loadFailed'));
      }
      return value;
    }
    function install(value) {
      frozen = structuredClone(value);
      confirmed = frozen.confirmation !== null; marks = new Set(frozen.confirmation?.marks || []); attested = confirmed;
    }
    function errorMessage(problem, fallback) {
      return problem && typeof problem.message === 'string' && problem.message.trim() ? humanDetail(problem.message) : t(fallback);
    }
    function canReadNew() { return confirmed || marks.size === 0 && !attested; }
    async function open(useNew = false) {
      if (disposed || useNew === true && (typeof readNew !== 'function' || pending || !canReadNew())) return;
      const ticket = ++generation; pending = true; error.hidden = true;
      if (!dialog.open) dialog.showModal(); refresh();
      try {
        const value = await (useNew === true ? readNew() : read()); if (ticket !== generation || !dialog.open) return;
        if (value === null) { frozen = null; marks.clear(); expanded.clear(); confirmed = false; attested = false; if (entry) entry.hidden = true; dialog.close(); return; }
        checkedView(value);
        // Same-token drafts, including edits to a saved revision, remain local.
        // New tokens restore the host's authoritative persisted confirmation.
        if (!frozen || frozen.token !== value.token) { install(value); expanded.clear(); }
        if (!frozen.rows.length && !frozen.failed?.length) { if (entry) entry.hidden = true; dialog.close(); return; }
      } catch (problem) { if (ticket === generation && dialog.open) { error.hidden = false; error.textContent = errorMessage(problem, 'loadFailed'); } }
      finally { if (ticket === generation && dialog.open) { pending = false; refresh(); } }
    }
    async function save() {
      if (!frozen || !frozen.rows.length || pending || confirmed || !attested) return;
      const ticket = generation, original = frozen;
      const draft = { token: frozen.token, marks: [...marks], allRead: true };
      pending = true; error.hidden = true; refresh(false);
      try {
        const accepted = await confirm(draft);
        if (ticket !== generation || !dialog.open) return;
        checkedView(accepted, 'confirmFailed');
        const saved = accepted.confirmation, sent = [...draft.marks].sort();
        if (!saved || saved.revision !== (original.confirmation?.revision || 0) + 1 || accepted.token === original.token ||
          accepted.rows.length !== original.rows.length || accepted.rows.some((row, index) => row.id !== original.rows[index].id || model.rowKey(row) !== model.rowKey(original.rows[index])) ||
          accepted.sampleKind !== original.sampleKind || saved.marks.length !== sent.length ||
          [...saved.marks].sort().some((mark, index) => mark !== sent[index])) throw Error(t('confirmFailed'));
        install(accepted); pending = false; refresh(); scroll.scrollTop = 0;
      } catch (problem) { if (ticket === generation && dialog.open) { pending = false; error.hidden = false; error.textContent = errorMessage(problem, 'confirmFailed'); refresh(false); } }
    }
    entry?.addEventListener('click', open); close.addEventListener('click', () => dialog.close());
    const onClose = () => { generation++; pending = false; };
    dialog.addEventListener('close', onClose);
    attest.addEventListener('change', () => { attested = attest.checked; refresh(false); });
    accept.addEventListener('click', save);
    newest.addEventListener('click', () => open(true));
    edit.addEventListener('click', () => { confirmed = false; attested = false; refresh(false); });
    refresh();
    return { open, refresh, available(value) { if (!disposed && entry) entry.hidden = value !== true; }, stats,
      dispose() { disposed = true; generation++; entry?.removeEventListener('click', open); if (dialog.open) dialog.close(); dialog.removeEventListener('close', onClose); frozen = null; marks.clear(); expanded.clear(); controls.clear(); records.replaceChildren(); readings.replaceChildren(); failure.replaceChildren(); error.textContent = ''; if (entry) entry.hidden = true; dialog.replaceChildren(); } };
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceButlerReview = api;
})(globalThis);
