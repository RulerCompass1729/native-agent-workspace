// Build-time only. The native service, DSH host and Claude MCP need RunAsNode.
const fs = require('node:fs');
const path = require('node:path');
// Electron's published fuse-wire marker (@electron/fuses 2.1.3, MIT).
const marker = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
async function oneWire(file) {
  let tail = Buffer.alloc(0), count = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const data = Buffer.concat([tail, chunk]);
    for (let at = data.indexOf(marker); at !== -1; at = data.indexOf(marker, at + 1)) count++;
    tail = data.subarray(Math.max(0, data.length - marker.length + 1));
  }
  if (count !== 1) throw Error(`Expected one Apple Silicon fuse wire, found ${count}.`);
}
async function wire(app) {
  const sdk = await import('@electron/fuses');
  await oneWire(sdk.pathToFuseFile(app));
  const current = await sdk.getCurrentFuseWire(app);
  if (current.version !== sdk.FuseVersion.V1) throw Error('Unsupported Electron fuse version.');
  return { sdk, current };
}
async function verifyPackageFuses(app) {
  const { sdk, current } = await wire(app), F = sdk.FuseV1Options;
  if (current[F.RunAsNode] !== sdk.FuseState.ENABLE || current[F.EnableNodeOptionsEnvironmentVariable] !== sdk.FuseState.DISABLE || current[F.EnableNodeCliInspectArguments] !== sdk.FuseState.DISABLE) throw Error('Packaged Electron fuse policy did not verify.');
  return current;
}
async function inspectVendorFuses(app) {
  const result = await wire(app), { sdk, current } = result, F = sdk.FuseV1Options;
  for (const key of [F.RunAsNode, F.EnableNodeOptionsEnvironmentVariable, F.EnableNodeCliInspectArguments]) if (current[key] !== sdk.FuseState.ENABLE) throw Error('Expected supported, enabled vendor fuses before packaging.');
  return result;
}
async function afterExtractFuses({ buildPath, platform }) {
  if (platform !== 'darwin') throw Error('Fuse policy is verified for macOS only.');
  const app = path.join(buildPath, 'Electron.app');
  if (!fs.statSync(app).isDirectory()) throw Error('Extracted Electron.app is unavailable.');
  const { sdk, current: before } = await inspectVendorFuses(app), F = sdk.FuseV1Options;
  // A removed fuse can be overwritten by the SDK even though Electron ignores
  // it. Require the known vendor defaults before making either change.
  await sdk.flipFuses(app, { version: sdk.FuseVersion.V1,
    [F.RunAsNode]: true,
    [F.EnableNodeOptionsEnvironmentVariable]: false,
    [F.EnableNodeCliInspectArguments]: false,
  });
  const after = await verifyPackageFuses(app);
  const changed = new Set([String(F.EnableNodeOptionsEnvironmentVariable), String(F.EnableNodeCliInspectArguments)]);
  if (Object.keys(after).length !== Object.keys(before).length || Object.entries(before).some(([key, value]) => !changed.has(key) && after[key] !== value)) throw Error('An unrelated Electron fuse changed.');
}
const packageFuseOptions = Object.freeze({ afterExtract: [afterExtractFuses] });
module.exports = { afterExtractFuses, verifyPackageFuses, inspectVendorFuses, packageFuseOptions };
