// This session-local mod uses Claude Code's public API. No prompt rewriting,
// extra model requests, terminal key injection, or global plugin installation.
let stopped = false;
let generation = 0;
const legacyOnly = false;
let collecting = null;
let foreignSubmissions = 0;
let foreignRevision = 0;
let rootBinding = null;
// Root transitions followed inside one process: SessionEnd reason -> SessionStart source.
const FOLLOWED_ROOT_TRANSITIONS = { clear: 'clear', resume: 'fork' };
const rootEnds = new Map();
const rootTransitions = [];
let syncingRoot = false;
let syncRootAgain = false;
let rootSyncBlocked = false;
let contextTransitions = false;
let nativeBlocks = false;
let addressedTool = false;
let addressedReading = false;
async function observeAddressedTool($, ownGeneration) {
  if (legacyOnly || stopped || ownGeneration !== generation || addressedReading) return;
  const binding = rootBinding;
  addressedReading = true;
  try {
    const available = (await $.tool.list()).some(t => t.name === 'mcp__native_workspace__workspace_message');
    if (!binding || binding !== rootBinding || stopped || ownGeneration !== generation || available === addressedTool) return;
    await request($, '/addressed-capability', { available }, binding);
    addressedTool = available;
  } catch { /* Keep the previously confirmed capability; actual calls still validate. */ }
  finally { addressedReading = false; }
}
let nativeModelSupported = false;
let modelReadRevision = 0;
let modelReads = 0, modelReadAgain = false;
async function observeModel($) {
  const binding = rootBinding, revision = ++modelReadRevision, ownGeneration = generation;
  if (!nativeModelSupported || !binding || stopped) return;
  // Metadata cannot hold input polling or buffered native output. Native API
  // reads are not abortable; cap in-flight reads and coalesce later switches.
  if (modelReads >= 2) { modelReadAgain = true; return; }
  const epoch = binding.observationEpoch;
  modelReads++;
  try {
    const model = await $.session.model();
    const sessionId = await $.session.id();
    if (stopped || generation !== ownGeneration || revision !== modelReadRevision ||
      rootBinding !== binding || binding.observationEpoch !== epoch || sessionId !== binding.sessionId || typeof model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,159}$/.test(model)) return;
    enqueueBlock($, { id: 'control:model', kind: 'control', status: 'complete', model }, binding);
  } catch { /* Missing native metadata never triggers a model request or fallback. */ }
  finally {
    modelReads--;
    if (modelReadAgain) { modelReadAgain = false; observeModel($); }
  }
}
let nativeUsageSupported = false, usageReading = false, usageReadAgain = false, usageRevision = 0;
async function observeUsage($) {
  const binding = rootBinding, revision = ++usageRevision, ownGeneration = generation;
  if (!nativeUsageSupported || !binding || stopped) return;
  if (usageReading) { usageReadAgain = true; return; }
  const epoch = binding.observationEpoch;
  usageReading = true;
  try {
    // No breakdown: the native status-line metadata is free. Never request
    // /context's full token-count calls or change the person's status line.
    const value = await $.session.usage();
    const sessionId = await $.session.id();
    if (stopped || ownGeneration !== generation || revision !== usageRevision || binding !== rootBinding ||
      epoch !== binding.observationEpoch || sessionId !== binding.sessionId) return;
    if (!Number.isSafeInteger(value?.context?.window) || value.context.window <= 0) return;
    const usage = { context: { window: value.context?.window, tokens: value.context?.tokens, percent: value.context?.percent },
      cost: { usd: value.cost?.usd }, rateLimits: (Array.isArray(value.rateLimits) ? value.rateLimits : []).slice(0, 8).map(r => ({ kind: r?.kind, percentUsed: r?.percentUsed, resetsAt: r?.resetsAt })) };
    enqueueBlock($, { id: 'control:usage', kind: 'control', status: 'complete', usage }, binding);
  } catch { /* Retain the last dated reading; unknown is never zero. */ }
  finally { usageReading = false; if (usageReadAgain) { usageReadAgain = false; observeUsage($); } }
}
let activeTurn = null;
let lastPhase = null;
const rootToolCalls = new Map();
function observePhase($, phase, binding = rootBinding, turnId = activeTurn) {
  if (!nativeBlocks || stopped || !binding || binding !== rootBinding || !turnId || turnId !== activeTurn ||
      (lastPhase?.binding === binding && lastPhase.turnId === turnId && lastPhase.phase === phase)) return;
  lastPhase = { binding, turnId, phase };
  enqueueBlock($, { id: 'control:activity', kind: 'control', status: 'complete', turnId, phase }, binding);
}
function heartbeat($, binding, ownGeneration) {
  $.clock.after(1000, () => {
    if (stopped || rootBinding !== binding || generation !== ownGeneration || rootEnds.has(binding.sessionId)) return;
    if (activeTurn && !displayTurns.get(activeTurn)?.ended) enqueueBlock($, { id: 'control:heartbeat', kind: 'control', status: 'complete' }, binding);
    heartbeat($, binding, ownGeneration);
  });
}
// Only native turn identity + a complete matching final display can authorize
// a reply body. Raw Stop text must not bypass a display transform.
const displayTurns = new Map();
const promptTurns = new Map(), displayTurnLinks = new Map();
let rootPrompt = null;
function trimLinks(map) { while (map.size > 64) map.delete(map.keys().next().value); }
function displayTurn(id, binding) {
  let turn = displayTurns.get(id);
  if (!turn || turn.binding !== binding) {
    turn = { binding, blocks: new Map(), incomplete: false }; displayTurns.set(id, turn);
    while (displayTurns.size > 8) displayTurns.delete(displayTurns.keys().next().value);
  }
  return turn;
}
function failureText(turn) {
  return turn.failedPrompt && !turn.failureAmbiguous && turn.failure?.text || '';
}
function publishFailure($, turnId, turn, binding) {
  if (turn.ended && turn.endReason === 'error' && turn.failedPrompt && turn.failure) {
    const detail = failureText(turn);
    enqueueBlock($, { id: `turn:${turnId}`, turnId, kind: 'turn', status: 'failed',
      text: turn.endingText + (detail ? `\n${detail}` : ''), incomplete: Boolean(turn.failureAmbiguous), failedRequest: true,
      ...(!turn.failureAmbiguous ? { errorMessageId: turn.failure.uuid } : {}) }, binding);
  }
}
const observations = [];
let observing = false;
let observationGap = false;
let observationGapRevision = 0;
let observationRequests = 0;
let observerReconnect = false;
let observerRebinding = null;
let observerBindRequest = null;
function markObservationGap(binding) {
  if (binding && binding.lease === rootBinding?.lease) { observationGap = true; observationGapRevision++; }
}

