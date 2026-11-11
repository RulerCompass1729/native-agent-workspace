'use strict';
// Dormant, event-only record-mode coordinator. Trusted host adapters are local
// dependencies; there is no native, queue/lifecycle or model API implementation.
const { createHash, randomUUID } = require('node:crypto');
const { buildInput, interpretResult, validateEvent } = require('./butler-policy.cjs');
const { summarizeUsage } = require('./butler-usage.cjs');
const identityKey = s => JSON.stringify([s?.selectionRevision, s?.identity?.sessionId, s?.identity?.nativeId, s?.runnerRef || s?.runner?.runnerRef]);
const selectionFor = s => ({ selectionRevision: s.selectionRevision, identity: s.identity, runnerRef: s.runner.runnerRef });
const sameRole = (saved, current) => saved?.selectionRevision === current.selectionRevision && saved.runnerRef === current.runner.runnerRef;
const day = time => new Date(time).toISOString().slice(0, 10);
const stableId = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cost = value => Number.isSafeInteger(value) && value >= 0;
const wakes = e => ['request', 'queue-empty', 'ready', 'recovery'].includes(e.kind);

class ButlerController {
  constructor({ role, ledger, backend, view, run, publish = null, ask = null, onBlocked = null, estimateBatchCost = () => null,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout, readyDelayMs = 30000 }) {
    if (!role || !ledger || !backend || typeof view !== 'function' || typeof run !== 'function' || readyDelayMs < 0) throw Error('Invalid butler controller');
    Object.assign(this, { role, ledger, backend, view, run, publish, ask, onBlocked, estimateBatchCost, now, schedule, cancel, readyDelayMs });
    this.timer = null; this.running = null; this.closed = false; this.lastOutcome = null; this.recovered = false; this.recovering = null;
    // Recovery is mandatory even if the host calls receive() before resume().
    // A saved running turn or reserved delivery is uncertain, never replayable.
    const previous = ledger.snapshot();
    if (previous.activeBatch?.status === 'running') {
      ledger.beginAttempt(previous.activeBatch.batchId, previous.activeBatch.selection);
      ledger.failBatch(previous.activeBatch.batchId, 'restart-unconfirmed');
    }
    for (const delivery of previous.deliveries) if (delivery.status === 'reserved') ledger.ackDelivery(delivery.deliveryId, 'unknown');
  }
  async recoverPublications() {
    if (this.closed || this.recovered) return { status: 'ready' };
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      try {
        await this.flushQuestions(); await this.flushReports(); this.recovered = true;
        return { status: 'ready' };
      } catch (error) {
        const reason = error.code === 'ERR_BUTLER_CONTEXT' ? 'context-unavailable' : 'publication-recovery-unavailable';
        const outcome = { status: 'blocked', reason, batchId: null };
        try { this.notice(reason, null); }
        catch { this.notifyBlocked({ eventId: null, reason: 'state-unavailable' }); }
        this.lastOutcome = outcome; return outcome;
      }
    })().finally(() => { this.recovering = null; });
    return this.recovering;
  }
  async receive(event) {
    if (this.closed) throw Error('Butler controller closed');
    validateEvent(event); // Nothing secret-shaped/unsupported is journaled first.
    const duplicate = this.ledger.snapshot().events.some(e => e.eventId === event.eventId);
    this.ledger.ingest(event);
    // Rule-only B1 events remain consumed even when publication recovery cannot
    // read the host's current session view. The source event is already durable.
    if (!duplicate && !wakes(event)) this.ledger.consumeRecorded([event.eventId]);
    const recovery = await this.recoverPublications();
    if (duplicate) return { status: 'duplicate' };
    return this.dispatchPersisted(event, recovery, event.kind === 'recovery');
  }
  // Intake commits the source before notifying this dormant coordinator. Read
  // only that committed identity; a signal cannot admit text or authorize retry.
  async notifyPersisted(eventId) {
    if (this.closed) throw Error('Butler controller closed');
    const snapshot = this.ledger.snapshot();
    const event = typeof eventId === 'string' && snapshot.events.find(e => e.eventId === eventId);
    if (!event) throw Error('Butler persisted event unavailable');
    if (!snapshot.pendingEvents.some(e => e.eventId === eventId)) return { status: 'duplicate' };
    if (!wakes(event)) {
      const owner = snapshot.activeBatch;
      // The batch owns its complete input prefix, including rule-only facts.
      // A late intake signal must not consume one of those inputs separately.
      if (owner?.eventIds.includes(eventId)) return { status: owner.status === 'failed' ? 'awaiting-retry' : 'batched', batchId: owner.batchId };
      this.ledger.consumeRecorded([eventId]);
    }
    const recovery = await this.recoverPublications();
    if (wakes(event)) {
      // Another notification may finish or fail the batch while publication
      // recovery awaits. Only current pending work may arm another deadline.
      const current = this.ledger.snapshot();
      if (!current.pendingEvents.some(e => e.eventId === eventId)) return { status: 'duplicate' };
      if (current.activeBatch?.status === 'failed') return { status: 'awaiting-retry', batchId: current.activeBatch.batchId };
    }
    return this.dispatchPersisted(event, recovery, false);
  }
  dispatchPersisted(event, recovery, retry) {
    if (event.kind === 'ready') {
      if (!this.running) this.armReady();
      return recovery.status === 'blocked' ? recovery : { status: 'batched' };
    }
    if (recovery.status === 'blocked') return recovery;
    if (!wakes(event)) return { status: 'recorded' };
    return this.drain({ retry });
  }
  armReady() {
    if (this.closed || this.timer !== null) return;
    const first = this.ledger.pendingEvents().find(e => e.kind === 'ready');
    if (first) this.timer = this.schedule(() => {
      this.timer = null;
      this.drain().catch(() => {
        try { this.notice('state-unavailable', null); }
        catch { this.notifyBlocked({ eventId: null, reason: 'state-unavailable' }); }
      });
    }, Math.max(0, first.time + this.readyDelayMs - this.now()));
  }
  async resume() {
    if (this.closed) return { status: 'closed' };
    const snapshot = this.ledger.snapshot(), activeIds = new Set(snapshot.activeBatch?.eventIds || []);
    const recorded = snapshot.pendingEvents.filter(e => !wakes(e) && !activeIds.has(e.eventId)).map(e => e.eventId);
    for (let i = 0; i < recorded.length; i += 100) this.ledger.consumeRecorded(recorded.slice(i, i + 100));
    const recovery = await this.recoverPublications();
    if (recovery.status === 'blocked') return recovery;
    if (snapshot.activeBatch) {
      if (snapshot.activeBatch.status === 'running') this.ledger.failBatch(snapshot.activeBatch.batchId, 'restart-unconfirmed');
      return { status: 'awaiting-retry', batchId: snapshot.activeBatch.batchId };
    }
    const pending = this.ledger.pendingEvents();
    if (pending.some(e => ['request', 'queue-empty', 'recovery'].includes(e.kind))) return this.drain();
    this.armReady(); return { status: pending.some(e => e.kind === 'ready') ? 'batched' : 'empty' };
  }
  authenticatedSelection() {
    try {
      const current = this.role.current(); if (!current) return null;
      const state = this.hostView(), record = state.records.find(s => s.id === current.identity.sessionId);
      return this.role.authorize(record, { selectionRevision: current.selectionRevision, runnerRef: current.runner.runnerRef }, state.records);
    } catch {
      const error = Error('Butler host context unavailable'); error.code = 'ERR_BUTLER_CONTEXT'; throw error;
    }
  }
  hostView() {
    try {
      const state = this.view();
      if (!state || !Array.isArray(state.records) || !Array.isArray(state.spaces)) throw Error('Invalid view');
      return state;
    } catch {
      const error = Error('Butler host context unavailable'); error.code = 'ERR_BUTLER_CONTEXT'; throw error;
    }
  }
  notifyBlocked(notice) {
    try { this.onBlocked?.(notice)?.catch?.(() => {}); }
    catch { /* The durable notice is authoritative; host display cannot undo it. */ }
  }
  notice(reason, selection, batchId = null, questionId = null) {
    const snapshot = this.ledger.snapshot();
    const unsettled = reason === 'usage-cost-unknown' ? snapshot.attempts.find(a => !cost(a.usage?.costMicros)) : null;
    const scope = questionId ? ['question', questionId] : reason === 'daily-budget-reached' ? null : unsettled ? [unsettled.batchId, unsettled.attempt] : batchId;
    const eventId = `butler-block:${stableId([reason, selection?.selectionRevision, reason === 'daily-budget-reached' ? day(this.now()) : null, scope])}`;
    const existed = snapshot.events.some(e => e.eventId === eventId);
    this.ledger.ingest({ eventId, kind: 'blocked', sourceRef: eventId, payload: { reason, ...(questionId ? { itemId: questionId } : {}) } });
    this.ledger.consumeRecorded([eventId]);
    if (!existed) this.notifyBlocked({ eventId, reason, ...(questionId ? { questionId } : {}) });
  }
  blocked(reason, selection, batch) {
    if (batch) this.ledger.failBatch(batch.batchId, reason);
    this.notice(reason, selection, batch?.batchId);
    return { status: 'blocked', reason, batchId: batch?.batchId || null };
  }
  budgetReady(selection, events) {
    if (!selection.budget || selection.budget.currency !== 'USD' || selection.budget.dayBoundary !== 'UTC') return 'budget-unset';
    const usage = summarizeUsage(this.ledger.snapshot(), { now: this.now() });
    if (usage.guard.reason) return usage.guard.reason;
    const spent = usage.today.costMicros.value;
    if (spent >= selection.budget.limitMicros) return 'daily-budget-reached';
    const estimated = this.estimateBatchCost(events);
    if (!cost(estimated)) return 'next-batch-cost-unknown';
    return spent + estimated > selection.budget.limitMicros ? 'daily-budget-reached' : null;
  }
  announceCost(selection, batchId) {
    const reason = this.budgetReady(selection, []);
    if (['daily-budget-reached', 'usage-cost-unknown', 'usage-cost-invalid'].includes(reason)) this.notice(reason, selection, batchId);
  }
  drain({ retry = false } = {}) {
    if (this.closed) return Promise.resolve({ status: 'closed' });
    if (this.running) return this.running;
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
    this.running = (async () => {
      const recovery = await this.recoverPublications();
      if (recovery.status === 'blocked') return recovery;
      let outcome;
      do { outcome = await this.process(retry); retry = false; }
      while (!this.closed && outcome.status === 'recorded' && this.ledger.pendingEvents().some(wakes));
      return outcome;
    })().finally(() => { this.running = null; });
    return this.running;
  }
  async process(retry) {
    let selection, batch, completed = false;
    try {
      selection = this.authenticatedSelection();
      if (!selection) return { status: 'unselected' };
      const snapshot = this.ledger.snapshot(), saved = snapshot.activeBatch, expected = selectionFor(selection);
      if (saved?.status === 'running') return this.blocked('restart-unconfirmed', selection, saved);
      if (saved?.status === 'failed' && !retry) return { status: 'awaiting-retry', batchId: saved.batchId };
      let chosen = saved ? snapshot.events.filter(e => saved.eventIds.includes(e.eventId)) : snapshot.pendingEvents.slice(0, 100);
      if (!chosen.length) return { status: 'empty' };
      // Context capacity is checked before creating an active batch. A temporary
      // catalog problem must not permanently poison the pending event prefix.
      let preview;
      try {
        const catalog = this.hostView().spaces;
        const make = events => buildInput({ batchId: 'preflight', events, catalog, questions: snapshot.questions });
        try { preview = make(chosen); }
        catch (error) {
          if (saved || error.code !== 'ERR_BUTLER_INPUT_CAPACITY') throw error;
          // Maximal fitting prefix. Keep every event whole and leave the rest pending.
          let low = 1, high = chosen.length - 1;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            try { preview = make(chosen.slice(0, middle)); low = middle + 1; }
            catch (candidateError) {
              if (candidateError.code !== 'ERR_BUTLER_INPUT_CAPACITY') throw candidateError;
              high = middle - 1;
            }
          }
          if (!preview) throw error;
          chosen = chosen.slice(0, preview.events.length);
        }
      }
      catch { return this.blocked('context-unavailable', selection); }
      if (saved) {
        if (identityKey(saved.selection) !== identityKey(expected)) this.ledger.rebindBatch(saved.batchId, saved.selection, expected);
        batch = this.ledger.retryBatch(saved.batchId, expected);
      } else batch = this.ledger.beginBatch(expected, chosen.length);
      const budget = this.budgetReady(selection, chosen);
      if (budget) return this.blocked(budget, selection, batch);
      const backend = await this.backend.ensure();
      if (backend.ready !== true) return this.blocked('native-boundary-unqualified', selection, batch);
      if (Object.keys(selection.runner).some(k => backend.binding[k] !== selection.runner[k])) return this.blocked('runner-binding-changed', selection, batch);
      if (identityKey(selection) !== identityKey(this.authenticatedSelection())) return this.blocked('selection-changed', selection, batch);
      const input = { ...preview, batchId: batch.batchId, attempt: batch.attempt };
      // This durable unknown-cost marker precedes the call, including a call
      // that throws before a response. A model never supplies this envelope.
      this.ledger.beginAttempt(batch.batchId, expected);
      const response = await this.run(input, expected);
      const proven = response && response.batchId === batch.batchId && response.attempt === batch.attempt && identityKey(response.selection) === identityKey(expected);
      // A trusted late envelope may account for its own historical attempt,
      // but can neither complete nor overwrite the current attempt's work.
      const metered = response && this.ledger.snapshot().attempts.find(a => a.batchId === response.batchId && a.attempt === response.attempt && identityKey(a.selection) === identityKey(response.selection));
      if (metered && response.usage != null) this.ledger.recordAttemptUsage(metered.batchId, metered.selection, response.usage, metered.attempt);
      this.announceCost(selection, batch.batchId);
      const active = this.ledger.snapshot().activeBatch;
      if (!proven || !active || active.attempt !== batch.attempt || identityKey(selection) !== identityKey(this.authenticatedSelection())) return this.blocked('stale-native-reply', selection, active?.attempt === batch.attempt ? batch : null);
      if (response.failureCode) return this.blocked('batch-failed', selection, batch);
      const result = interpretResult(response.reply, { events: chosen, catalog: this.hostView().spaces, questions: this.ledger.snapshot().questions });
      if (response.usage !== undefined) result.usage = response.usage;
      this.ledger.completeBatch(batch.batchId, expected, result); completed = true;
      if (!this.closed) { await this.flushQuestions(selection); await this.flushReports(selection); }
      this.lastOutcome = { status: 'recorded', batchId: batch.batchId }; return this.lastOutcome;
    } catch (error) {
      if (completed) {
        this.recovered = false;
        try { this.notice('publication-recovery-unavailable', selection, batch.batchId); }
        catch { this.notifyBlocked({ eventId: null, reason: 'state-unavailable' }); }
        return { status: 'report-pending', batchId: batch.batchId };
      }
      try {
        if (selection && batch) this.announceCost(selection, batch.batchId);
        return this.blocked(error.code === 'ERR_BUTLER_CONTEXT' ? 'context-unavailable' : error.code === 'ERR_BUTLER_RESULT' ? 'invalid-model-result' : 'batch-failed', selection, batch);
      } catch {
        this.lastOutcome = { status: 'blocked', reason: 'state-unavailable' };
        this.notifyBlocked({ eventId: null, reason: 'state-unavailable' }); return this.lastOutcome;
      }
    }
  }
  observeQuestion(input) {
    const reserved = this.ledger.reserveQuestion(input);
    if (reserved.shouldNotify) this.ledger.ackDelivery(reserved.deliveryId, 'unknown');
    return reserved.question;
  }
  questionMetricGap(reason, selection, questionId) {
    // Epoch ownership belongs to the host shared by B1 and this publisher. A
    // failed append cannot authorize a send or turn unknown coverage into zero.
    try { this.ledger.markQuestionMetricGap(reason); } catch { /* The writer retains its failed/open-epoch state. */ }
    try { this.notice('question-metric-unavailable', selection, null, questionId); }
    catch { this.notifyBlocked({ eventId: null, reason: 'question-metric-unavailable', questionId }); }
  }
  async flushQuestions(selection) {
    if (!this.ask || this.closed) return;
    selection ||= this.authenticatedSelection(); if (!selection) return;
    const snapshot = this.ledger.snapshot();
    for (const question of snapshot.questions.filter(q => q.status === 'open')) {
      if (snapshot.deliveries.some(d => d.kind === 'question' && d.targetId === question.questionId)) continue;
      if (this.closed || identityKey(selection) !== identityKey(this.authenticatedSelection())) return;
      const authorized = snapshot.batches.some(b => b.status === 'completed' && sameRole(b.selection, selection) && b.actions.some(a => a.questionId === question.questionId));
      if (!authorized) continue;
      let reserved;
      try { reserved = this.ledger.reserveStoredQuestion(question.questionId); }
      catch (error) {
        if (!['BUTLER_QUESTION_STATE', 'BUTLER_QUESTION_SOURCE', 'BUTLER_QUESTION_EVIDENCE', 'BUTLER_UNKNOWN_EVIDENCE'].includes(error.code)) throw error;
        this.notice('question-delivery-unavailable', selection, null, question.questionId);
        continue;
      }
      if (!reserved.shouldNotify) continue;
      const attemptId = randomUUID();
      try {
        this.ledger.beginQuestionSend({ attemptId, questionId: question.questionId, deliveryId: reserved.deliveryId,
          sourceEventId: question.evidenceRevision, channel: 'butler-ask' });
      } catch (error) {
        this.questionMetricGap(error.code === 'BUTLER_QUESTION_METRIC_EPOCH' ? 'epoch-unavailable' : 'write-failed', selection, question.questionId);
        this.ledger.ackDelivery(reserved.deliveryId, 'unknown');
        continue;
      }
      let observed = false;
      // This callback is passed only to the trusted host publisher, never to a
      // model. A transport receipt is not evidence that the person saw it.
      const observe = actual => {
        if (!['shown', 'failed', 'unknown'].includes(actual)) {
          this.questionMetricGap('unexpected-display', selection, question.questionId); return false;
        }
        observed = true;
        try { this.ledger.ackQuestionSend(attemptId, actual); return true; }
        catch (error) {
          this.questionMetricGap(error.code === 'BUTLER_QUESTION_METRIC_EPOCH' ? 'epoch-unavailable' : 'write-failed', selection, question.questionId);
          return false;
        }
      };
      let status = 'unknown';
      try {
        const receipt = await this.ask({ ...question, deliveryId: reserved.deliveryId }, observe);
        if (receipt?.deliveryId === reserved.deliveryId && receipt.status === 'sent') status = 'sent';
      } catch { /* Unknown delivery is durable, not retried. */ }
      if (!observed) observe('unknown');
      this.ledger.ackDelivery(reserved.deliveryId, status);
    }
  }
  async flushReports(selection) {
    if (!this.publish || this.closed) return;
    selection ||= this.authenticatedSelection(); if (!selection) return;
    const snapshot = this.ledger.snapshot();
    for (const report of this.ledger.pendingReports()) {
      if (this.closed || identityKey(selection) !== identityKey(this.authenticatedSelection())) return;
      const origin = snapshot.batches.find(b => b.batchId === report.batchId);
      if (!origin || !sameRole(origin.selection, selection)) continue;
      const reserved = this.ledger.reserveReport(report.reportId); if (!reserved.shouldNotify) continue;
      let status = 'unknown';
      try {
        const receipt = await this.publish({ ...report, deliveryId: reserved.deliveryId });
        if (receipt?.deliveryId === reserved.deliveryId && receipt.status === 'sent') status = 'sent';
      } catch { /* Unknown delivery remains durable; no automatic resend. */ }
      this.ledger.ackDelivery(reserved.deliveryId, status);
    }
  }
  close() {
    this.closed = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null; return this.running || this.recovering || Promise.resolve();
  }
}
module.exports = { ButlerController };
