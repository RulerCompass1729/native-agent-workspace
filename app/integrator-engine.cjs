'use strict';
// Hands delivered work to the integrator (B6, E2b): the steps between the handoff record and
// the app. It takes in the deliveries NAW recorded in spaces, and when the session the person
// designated as integrator can take a message, it opens one handoff and sends it.
//
// When the integrator has answered, it settles the handoff: what the answer says about a merge
// is checked with git first. Then it tells: each delivery's space gets a record of where the
// delivery stands, and the person gets one notice per reason.
//
// Everything it touches is passed in: the record, who is designated, a fresh look at the
// sessions, main's head, a git reader, the send, the writer of space records and the notice.
// It calls no model, runs no program, merges nothing and takes no lock.
// It is not connected to the app yet.
const { validReady, notSent, NATIVE_DRAFT_KEY } = require('./queue-dispatch.cjs');
const { roomIds } = require('./collaboration-spaces.cjs');

// How long an answer with merge lines waits for main's head to become readable before it is
// settled without it (its merges are then held for the person as "main could not be read").
const HEAD_WAIT_MS = 10 * 60 * 1000;
const FULL_ID = /^[0-9a-f]{40}$/u;

if (typeof NATIVE_DRAFT_KEY !== 'string') throw Error('The dispatcher no longer names the unsent-prompt refusal');
// Stands in for main's head while only asking whether a handoff would open; git is read only then.
const SOME_HEAD = '0'.repeat(40);
const none = why => ({ kind: 'none', why });

class IntegratorEngine {
  // - handoffs: the record (IntegrationHandoffs).
  // - designation(): { sessionId, nativeId } or null for nobody; it throws when it cannot be read.
  // - mainHead(): the full commit id main points at, or null when it cannot be read.
  // - send(session, text, handoffId): sends the handoff message and returns its delivery tag, as
  //   a string or as { tag, control }. An error marked notSent means nothing was sent; any other
  //   failure leaves it unknown.
  // - typing(sessionId): told when the send was refused because the person left a prompt unsent
  //   in that session, so the caller leaves the session alone for a while, as after typing.
  // - reader: the read-only git reader ({ commit, isAncestor, changes }) for checking merges.
  // - record(fact): writes one delivery's space record, at once or as a promise; it may be asked
  //   to write the same fact (same key and label) again after a crash and must then write nothing new.
  // - notify(info): tells the person about one reason ({ reason, count, roomId, itemId, sessionId? }).
  constructor(options) {
    this.handoffs = options.handoffs;
    this.designation = options.designation;
    this.mainHead = options.mainHead;
    this.send = options.send;
    this.typing = options.typing || (() => {});
    this.reader = options.reader || null;
    this.record = options.record || (() => {});
    this.notify = options.notify || (async () => {});
    this.now = options.now || Date.now;
    this.headWaitMs = options.headWaitMs ?? HEAD_WAIT_MS;
  }
  // The record cannot be read: nothing is taken in or handed out until the person has looked at it.
  unreadable() { return this.handoffs.failed === true; }

  // Whether a pass is worth making: something can be handed out, or a handoff is open.
  hasWork() {
    try { const summary = this.handoffs.summary(); return summary.deliverable > 0 || summary.handoff !== null; }
    catch { return false; }
  }

  // Take in the deliveries recorded in the given spaces. Each is a READY fact NAW wrote into its
  // space when a queue item was done. One that is older than this record was dealt with by hand
  // and is not handed out; one already known changes nothing and writes nothing.
  intake(rooms) {
    const report = { stored: [], superseded: [], skipped: 0, full: false };
    const since = this.handoffs.begin(this.now());
    for (const room of Array.isArray(rooms) ? rooms : []) {
      if (!room || typeof room.id !== 'string' || !Array.isArray(room.events)) continue;
      for (const event of room.events) {
        const monitor = event?.monitor;
        if (!monitor || monitor.kind !== 'ready') continue;
        // A fact is taken only from the space that recorded it, in the shape NAW itself writes.
        if (!validReady(monitor) || typeof monitor.itemId !== 'string' || monitor.key !== `ready:${room.id}:${monitor.itemId}` || !Number.isFinite(event.time)) { report.skipped += 1; continue; }
        if (event.time < since || this.handoffs.knows(monitor.key)) continue;
        let result;
        try {
          result = this.handoffs.noteReady({ key: monitor.key, roomId: room.id, itemId: monitor.itemId, branch: monitor.branch, commit: monitor.commit,
            memberId: event.sessionId, memberName: event.uiMessage?.params?.name, spaceName: room.name, text: event.uiMessage?.params?.text }, event.time);
        } catch (error) {
          if (error?.message !== 'Invalid delivery') throw error;
          report.skipped += 1; continue;
        }
        if (result.stored) { report.stored.push(monitor.key); report.superseded.push(...result.superseded); }
        else if (result.why === 'backlog-full') report.full = true;
      }
    }
    return report;
  }