function enqueueBlock($, row, binding = rootBinding) {
  if (!nativeBlocks || !binding || binding !== rootBinding || stopped) return;
  // No synchronous IO in a display hook. Keep the entire accepted batch; an
  // overrun is an explicit gap, never a sliced fragment presented as complete.
  const size = JSON.stringify(row).length;
  if (size > 500000) { markObservationGap(binding); return; }
  while (observations.length >= 256 || observations.reduce((n, x) => n + JSON.stringify(x.row).length, 0) + size > 4000000) {
    observations.shift(); markObservationGap(binding);
  }
  observations.push({ row: { ...row, block: true, sequence: ++binding.observationSequence, epoch: binding.observationEpoch }, binding });
  if (!observing) { observing = true; $.clock.after(0, () => flushObservations($)); }
}

function observeAppend($, e, result, binding, turnId, candidate, nativeApiError) {
  if ((!contextTransitions && !nativeBlocks) || !binding || stopped || rootBinding !== binding || e.agentId ||
    result?.deny || result?.uuid !== e.uuid || !/^[a-f0-9-]{36}$/i.test(result?.uuid || '')) return;
  const message = result.message;
  if (!message || message.isMeta || !Array.isArray(message.content)) return;
  const text = blocks => typeof blocks === 'string' ? blocks : Array.isArray(blocks)
    ? blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  if (nativeBlocks) {
    // A queue record is virtual; only the accepted conversation attachment is
    // a display row. Its UUID and final content come from the native engine.
    const queuedHuman = e.door === 'delivery' && ['composer', 'bridge'].includes(e.origin?.kind);
    const queuedEngine = e.door === 'attachment' && e.origin?.kind === 'engine' && message.role === 'user';
    // Native queued deliveries can use the system channel, with no API role.
    // Keep the final accepted rendering, including native framing; never strip
    // it or infer a human author from the text of an unrelated delivery.
    if (binding.nativeInlineInput && (queuedHuman || queuedEngine) && message.type === 'attachment' &&
      message.name === 'queued_command') {
      const inputTurn = typeof turnId === 'string' && turnId && !displayTurns.get(turnId)?.ended ? turnId : undefined;
      enqueueBlock($, { id: `prompt:${result.uuid}`, kind: 'input', turnId: inputTurn,
        text: text(message.content), title: '工作中插入', inputMode: 'native-inline',
        status: 'complete', incomplete: [e.message?.content, message.content].some(blocks => Array.isArray(blocks) && blocks.some(b => b?.type !== 'text')) }, binding);
    }
    // Retained hosts have no stable GUI user-row ID. Observe the accepted
    // native append instead of guessing a match to a random legacy cache ID.
    if (legacyOnly && e.door === 'prompt' && message.type === 'user') {
      const nonText = message.content.some(b => b?.type !== 'text');
      enqueueBlock($, { id: `prompt:${result.uuid}`, kind: 'input',
        text: text(message.content), status: 'complete', incomplete: nonText,
        ...(candidate === collecting && !candidate?.invalid && candidate?.appends === 1 && candidate?.tag && text(message.content) === candidate.text ? { inputTag: candidate.tag } : {}) });
    }
    // A qualified managed reader uses accepted IDs for ordinary input too.
    // This mod's own submissions already have their visible app row.
    if (!legacyOnly && binding.nativePromptInput && e.door === 'prompt' && message.type === 'user' &&
      !(e.origin?.kind === 'plugin' && e.origin.name === 'native-workspace-submit')) {
      enqueueBlock($, { id: `prompt:${result.uuid}`, kind: 'input', inputMode: 'native-prompt',
        text: text(message.content), status: 'complete', incomplete: message.content.some(b => b?.type !== 'text') }, binding);
    }
    // Display IDs and saved transcript IDs are different namespaces. Text is
    // collected from MessageDisplay only, not guessed equal to an append/Stop.
    if (e.door === 'response' && e.origin?.kind === 'model' && message.type === 'assistant') {
      // Engine-generated API failures bypass MessageDisplay. Classify the
      // inspected native stand-in, but keep only the downstream stored text.
      // A failed prompt and error turn boundary must independently agree.
      if (turnId && nativeApiError &&
        message.content.every(b => b?.type === 'text' && typeof b.text === 'string')) {
        const turn = displayTurn(turnId, binding), detail = text(message.content);
        if (detail.length <= 500000) {
          if (turn.failure && turn.failure.uuid !== result.uuid) turn.failureAmbiguous = true;
          else turn.failure = { uuid: result.uuid, text: detail };
          publishFailure($, turnId, turn, binding);
        } else markObservationGap(binding);
      }
      for (const block of message.content) if (block?.type === 'tool_use' && typeof block.id === 'string') {
        enqueueBlock($, { id: `tool:${block.id}`, kind: 'tool', turnId,
          title: block.name || '', input: JSON.stringify(block.input || {}, null, 2), status: 'running' });
      }
    } else if (e.door === 'tool-result' && e.origin?.kind === 'tool' && message.type === 'user') {
      for (const block of message.content) if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const nonText = Array.isArray(block.content) && block.content.some(b => b?.type !== 'text');
        enqueueBlock($, { id: `tool:${block.tool_use_id}`, kind: 'tool',
          title: e.origin.tool || '', text: text(block.content), status: block.is_error ? 'failed' : 'complete', incomplete: nonText });
      }
    }
    return;
  }
  const rows = [];
  if (e.door === 'response' && e.origin?.kind === 'model' && message.type === 'assistant') {
    rows.push({ id: result.uuid, kind: 'response', text: text(message.content) });
  } else if (e.door === 'tool-result' && e.origin?.kind === 'tool' && message.type === 'user') {
    for (const [index, block] of message.content.entries()) if (block?.type === 'tool_result') {
      rows.push({ id: `${result.uuid}:${index}`, kind: 'tool-output', title: typeof e.origin.tool === 'string' ? e.origin.tool.slice(0, 200) : '',
        text: text(block.content), nonText: Array.isArray(block.content) && block.content.some(b => b?.type !== 'text') });
    }
  }
  for (const row of rows) {
    if (!row.text && !row.nonText) continue;
    row.truncated = row.text.length > 12000;
    row.text = row.text.slice(-12000);
    row.sequence = ++binding.observationSequence;
    row.epoch = binding.observationEpoch;
    // Bounded, private observation only. Native append never waits for local
    // delivery. Retired root observations cannot bind a new root or send work.
    while (observations.length >= 64 || observations.reduce((n, x) => n + x.row.text.length, 0) + row.text.length > 256000) {
      observations.shift(); markObservationGap(binding);
    }
    observations.push({ row, binding });
  }
  if (!observing && observations.length) {
    observing = true; $.clock.after(0, () => flushObservations($));
  }
}

