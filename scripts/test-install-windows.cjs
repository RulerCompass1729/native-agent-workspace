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
const entry = path.join(profile, 'fixture.cjs');
fs.writeFileSync(entry, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',process.env.NAW_DATA_DIR);app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{app.dock?.hide();const w=new BrowserWindow({x:100,y:120,width:640,height:480,show:false,focusable:false,skipTaskbar:true,opacity:0,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadURL('data:text/html,<p>Synthetic metadata fixture</p>');});`);
let app;
(async () => {
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  await app.firstWindow();
  const pid = app.process().pid;
  let windows = [], expected;
  for (let n = 0; n < 20; n++) {
    expected = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { bounds: w.getBounds(), focused: w.isFocused(), opacity: w.getOpacity(), visible: w.isVisible() }; });
    windows = gate.windowFrames(gate.processInfo(pid));
    if (windows.length) break;
    if (n === 0) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(windows.length > 0, 'Own isolated GUI must be observable; empty metadata is not PASS');
  assert.equal(gate.geometry([{ bounds: expected.bounds }], windows), true);
  assert.equal(expected.focused, false); assert.equal(expected.opacity, 0);
  assert.ok(windows.every(w => Object.keys(w).sort().join() === 'bounds,cgBounds,frameBasis,id,onScreen,pid'));
  console.log(JSON.stringify({ pass: 1, fail: 0, pid, windows, expected, target: 'owned isolated GUI only', screenshots: 0, modelCalls: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { if (app) await app.close(); } finally { try { await scratch.release(); } finally { release(); } }
});
