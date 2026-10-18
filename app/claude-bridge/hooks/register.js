// This session-local mod uses Claude Code's public API. No prompt rewriting,
// extra model requests, terminal key injection, or global plugin installation.
let stopped = false;

async function request($, route, body) {
  const socketPath = await $.env.get('NAW_SUBMIT_SOCKET');
  const token = await $.env.get('NAW_HOOK_TOKEN');
  const sessionId = await $.session.id();
  if (!socketPath || !token) throw new Error('Workspace connection unavailable');
  const response = await $.http.fetch('http://localhost' + route, {
    socketPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: JSON.stringify({ ...body, sessionId }),
  });
  if (!response.ok) throw new Error('Workspace connection refused');
  return JSON.parse(response.text);
}

async function listen($) {
  if (stopped) return;
  try {
    const message = await request($, '/next', {});
    if (message.closed) { stopped = true; return; }
    if (message.id && typeof message.text === 'string') {
      const draft = await $.prompt.read();
      if (draft.text) await request($, '/result', { id: message.id, status: 'draft' });
      else {
        // Authorize before calling the API. Native 2.1.302 does not re-enter
        // this mod's own prompt.submit hook for its background submissions.
        // The local grant is the dispatch boundary: later human actions can
        // interrupt native work, but must not pretend an accepted send vanished.
        const verdict = await request($, '/authorize', { id: message.id, text: message.text });
        if (!verdict.allowed) await request($, '/result', { id: message.id, status: 'blocked' });
        else if ((await $.prompt.read()).text) await request($, '/result', { id: message.id, status: 'draft' });
        else {
          const result = await $.prompt.submit({ text: message.text, asUser: true });
          await request($, '/result', { id: message.id, status: result.drop ? 'blocked' : 'accepted' });
        }
      }
    }
    $.clock.after(0, () => listen($));
  } catch {
    // Never replay a request whose result is uncertain. Reconnect only to wait
    // for future explicit requests, without retaining the old message.
    $.clock.after(1000, () => listen($));
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const version = (await $.session.version()).version.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
    const supported = version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 302))));
    stopped = !supported;
    if (supported) $.clock.after(0, () => listen($));
    return next(e);
  });
  on('session.end', async ($, e, next) => { stopped = true; return next(e); });
}
