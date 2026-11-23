// Test-only gate around the shipped Workspace.resume: counts resumes in flight and can hold them,
// so a window test can see how many run at once. The resume itself is unchanged.
require('./background-control.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const original = Workspace.prototype.resume;
const started = [];
let inFlight = 0, most = 0, held = false, waiting = [];
Workspace.prototype.resume = async function (...args) {
  inFlight++; most = Math.max(most, inFlight); started.push(args[0]);
  try {
    if (held) await new Promise(resolve => waiting.push(resolve));
    await new Promise(resolve => setTimeout(resolve, 120));
    return await original.apply(this, args);
  } finally { inFlight--; }
};
process.on('message', q => {
  if (!['resumeHold', 'resumeRelease', 'resumeCount'].includes(q.method)) return;
  if (q.method === 'resumeHold') held = true;
  if (q.method === 'resumeRelease') { held = false; const go = waiting; waiting = []; go.forEach(resolve => resolve()); }
  process.send({ resumeRequestId: q.id, inFlight, most, held: waiting.length, started });
});