async function flushObservations($) {
  let retry = false;
  try {
    while (observations.length) {
      const entry = observations[0], { binding } = entry;
      if (stopped || binding !== rootBinding) { observations.shift(); continue; }
      if (legacyOnly && observerReconnect) {
        try { await refreshLegacyObserver($, generation); observerReconnect = false; }
        catch (error) {
          if (error.code === 'OBSERVER_IDENTITY') { markObservationGap(binding); if (observations[0] === entry) observations.shift(); continue; }
          retry = true; break;
        }
        if (stopped || binding !== rootBinding) continue;
      }
      const row = entry.row;
      const gap = observationGap, revision = observationGapRevision;
      try {
        // The native HTTP API exposes no abort option. Bound outstanding calls
        // as well as our wait: a stalled old root cannot hold the new queue, nor
        // can repeated timeouts accumulate unbounded host requests.
        if (observationRequests >= 2) throw Error('Observation transport busy');
        observationRequests++;
        const sending = request($, '/observation', { ...row, gap }, binding).finally(() => { observationRequests--; });
        let timer;
        const deadline = new Promise((_, reject) => { timer = $.clock.after(1500, () => reject(Error('Observation timeout'))); });
        let observed;
        try { observed = await Promise.race([sending, deadline]); } finally { timer?.cancel(); }
        // Native control must not hold the observation queue. Its exact result
        // and submission settlement return separately; no automatic retry.
        if (observed?.abort) $.clock.after(0, () => abortNativeTurn($, binding, observed.abort).catch(() => {}));
        if (entry.row !== row && binding === rootBinding) continue;
        if (binding === rootBinding && revision === observationGapRevision) observationGap = false;
      } catch (error) {
        if (entry.row !== row && binding === rootBinding) continue;
        // A retained CLI outlives the GUI transport. Retry observation only,
        // within the existing bounded queue; the native prompt is never replayed.
        if (legacyOnly && !stopped && binding === rootBinding && error.status !== 409) {
          observerReconnect = true;
          retry = true; break;
        }
        markObservationGap(binding);
      }
      // A display-hook overrun may already have evicted this in-flight entry.
      if (observations[0] === entry) observations.shift();
    }
  } finally {
    // One observation retry timer, independent of the command listener held
    // in prompt.submit. Stop/end drains it; hooks never await this transport.
    if (retry) $.clock.after(1000, () => flushObservations($));
    else observing = false;
  }
}

async function abortNativeTurn($, binding, command) {
  if (stopped || binding !== rootBinding || rootEnds.has(binding.sessionId) ||
      command.epoch !== binding.observationEpoch || command.turnId !== activeTurn ||
      !/^[a-f0-9-]{36}$/i.test(command.id || '') || displayTurns.get(activeTurn)?.ended) return;
  const pending = collecting;
  const report = submitSettled => request($, '/abort-result', { id: command.id, epoch: command.epoch, turnId: command.turnId, status: 'aborted', submitSettled }, binding);
  try { await $.turn.abort({ turnId: command.turnId }); }
  catch { await request($, '/abort-result', { id: command.id, epoch: command.epoch, turnId: command.turnId, status: 'failed' }, binding); return; }
  if (stopped || binding !== rootBinding) return;
  await report(!pending || pending.finished === true);
  if (pending && !pending.finished) pending.settled.then(() => {
    if (!stopped && binding === rootBinding) report(true).catch(() => {});
  });
}

