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
// Reasons a handoff did not open that only the person can change: they were asked about the
// integrator, automatic messages are off, that session is paused for them, its backend needs an update.
const PERSON_ONLY = ['integrator-asked', 'automatic-messages-off', 'paused', 'backend-update-needed'];
const who = designated => (designated && typeof designated === 'object' ? `${designated.sessionId}\n${designated.nativeId}` : '');
// A cheap sign of where a space's record ends: it changes whenever an event is added.
const mark = room => `${room.events.length}:${room.events.at(-1)?.id ?? ''}`;
// Whether the caller's list of sessions is complete, so that a session missing from it is gone.
// The caller says so outright, or answers for the one session that is looked for.
const complete = (view, sessionId) => (typeof view?.complete === 'function' ? view.complete(sessionId) === true : view?.complete === true);

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
  // - repository(): whether there is a main repository that can be read now: true, or null for
  //   none (none chosen, or the chosen one fails its checks). Absent, main is read as given.
  // - open(): one checked look at that repository for a whole settlement: { mainHead(), reader },
  //   or null when it cannot be read now. Every git question of the settlement then goes to the
  //   same folder, checked once. Absent, mainHead and reader above are used.
  // - record(fact): writes one delivery's space record, at once or as a promise; it may be asked
  //   to write the same fact (same key and label) again after a crash and must then write nothing new.
  // - notify(info): tells the person about one reason ({ reason, count, roomId, itemId, sessionId? }).
  // - holderRecord(fact): writes, into one space, that a member holding the open handoff gets no
  //   queue work for now ({ roomId, sessionId, name, handoffId, waiting }); returns { recorded }.
  //   Absent, nothing of the kind is written. nameOf(session) gives the name to write. With
  //   closed: true the same writer says that the handoff is over. holderLines() gives the spaces
  //   that were told about an open handoff and not yet about its end, as their records say it.
  constructor(options) {
    this.handoffs = options.handoffs;
    this.designation = options.designation;
    this.mainHead = options.mainHead;
    this.send = options.send;
    this.typing = options.typing || (() => {});
    this.reader = options.reader || null;
    this.repository = options.repository || null;
    this.open = options.open || null;
    this.record = options.record || (() => {});
    this.notify = options.notify || (async () => {});
    this.holderRecord = options.holderRecord || null;
    this.nameOf = options.nameOf || (session => session?.name);
    this.holderLines = options.holderLines || null;
    // Which spaces were told about which holder: one entry per space, handoff and member
    // ({ roomId, sessionId, handoffId, name }). Kept while the app runs, and read from the
    // spaces' records after a start (again on the next pass if they cannot be read then).
    this.holderTold = null;
    this.now = options.now || Date.now;
    this.headWaitMs = options.headWaitMs ?? HEAD_WAIT_MS;
    // How far each space's record was looked through by the last intake (kept while the app runs).
    this.looked = new Map();
    // Where a space's record stood when one of its deliveries was left out of a full backlog.
    this.leftOut = new Map();
    // Why the last attempt to hand out stopped, when only the person can change that; null otherwise.
    this.blocked = null;
  }
  // The record cannot be read: nothing is taken in or handed out until the person has looked at it.
  unreadable() { return this.handoffs.failed === true; }

  // Whether a pass is worth making, that is, whether something can move without the person:
  // a space whose record changed since the last intake (it may hold a new delivery); a handoff
  // that was sent and awaits its answer; a delivery to hand out when somebody is designated; or
  // a space record or notice that is still owed. What waits for the person (nobody designated,
  // a waiting handoff) needs no passes: the person's step starts them again.
  hasWork(rooms) {
    try {
      // A record that cannot be read moves nothing until the person has looked at it.
      if (this.unreadable()) return false;
      if (Array.isArray(rooms) && rooms.some(room => room && typeof room.id === 'string' && Array.isArray(room.events) && this.unlooked(room))) return true;
      const summary = this.handoffs.summary();
      if (summary.handoff?.status === 'sent') return true;
      // Deliveries to hand out, or held because an integrator was gone, can move when somebody is
      // designated, unless the last attempt ended on something only the person can change.
      const waiting = summary.deliverable > 0 || this.handoffs.reasonsHeld().some(reason => reason.startsWith('integrator-missing:'));
      if (!summary.handoff && waiting) {
        const designated = this.designation();
        // A block is over as soon as the person designates somebody else (or somebody at all).
        if (designated && !(this.blocked && this.blocked.designated === who(designated))) return true;
      }
      return this.handoffs.pendingNotices().length > 0 || this.handoffs.showable().length > 0;
    } catch { return false; }
  }

  // The session an open handoff was sent to, as a list of at most one id. Until that handoff is
  // closed (settled, or dealt with by the person) the queue sends it nothing and does not rotate
  // it. A record that cannot be read names nobody.
  holding() {
    try { const open = this.handoffs.summary().handoff; return open ? [open.integrator.sessionId] : []; } catch { return []; }
  }
  // The same, with what a space is told about it: which handoff, and whether it waits for the person.
  holder() {
    try { const open = this.handoffs.summary().handoff; return open ? { sessionId: open.integrator.sessionId, handoffId: open.id, waiting: open.status === 'waiting' } : null; } catch { return null; }
  }

  // Whether a space's record is worth looking through: it changed since the last intake. One with
  // a delivery that was left out of a full backlog is worth it only when its record has changed
  // since then or the backlog has room again; the same look would otherwise repeat without end.
  unlooked(room) {
    const now = mark(room);
    if (this.looked.get(room.id) === now) return false;
    return this.leftOut.get(room.id) !== now || !this.handoffs.full();
  }

  // Take in the deliveries recorded in the given spaces. Each is a READY fact NAW wrote into its
  // space when a queue item was done. One that is older than this record was dealt with by hand
  // and is not handed out; one already known changes nothing and writes nothing.
  intake(rooms) {
    const report = { stored: [], superseded: [], skipped: 0, full: false };
    const since = this.handoffs.begin(this.now());
    for (const room of Array.isArray(rooms) ? rooms : []) {
      if (!room || typeof room.id !== 'string' || !Array.isArray(room.events)) continue;
      let left = false;
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
        else if (result.why === 'backlog-full') { report.full = true; left = true; }
      }
      // This space's record has been looked through up to here, unless one of its own deliveries
      // was left out because the backlog was full: that one is looked for again (see unlooked()).
      if (left) this.leftOut.set(room.id, mark(room));
      else { this.looked.set(room.id, mark(room)); this.leftOut.delete(room.id); }
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
    return { membership, input: { integrator, session, inSpace, complete: complete(view, usable ? integrator.sessionId : undefined), wakePolicy: view?.wakePolicy, now: view?.now,
      idleSince: view?.idleSince, humanAt: view?.humanAt, settleMs: view?.settleMs, humanQuietMs: view?.humanQuietMs,
      busy: Boolean(session) && typeof view?.busy === 'function' && view.busy(session.id) === true, review: view?.review, checkpoint: view?.checkpoint,
      // Asked only when the caller has such a thing; a failure to say counts as "none that can be read".
      ...(this.repository ? { repository: this.readable() } : {}) } };
  }

  // The person changed something only they can change (they chose a main repository): the next
  // look tries again at once instead of waiting for a pass that runs for another reason.
  unblock() { this.blocked = null; }

  // Whether the person's main repository can be read now: true, or null.
  readable() { try { return this.repository() === true ? true : null; } catch { return null; } }

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
    const result = await this.attempt(view, look);
    // Remembered for hasWork(): what only the person can change does not keep passes going. Any
    // pass that runs for another reason (a window's own check, queue work) tries again and clears it.
    const personOnly = result.kind === 'ask-integrator' || result.kind === 'none' && PERSON_ONLY.includes(result.why);
    let designated = null;
    if (personOnly) { try { designated = this.designation(); } catch { /* Unknown: any later designation ends the block. */ } }
    this.blocked = personOnly ? { why: result.why || result.reason, designated: who(designated) } : null;
    return result;
  }
  async attempt(view, look) {
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
    return { integrator, session, complete: complete(view, handoff.integrator.sessionId), now: view?.now, idleSince: view?.idleSince, settleMs: view?.settleMs, unconfirmedMs: view?.unconfirmedMs };
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
      // One look at the repository for the whole settlement. A repository that cannot be read
      // now gives no head, which is handled just below like any head that cannot be read; it is
      // never taken for a commit that does not exist.
      let mainHead = null, reader = this.reader;
      if (this.open) {
        let repository = null;
        try { repository = await this.open(); } catch { /* Cannot be read now. */ }
        reader = repository ? repository.reader : null;
        if (repository) { try { mainHead = await repository.mainHead(); } catch { /* Unknown: handled just below. */ } }
      } else { try { mainHead = await this.mainHead(); } catch { /* Unknown: handled just below. */ } }
      if (typeof mainHead !== 'string' || !FULL_ID.test(mainHead)) {
        // Main's head cannot be read just now. The answer waits a bounded while, counted from the
        // first time this was seen for this handoff and kept in the record, so a restart does not
        // begin it again. After that it is settled without git: its merges are held for the
        // person as "main could not be read" instead of the one place staying taken in silence.
        const now = this.now();
        if (now - handoffs.headUnreadSince(open.id, now) < this.headWaitMs) return none('main-unknown');
        checked = { handoffId: open.id, mainUnreadable: true };
      } else {
        checked = reader ? await handoffs.verify(reader, action, mainHead) : {};
        // Git read the head but did not answer a question about a merge (it failed, timed out, or the
        // repository went away meanwhile): the same trouble as a head that cannot be read. The answer waits
        // the same bounded while and is checked again; after that it is settled with those merges held as
        // "could not be checked", never as merges that were not found.
        if (Object.values(checked.verified || {}).some(verdict => verdict?.why === 'git-unanswered')) {
          const now = this.now();
          if (now - handoffs.headUnreadSince(open.id, now) < this.headWaitMs) return none('git-unanswered');
        }
      }
      let fresh = null;
      try { fresh = await look(); } catch { /* No fresh view: nothing is settled from the older one. */ }
      if (!fresh) return none('not-ready-now');
      const again = handoffs.plan(this.settleInput(fresh, open));
      if (JSON.stringify(again) !== JSON.stringify(action)) return none('changed-while-checking');
    }
    const result = handoffs.settle(action, checked, this.now());
    return { kind: 'settled', handoffId: action.handoffId, ...result };
  }

  // The person's "check again" on a delivery held because git could not be read: the claim kept with it
  // is asked of git once more, against the main commit of the handoff it was merged in (so that a merge
  // made then is still "new"), in one checked look at the repository. Returns { outcome: 'merged' |
  // 'unverified' | 'unanswered', notify, install }; with no answer, `head` says whether main's head at
  // least was read. The spaces and the person are told by the next pass.
  async recheck(key) {
    const handoffs = this.handoffs, began = this.now();
    const claim = handoffs.claimOf(key);
    // A claim whose tests did not all pass can never count: git is not asked.
    if (claim.tests.total < 1 || claim.tests.passed !== claim.tests.total) return handoffs.recheck(claim, { verified: false, why: 'tests-not-all-passed' }, null, this.now());
    let mainHead = null, reader = this.reader;
    if (this.open) {
      let repository = null;
      try { repository = await this.open(); } catch { /* Cannot be read now. */ }
      reader = repository ? repository.reader : null;
      if (repository) { try { mainHead = await repository.mainHead(); } catch { /* Unknown: nothing is checked. */ } }
    } else { try { mainHead = await this.mainHead(); } catch { /* Unknown: nothing is checked. */ } }
    if (!reader || typeof mainHead !== 'string' || !FULL_ID.test(mainHead)) return { outcome: 'unanswered', head: false, notify: [], install: null };
    const verdict = await handoffs.verifyClaim(reader, claim, mainHead);
    const result = handoffs.recheck(claim, verdict, mainHead, this.now(), began);
    return result.outcome === 'unanswered' ? { ...result, head: true } : result;
  }

  // Tell where things stand: a space record for every delivery whose space does not say it yet,
  // and one notice for every reason the person has not been told about.
  // - A space record is written, then marked written. A crash in between writes it again; the
  //   writer recognises the repeat by its key and label. A space always ends up saying where the
  //   delivery stands now; a state that was passed through between two tellings is not told.
  // - A notice is marked as started before it is shown and as done after. A crash in between
  //   leaves it started: it is not shown again and is reported as unknown.
  async tell(view) {
    const handoffs = this.handoffs, written = [];
    // The holder's spaces first; a fault there does not keep the records and notices below from
    // being made, and is thrown at the end.
    let lines = 0, fault = null;
    try { lines = this.tellHolder(view); } catch (error) { fault = error; }
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
    const result = { shown: written.length + lines, told, unknown: handoffs.unknownNotices() };
    // The fault is thrown with what this step did all the same, so the caller can still announce it.
    if (fault) throw Object.assign(fault, { told: result });
    return result;
  }

  // A member that holds the open handoff is kept out of its spaces' queues (see holding()). Each
  // of those spaces is told so once per handoff and state of it. An integrator in no space has
  // no queue to be kept out of. A space that is being updated is told on a later pass; any other
  // failure to write is thrown. Returns how many lines were written.
  tellHolder(view) {
    // A record that cannot be read says nothing about who holds what: nothing is written, also no ending.
    if (!this.holderRecord || this.unreadable()) return 0;
    const entry = line => `${line.roomId}\n${line.handoffId}\n${line.sessionId}`;
    let remembered = this.holderTold;
    if (!remembered) {
      remembered = new Map();
      try {
        for (const line of this.holderLines ? this.holderLines() : []) remembered.set(entry(line), { roomId: line.roomId, sessionId: line.sessionId, handoffId: line.handoffId, name: line.name });
        this.holderTold = remembered;
      } catch { remembered = new Map(); /* The spaces' records cannot be read just now: read again on the next pass. */ }
    }
    const holder = this.holder();
    let written = 0;
    const updating = error => { if (error?.uiMessage?.key !== 'error.room.updatingDraftRetained') throw error; };
    // A handoff the spaces were told about is over (or another one took its place): each of them is told once.
    for (const [id, told] of [...remembered]) {
      if (holder && holder.handoffId === told.handoffId && holder.sessionId === told.sessionId) continue;
      try {
        if (this.holderRecord({ roomId: told.roomId, sessionId: told.sessionId, name: told.name, handoffId: told.handoffId, closed: true })?.recorded === true) written += 1;
        remembered.delete(id);
      } catch (error) { updating(error); }
    }
    const session = holder && (Array.isArray(view?.sessions) ? view.sessions : []).find(candidate => candidate?.id === holder.sessionId);
    if (!session) return written;
    let spaces = [];
    try { spaces = roomIds(session); } catch { return written; }
    for (const roomId of spaces) {
      try {
        const name = this.nameOf(session);
        const result = this.holderRecord({ roomId, sessionId: holder.sessionId, name, handoffId: holder.handoffId, waiting: holder.waiting });
        if (result?.recorded === true) written += 1;
        // Remembered where the space says so (now or already), so that its end is told there.
        if (result?.recorded === true || result?.why === 'known') remembered.set(entry({ roomId, handoffId: holder.handoffId, sessionId: holder.sessionId }), { roomId, sessionId: holder.sessionId, handoffId: holder.handoffId, name });
      } catch (error) { updating(error); }
    }
    return written;
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
    try { done.told = await this.tell(view); }
    catch (error) {
      if (error?.told) done.told = error.told;
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
