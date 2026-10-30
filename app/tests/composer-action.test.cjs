const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const decision = source.slice(source.indexOf('function soloAction('), source.indexOf('function renderComposer('));
const interruptDecision = source.slice(source.indexOf('const pendingInterrupts ='), source.indexOf('let shareRevision ='));
// Pure decision regression, not a real legacy connection or DOM test. Native
// error journeys separately exercise the production snapshot and actual UI.
test('failure guidance cannot hide first-time legacy connection or claim plugin reload repairs an API error', () => {
  const s = { provider: 'claude', state: 'error', owner: 'owner', chatAvailable: false, legacyInputEligible: true };
  const action = () => vm.runInNewContext(interruptDecision + decision + ';soloAction(s)', { s, owner: 'owner', disconnected: false, nativeUsable: () => true, canResume: () => false });
  assert.equal(action().kind, 'connect');
  s.legacyInputPrepared = true;
  assert.equal(action().kind, 'terminal'); assert.match(action().hint, /原生请求未完成/);
  assert.ok(!action().hint.includes('/reload-plugins'));
  s.failedTurnInputAvailable = true;
  assert.equal(action().kind, 'send'); assert.match(action().hint, /不会自动重试/);
  s.nativeInputRequired = true; assert.equal(action().kind, 'terminal');
  s.nativeInputRequired = false; s.failedTurnInputAvailable = false;
  s.owner = 'other'; assert.equal(action().kind, 'claim');
  s.owner = 'owner'; s.state = 'idle'; assert.match(action().hint, /reload-plugins/);
});
test('local and cross-window pending interruption keep the next draft editable without suggesting native recovery', () => {
  const s = { id:'session', provider:'claude', state:'idle', owner:'owner', nativeInputRequired:true };
  const context = { s, owner:'owner', disconnected:false, nativeUsable:()=>true, canResume:()=>false };
  for (const local of [true,false]) {
    s.interruptPending = !local;
    const action = vm.runInNewContext(interruptDecision + decision + (local ? ';pendingInterrupts.add(s.id)' : '') + ';soloAction(s)', {...context});
    assert.equal(action.kind,'send');assert.equal(action.label,'等待中断确认');assert.match(action.hint,/编辑草稿/);
  }
});

test('root column requires explicit chat view and never implies a passive takeover', () => {
  const s = { id:'column', provider:'codex', state:'idle', owner:'owner', view:'terminal', chatAvailable:true };
  const context = { s, owner:'owner', disconnected:false, nativeUsable:()=>true, canResume:()=>false, focusedRoomMember:()=>false, mode:'terminal' };
  const action = () => vm.runInNewContext(interruptDecision + decision + ";soloAction(s,{column:true,mode:'chat'})", {...context});
  assert.equal(action().kind,'chat');
  s.owner='other';assert.equal(action().kind,'claim');
  s.owner='owner';s.view='chat';assert.equal(action().kind,'send');
  s.nativeInputRequired=true;assert.equal(action().kind,'terminal');
});
test('column native writes require positive matching native lifetime proof', () => {
  const proof = source.slice(source.indexOf('function currentTerminalDisplay('),source.indexOf('function canCaptureTerminal('));
  const entry={generation:2,nativeId:'native-a',epoch:'epoch-a'},record={id:'column',nativeId:'native-a',connectionRevision:2,terminalState:{alive:true,epoch:'epoch-a'}};
  const display=()=>vm.runInNewContext(proof+';currentTerminalDisplay(entry,record)',{entry,record,columnTerminalBinding:()=>({})});
  assert.equal(display(),true);
  record.terminalState.epoch=null;assert.equal(display(),false);
  record.terminalState.epoch='epoch-b';assert.equal(display(),false);
  record.terminalState.epoch='epoch-a';record.nativeId='native-b';assert.equal(display(),false);
  record.nativeId='native-a';record.nativeContextPending={reason:'resume'};assert.equal(display(),false);
});

test('column cancellation belongs to the in-flight composition, never ordinary future input', () => {
  const cancel = source.slice(source.indexOf('function cancelColumnComposition('),source.indexOf('function suspendColumnInputs('));
  const entry={composing:false,compositionOrigin:{cancelled:false},composition:null};
  const apply=()=>vm.runInNewContext(cancel+';cancelColumnComposition(entry)',{entry});
  apply();assert.equal(entry.compositionOrigin.cancelled,false);assert.equal(Object.keys(entry).length,3);
  entry.composing=true;apply();assert.equal(entry.compositionOrigin.cancelled,true);
  entry.composing=false;entry.composition={consumed:false,cancelled:false};apply();assert.equal(entry.composition.cancelled,true);
  entry.composition={consumed:true,cancelled:false};apply();assert.equal(entry.composition.cancelled,false);
});
