'use strict';
// What a person window is given of the butler. The core's person view (app/butler-person.cjs) is turned into the
// entry the window draws (app/butler-entry-view.js documents that shape), and the result of a person's action is
// cut down to what the window needs. Both are pure: nothing is read, started or checked here.
//
// Only named fields are copied, so the session identity, the runner and backend references, batch ids and stop
// targets stay in the main process even if the core's view grows.
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const amount = value => Number.isSafeInteger(value) && value >= 0;
const word = value => typeof value === 'string' && value.length > 0 && value.length <= 120;
// The person-only actions the window may offer, by the names the main process's `butler` call accepts. The core's
// `open` and `close` are capabilities of the core, not names of that call (it has `setActive`), and the entry has no
// control for them: they are not passed on.
const ENTRY_ACTIONS = Object.freeze(['designate', 'revoke', 'recheck']);
// Whether this version can start a butler at all. The desktop gives the host no pre-start qualification and the
// core's activation is off, so it cannot. This is a statement about the build, never read from "backend ready".
const STARTABLE = false;
const UNAVAILABLE = () => ({ version: 1, unavailable: true, actions: [] });

function reading(value) {
  return plain(value) && amount(value.knownLowerBound) && amount(value.unknownRuns) ? { knownLowerBound: value.knownLowerBound, unknownRuns: value.unknownRuns } : null;
}
// Today's recorded wake-ups. Only a reading the core calls recorded is passed on: "unverified" and "unavailable"
// are no reading, and are never turned into a zero.
function usage(value) {
  if (!plain(value) || value.state !== 'recorded' || !word(value.utcDay) || !plain(value.today) || !amount(value.today.recordedRunCount)) return null;
  const cost = reading(value.today.costMicros), tokens = plain(value.today.tokens) ? reading(value.today.tokens.totalTokens) : null;
  if (!cost || !tokens) return null;
  return { utcDay: value.utcDay, today: { recordedRunCount: value.today.recordedRunCount, costMicros: cost, tokens: { totalTokens: tokens } } };
}
function entry(view, { reviewAvailable = false } = {}) {
  // No readable designation record is not "none designated".
  if (!plain(view) || !plain(view.role) || view.role.available !== true || !amount(view.role.revision)) return UNAVAILABLE();
  const chosen = view.role.selected;
  if (chosen !== null && !plain(chosen)) return UNAVAILABLE();
  const configuration = chosen && plain(chosen.configuration) ? chosen.configuration : {}, budget = chosen ? chosen.budget ?? null : null;
  const host = plain(view.backend) && view.backend.available === true ? view.backend : null;
  const reminder = plain(view.dailyReminder) && view.dailyReminder.currency === 'USD' && amount(view.dailyReminder.amountMicros) && view.dailyReminder.dayBoundary === 'UTC'
    ? { amountMicros: view.dailyReminder.amountMicros, dayBoundary: 'UTC' } : null;
  return { version: 1,
    role: { revision: view.role.revision, selected: chosen ? {
      runner: { profile: word(configuration.profile) ? configuration.profile : null, provider: word(configuration.provider) ? configuration.provider : null, model: word(configuration.model) ? configuration.model : null },
      // The designation's own daily limit, as recorded; none stays none. One that is recorded but cannot be read is
      // passed on as unreadable, so the window does not put the reminder line in its place.
      budget: budget === null ? null : plain(budget) && amount(budget.limitMicros) && word(budget.dayBoundary) ? { limitMicros: budget.limitMicros, dayBoundary: budget.dayBoundary }
        : { limitMicros: null, dayBoundary: null } } : null },
    // The daily reminder line the person agreed to. It is not the designation's limit.
    reminder,
    // The core could not establish the designated butler's state from its own records.
    uncertain: Boolean(chosen) && view.state !== 'selected-disabled',
    startable: STARTABLE,
    backend: host ? { state: word(host.state) ? host.state : 'unknown', ready: host.ready === true, blocked: Array.isArray(host.blocked) ? host.blocked.filter(word) : [] } : null,
    intake: { recordPeriod: view.recordPeriod === 'on' ? 'on' : 'off' },
    // Only a refusal the core recorded and still traces to this designation.
    hold: plain(view.pause) && word(view.pause.reason) ? view.pause.reason : null,
    usage: chosen ? usage(view.usage) : null,
    reviewAvailable: Boolean(chosen) && reviewAvailable === true,
    actions: plain(view.actions) ? ENTRY_ACTIONS.filter(name => view.actions[name] === true) : [] };
}
// The result of designate, revoke or setActive: its plain facts, without the target it acted on.
// Each fact has its own kind: a short word, a yes or no, a count, or a yes, no or "not known" (null).
const known = value => value === null || typeof value === 'boolean';
const OUTCOME = Object.freeze({ activation: word, recordPeriod: word, status: word, reason: word, revoked: value => typeof value === 'boolean', revision: amount,
  stopped: known, cleanupConfirmed: known });
function outcome(value, nested = true) {
  if (!plain(value)) return null;
  const result = {};
  for (const [key, fits] of Object.entries(OUTCOME)) if (Object.hasOwn(value, key) && fits(value[key])) result[key] = value[key];
  if (nested && Object.hasOwn(value, 'shutdown')) result.shutdown = outcome(value.shutdown, false);
  return result;
}
module.exports = Object.freeze({ entry, outcome, ENTRY_ACTIONS, STARTABLE });