async function refreshLegacyObserver($, ownGeneration) {
  if (observerRebinding) return observerRebinding;
  const previous = rootBinding;
  const changed = () => Object.assign(Error('Observer identity changed'), { code: 'OBSERVER_IDENTITY' });
  const refresh = async () => {
    const binding = await connection($);
    if (!legacyOnly || stopped || generation !== ownGeneration || rootBinding !== previous ||
      !previous || binding.sessionId !== previous.sessionId || binding.socketPath !== previous.socketPath ||
      rootEnds.has(previous.sessionId)) throw changed();
    if (binding.token === previous.token) return;
    const version = (await $.session.version()).version;
    // Native HTTP cannot be aborted. Reuse one metadata request for this
    // credential across wait timeouts; repeating root-bind would rotate epochs.
    if (!observerBindRequest || observerBindRequest.token !== binding.token || observerBindRequest.generation !== ownGeneration) {
      if (observationRequests >= 2) throw Error('Observation transport busy');
      observationRequests++;
      observerBindRequest = { token: binding.token, generation: ownGeneration,
        promise: request($, '/root-bind', { nativeBlocks, nativeQueue: version === '2.1.302',
          nativeInlineInput: ['2.1.310', '2.1.311', '2.1.312'].includes(version),
          nativePromptInput: false,
          nativeSharedDisplay: nativeBlocks && version === '2.1.302' }, binding).finally(() => { observationRequests--; }) };
    }
    const pending = observerBindRequest;
    let timer, result;
    const deadline = new Promise((_, reject) => { timer = $.clock.after(1500, () => reject(Object.assign(Error('Observer rebind timeout'), { code: 'OBSERVER_TIMEOUT' }))); });
    try { result = await Promise.race([pending.promise, deadline]); }
    catch (error) { if (error.code !== 'OBSERVER_TIMEOUT' && observerBindRequest === pending) observerBindRequest = null; throw error; }
    finally { timer?.cancel(); }
    const current = await connection($);
    if (stopped || generation !== ownGeneration || rootBinding !== previous ||
      await $.session.id() !== previous.sessionId || typeof result.lease !== 'string' || result.nativeBlocks !== true) throw changed();
    if (current.token !== binding.token || current.sessionId !== binding.sessionId || current.socketPath !== binding.socketPath) throw Error('Observer connection changed');
    // Preserve native display/prompt links only for this same live root. Command
    // listeners hold a separate connection value: their old receipt/grant must
    // still go to its old credential, never to this new observer.
    Object.assign(previous, binding, { lease: result.lease, observationEpoch: result.observationEpoch, observationSequence: 0,
      nativeInlineInput: nativeBlocks && result.nativeInlineInput === true, nativePromptInput: false });
    for (const entry of observations) if (entry.binding === previous) {
      entry.row = { ...entry.row, epoch: previous.observationEpoch, sequence: ++previous.observationSequence, replayed: true };
    }
    if (observerBindRequest === pending) observerBindRequest = null;
    observeModel($); observeUsage($);
  };
  observerRebinding = refresh();
  try { await observerRebinding; } finally { observerRebinding = null; }
}

