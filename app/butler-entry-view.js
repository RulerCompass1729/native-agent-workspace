// What the person sees of the butler: one pure function over the entry the main process answers a person window
// with (app/butler-entry-host.cjs builds it from the core's person view). The renderer keeps no butler state and
// works nothing out from the ledger. A field the main process does not give stays unknown here; it is never
// guessed, and a missing amount is never shown as zero.
//
// The closed switch: in an ordinary launch the main process refuses the question, the window has no entry, and
// `entryView` answers `{ visible: false }`: the interface is unchanged.
//
// entry = { version: 1,
//   role:    { revision, selected: null | { runner: { profile, provider, model }, budget: null | { limitMicros, dayBoundary } } }
//   reminder: the daily reminder line the person agreed to, { amountMicros, dayBoundary }; shown when the
//            designation records no limit of its own
//   uncertain: true when the core cannot establish the designated butler's state from its own records
//   offer:   what a designation would select, same shape as `selected`; needed before the person is asked
//   startable: true | false, whether this version can start a butler at all (its pre-start checks)
//   backend: ButlerBackend.snapshot() fields: { state, ready, blocked[] }, or null
//   intake:  ButlerIngress.status() fields: { recordPeriod }
//   hold:    the reason of the core's latest recorded refusal to wake it that is still in force, or null
//   usage:   the shared reading app/butler-usage.cjs summarizeUsage() returns, or null while unverified
//   reviewAvailable: whether a record table exists to open
//   actions: the person-only actions the main process accepts now (designate, revoke, recheck)
//   unavailable: true when the designation record cannot be read; nothing else is then given }
// Turning a butler off while keeping the designation is not here: the core has no such switch yet.
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.nativeWorkspaceButlerEntryView = api; })(typeof self !== 'undefined' ? self : globalThis, function () {
  // Reasons that mean "this version cannot start a butler", whatever the person does.
  const BUILD_REASONS = Object.freeze(['tools-unqualified', 'context-unqualified', 'provider-unqualified', 's2-unqualified', 'runtime-unqualified', 'configuration-unset', 'qualification-invalid', 'driver-unavailable']);
  // The core's reasons for not waking a butler that have their own sentence; any other reason gets the general one.
  const HOLD_REASONS = Object.freeze(['daily-budget-reached', 'usage-cost-unknown', 'next-batch-cost-unknown']);
  const ACTIONS = Object.freeze(['designate', 'revoke', 'recheck']);
  // The only provider built so far; the sentences about what is sent name it.
  const PROVIDER = 'deepseek';
  const PROFILE_NAMES = Object.freeze({ 'deepseek-pro': 'DeepSeek pro' });
  const amount = value => Number.isSafeInteger(value) && value >= 0;
  const word = value => typeof value === 'string' && value.length > 0 && value.length <= 120;
  // The line shown beside a designation is its own daily limit when it records one, else the reminder line the
  // main process gives. A limit that is recorded but cannot be read is not replaced by the reminder.
  function choice(value, reminder) {
    const runner = value && value.runner, budget = value && value.budget;
    const line = budget ? { limitMicros: budget.limitMicros, dayBoundary: budget.dayBoundary } : reminder ? { limitMicros: reminder.amountMicros, dayBoundary: reminder.dayBoundary } : null;
    if (!runner || !line || !word(runner.profile) || !word(runner.model) || runner.provider !== PROVIDER || !amount(line.limitMicros) || line.dayBoundary !== 'UTC') return null;
    return { name: PROFILE_NAMES[runner.profile] || runner.profile, profile: runner.profile, provider: runner.provider, model: runner.model, limitMicros: line.limitMicros, dayBoundary: line.dayBoundary };
  }
  // The shared reading of today's recorded runs (app/butler-usage.cjs summarizeUsage). A run is a recorded wake-up,
  // not a provider request. Sums that leave runs out are lower bounds and are shown as such; a reading that cannot
  // be read is no reading.
  function usageToday(value) {
    const today = value && value.today, cost = today && today.costMicros, tokens = today && today.tokens && today.tokens.totalTokens;
    // An overflowed sum has no lower bound and fails here too.
    if (!today || !cost || !tokens || typeof value.utcDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.utcDay) ||
        ![today.recordedRunCount, cost.knownLowerBound, cost.unknownRuns, tokens.knownLowerBound, tokens.unknownRuns].every(amount)) return null;
    // At least this many runs are incomplete: one may lack its cost and another its tokens.
    const unknown = Math.max(cost.unknownRuns, tokens.unknownRuns);
    if (unknown > today.recordedRunCount) return null;
    return { day: value.utcDay, runs: today.recordedRunCount, unknown, totalTokens: tokens.knownLowerBound, costMicros: cost.knownLowerBound };
  }
  function entryView(entry) {
    if (!entry || typeof entry !== 'object' || entry.version !== 1) return { visible: false };
    // The designation record could not be read: that is not "none designated", and nothing can be done from here.
    if (entry.unavailable === true) return { visible: true, state: 'unknown', revision: null, actions: [], choice: null, usage: null };
    if (!entry.role || !Number.isSafeInteger(entry.role.revision)) return { visible: false };
    const offered = Array.isArray(entry.actions) ? entry.actions.filter(action => ACTIONS.includes(action)) : [];
    const selected = entry.role.selected ? choice(entry.role.selected, entry.reminder) : null;
    const view = (state, possible, extra = {}) => ({ visible: true, state, revision: entry.role.revision, actions: possible.filter(action => action === 'review' || offered.includes(action)),
      choice: selected, usage: selected ? usageToday(entry.usage) : null, ...extra });
    if (!entry.role.selected) {
      // The person is asked only when the confirmation can be complete: which model, and whether it would start.
      const offer = choice(entry.offer), known = offer && typeof entry.startable === 'boolean';
      // `later`: the main process does not accept a designation now, so the person is told there is none to make.
      return view('empty', known ? ['designate'] : [], { offer: known ? offer : null, startable: known ? entry.startable : null, later: !offered.includes('designate') });
    }
    // A designation this version cannot describe is shown as unknown and can only be revoked.
    if (!selected) return view('unknown', ['revoke']);
    // The core says it cannot tell: that comes before anything this function could work out from the rest.
    if (entry.uncertain === true) return view('unknown', ['recheck', 'revoke']);
    const backend = entry.backend && typeof entry.backend === 'object' ? entry.backend : null;
    const blocked = backend && Array.isArray(backend.blocked) ? backend.blocked : [];
    const review = entry.reviewAvailable === true ? ['review'] : [];
    if (backend && backend.ready === true && entry.startable === true) {
      // Ready is the host's confirmation that it can start, not a model at work. Paused comes only from a refusal
      // the core recorded; the record period only from the core saying it has begun.
      if (word(entry.hold)) return view('held', [...review, 'revoke'], { holdReason: HOLD_REASONS.includes(entry.hold) ? entry.hold : 'other' });
      return view(entry.intake && entry.intake.recordPeriod === 'on' ? 'recording' : 'ready', [...review, 'revoke']);
    }
    // What the person cannot fix comes first; a missing key is then a second line, not the headline.
    if (entry.startable === false || blocked.some(reason => BUILD_REASONS.includes(reason))) return view('blocked-build', ['revoke'], { alsoMissingKey: blocked.includes('credential-missing') });
    if (backend && backend.state === 'blocked' && blocked.length === 1 && blocked[0] === 'credential-missing') return view('blocked-credential', ['recheck', 'revoke']);
    return view('unknown', ['recheck', 'revoke']);
  }
  return Object.freeze({ entryView, BUILD_REASONS, HOLD_REASONS, ACTIONS });
});
