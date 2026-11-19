'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const { readSource } = require('./regular-popup-source.cjs'), { validateInput } = require('./regular-popup-dsh.cjs');
function sandboxProfile({ home, code, modules, execPath, port }) {
  if (![home, code, modules, execPath].every(p => typeof p === 'string' && path.isAbsolute(p)) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('sandbox-invalid');
  home = fs.realpathSync(home); code = fs.realpathSync(code); modules = fs.realpathSync(modules); execPath = fs.realpathSync(execPath);
  const quote = JSON.stringify, read = [...new Set([home, code, modules, path.dirname(path.dirname(execPath)), '/System', '/usr/lib', '/usr/share', '/private/etc/ssl', '/Library/Apple'])].map(p => `(subpath ${quote(p)})`).join(' ');
  // The loader traverses ancestor directories; their descendant files remain denied.
  const ancestors = new Set();
  for (const entry of [home, code, modules, execPath]) { let parent = entry; while (true) { ancestors.add(parent); const next = path.dirname(parent); if (next === parent) break; parent = next; } }
  const traversal = [...ancestors].map(p => `(literal ${quote(p)})`).join(' ');
  return `(version 1)(allow default)(deny file-read* file-write*)(deny process-exec)(deny network*)(allow process-exec (literal ${quote(execPath)}))(allow file-read* ${read} ${traversal} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))(allow file-write* (subpath ${quote(home)}) (literal "/dev/null"))(allow network-outbound (remote tcp4 ${quote('localhost:' + port)}))`;
}
async function runWorker(input, { directory, signal, authorize }, deps = {}) {
  validateInput(input); if (signal?.aborted) throw Error('cancelled');
  if (new Date().getUTCFullYear() !== 2026) throw Error('pricing-unqualified');
  let key, home, proxy, child, identity;
  try {
    key = await (deps.readKey || require('./dsh-tui.cjs').readKey)();
    if (signal?.aborted) throw Error('cancelled');
    home = fs.mkdtempSync(path.join(directory, 'discovery-worker-')); fs.chmodSync(home, 0o700); identity = fs.lstatSync(home);
    proxy = await (deps.egress || require('./dsh-egress.cjs')).startEgress({ onViolation: () => child?.kill('SIGTERM') });
    if (signal?.aborted) throw Error('cancelled');
    const execPath = deps.execPath || process.execPath, entry = deps.entry || path.join(__dirname, 'regular-popup-worker.mjs');
    const code = path.dirname(__dirname), modules = fs.realpathSync(path.resolve(path.dirname(require.resolve('@deepseek-ai/cordis')), '../../..'));
    const profile = sandboxProfile({ home, code, modules, execPath, port: proxy.port });
    const result = await new Promise((resolve, reject) => {
      let out = '', pending = '', stopped = false, killTimer, authorized = false, result;
      const abort = () => { child?.kill('SIGTERM'); killTimer ||= setTimeout(() => child?.kill('SIGKILL'), 1000); };
      const timer = setTimeout(abort, 40000);
      const finish = (error, value) => { if (stopped) return; stopped = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); error ? reject(Error('provider-unconfirmed')) : resolve(value); };
      try { child = (deps.spawn || spawn)('/usr/bin/sandbox-exec', ['-p', profile, execPath, '--disable-sigusr1', entry], {
        cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home, DSH_HOME: home, TMPDIR: home, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:' + proxy.port, HTTPS_PROXY: 'http://127.0.0.1:' + proxy.port, DEEPSEEK_API_KEY: key }, stdio: ['pipe', 'pipe', 'ignore'] });
        key = undefined; signal?.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
          out += chunk; pending += chunk; if (Buffer.byteLength(out) > 20000) { abort(); return; }
          let end; while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            try { const message = JSON.parse(line);
              if (message.authorize === true && Object.keys(message).length === 1 && !authorized && !signal?.aborted && typeof authorize === 'function') {
                const grant = authorize(); if (!/^\d{4}-\d{2}-\d{2}$/.test(grant?.budgetDay)) throw Error(); authorized = true;
                child.stdin.write(JSON.stringify({ authorized: true, budgetDay: grant.budgetDay }) + '\n');
              } else if (authorized && result === undefined && !Object.hasOwn(message, 'authorize')) result = message;
              else throw Error();
            } catch { abort(); }
          }
        });
        child.on('error', () => finish(Error())); child.on('close', code => { if (code !== 0 || signal?.aborted || proxy.violated || !authorized || result === undefined || pending.trim()) return finish(Error()); finish(null, result); });
        child.stdin.on('error', () => {}); child.stdin.write(JSON.stringify(input) + '\n'); if (signal?.aborted) abort();
      } catch { finish(Error()); }
    });
    const current = fs.lstatSync(home); if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink()) throw Error('owner-changed');
    return result;
  } catch { throw Error('provider-unconfirmed'); }
  finally { key = undefined; await proxy?.close().catch(() => {}); if (home && identity) { const s = fs.lstatSync(home); if (!s.isSymbolicLink() && s.isDirectory() && s.uid === process.getuid() && s.dev === identity.dev && s.ino === identity.ino) fs.rmSync(home, { recursive: true }); } }
}
function createTransport({ directory }) {
  const controller = new AbortController();
  return { readSource: options => readSource({ signal: AbortSignal.any([controller.signal, options.signal]) }),
    select: (input, options) => runWorker(input, { directory, signal: AbortSignal.any([controller.signal, options.signal]), authorize: options.authorize }), close: () => controller.abort() };
}
module.exports = { createTransport, runWorker, sandboxProfile };
