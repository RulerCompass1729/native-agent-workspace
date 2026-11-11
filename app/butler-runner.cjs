'use strict';
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pythonExecutable, nativeEnvironment } = require('./platform.cjs');
const { butlerBinding } = require('./butler-backend.cjs');
const { failure } = require('./service-binding.cjs');
const helper = path.join(__dirname, 'butler-runner.py');
function receipt(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw failure('preflight-unconfirmed'); }
  if (typeof value?.credentialPresent !== 'boolean' || value.ok !== true || value.credentialPresent !== true) {
    const codes = ['profile-missing', 'profile-binding-mismatch', 'provider-binding-mismatch', 'profile-unreadable', 'profile-layout-unsupported', 'credential-missing'];
    throw failure(codes.includes(value?.reason) ? value.reason : 'preflight-unconfirmed');
  }
  return true;
}
function checkProfile() {
  const result = spawnSync(pythonExecutable(), [helper, '--check'], { env: nativeEnvironment(), encoding: 'utf8', timeout: 3000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] });
  receipt(result.stdout);
  if (result.status !== 0) throw failure('preflight-unconfirmed');
  return true;
}
function credentialPresent() { try { return checkProfile(); } catch { return false; } }
function spawnRunner(binary, args, binding, python) {
  binding = butlerBinding(binding);
  // This legacy transport is pinned; the shared backend accepts other hosts.
  if (binding.profile !== 'deepseek-pro' || binding.provider !== 'deepseek' || binding.model !== 'deepseek-v4-pro') throw failure('binding-mismatch');
  if (python === undefined) python = pythonExecutable();
  const pinned = ['--profile', binding.profile, '-c', 'model="deepseek-v4-pro"', '-c', 'model_provider="deepseek"',
    '-c', 'model_providers.deepseek.env_key="DEEPSEEK_API_KEY"'];
  const child = spawn(python, [helper, binary, ...pinned, ...args], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'], env: nativeEnvironment() });
  const preflight = new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(failure('preflight-unconfirmed')), 3000);
    const finish = fn => { clearTimeout(timer); fn(); };
    child.once('error', () => finish(() => reject(failure('preflight-unconfirmed'))));
    child.stdio[3].on('data', data => { text += data; if (text.length > 4096) { child.stdio[3].destroy(); finish(() => reject(failure('preflight-unconfirmed'))); } });
    child.stdio[3].once('end', () => finish(() => { try { resolve(receipt(text)); } catch (error) { reject(error); } }));
  });
  return { child, preflight };
}
module.exports = { credentialPresent, checkProfile, spawnRunner };
