'use strict';
const path = require('node:path');
const { connectService } = require('../app/service-connection.cjs');
async function readVersion(directory) {
  if (!path.isAbsolute(directory || '')) throw Error('Backend directory required');
  const client = await connectService(directory, 'install-version-check', { page: false });
  let timer;
  try {
    const state = await Promise.race([client.call('initial'), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Version deadline')), 2000);
    })]);
    if (!Number.isSafeInteger(state?.servicePid) || state.servicePid < 2 || typeof state.runtimeVersion !== 'string' || !/^0\.1\.0-alpha\.\d+$/.test(state.runtimeVersion)) throw Error('Version unavailable');
    // The initial frame can contain content; only metadata leaves this short-lived process.
    return { servicePid: state.servicePid, runtimeVersion: state.runtimeVersion };
  } finally { clearTimeout(timer); client.socket.destroy(); }
}
module.exports = { readVersion };
if (require.main === module) readVersion(process.argv.length === 3 ? process.argv[2] : null).then(value => {
  console.log(JSON.stringify(value));
}).catch(() => { console.error('Backend version unconfirmed'); process.exitCode = 1; });
