const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const gate = require('./check-install-state.cjs');
const slot = process.env.NAW_GUI_SLOT, legacy = process.env.NAW_FRAMES_EXPECT === 'v3-legacy';
if (![undefined, 'v4', 'v3-legacy'].includes(process.env.NAW_FRAMES_EXPECT)) throw Error('NAW_FRAMES_EXPECT must be v4 or v3-legacy');
if (!slot || !path.isAbsolute(slot)) throw Error('Explicit canonical GUI slot required');
const token = randomUUID(); fs.mkdirSync(slot);
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex E', task: 'install frame background regression', pid: process.pid, token, at: new Date().toISOString() }));
let released = false;
const release = () => { if (released) return; if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token !== token) throw Error('GUI slot ownership changed'); fs.rmSync(slot, { recursive: true }); released = true; };
process.once('exit', () => { if (!released) try { release(); } catch { process.exitCode = 1; } });
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-install-window-'));
// v3-legacy: a copy of an older release's app/ beside this script (e.g. git archive of 287) answers without the Electron list.
const entry = path.join(profile, 'fixture.cjs'), source = path.resolve(__dirname, '../app');
fs.writeFileSync(entry, `const {app,BrowserWindow}=require('electron');
const {createOutboxBroker}=require(${JSON.stringify(path.join(source, 'computer-use-outbox-broker.cjs'))});
const {windowFrames}=require(${JSON.stringify(path.join(source, 'window-frames.cjs'))});
app.setPath('userData',process.env.NAW_DATA_DIR);app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{app.dock?.hide();const options={x:100,y:120,width:640,height:480,show:false,focusable:false,skipTaskbar:true,opacity:0,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}};
const w=new BrowserWindow(options),b=new BrowserWindow(options);global.__testHumanWindow=w;global.__testBackgroundWindow=b;
const no=()=>{throw Error('No native action in this fixture');};
global.__testFrameCalls=[];
global.__testFrameBroker=await createOutboxBroker({descriptorFile:require('node:path').join(process.env.NAW_DATA_DIR,'outbox-owner.json'),bind:no,createView:no,windowFrames:(includeLocalPages,includeElectron)=>{global.__testFrameCalls.push([includeLocalPages,includeElectron]);
return windowFrames([{win:w,view:{owner:'synthetic-owner'},background:false},{win:b,view:{owner:'synthetic-background'},background:true}],includeLocalPages?[]:undefined,includeElectron?BrowserWindow.getAllWindows():undefined);}});
await Promise.all([w.loadURL('data:text/html,<p>Synthetic metadata fixture</p>'),b.loadURL('data:text/html,<p>Synthetic background fixture</p>')]);});`);
let app;
const synthetic = { version: '0.1.0-alpha.999', revision: 'a'.repeat(40) };
const state = windows => ({ profile: '/synthetic', gui: { pid: 1, started: 'x' }, views: [], windows, inferredMenuWindows: [],
  bundle: { ...synthetic, runtimeHash: 'b'.repeat(16) }, backend: { ...synthetic, runtimeHash: 'b'.repeat(16) }, dsh: { status: 'qualified', digest: 'same' } });
(async () => {
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, TZ: 'America/Los_Angeles', NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  await app.firstWindow();
  await app.evaluate(async () => { while (!global.__testFrameBroker) await new Promise(resolve => setTimeout(resolve, 20)); });
  const pid = app.process().pid;
  const timezoneSplit = JSON.parse(fs.readFileSync(path.join(profile, 'outbox-owner.json'))).issuer.started !== gate.processInfo(pid).started;
  assert.equal(timezoneSplit, true, 'local issuer time and UTC installer time are distinct proof formats');
  let windows = [], inferredMenuWindows, offscreenWindows, expected;
  for (let n = 0; n < 20; n++) {
    expected = await app.evaluate(() => { const w = global.__testHumanWindow; return { bounds: w.getBounds(), focused: w.isFocused(), opacity: w.getOpacity(), visible: w.isVisible() }; });
    ({ windows, inferredMenuWindows, offscreenWindows } = gate.windowFrames(gate.processInfo(pid), undefined, profile));
    if (windows.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(windows.length, 1, 'Only the positively identified human recovery window belongs in the result');
  assert.equal(gate.geometry([{ owner: 'synthetic-owner', bounds: expected.bounds }], windows), true);
  assert.equal(expected.focused, false); assert.equal(expected.opacity, 0); assert.equal(expected.visible, false);
  assert.ok(windows.every(w => Object.keys(w).sort().join() === 'bounds,cgBounds,frameBasis,id,onScreen,owner,pid'));
  const calls = await app.evaluate(() => global.__testFrameCalls);
  assert.deepEqual(calls.at(-1), legacy ? [true, undefined] : [true, true], 'the installer reached the expected frame version');
  assert.ok(Array.isArray(offscreenWindows) && offscreenWindows.length <= 1);
  const background = await app.evaluate(() => { const w = global.__testBackgroundWindow; return { visible: w.isVisible(), focusable: w.isFocusable(), focused: w.isFocused() }; });
  assert.deepEqual(background, { visible: false, focusable: false, focused: false });
  await app.evaluate(async ({ BrowserWindow }) => {
    const u = new BrowserWindow({ width: 320, height: 240, show: false, focusable: false, skipTaskbar: true, opacity: 0,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    global.__testUnknownWindow = u; await u.loadURL('data:text/html,<p>Unclaimed synthetic human window</p>');
  });
  let unknown;
  if (legacy) {
    // An older GUI cannot list its BrowserWindows: recorded as unproven, which compare() refuses after install.
    unknown = gate.windowFrames(gate.processInfo(pid), undefined, profile).offscreenWindows;
    assert.deepEqual(unknown.map(w => w.basis), ['unproven']);
    assert.equal(gate.compare({ ...state(windows), offscreenWindows: [] }, { ...state(windows), offscreenWindows: unknown }, synthetic)
      .find(r => r[0].startsWith('offscreen windows outside Electron'))[3], false);
  } else assert.throws(() => gate.windowFrames(gate.processInfo(pid), undefined, profile), /frame 口径待核实/);
  console.log(JSON.stringify({ pass: 1, fail: 0, pid, mode: legacy ? 'v3-legacy' : 'v4', calls, windows, inferredMenuWindows, offscreenWindows, expected, background,
    unknownWindow: legacy ? { recorded: unknown, postRefused: true } : 'refused', timezoneSplit, target: 'owned isolated GUI only', screenshots: 0, modelCalls: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { if (app) { try { await app.evaluate(async () => { await global.__testFrameBroker?.close(); }); } finally { await app.close(); } } } finally { try { await scratch.release(); } finally { release(); } }
});
