const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { executable, nativeEnvironment } = require('./platform.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function waitForPrevious(filename) {
  let previous;
  try { previous = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw Object.assign(new Error('UI host record is unreadable'), { code: 'NAW_UI_RECORD' }); }
  // Never signal a PID read from disk. Its original process may have exited.
  for (let i = 0; i < 30 && alive(previous.pid); i++) await delay(100);
  if (alive(previous.pid)) throw Object.assign(new Error('Previous UI host is still running'), { code: 'NAW_UI_BUSY' });
}

// Run the pinned, unmodified DSH Web profile behind the local desktop view.
// Its UI may restart; the native session service is a separate owner.
async function startDsh(dataDir) {
  const registry = path.join(dataDir, 'ui-host.json');
  await waitForPrevious(registry);
  const home = path.join(dataDir, 'dsh');
  const profile = path.join(home, 'profiles/web');
  fs.mkdirSync(path.join(profile, 'node_modules/@rulercompass'), { recursive: true, mode: 0o700 });
  const manifest = path.join(profile, 'package.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }), { mode: 0o600 });
  const link = path.join(profile, 'node_modules/@rulercompass/native-workspace');
  try { if (fs.readlinkSync(link) !== path.join(__dirname, 'dsh')) fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!fs.existsSync(link)) fs.symlinkSync(path.join(__dirname, 'dsh'), link);
  fs.copyFileSync(path.join(__dirname, 'dsh/profile.patch.yml'), path.join(profile, 'cordis.patch.yml'));
  const bin = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
  const node = executable('node');
  if (!node) throw Object.assign(new Error('Node.js is missing'), { code: 'NAW_NODE_MISSING' });
  const child = spawn(node, ['--require', path.join(__dirname, 'ui-parent-lease.cjs'), bin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: dataDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: nativeEnvironment({ DSH_HOME: home }),
  });
  if (child.pid) fs.writeFileSync(registry, JSON.stringify({ pid: child.pid, parentPid: process.pid }), { mode: 0o600 });
  child.once('exit', () => {
    try { if (JSON.parse(fs.readFileSync(registry, 'utf8')).pid === child.pid) fs.rmSync(registry); } catch {}
  });
  const stop = () => { if (child.connected) child.disconnect(); else if (child.exitCode === null) child.kill('SIGTERM'); };
  const url = await new Promise((resolve, reject) => {
    let pending = ''; const timer = setTimeout(() => { stop(); reject(new Error('DSH 界面服务启动超时；原生会话保持运行。')); }, 60000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { pending += chunk; if (pending.length > 100000) pending = pending.slice(-50000); const match = pending.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    // Tokens may appear in DSH diagnostics. Keep them out of logs and the UI.
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动 DSH 界面服务。')); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH 界面服务退出（${code}）；原生会话未被替换。`)); });
  });
  return { child, stop, url, origin: new URL(url).origin };
}
module.exports = { startDsh };
