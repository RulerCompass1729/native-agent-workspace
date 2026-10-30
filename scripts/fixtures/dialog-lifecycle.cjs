// Synthetic native transport/history only. No provider process or model call.
require('./collaboration-overview.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHistory } = require(path.join(root, 'app/native-history.cjs'));
const history = { nativeId: '11111111-2222-4333-8444-555555555555', cwd: process.env.NAW_WORKSPACE, name: 'Synthetic history', updatedAt: 1000, model: 'Fixture model' };
NativeHistory.prototype.ready = async function () { return {}; };
NativeHistory.prototype.list = async function () { return { data: [history], nextCursor: null }; };
NativeHistory.prototype.read = async function (id) { if (id !== history.nativeId) throw Error('Unknown fixture history'); return history; };
