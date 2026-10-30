// Synthetic native boundary for an isolated real Unix RPC test. No provider boot.
const fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const directory = process.argv[2];
if (!directory || fs.realpathSync(directory) !== process.env.NAW_MOBILE_FIXTURE_ROOT) throw Error('Isolated mobile fixture root required');
const calls = [];
process.on('message', value => {
  if (value?.mobileFixture === 'stats') process.send?.({ mobileFixtureStats: value.id, calls });
});
class MobileFixtureHost {
  constructor() { this.binaries = { claude: 'synthetic', codex: 'synthetic' }; }
  async start() {}
  create(record) {
    record.nativeId ||= randomUUID();
    const r = new EventEmitter(); r.chatAvailable = true;
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, valid) => {
      if (!valid()) throw Object.assign(Error('Synthetic native guard rejected'), { notSent: true });
      calls.push({ text, tag, nativeId: record.nativeId }); r.emit('submitted', tag); r.emit('state', 'working');
    };
    r.stop = async () => r.emit('state', 'ended'); return r;
  }
  close() {}
}
require(path.resolve(__dirname, '../../adapters.cjs')).NativeHost = MobileFixtureHost;
