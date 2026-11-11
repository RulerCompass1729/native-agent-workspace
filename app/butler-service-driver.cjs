'use strict';
// Trusted local dependency for ButlerBackend; never selects a normal service
// slot. Constructing it does not launch a provider or qualify any B4 gate.
const path = require('node:path'), fs = require('node:fs');
const { butlerBinding } = require('./butler-backend.cjs');
const binding = require('./service-binding.cjs');
const { connectService, ensureServiceAt } = require('./service-client.cjs');
const { createLock, readLock, ownerMayBeAlive, releaseLock } = require('./service-lock.cjs');
const { credentialPresent } = require('./butler-runner.cjs');
class ButlerServiceDriver {
  constructor(directory, { executablePath = process.execPath } = {}) {
    if (!path.isAbsolute(directory)) throw binding.failure('invalid-directory');
    this.store = path.join(directory, 'store'); this.executablePath = executablePath;
  }
  async probe(proof) {
    const client = await connectService(this.store, 'butler-driver');
    try {
      const state = await client.call('initial');
      binding.assertBinding(state.serviceBinding, proof);
      if (state.runtimeVersion !== proof.runtimeVersion) throw binding.failure('binding-mismatch');
      const runner = await client.call('ensureButlerRunner', proof);
      binding.assertBinding(runner.binding, proof);
      if (runner.credentialPresent !== true || runner.nativeReady !== true) throw binding.failure('runner-unconfirmed');
      return { status: 'present', binding: proof };
    } finally { client.close(); }
  }
  async recover(value) {
    const proof = butlerBinding(value), stored = binding.readBinding(this.store);
    if (stored) binding.assertBinding(stored, proof);
    else if (fs.readdirSync(this.store).length) throw binding.failure('binding-mismatch');
    try { return await this.probe(proof); }
    catch (error) {
      // Identity/provider failures are not absence. Neither is an unreadable
      // connection record or an uncertain native child left by a dead daemon.
      if (error.code === 'binding-mismatch') throw error;
      for (const [name, kind] of [['service.lock', 'service'], ['services.lock', 'startup']]) {
        if (!fs.existsSync(path.join(this.store, name))) continue;
        const record = readLock(path.join(this.store, name));
        if (!record || ownerMayBeAlive(record, this.store, kind)) throw binding.failure('owner-unconfirmed');
      }
      if (!binding.runnerAbsent(this.store)) throw binding.failure('runner-exit-unconfirmed');
      // Only a never-started store or a proven former daemon can be absent.
      if (fs.existsSync(path.join(this.store, 'connection.json'))) throw binding.failure('liveness-unconfirmed');
      return { status: 'absent' };
    }
  }
  async start(value) {
    const proof = butlerBinding(value);
    binding.reserveBinding(this.store, proof);
    const file = path.join(this.store, 'services.lock');
    if (fs.existsSync(file)) {
      const old = readLock(file);
      if (!old || ownerMayBeAlive(old, this.store, 'startup') || !releaseLock(file, old)) throw binding.failure('owner-unconfirmed');
    }
    const lock = createLock(file, 'startup', this.store);
    try {
      await ensureServiceAt(this.store, this.executablePath, path.join(this.store, 'workspace'), false, proof);
      return await this.probe(proof);
    } finally { releaseLock(file, lock); }
  }
}
module.exports = { ButlerServiceDriver, credentialPresent };