  // What the record's plan needs, from what the caller sees now.
  observe(view) {
    let integrator;
    try { integrator = this.designation(); } catch { integrator = undefined; }
    const usable = integrator && typeof integrator === 'object' && typeof integrator.sessionId === 'string';
    const session = usable ? (Array.isArray(view?.sessions) ? view.sessions : []).find(candidate => candidate?.id === integrator.sessionId) : undefined;
    let inSpace = false, membership = true;
    // Only the designated native session's membership matters; another one under that id is "gone" to the record.
    if (session && session.nativeId === integrator.nativeId) { try { inSpace = roomIds(session).length > 0; } catch { membership = false; } }
    return { membership, input: { integrator, session, inSpace, complete: view?.complete === true, wakePolicy: view?.wakePolicy, now: view?.now,
      idleSince: view?.idleSince, humanAt: view?.humanAt, settleMs: view?.settleMs, humanQuietMs: view?.humanQuietMs,
      busy: Boolean(session) && typeof view?.busy === 'function' && view.busy(session.id) === true, review: view?.review, checkpoint: view?.checkpoint } };
  }

  // Open one handoff and send it, if the integrator can take it now.
  // - `view` is what the caller sees at this moment: { sessions, complete, wakePolicy, now,
  //   idleSince, humanAt, settleMs?, humanQuietMs?, busy?(sessionId), review?, checkpoint? }.
  // - `look()` returns the same kind of view read afresh, right before anything is recorded,
  //   or null when the moment has passed.
  // Returns what happened: { kind: 'opened' | 'refused' | 'unconfirmed' | 'ask-integrator' | 'none', ... }.
  // The handoff is recorded as sent before the message goes out, and it goes out once: a send
  // whose outcome is unknown is never repeated, and a crash in between leaves an unconfirmed
  // handoff that is later settled as such.
  async handOut(view, look) {
    const handoffs = this.handoffs;
    if (handoffs.summary().handoff) return none('handoff-open');
    const first = this.observe(view);
    if (!first.membership) return none('membership-unknown');
    // Ask the record what it would do, without reading git or recording anything.
    const planned = handoffs.plan({ ...first.input, mainHead: SOME_HEAD });
    // Asking the person is recorded without any head: the stand-in never reaches the record.
    if (planned.kind === 'ask-integrator') return { ...handoffs.advance(first.input, this.now()), released: [] };
    // Go on only if a handoff would open, or if deliveries held for a missing integrator may come back.
    if (planned.kind !== 'open' && !this.releasable(first.input)) return { ...planned, released: [] };
    let fresh = null, mainHead = null;
    try { fresh = await look(); } catch { /* No fresh view: nothing is decided from the older one. */ }
    if (!fresh) return { ...none('not-ready-now'), released: [] };
    const second = this.observe(fresh);
    if (!second.membership) return { ...none('membership-unknown'), released: [] };
    // From here on everything is decided on the fresh view, the release first.
    const released = this.releasable(second.input) ? handoffs.reasonCleared('integrator-designated').released : [];
    const again = handoffs.plan({ ...second.input, mainHead: SOME_HEAD });
    if (again.kind === 'ask-integrator') return { ...handoffs.advance(second.input, this.now()), released };
    if (again.kind !== 'open') return { ...again, released };
    try { mainHead = await this.mainHead(); } catch { /* An unknown head opens nothing. */ }
    // The decision and its record are one step, made on the fresh view and the head just read.
    const action = handoffs.advance({ ...second.input, mainHead }, this.now());
    if (action.kind !== 'open') return { ...action, released };
    const opened = { handoffId: action.handoffId, keys: action.keys, sessionId: action.integrator.sessionId, released };
    try {
      const session = second.input.session;
      const delivery = await this.send(session, action.text, action.handoffId);
      // The control revision the person's later take-over is measured against is the one of the
      // session the message went to, unless the send reports a newer one.
      const control = Number.isSafeInteger(delivery?.control) ? delivery.control : Number.isSafeInteger(session.controlRevision) ? session.controlRevision : 0;
      handoffs.confirmSent(action.handoffId, { tag: typeof delivery === 'string' ? delivery : delivery?.tag, control }, this.now());
      return { kind: 'opened', ...opened };
    } catch (error) {
      // Sent or not is unknown (a timeout, a lost reply, a tag that could not be recorded): it is
      // not sent again, and the handoff is later settled as unconfirmed.
      if (!notSent(error)) return { kind: 'unconfirmed', ...opened };
      // Nothing was sent. A prompt the person left unsent there is the person at work in that
      // session: it does not use up the attempts, and the caller treats it as typing.
      const typing = error?.uiMessage?.key === NATIVE_DRAFT_KEY;
      const refused = handoffs.sendRefused(action.handoffId, this.now(), { counts: !typing });
      if (typing) { try { this.typing(action.integrator.sessionId); } catch { /* The refusal is recorded either way. */ } }
      return { kind: 'refused', ...opened, held: refused.held, typing };
    }
  }

