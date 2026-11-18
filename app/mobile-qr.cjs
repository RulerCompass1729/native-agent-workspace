'use strict';
// Core Image is local. The bearer link is sent through a pipe, never argv, a file, or diagnostics.
const path = require('node:path');
const unavailable = () => Error('The local pairing code could not be generated.');
async function generate(link, { spawn = require('node:child_process').spawn } = {}) {
  let site;
  try { site = new URL(link); } catch { throw unavailable(); }
  if (typeof link !== 'string' || link.length > 4096 || site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/mobile/' || site.search || !/^#pair=[A-Za-z0-9_-]{43}$/.test(site.hash)) throw unavailable();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, 'mobile-qr.jxa')], {
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe','pipe','pipe'] });
    let out = '', size = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(unavailable()) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 5000);
    child.on('error', () => finish(true)); child.stdin.on('error', () => finish(true));
    child.stdout.on('data', value => { size += value.length; if (size > 256 * 1024) { child.kill(); finish(true); } else out += value; });
    child.stderr.resume(); // Never put helper diagnostics or the link into a renderer/log.
    child.on('close', code => {
      const value = out.trim();
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || !Buffer.from(value,'base64').subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) finish(true);
      else finish(false, 'data:image/png;base64,' + value);
    });
    child.stdin.end(link);
  });
}
module.exports = { generate };
