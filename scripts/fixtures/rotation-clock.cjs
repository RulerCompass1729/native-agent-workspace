// electron -r for an isolated test window: the dispatcher's own constructor options (quiet times and minimum age) from
// the test, nothing else. No production code reads these. Refused without the test lease main.cjs itself verifies.
const path = require('node:path');
if (!process.env.NAW_TEST_PARENT_PID || !process.env.NAW_DATA_DIR) throw Error('rotation-clock: isolated test only');
const root = process.env.NAW_TEST_APP_ROOT, rules = require(path.join(root, 'app/queue-dispatch.cjs'));
const ALLOWED = ['quietMs', 'quietCompactMs', 'quietContextMs', 'memoryMinAgeMs'];
const given = JSON.parse(process.env.NAW_TEST_ROTATION_OPTIONS || '{}');
for (const [key, value] of Object.entries(given)) if (!ALLOWED.includes(key) || !Number.isSafeInteger(value) || value < 0) throw Error('rotation-clock: ' + key);
const Base = rules.QueueDispatcher;
rules.QueueDispatcher = class QueueDispatcher extends Base {
  constructor(options) { super({ ...options, ...given }); }
};
