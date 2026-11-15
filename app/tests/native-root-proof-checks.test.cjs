const test = require('node:test'), assert = require('node:assert/strict');
const { rootCall, consumeCredential } = require('../background-control-native.cjs');
const { classifyOutboxFailure } = require('../computer-use-outbox-native.cjs');
const changes = {
 aborted: f => f.abort.abort(), target: f => { f.current = false; }, 'native-blocks': f => { f.target.nativeBlocks = false; },
 disposed: f => { f.target.disposed = true; }, stopped: f => { f.target.stopped = true; }, 'root-ending': f => { f.target.rootEnding = {}; },
 'terminal-alive': f => { f.target.terminal.alive = false; }, 'native-context-pending': f => { f.target.record.nativeContextPending = {}; },
 'native-id': f => { f.target.record.nativeId = 'other-native'; }, 'root-binding': f => { f.target.validRootBinding = () => false; },
 'observation-epoch': f => { f.target.observationEpoch++; }, 'display-gap': f => { f.target.displayGap = true; },
 'live-turn-missing': f => { f.target.liveTurn = null; }, 'live-turn-reference': f => { f.target.liveTurn = { ...f.target.liveTurn }; },
 'live-turn-id': f => { f.target.liveTurn.id = 'other-turn'; }, 'live-prompt-id': f => { f.target.liveTurn.promptId = 'other-prompt'; },
};
function fixture() {
 const f = { abort: new AbortController(), current: true };
 f.target = { record: { provider: 'claude', nativeId: 'owned-native' }, nativeBlocks: true, terminal: { alive: true },
  observationEpoch: 1, liveTurn: { id: 'owned-turn', promptId: 'owned-prompt' }, validRootBinding: () => true };
 f.message = { arguments: { action: 'catalog' }, turnId: 'owned-turn', promptId: 'owned-prompt', callId: 'owned-call', epoch: 1 };
 f.proof = rootCall(f.target, f.message, f.abort.signal, () => f.current);
 return f;
}
for (const [name, change] of Object.entries(changes)) test(`native control names the failing original-root predicate: ${name}`, () => {
 const f = fixture(); change(f);
 assert.throws(() => consumeCredential(f.proof.credential), error => {
  const detail = classifyOutboxFailure(error);
  assert.equal(detail.failureReason, 'native-call-invalidated'); assert.equal(detail.failureCheck, name); return true;
 });
});
test('an unsent draft, composing flag and normal native progress do not change root authority', () => {
 const f = fixture();f.target.record.liveDraft = 'SYNTHETIC UNSENT DRAFT';f.target.composing = true;f.target.liveTurn.phase = 'thinking';
 assert.equal(consumeCredential(f.proof.credential).valid(), true);
 assert.throws(() => consumeCredential(f.proof.credential), error => classifyOutboxFailure(error).failureReason === 'duplicate-call');
});
test('mutating request metadata cannot retarget an already issued control identity', () => {
 const f = fixture();
 f.message.turnId = f.target.liveTurn.id = 'other-turn';
 f.message.promptId = f.target.liveTurn.promptId = 'other-prompt';
 assert.throws(() => consumeCredential(f.proof.credential), error => classifyOutboxFailure(error).failureCheck === 'live-turn-id');
});
test('a root-binding check exception is refused by name without copying its private exception', () => {
 const f = fixture();f.target.validRootBinding = () => { throw Error('PRIVATE_BINDING_VALUE'); };
 assert.throws(() => consumeCredential(f.proof.credential), error => {
  assert.equal(classifyOutboxFailure(error).failureCheck, 'root-binding');assert.doesNotMatch(error.message, /PRIVATE_BINDING_VALUE/);return true;
 });
});

for (const [name, mutate] of Object.entries({
 'retained-reader': t => { t.retainedReader = false; }, 'native-input-required': t => { t.nativeInputRequired = true; },
 'root-turn-missing': t => { t.rootTurn = null; }, 'root-turn-reference': t => { t.rootTurn = { ...t.rootTurn }; },
 'root-turn-status': t => { t.rootTurn.status = 'idle'; }, 'root-turn-id': t => { t.rootTurn.id = 'different'; },
 'root-prompt-id': t => { t.rootTurn.promptId = 'different'; }, 'native-permissions': t => { t.livePermissions.set('permission', {}); },
})) test(`retained HTTP outbox names its own validity policy: ${name}`, async t => {
 const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const { createSubmissionServer, consumeRootOutboxProof } = require('../claude-submit.cjs');
 const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'root-proof-http-'));
 const f = fixture(), target = { ...f.target, submission: {}, retainedReader: true, livePermissions: new Map(),
  rootTurn: { id: 'owned-turn', promptId: 'owned-prompt', status: 'working' } };
 const args = { recipient_id: 'recipient', message: 'SYNTHETIC TASK' }, socketPath = path.join(dir, 'root.sock');
 const server = createSubmissionServer(socketPath, new Map([['token', target]]), { restrictedOutboxCall: async credential => {
  mutate(target);
  try { consumeRootOutboxProof(credential); assert.fail('Revoked root must not send'); }
  catch (error) { return { status: 'unconfirmed', ...classifyOutboxFailure(error), retry: false }; }
 } });
 t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); fs.rmSync(dir, { recursive: true }); });
 await server.start();
 const result = await new Promise((resolve, reject) => {
  const req = http.request({ socketPath, method: 'POST', path: '/addressed-message', headers: { 'x-workspace-token': 'token' } }, res => {
   let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve(JSON.parse(body)));
  });req.on('error', reject);req.end(JSON.stringify({ ...f.message, sessionId: target.record.nativeId, arguments: args }));
 });
 assert.equal(result.status, 'unconfirmed');assert.equal(result.receipt.failureCheck, name);
});