async function connection($) {
  const sessionId = await $.session.id();
  const socketPath = await $.env.get('NAW_SUBMIT_SOCKET');
  const token = await $.env.get('NAW_HOOK_TOKEN');
  if (socketPath && token) {
    if (rootBinding && rootBinding.sessionId !== sessionId) throw Error('Root context changed');
    return { socketPath, token, sessionId, ...(rootBinding ? { lease: rootBinding.lease } : {}) };
  }
  // Old workspace processes already have a private hooks directory. A
  // descriptor there lets this mod attach without restarting the native CLI.
  const hook = await $.env.get('NAW_HOOK_SOCKET');
  if (!hook || !token || !/^[a-f0-9-]{36}$/i.test(sessionId) || !hook.endsWith('/hooks.sock')) throw Error('Workspace connection unavailable');
  const directory = hook.slice(0, -'hooks.sock'.length);
  const descriptor = JSON.parse(await $.fs.read(directory + 'gui-' + sessionId + '.json'));
  if (descriptor.sessionId !== sessionId || descriptor.socketPath !== directory + 'gui-submit.sock' || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw Error('Workspace connection unavailable');
  return { ...descriptor, ...(rootBinding?.token === descriptor.token && rootBinding.sessionId === sessionId ? { lease: rootBinding.lease } : {}) };
}

async function request($, route, body, binding) {
  const { socketPath, token, sessionId, lease } = binding || await connection($);
  if (!socketPath || !token) throw new Error('Workspace connection unavailable');
  // A trailing lost observation must be visible even without another append.
  // Piggyback a gap on the existing independent control poll/reconnect path.
  const reportGap = route === '/next' && observationGap && lease === rootBinding?.lease;
  const gapRevision = observationGapRevision;
  const response = await $.http.fetch('http://localhost' + route, {
    socketPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: JSON.stringify({ ...body, sessionId, ...(lease ? { lease } : {}), ...(reportGap ? { observationGap: true, epoch: rootBinding.observationEpoch } : {}) }),
  });
  if (!response.ok) { const error = new Error('Workspace connection refused'); error.status = response.status; throw error; }
  if (reportGap && lease === rootBinding?.lease && gapRevision === observationGapRevision) observationGap = false;
  return JSON.parse(response.text);
}

async function listen($, ownGeneration) {
  if (stopped || generation !== ownGeneration) return;
  try {
    observeAddressedTool($, ownGeneration);
    const binding = await connection($);
    // A GUI reopen rotates only the compatibility credential. Rebind the
    // observer to that same native root; never repeat a pending submission.
    if (legacyOnly && binding.nativeBlocks && nativeBlocks &&
      (!rootBinding || rootBinding.token !== binding.token)) {
      if (!rootBinding) return await bindRoot($, ownGeneration);
      await refreshLegacyObserver($, ownGeneration);
      return await listen($, ownGeneration);
    }
    const message = await request($, '/next', {}, binding);
    if (stopped || generation !== ownGeneration) return;
    if (message.closed) {
      if (binding.compat) $.clock.after(1000, () => listen($, ownGeneration));
      else stopped = true;
      return;
    }
    if (message.id && typeof message.text === 'string') {
      const intentRevision = foreignRevision;
      const draft = await $.prompt.read();
      if (draft.text) await request($, '/result', { id: message.id, status: 'draft' }, binding);
      else {
        // Authorize before calling the API. Native 2.1.302 does not re-enter
        // this mod's own prompt.submit hook for its background submissions.
        // The local grant is the dispatch boundary: later human actions can
        // interrupt native work, but must not pretend an accepted send vanished.
        const verdict = await request($, '/authorize', { id: message.id, text: message.text }, binding);
        if (stopped || generation !== ownGeneration) return;
        if (!verdict.allowed) await request($, '/result', { id: message.id, status: 'blocked' }, binding);
        else if ((await $.prompt.read()).text) await request($, '/result', { id: message.id, status: 'draft' }, binding);
        else {
          if (stopped || generation !== ownGeneration || await $.session.id() !== binding.sessionId) return;
          if (stopped || generation !== ownGeneration) return;
          if (foreignRevision !== intentRevision || foreignSubmissions) {
            await request($, '/result', { id: message.id, status: 'blocked', reason: 'input-changed' }, binding);
            if (!stopped && generation === ownGeneration) $.clock.after(0, () => listen($, ownGeneration));
            return;
          }
          const candidate = { tag: message.id, events: [], turns: [], appends: 0, text: message.text, invalid: foreignSubmissions !== 0 };
          candidate.settled = new Promise(resolve => { candidate.resolveSettled = resolve; });
          collecting = candidate;
          let result;
          try { result = await $.prompt.submit({ text: message.text, asUser: true }); }
          finally { candidate.finished = true; candidate.resolveSettled(); if (collecting === candidate) collecting = null; }
          const event = candidate.events[0];
          const promptId = !candidate.invalid && !stopped && generation === ownGeneration &&
            candidate.events.length === 1 && candidate.appends === 1 && event.session_id === binding.sessionId &&
            !event.agent_id && typeof event.prompt_id === 'string' &&
            /^[a-f0-9-]{36}$/i.test(event.prompt_id) &&
            event.prompt === message.text && result.text === message.text &&
            result.origin?.kind === 'plugin' &&
            result.origin.name === (legacyOnly ? 'native-workspace-compat' : 'native-workspace-submit')
            ? event.prompt_id : undefined;
          // Acceptance and reply attribution are separate. Missing/ambiguous
          // identity never changes an accepted send into a retryable failure.
          await request($, '/result', { id: message.id, status: result.drop ? 'blocked' : 'accepted', reason: result.drop ? 'native-rejection' : undefined, promptId,
            turnId: promptId && candidate.turns.length === 1 ? candidate.turns[0] : undefined }, binding);
        }
      }
    }
    if (!stopped && generation === ownGeneration) $.clock.after(0, () => listen($, ownGeneration));
  } catch {
    // Never replay a request whose result is uncertain. Reconnect only to wait
    // for future explicit requests, without retaining the old message.
    if (!stopped && generation === ownGeneration) $.clock.after(1000, () => listen($, ownGeneration));
  }
}

async function bindRoot($, ownGeneration) {
  const binding = await connection($);
  const version = (await $.session.version()).version;
  const result = await request($, '/root-bind', { nativeBlocks, addressedTool, nativeQueue: (legacyOnly ? version === '2.1.302' : ['2.1.308', '2.1.309', '2.1.310', '2.1.311', '2.1.312'].includes(version)),
    nativeInlineInput: ['2.1.310', '2.1.311', '2.1.312'].includes(version),
    nativePromptInput: !legacyOnly && ['2.1.310', '2.1.311', '2.1.312'].includes(version),
    nativeAbort: !legacyOnly && ['2.1.310', '2.1.311', '2.1.312'].includes(version),
    nativeSharedDisplay: legacyOnly && nativeBlocks && version === '2.1.302' }, binding);
  if (stopped || generation !== ownGeneration || typeof result.lease !== 'string') return;
  nativeBlocks = nativeBlocks && result.nativeBlocks === true;
  rootBinding = { ...binding, lease: result.lease, observationEpoch: result.observationEpoch, observationSequence: 0,
    nativeInlineInput: nativeBlocks && result.nativeInlineInput === true, nativePromptInput: nativeBlocks && result.nativePromptInput === true };
  heartbeat($, rootBinding, ownGeneration);
  // Native MCP connection may finish just after session.start. One early
  // metadata refresh avoids waiting for the existing /next poll to return.
  if (!legacyOnly) $.clock.after(500, () => observeAddressedTool($, ownGeneration));
  observeModel($); observeUsage($);
  await listen($, ownGeneration);
}

async function syncRoot($) {
  if (rootSyncBlocked || !rootBinding) return;
  if (syncingRoot) { syncRootAgain = true; return; }
  syncingRoot = true;
  syncRootAgain = false;
  let retry = false;
  try {
    while (rootEnds.has(rootBinding.sessionId)) {
      const ending = rootEnds.get(rootBinding.sessionId);
      if (!ending.confirmed) {
        await request($, '/root-end', { reason: ending.reason }, rootBinding);
        ending.confirmed = true;
      }
      const transition = rootTransitions[0];
      const expectedSource = FOLLOWED_ROOT_TRANSITIONS[ending.reason];
      if (!transition || transition.sessionId !== rootBinding.sessionId || !expectedSource || expectedSource !== transition.source) return;
      // A fork was admitted before the engine reported it as current; confirm
      // that now unless a later queued transition already proves it was.
      if (transition.source === 'fork' && rootTransitions.length === 1 && await $.session.id() !== transition.nextSessionId) {
        // Bounded: a root that never becomes current is dropped, leaving the
        // GUI closed for this context instead of polling for the process lifetime.
        transition.confirmAttempts = (transition.confirmAttempts || 0) + 1;
        if (transition.confirmAttempts > 30) { rootTransitions.shift(); return; }
        throw Error('Root not yet current'); // retried below
      }
      const result = await request($, '/root-clear', { nextSessionId: transition.nextSessionId,
        source: transition.source, model: transition.model }, rootBinding);
      if (typeof result.lease !== 'string') throw Error('Root lease missing');
      rootEnds.delete(rootBinding.sessionId);
      rootBinding = { ...rootBinding, sessionId: transition.nextSessionId, lease: result.lease, observationEpoch: result.observationEpoch, observationSequence: 0,
        nativeInlineInput: nativeBlocks && result.nativeInlineInput === true, nativePromptInput: nativeBlocks && result.nativePromptInput === true };
      observationGap = false; observationGapRevision++;
      rootTransitions.shift();
    }
    const revision = generation, currentId = await $.session.id();
    if (revision !== generation || rootTransitions.length || rootEnds.has(rootBinding.sessionId)) {
      syncRootAgain = true; return;
    }
    if (!rootSyncBlocked && stopped && currentId === rootBinding.sessionId) {
      stopped = false; const ownGeneration = generation;
      $.clock.after(0, () => listen($, ownGeneration));
    }
  } catch {
    // Retry identity metadata only, in order. Never replay a native command or
    // prompt. Each queued transition was proven by classic.SessionStart while
    // $.session.id() still identified that root, even if it has since ended.
    retry = true;
  } finally {
    syncingRoot = false;
    if (!rootSyncBlocked && (syncRootAgain || retry)) $.clock.after(syncRootAgain ? 0 : 1000, () => syncRoot($));
  }
}

export function register(on) {
  on('tool.describe', { tool: 'mcp__native_workspace__workspace_message' }, async ($, e, next) => ({ ...await next(e), isDeferred: false }));
  on('tool.call', { tool: 'mcp__native_workspace__workspace_message' }, async ($, e, next) => {
    const binding = rootBinding, turnId = activeTurn, promptId = rootPrompt?.id;
    if (!addressedTool || stopped || !binding || !turnId || !promptId || e.agentId ||
      next.origin?.plugin !== 'engine' || e.tool_use_id === undefined) return { deny: '没有本原生主会话的定向协作授权。' };
    const args = { recipient_id: e.recipient_id, message: e.message };
    // Let Claude run the real MCP call: PreToolUse, configured rules, native
    // approval and any managed hooks all remain on the execution path.
    const executed = await next(e);
    let approved;
    try { approved = JSON.parse(executed.text); } catch { /* Refused or not our exact MCP result. */ }
    if (executed.deny || executed.isError || approved?.approved !== true || approved.recipient_id !== args.recipient_id || approved.message !== args.message) {
      await request($, '/addressed-failed', { turnId, promptId, callId: e.tool_use_id, epoch: binding.observationEpoch }, binding).catch(() => {});
      if (executed.deny || executed.isError) return executed;
      return { deny: '原生工具结果或输入已变化；没有安排转交。' };
    }
    if (stopped || rootBinding !== binding || activeTurn !== turnId || rootPrompt?.id !== promptId || observationGap) return { deny: '原生回合或连接已变化，未安排转交。' };
    try {
      const result = await request($, '/addressed-message', { turnId, promptId, callId: e.tool_use_id, epoch: binding.observationEpoch, arguments: args }, binding);
      return { result: JSON.stringify(result), isError: result.status !== 'staged' };
    } catch { return { deny: '本地接收结果未确认；不要重试，请让真人核对。' }; }
  });
  on('classic.PostModelSwitch', async ($, e, next) => {
    const binding = rootBinding, ownGeneration = generation;
    const watching = nativeModelSupported && !stopped && binding && !e.agent_id && e.session_id === binding.sessionId;
    const revision = watching ? ++modelReadRevision : null;
    if (watching) modelReadAgain = false;
    const result = await next(e);
    // The native post-switch event carries the resolved selection. A query
    // inside this hook can still see the previous value on retained runtimes.
    if (watching && !stopped && rootBinding === binding && generation === ownGeneration && revision === modelReadRevision &&
      typeof e.to_model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,159}$/.test(e.to_model)) {
      enqueueBlock($, { id: 'control:model', kind: 'control', status: 'complete', model: e.to_model }, binding);
    }
    return result;
  }).catch(($, e, next) => next(e));
  on('tool.call', async ($, e, next) => {
    const binding = rootBinding;
    if (!nativeBlocks || e.agentId || !e.tool_use_id || next.origin?.plugin !== 'engine' || next.origin?.tier !== 'core') return next(e);
    const call = { binding, turnId: activeTurn, id: `permission:${e.tool_use_id}`, progress: false };
    rootToolCalls.set(e.tool_use_id, call);
    try { return await next(e); }
    finally {
      if (rootToolCalls.get(e.tool_use_id) === call) rootToolCalls.delete(e.tool_use_id);
      if (binding === rootBinding) enqueueBlock($, { id: 'control:permission-end', kind: 'control', status: 'complete', permissionId: call.id }, binding);
    }
  }).catch(($, e, next) => next(e));
  on('tool.check', async ($, e, next) => {
    const call = rootToolCalls.get(e.tool_use_id), result = await next(e);
    if (!call || e.agentId || call.binding !== rootBinding || next.origin?.plugin !== 'engine' || next.origin?.tier !== 'core' || result.decision !== 'ask') return result;
    let input = '', incomplete = false;
    try { input = JSON.stringify(e.input ?? {}, null, 2); if (input.length > 500000) { input = ''; incomplete = true; } } catch { incomplete = true; }
    enqueueBlock($, { id: 'control:permission', kind: 'control', status: 'complete', permissionId: call.id,
      turnId: call.turnId, title: e.tool || '', input, incomplete }, call.binding);
    return result;
  }).catch(($, e, next) => next(e));
  on('ui.render', { component: 'AskUserQuestion' }, ($, e, next) => {
    const call = rootToolCalls.get(e.requestId);
    // This native dialog can open without a tool permission request. Observe
    // its own exact root tool ID; leave all input and selection with the TUI.
    if (e.surface === 'terminal' && call && call.binding === rootBinding && next.origin?.plugin === 'engine' && next.origin?.tier === 'core') {
      let input = '', incomplete = false;
      try { input = JSON.stringify({ questions: e.props.questions }, null, 2); if (input.length > 500000) { input = ''; incomplete = true; } } catch { incomplete = true; }
      if (call.questionInput !== input) {
        call.questionInput = input;
        enqueueBlock($, { id: 'control:permission', kind: 'control', status: 'complete', permissionId: call.id,
          turnId: call.turnId, title: e.props.tool, input, incomplete }, call.binding);
      }
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    const call = rootToolCalls.get(e.props.tool_use_id);
    if (call && !call.progress && call.binding === rootBinding && e.props.kind === 'background_hint' && next.origin?.plugin === 'engine' && next.origin?.tier === 'core') {
      call.progress = true;
      enqueueBlock($, { id: 'control:permission-end', kind: 'control', status: 'complete', permissionId: call.id }, call.binding);
      observePhase($, 'tool', call.binding, call.turnId);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on('classic.PermissionRequest', ($, e, next) => {
    // Ordered with display observations, before native permission handling.
    // No permission decision or tool payload is copied into the shared room.
    const binding = rootBinding;
    if (e.agent_id || e.session_id !== binding?.sessionId) return next(e);
    const link = promptTurns.get(e.prompt_id);
    const turnId = link?.binding === binding && !link.ambiguous ? link.turnId : undefined;
    enqueueBlock($, { id: 'control:permission', kind: 'control', status: 'complete', boundaryOnly: true,
      turnId, promptId: e.prompt_id }, binding);
    return next(e);
  }).catch(($, e, next) => { markObservationGap(rootBinding); return next(e); });
  on('classic.StopFailure', async ($, e, next) => {
    const binding = rootBinding, prompt = promptTurns.get(e.prompt_id), ownGeneration = generation;
    const result = await next(e);
    if (nativeBlocks && binding && binding === rootBinding && ownGeneration === generation && !e.agent_id &&
      e.session_id === binding.sessionId && prompt?.binding === binding && !prompt.ambiguous) {
      const turn = displayTurn(prompt.turnId, binding);
      turn.failedPrompt = true;
      publishFailure($, prompt.turnId, turn, binding);
    }
    // StopFailure may carry a previous/untransformed assistant message. Never
    // use it as the error body or as a completed assistant reply.
    return result;
  }).catch(($, e, next) => { markObservationGap(rootBinding); return next(e); });
  on('classic.MessageDisplay', async ($, e, next) => {
    const binding = rootBinding;
    const result = await next(e);
    try {
      if (nativeBlocks && !e.agent_id && binding === rootBinding && e.session_id === binding?.sessionId) {
        const visible = typeof result?.displayContent === 'string' ? result.displayContent : e.delta;
        // Classic display IDs and mod engine turn IDs are distinct namespaces.
        // Join through native prompt_id, then pin the display-turn link. A later
        // typed prompt must not reassign an already streaming display message.
        const key = `${binding.sessionId}:${e.turn_id}`;
        let link = displayTurnLinks.get(key);
        const prompt = promptTurns.get(e.prompt_id);
        if (!link && prompt?.binding === binding && !prompt.ambiguous) {
          link = prompt; displayTurnLinks.set(key, link); trimLinks(displayTurnLinks);
        }
        const turnId = link?.turnId || `display:${e.turn_id}`;
        const turn = displayTurn(turnId, binding);
        if (!link || link.promptId !== e.prompt_id) turn.incomplete = true;
        let block = turn.blocks.get(e.message_id);
        if (!block) { block = { raw: '', index: -1 }; turn.blocks.set(e.message_id, block); }
        if (block.index + 1 !== e.index || turn.ended) turn.incomplete = true;
        block.index = e.index; block.raw += e.delta; block.final = e.final;
        turn.last = e.message_id;
        if (turn.blocks.size > 64 || [...turn.blocks.values()].reduce((n, b) => n + b.raw.length, 0) > 500000) {
          turn.blocks.clear(); turn.incomplete = true;
        }
        enqueueBlock($, { id: `display:${e.message_id}`, turnId, displayTurnId: e.turn_id, promptId: e.prompt_id, kind: 'response', index: e.index,
          delta: visible, status: e.final ? 'complete' : 'streaming' }, binding);
      }
    } catch { markObservationGap(binding); }
    return result;
  }).catch(($, e, next) => next(e));
  on('turn.start', ($, e, next) => {
    if (!e.agentId) {
      activeTurn = e.turnId;
      lastPhase = null;
      enqueueBlock($, { id: 'control:turn-start', kind: 'control', turnId: e.turnId, promptId: rootPrompt?.id, status: 'running' });
      // Native contract: root turn.start follows UserPromptSubmit. Repeated
      // starts for the same prompt are ambiguous, never a sharing authority.
      if (rootPrompt?.binding === rootBinding) {
        const previous = promptTurns.get(rootPrompt.id);
        promptTurns.set(rootPrompt.id, { binding: rootBinding, turnId: e.turnId, promptId: rootPrompt.id,
          ambiguous: Boolean(previous && previous.turnId !== e.turnId) }); trimLinks(promptTurns);
      }
      if (collecting) collecting.turns.push(e.turnId);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on('turn.step', async function* ($, e, next) {
    const binding = rootBinding;
    if (e.agentId || e.turnId !== activeTurn || next.origin?.plugin !== 'engine' || next.origin?.tier !== 'core') return yield* next(e);
    observePhase($, 'requesting', binding, e.turnId);
    const iterator = next(e)[Symbol.asyncIterator](); let finished = false, sent;
    try {
      while (true) {
        const item = await iterator.next(sent);
        if (item.done) { finished = true; return item.value; }
        const phase = ['thinking', 'text', 'input', 'tool'].includes(item.value?.kind) ? item.value.kind : null;
        if (phase) observePhase($, phase, binding, e.turnId);
        sent = yield item.value;
      }
    } finally { if (!finished) await iterator.return?.(); }
  }).catch(async function* ($, e, next) { return yield* next(e); });
  on('turn.complete', async ($, e, next) => {
    const binding = rootBinding;
    const result = await next(e);
    try {
      if (!e.agentId && binding === rootBinding) {
        observeUsage($);
        const turn = displayTurn(e.turnId, binding), final = turn.blocks.get(turn.last);
        // Text equality is only a completeness check inside an explicit native
        // turn, never a substitute for prompt/turn identity. Forward the display
        // ID, not the possibly unredacted answer.
        const finalDisplayId = turn?.binding === binding && !turn.incomplete && final?.final &&
          typeof e.answer === 'string' && final.raw.trimEnd() === e.answer.trimEnd() ? `display:${turn.last}` : undefined;
        turn.ended = true; turn.endReason = e.reason;
        turn.endingText = '';
        enqueueBlock($, { id: `turn:${e.turnId}`, turnId: e.turnId, kind: 'turn', finalDisplayId,
          text: turn.endingText + (e.reason === 'error' && failureText(turn) ? `\n${failureText(turn)}` : ''),
          status: e.reason === 'aborted' ? 'interrupted' : e.reason === 'answer' ? 'complete' : 'failed',
          failedRequest: e.reason === 'error' && turn.failedPrompt === true,
          ...(e.reason === 'error' && turn.failedPrompt && turn.failure && !turn.failureAmbiguous ? { errorMessageId: turn.failure.uuid } : {}) }, binding);
      }
    } catch { markObservationGap(binding); }
    return result;
  }).catch(($, e, next) => next(e));
  on('session.append', async ($, e, next) => {
    const observationBinding = rootBinding;
    const observationTurn = activeTurn, observationEpoch = observationBinding?.observationEpoch, observationGeneration = generation;
    const content = e.message?.content;
    const nativeApiError = e.door === 'response' && e.origin?.kind === 'model' && e.origin.model === '<synthetic>' &&
      e.message?.type === 'assistant' && content?.length === 1 && content[0]?.type === 'text' &&
      typeof content[0].text === 'string' && /^API Error: /.test(content[0].text);
    if (collecting && e.door === 'prompt') {
      collecting.appends++;
      // The native engine pins origin. A previously queued foreign prompt also
      // appends before its turn starts; it cannot masquerade as our submission.
      const name = legacyOnly ? 'native-workspace-compat' : 'native-workspace-submit';
      if (e.agentId || typeof e.uuid !== 'string' || !/^[a-f0-9-]{36}$/i.test(e.uuid) ||
        e.origin?.kind !== 'plugin' || e.origin.name !== name ||
        e.origin.asUser !== true || e.message?.type !== 'user' || e.message.role !== 'user' ||
        !Array.isArray(e.message.content) || e.message.content.length !== 1 ||
        e.message.content[0].type !== 'text' || e.message.content[0].text !== collecting.text ||
        collecting.events.length !== 1) collecting.invalid = true;
    }
    const candidate = collecting;
    try {
      const result = await next(e);
      try {
        if (observationGeneration === generation && observationBinding?.observationEpoch === observationEpoch) observeAppend($, e, result, observationBinding, observationTurn, candidate, nativeApiError);
        else markObservationGap(observationBinding);
        if (!e.agentId && e.door === 'response' && observationBinding === rootBinding) observeUsage($);
      }
      catch { markObservationGap(observationBinding); } // Never fail native append.
      return result;
    }
    catch (error) { if (candidate) candidate.invalid = true; throw error; }
  }).catch(async ($, e, next) => {
    if (collecting) collecting.invalid = true;
    return next(e); // Native catch continuation is replay-safe.
  });
  on('prompt.submit', async ($, e, next) => {
    // Native skips the caller's own submit hook. Every other ingress, including
    // identical human text, invalidates correlation without changing its input.
    foreignSubmissions++;
    foreignRevision++;
    if (collecting) collecting.invalid = true;
    enqueueBlock($, { id: 'control:input', kind: 'control', status: 'complete' });
    try { return await next(e); }
    finally { foreignSubmissions--; }
  }).catch(async ($, e, next) => {
    foreignRevision++;
    if (collecting) collecting.invalid = true;
    return next(e);
  });
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!e.agent_id && e.session_id === rootBinding?.sessionId && /^[a-f0-9-]{36}$/i.test(e.prompt_id || '')) rootPrompt = { id: e.prompt_id, binding: rootBinding };
    const candidate = collecting;
    if (candidate) {
      // Count all events, including malformed/unknown identities. Filtering
      // first could make an unrelated event look like the only candidate.
      if (candidate.events.length < 2) candidate.events.push(e);
      else candidate.invalid = true;
    }
    try { return await next(e); }
    catch (error) { if (candidate) candidate.invalid = true; throw error; }
  }).catch(async ($, e, next) => {
    if (collecting) collecting.invalid = true;
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    if (collecting) collecting.invalid = true;
    const ownGeneration = ++generation;
    const nativeVersion = (await $.session.version()).version;
    nativeUsageSupported = ['2.1.309', '2.1.310', '2.1.311', '2.1.312'].includes(nativeVersion);
    nativeModelSupported = ['2.1.302', '2.1.308', '2.1.309', '2.1.310', '2.1.311', '2.1.312'].includes(nativeVersion);
    nativeBlocks = legacyOnly ? ['2.1.302', '2.1.307', '2.1.308', '2.1.309', '2.1.310'].includes(nativeVersion)
      : ['2.1.307', '2.1.308', '2.1.309', '2.1.310', '2.1.311', '2.1.312'].includes(nativeVersion);
    contextTransitions = !legacyOnly && ['2.1.306', '2.1.307', '2.1.308', '2.1.309', '2.1.310', '2.1.311', '2.1.312'].includes(nativeVersion);
    const version = nativeVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
    const supported = version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 302))));
    stopped = !supported;
    addressedTool = false;
    if (supported && await $.env.get('NAW_HOOK_TOKEN') && !(legacyOnly && await $.env.get('NAW_SUBMIT_SOCKET'))) $.clock.after(0, () => contextTransitions ? bindRoot($, ownGeneration).catch(() => {}) : listen($, ownGeneration));
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    if (collecting) collecting.invalid = true;
    stopped = true; generation++;
    const known = rootBinding && (e.sessionId === rootBinding.sessionId || rootTransitions.some(t => t.nextSessionId === e.sessionId));
    if (known) {
      if (rootEnds.size >= 64 && !rootEnds.has(e.sessionId)) rootSyncBlocked = true;
      else rootEnds.set(e.sessionId, { reason: e.reason });
      $.clock.after(0, () => syncRoot($));
    }
    return next(e);
  });
  on('classic.SessionStart', async ($, e, next) => {
    const previousId = rootTransitions.at(-1)?.nextSessionId || rootBinding?.sessionId;
    // A /clear reports the new id as current before this hook; a /branch (fork)
    // still answers the ending id here and swaps afterwards, so the new id is
    // confirmed again before the transition is sent.
    const currentId = contextTransitions ? await $.session.id() : null;
    const expectedStart = FOLLOWED_ROOT_TRANSITIONS[rootEnds.get(previousId)?.reason];
    if (contextTransitions && expectedStart && expectedStart === e.source && !e.agent_id &&
      e.session_id !== previousId && (e.session_id === currentId || (e.source === 'fork' && currentId === previousId))) {
      if (collecting) collecting.invalid = true;
      stopped = true; generation++;
      if (rootTransitions.length >= 64) rootSyncBlocked = true;
      else rootTransitions.push({ sessionId: previousId, nextSessionId: e.session_id, source: e.source, model: e.model });
      $.clock.after(0, () => syncRoot($));
    }
    return next(e);
  });
}
