// An AX-rendering lease, not an input authority. The existing private broker
// owns its lifetime; the computer-use gate still qualifies every input/read.
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const FULL = ['nativeAPIs', 'webContents', 'inlineTextBoxes', 'extendedProperties'];
const REFUSAL = 'The exact NAW accessibility lease is unavailable; no action was sent.';
function createAccessibilityScope(app, windowExists) {
  let active = 0, added = [], readerBefore = false;
  return windowId => {
    if (!windowExists(windowId)) throw Error(REFUSAL);
    if (!active) {
      const before = app.getAccessibilitySupportFeatures();
      readerBefore = before.includes('screenReader');
      added = FULL.filter(feature => !before.includes(feature));
      app.setAccessibilitySupportFeatures([...new Set([...before, ...FULL])]);
    }
    active++; let released = false;
    return () => {
      if (released) return; released = true;
      if (--active) return;
      const current = app.getAccessibilitySupportFeatures();
      // A screen reader activated during the tool call keeps its complete tree.
      // Otherwise remove only our additions, preserving external feature changes.
      if (readerBefore || !current.includes('screenReader')) app.setAccessibilitySupportFeatures(current.filter(feature => !added.includes(feature)));
      added = [];
    };
  };
}
async function acquireAccessibility(target, descriptorFile = process.env.NAW_AX_OUTBOX_DESCRIPTOR) {
  const info = require('./computer-use-outbox-tool.cjs').privateFile(descriptorFile);
  const { processIdentity } = require('./platform.cjs');
  if (!target || Object.keys(target).sort().join(',') !== 'pid,started,windowId' ||
      info.version !== 1 || target.pid !== info.issuer?.pid || target.started !== info.issuer.started ||
      processIdentity(target.pid)?.started !== target.started || !Number.isSafeInteger(target.windowId) || target.windowId < 1 || target.windowId > 0xffffffff ||
      typeof info.capability !== 'string' || !/^[a-f0-9]{64}$/.test(info.capability) || typeof info.socketPath !== 'string' || !path.isAbsolute(info.socketPath)) throw Error(REFUSAL);
  const endpoint = fs.lstatSync(info.socketPath), parent = fs.lstatSync(path.dirname(info.socketPath));
  if (fs.realpathSync(info.socketPath) !== info.socketPath || !endpoint.isSocket() || endpoint.uid !== process.getuid() || (endpoint.mode & 0o777) !== 0o600 ||
      !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) throw Error(REFUSAL);
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.socketPath); let data = '', ready = false;
    const timer = setTimeout(() => refuse(), 3000);
    const refuse = () => { clearTimeout(timer); socket.destroy(); if (!ready) reject(Error(REFUSAL)); };
    socket.on('error', refuse); socket.on('end', refuse); socket.on('close', refuse);
    socket.on('connect', () => socket.write(JSON.stringify({ kind: 'accessibility', capability: info.capability, identity: target }) + '\n'));
    socket.on('data', chunk => {
      if (ready) return refuse();
      data += chunk; if (Buffer.byteLength(data) > 4096) return refuse();
      if (!data.includes('\n')) return;
      try { if (JSON.parse(data).accessibility !== 'ready') return refuse(); } catch { return refuse(); }
      ready = true; clearTimeout(timer);
      resolve(() => socket.destroy());
    });
  });
}
module.exports = { createAccessibilityScope, acquireAccessibility };