  // What the record's plan needs to settle the open handoff, from what the caller sees.
  settleInput(view, handoff) {
    let integrator;
    try { integrator = this.designation(); } catch { integrator = undefined; }
    const session = (Array.isArray(view?.sessions) ? view.sessions : []).find(candidate => candidate?.id === handoff.integrator.sessionId);
    return { integrator, session, complete: view?.complete === true, now: view?.now, idleSince: view?.idleSince, settleMs: view?.settleMs, unconfirmedMs: view?.unconfirmedMs };
  }

  // Settle the open handoff if it can be settled now. An answer that reports merges is checked
  // with git first; because that takes a moment, the answer is read again on a fresh look and
  // settled only if it still says the same. Returns { kind: 'settled', status, facts, notify,
  // install, question, ignored } or { kind: 'none', why }.
  async settle(view, look) {
    const handoffs = this.handoffs;
    const open = handoffs.summary().handoff;
    if (!open) return none('no-handoff');
    const action = handoffs.plan(this.settleInput(view, open));
    if (action.kind !== 'settle') return action;
    let checked = {};
    const merges = Object.values(action.results?.results || {}).some(result => result.kind === 'merged' && result.malformed !== true);
    if (merges) {
      let mainHead = null;
      try { mainHead = await this.mainHead(); } catch { /* Unknown: handled just below. */ }
      if (typeof mainHead !== 'string' || !FULL_ID.test(mainHead)) {
        // Main's head cannot be read just now. The answer waits a bounded while, counted from the
        // first time this was seen for this handoff and kept in the record, so a restart does not
        // begin it again. After that it is settled without git: its merges are held for the
        // person as "main could not be read" instead of the one place staying taken in silence.
        const now = this.now();
        if (now - handoffs.headUnreadSince(open.id, now) < this.headWaitMs) return none('main-unknown');
        checked = { handoffId: open.id, mainUnreadable: true };
      } else checked = this.reader ? await handoffs.verify(this.reader, action, mainHead) : {};
      let fresh = null;
      try { fresh = await look(); } catch { /* No fresh view: nothing is settled from the older one. */ }
      if (!fresh) return none('not-ready-now');
      const again = handoffs.plan(this.settleInput(fresh, open));
      if (JSON.stringify(again) !== JSON.stringify(action)) return none('changed-while-checking');
    }
    const result = handoffs.settle(action, checked, this.now());
    return { kind: 'settled', handoffId: action.handoffId, ...result };
  }

  // Tell where things stand: a space record for every delivery whose space does not say it yet,
  // and one notice for every reason the person has not been told about.
  // - A space record is written, then marked written. A crash in between writes it again; the
  //   writer recognises the repeat by its key and label. A space always ends up saying where the
  //   delivery stands now; a state that was passed through between two tellings is not told.
  // - A notice is marked as started before it is shown and as done after. A crash in between
  //   leaves it started: it is not shown again and is reported as unknown.
  async tell() {
    const handoffs = this.handoffs, written = [];
    for (const fact of handoffs.showable()) {
      try { await this.record(fact); } catch { break; }
      written.push({ key: fact.key, label: fact.label });
    }
    if (written.length) handoffs.markShown(written);
    const told = [];
    for (const reason of handoffs.pendingNotices()) {
      const info = handoffs.noticeInfo(reason);
      if (!info || !handoffs.reserveNotice(reason).reserved) continue;
      try { await this.notify(info); } catch { continue; }
      if (handoffs.confirmNotice(reason).confirmed) told.push(reason);
    }
    return { shown: written.length, told, unknown: handoffs.unknownNotices() };
  }

  // One whole pass, in order: take in, settle what is open, hand out, tell. A record that
  // cannot be read stops the pass, and the caller is given what the pass did before that, to show
  // the person. Any other failure of the first three steps still lets the telling happen (a
  // notice must not wait for an unrelated fault), and is then thrown to the caller.
  async pass(rooms, view, look) {
    if (this.unreadable()) return { kind: 'unreadable' };
    const done = {};
    let failure = null;
    try {
      done.taken = this.intake(rooms);
      done.settled = await this.settle(view, look);
      done.handed = await this.handOut(view, look);
    } catch (error) {
      if (this.unreadable()) return { kind: 'unreadable', ...done };
      failure = error;
    }
    try { done.told = await this.tell(); }
    catch (error) {
      if (this.unreadable()) return { kind: 'unreadable', ...done };
      failure ||= error;
    }
    if (failure) throw Object.assign(failure, { done });
    return { kind: 'passed', ...done };
  }

  // A designated integrator whose session is here: what was held because that integrator, or an
  // earlier one, was gone may be handed again. This only says whether that is so in the given view.
  releasable(input) {
    const { integrator, session } = input;
    if (!integrator || !session || session.archived || session.nativeId !== integrator.nativeId) return false;
    return this.handoffs.reasonsHeld().some(reason => reason.startsWith('integrator-missing:'));
  }
}

module.exports = { IntegratorEngine, HEAD_WAIT_MS };
