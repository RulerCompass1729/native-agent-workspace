const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
function fixture(root, { stale = false } = {}) {
  const app = path.join(root, 'app'), profile = path.join(root, 'profile with spaces'), version = '0.1.0-alpha.999';
  fs.mkdirSync(path.join(app, 'app'), { recursive: true }); fs.mkdirSync(profile);
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../app/service-client.cjs'), 'utf8');
  fs.writeFileSync(path.join(app, 'app/service-client.cjs'), bootstrap);
  const list = name => [...bootstrap.match(new RegExp('const ' + name + ' = (\\[[^;]+\\]);'))[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const entries = [...list('names').map(name => [name, name]), ...list('pluginFiles').map(name => ['claude-bridge/' + name, 'claude-bridge/' + name]), ...list('pluginTests').map(name => ['claude-bridge/' + name, 'claude-bridge-tests/' + name])];
  for (const [name] of entries) { const file = path.join(app, 'app', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '// synthetic runtime entry ' + name); }
  fs.writeFileSync(path.join(app, 'app/daemon.cjs'), `
const loaded=require('./dsh-tui.cjs'),net=require('node:net'),fs=require('node:fs'),path=require('node:path');
const directory=process.argv[2],endpoint=process.env.INSTALL_FIXTURE_SOCKET;
const server=net.createServer(socket=>{let buffer='',authenticated=false;socket.on('data',data=>{
  buffer+=data;for(let at;(at=buffer.indexOf('\\n'))>=0;){const row=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
    if(!authenticated){if(row.token!=='synthetic-fixture-token'||row.page!==false){socket.destroy();return;}authenticated=true;socket.write(JSON.stringify({ready:true})+'\\n');}
    else if(row.method==='initial')socket.write(JSON.stringify({id:row.id,ok:true,value:{servicePid:process.pid,runtimeVersion:process.env.NAW_APP_VERSION,messages:['synthetic private sentinel']}})+'\\n');
    else socket.destroy();
  }
});});
server.listen(endpoint,()=>fs.writeFileSync(path.join(directory,'connection.json'),JSON.stringify({protocol:1,endpoint,token:'synthetic-fixture-token',pid:process.pid}),{mode:0o600}));
process.on('message',()=>{if(server.listening)process.send({loaded});else server.once('listening',()=>process.send({loaded}));});
`);
  fs.writeFileSync(path.join(app, 'app/dsh-tui.cjs'), 'module.exports={sha:"new"};');
  const identity = createHash('sha256').update(version);
  for (const name of ['daemon.cjs', 'adapters.cjs', 'codex-terminal-bridge.cjs', 'workspace.cjs']) identity.update(fs.readFileSync(path.join(app, 'app', name)));
  const key = 'backends/' + identity.digest('hex').slice(0, 20), directory = path.join(profile, key), digest = createHash('sha256');
  for (const [name] of entries) digest.update(stale && name === 'dsh-tui.cjs' ? 'module.exports={sha:"old"};' : fs.readFileSync(path.join(app, 'app', name)));
  const runtimeHash = digest.digest('hex').slice(0, 16), runtime = path.join(directory, 'runtimes', runtimeHash);
  fs.mkdirSync(runtime, { recursive: true });
  for (const [name, destination] of entries) { const file = path.join(runtime, destination); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(app, 'app', name), file); }
  if (stale) fs.writeFileSync(path.join(runtime, 'dsh-tui.cjs'), 'module.exports={sha:"old"};');
  return { app, profile, version, directory, key, runtime, runtimeHash, entries };
}
async function start(value) {
  const child = spawn(process.execPath, [path.join(value.runtime, 'daemon.cjs'), value.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, NAW_APP_VERSION: value.version, INSTALL_FIXTURE_SOCKET: path.join(path.dirname(value.app), 'metadata.sock') } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const loaded = new Promise(resolve => child.once('message', resolve)); child.send('identify');
  let timer, report;
  try { report = await Promise.race([loaded, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic runtime did not start')), 3000); })]); }
  catch (error) { const done = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await done; throw error; }
  finally { clearTimeout(timer); }
  const started = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
  fs.writeFileSync(path.join(value.profile, 'services.json'), JSON.stringify({ format: 1, active: value.key, entries: [value.key] }));
  const lock = { format: 1, kind: 'service', directory: value.directory, pid: child.pid, started };
  fs.writeFileSync(path.join(value.directory, 'service.lock'), JSON.stringify(lock));
  return { child, loaded: report.loaded, lock, target: { app: value.app, executable: process.execPath, version: value.version, revision: 'a'.repeat(40) }, async close() { if (child.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await done; } } };
}
module.exports = { fixture, start };
