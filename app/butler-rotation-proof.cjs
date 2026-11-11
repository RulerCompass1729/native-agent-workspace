'use strict';
const { createHash } = require('node:crypto');
const PROOF_FILE_NAME = 'butler-rotation-proof.json', MAX_LOG = 32 * 1024 * 1024;
const fail = () => { throw Object.assign(Error('ERR_BUTLER_STATE'), { code: 'ERR_BUTLER_STATE' }); };
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parseRotationProof(value) {
  if (!fields(value, ['version', 'selection', 'revision', 'prefix', 'identity']) || value.version !== 1 || !hex(value.selection) || !integer(value.revision) ||
      !fields(value.identity, ['sessionId', 'nativeId']) || !id(value.identity.sessionId) || !id(value.identity.nativeId) ||
      value.prefix !== null && (!fields(value.prefix, ['length', 'digest']) || !integer(value.prefix.length) || value.prefix.length > MAX_LOG || !hex(value.prefix.digest))) fail();
  return { version: 1, selection: value.selection, revision: value.revision,
    prefix: value.prefix === null ? null : { length: value.prefix.length, digest: value.prefix.digest },
    identity: { sessionId: value.identity.sessionId, nativeId: value.identity.nativeId } };
}
function initialRotationProof(state, prefix = null) {
  return parseRotationProof({ version: 1, selection: hash(state), revision: 0, prefix, identity: state.selected.identity });
}
function advanceRotationProof(proof, prefix, identity) {
  if (JSON.stringify(prefix) === JSON.stringify(proof.prefix) && JSON.stringify(identity) === JSON.stringify(proof.identity)) return proof;
  if (proof.revision === Number.MAX_SAFE_INTEGER) fail();
  return parseRotationProof({ ...proof, revision: proof.revision + 1, prefix, identity });
}
module.exports = { PROOF_FILE_NAME, parseRotationProof, initialRotationProof, advanceRotationProof, selectionFingerprint: hash };
Object.freeze(module.exports);
