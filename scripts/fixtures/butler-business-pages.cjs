'use strict';
const { RoomState } = require('../../app/room-state.cjs');
const { ButlerRole } = require('../../app/butler-role.cjs');
const { ButlerBusiness } = require('../../app/butler-business.cjs');
const { ButlerReadAudit } = require('../../app/butler-read-audit.cjs');
// Actual private business projection/audit, synthetic records and designation.
function createBusiness(directory) {
  const person = Symbol('synthetic person');
  const role = new ButlerRole(directory, { authorizePerson: a => a === person });
  const runner = { runnerRef: 'fixture-runner', backendRef: 'fixture-backend', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
  const actor = { id: 'synthetic', nativeId: 'synthetic-native', provider: 'dsh', state: 'idle', roomIds: [], runner };
  if (!role.snapshot().revision) role.set(person, { identity: { sessionId: actor.id, nativeId: actor.nativeId }, runner }, 0);
  const room = new RoomState(directory);
  if (!room.queueItems().length) for (let i = 0; i < 50; i++) room.queueAdd(('Synthetic item ' + i + ': ' + 'Details: "quoted" and path\\part; ordinary text. '.repeat(160)).slice(0, 5900), null);
  const readAudit = new ButlerReadAudit(directory, { authorizePerson: value => value === person });
  const business = new ButlerBusiness({ role, roomState: room, view: () => ({ records: [actor] }), readAudit, dataDir: directory }).bind(actor, { selectionRevision: 1, runnerRef: runner.runnerRef });
  return { business, readAudit };
}
module.exports = function businessPages(directory) {
  const { business } = createBusiness(directory);
  const pages = []; let cursor;
  do { const page = business.invoke('readBusiness', { kind: 'queue', spaceId: 'shared', ...(cursor ? { cursor } : {}) }); pages.push(page); cursor = page.nextCursor; } while (cursor);
  return pages;
};
module.exports.createBusiness = createBusiness;
