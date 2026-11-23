// Resume every session left awaiting recovery (after an outage), at most two at a time.
// Each one goes through the ordinary single resume, with its own checks; nothing earlier is re-sent.
(function (root) {
  const LIMIT = 2;
  const eligible = (sessions = [], canResume) => sessions.filter(s => s && !s.archived && s.state === 'recoverable' && canResume(s));
  // `resumeOne(id)` resolves when that session's resume returns; a rejection fails only that row.
  function create({ resumeOne, limit = LIMIT, onChange = () => {} }) {
    const rows = new Map(), queue = [];
    let active = 0, waiters = [];
    const set = (id, row) => { rows.set(id, row); onChange(id, row); };
    const settle = () => {
      if (active || queue.length) return;
      const done = waiters; waiters = [];
      for (const resolve of done) resolve(counts());
    };
    const pump = () => {
      while (active < limit && queue.length) {
        const id = queue.shift();
        active++;
        set(id, { state: 'running' });
        Promise.resolve().then(() => resumeOne(id))
          .then(() => set(id, { state: 'done' }), error => set(id, { state: 'failed', error }))
          .finally(() => { active--; pump(); settle(); });
      }
    };
    const idle = () => new Promise(resolve => { waiters.push(resolve); settle(); });
    function add(ids) {
      for (const id of ids) {
        const state = rows.get(id)?.state;
        if (state === 'queued' || state === 'running' || state === 'done') continue;
        set(id, { state: 'queued' });
        queue.push(id);
      }
      pump();
      return idle();
    }
    function counts() {
      const all = [...rows.values()];
      const count = state => all.filter(row => row.state === state).length;
      return { total: all.length, done: count('done'), failed: count('failed'), pending: count('queued') + count('running') };
    }
    return { add, retry: id => add([id]), row: id => rows.get(id), ids: () => [...rows.keys()], counts, idle };
  }
  root.nativeWorkspaceResumeAll = { LIMIT, eligible, create };
  if (typeof module === 'object' && module.exports) module.exports = root.nativeWorkspaceResumeAll;
})(globalThis);
