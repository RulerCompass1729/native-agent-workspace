// This session-local mod uses Claude Code's public API. No prompt rewriting,
// extra model requests, terminal key injection, or global plugin installation.
let stopped = false;
let generation = 0;
const legacyOnly = false;

async function connection($) {
  const sessionId = await $.session.id();
  const socketPath = await $.env.get('NAW_SUBMIT_SOCKET');
  const token = await $.env.get('NAW_HOOK_TOKEN');
  if (socketPath && token) return { socketPath, token, sessionId };
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
  const { socketPath, token, sessionId } = binding || await connection($);
  if (!socketPath || !token) throw new Error('Workspace connection unavailable');
  const response = await $.http.fetch('http://localhost' + route, {
    socketPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: JSON.stringify({ ...body, sessionId }),
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
          const result = await $.prompt.submit({ text: message.text, asUser: true });
          await request($, '/result', { id: message.id, status: result.drop ? 'blocked' : 'accepted' }, binding);
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

export function register(on) {
  on('session.start', async ($, e, next) => {
    const ownGeneration = ++generation;
    const version = (await $.session.version()).version.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
    const supported = version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 302))));
    stopped = !supported;
    if (supported && await $.env.get('NAW_HOOK_TOKEN') && !(legacyOnly && await $.env.get('NAW_SUBMIT_SOCKET'))) $.clock.after(0, () => listen($, ownGeneration));
    return next(e);
  });
  on('session.end', async ($, e, next) => { stopped = true; generation++; return next(e); });
}
