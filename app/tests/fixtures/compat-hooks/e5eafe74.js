// This session-local mod uses Claude Code's public API. No prompt rewriting,
// extra model requests, terminal key injection, or global plugin installation.
let stopped = false;
let generation = 0;
const legacyOnly = false;
let collecting = null;
let foreignSubmissions = 0;
let foreignRevision = 0;
let rootBinding = null;
const rootEnds = new Map();
const rootTransitions = [];
let syncingRoot = false;
let syncRootAgain = false;
let rootSyncBlocked = false;
let contextTransitions = false;

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
  return descriptor;
}

async function request($, route, body, binding) {
  const { socketPath, token, sessionId, lease } = binding || await connection($);
  if (!socketPath || !token) throw new Error('Workspace connection unavailable');
  const response = await $.http.fetch('http://localhost' + route, {
    socketPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: JSON.stringify({ ...body, sessionId, ...(lease ? { lease } : {}) }),
  });
  if (!response.ok) throw new Error('Workspace connection refused');
  return JSON.parse(response.text);
}

async function listen($, ownGeneration) {
  if (stopped || generation !== ownGeneration) return;
  try {
    const binding = await connection($);
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
            await request($, '/result', { id: message.id, status: 'blocked' }, binding);
            if (!stopped && generation === ownGeneration) $.clock.after(0, () => listen($, ownGeneration));
            return;
          }
          const candidate = { events: [], appends: 0, text: message.text, invalid: foreignSubmissions !== 0 };
          collecting = candidate;
          let result;
          try { result = await $.prompt.submit({ text: message.text, asUser: true }); }
          finally { if (collecting === candidate) collecting = null; }
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
          await request($, '/result', { id: message.id, status: result.drop ? 'blocked' : 'accepted', promptId }, binding);
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
  const result = await request($, '/root-bind', {}, binding);
  if (stopped || generation !== ownGeneration || typeof result.lease !== 'string') return;
  rootBinding = { ...binding, lease: result.lease };
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
      if (ending.reason !== 'clear' || !transition || transition.sessionId !== rootBinding.sessionId) return;
      const result = await request($, '/root-clear', { nextSessionId: transition.nextSessionId,
        source: 'clear', model: transition.model }, rootBinding);
      if (typeof result.lease !== 'string') throw Error('Root lease missing');
      rootEnds.delete(rootBinding.sessionId);
      rootBinding = { ...rootBinding, sessionId: transition.nextSessionId, lease: result.lease };
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
  on('session.append', async ($, e, next) => {
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
    try { return await next(e); }
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
    try { return await next(e); }
    finally { foreignSubmissions--; }
  }).catch(async ($, e, next) => {
    foreignRevision++;
    if (collecting) collecting.invalid = true;
    return next(e);
  });
  on('classic.UserPromptSubmit', async ($, e, next) => {
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
    contextTransitions = !legacyOnly && nativeVersion === '2.1.306';
    const version = nativeVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
    const supported = version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 302))));
    stopped = !supported;
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
    if (contextTransitions && rootEnds.get(previousId)?.reason === 'clear' && e.source === 'clear' && !e.agent_id &&
      e.session_id !== previousId && e.session_id === await $.session.id()) {
      if (collecting) collecting.invalid = true;
      stopped = true; generation++;
      if (rootTransitions.length >= 64) rootSyncBlocked = true;
      else rootTransitions.push({ sessionId: previousId, nextSessionId: e.session_id, model: e.model });
      $.clock.after(0, () => syncRoot($));
    }
    return next(e);
  });
}
