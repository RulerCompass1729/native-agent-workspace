const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const gate = require('./check-install-state.cjs');
const slot = process.env.NAW_GUI_SLOT;
if (!slot || !path.isAbsolute(slot)) throw Error('Explicit canonical GUI slot required');
const token = randomUUID(); fs.mkdirSync(slot);
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex E', task: 'r8 isolated window metadata', pid: process.pid, token, at: new Date().toISOString() }));
let released = false;
const release = () => { if (released) return; if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token !== token) throw Error('GUI slot ownership changed'); fs.rmSync(slot, { recursive: true }); released = true; };
process.once('exit', () => { if (!released) try { release(); } catch { process.exitCode = 1; } });
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-install-window-'));
const entry = path.join(profile, 'fixture.cjs'), source = path.resolve(__dirname, '../app');
fs.writeFileSync(entry, `const {app,BrowserWindow}=require('electron');
const {createOutboxBroker}=require(${JSON.stringify(path.join(source, 'computer-use-outbox-broker.cjs'))});
const {windowFrames}=require(${JSON.stringify(path.join(source, 'window-frames.cjs'))});
app.setPath('userData',process.env.NAW_DATA_DIR);app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{app.dock?.hide();const w=new BrowserWindow({x:100,y:120,width:640,height:480,show:false,focusable:false,skipTaskbar:true,opacity:0,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
const no=()=>{throw Error('No native action in this fixture');};
global.__testFrameBroker=await createOutboxBroker({descriptorFile:require('node:path').join(process.env.NAW_DATA_DIR,'outbox-owner.json'),bind:no,createView:no,windowFrames:()=>windowFrames([{win:w,view:{owner:'synthetic-owner'},background:false}])});
await w.loadURL('data:text/html,<p>Synthetic metadata fixture</p>');});`);
let app;
(async () => {
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, TZ: 'America/Los_Angeles', NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  await app.firstWindow();
  await app.evaluate(async () => { while (!global.__testFrameBroker) await new Promise(resolve => setTimeout(resolve, 20)); });
  const pid = app.process().pid;
  const timezoneSplit = JSON.parse(fs.readFileSync(path.join(profile, 'outbox-owner.json'))).issuer.started !== gate.processInfo(pid).started;
  assert.equal(timezoneSplit, true, 'local issuer time and UTC installer time are distinct proof formats');
  let windows = [], expected;
  for (let n = 0; n < 20; n++) {
    expected = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { bounds: w.getBounds(), focused: w.isFocused(), opacity: w.getOpacity(), visible: w.isVisible() }; });
    windows = gate.windowFrames(gate.processInfo(pid), undefined, profile);
    if (windows.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(windows.length > 0, 'Own isolated GUI must be observable; empty metadata is not PASS');
  assert.equal(gate.geometry([{ owner: 'synthetic-owner', bounds: expected.bounds }], windows), true);
  assert.equal(expected.focused, false); assert.equal(expected.opacity, 0); assert.equal(expected.visible, false);
  assert.ok(windows.every(w => Object.keys(w).sort().join() === 'bounds,cgBounds,frameBasis,id,onScreen,owner,pid'));
  console.log(JSON.stringify({ pass: 1, fail: 0, pid, windows, expected, timezoneSplit, target: 'owned isolated GUI only', screenshots: 0, modelCalls: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { if (app) { await app.evaluate(async () => { await global.__testFrameBroker?.close(); }); await app.close(); } } finally { try { await scratch.release(); } finally { release(); } }
});
