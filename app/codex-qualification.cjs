// Codex version gates, one per capability (B3). Each static list is the set of
// exact versions that capability was qualified for by hand; together they
// reproduce the gates that used to be written inline. Automatic qualification
// can add a version for one capability only through allows(); quirk gates that
// exist for one old version's behaviour (adapters.cjs nativeUnsupportedTurns on
// 0.163, legacy-codex.cjs shared replies on 0.163, scoped-outbox-runtime.cjs
// terminal edits on 0.167) are not capabilities here and are never extended.
const STATIC = Object.freeze({
  // Outside history, turn metadata hydration and paged thread reads (native-history.cjs, adapters.cjs).
  history: Object.freeze(['0.163.0', '0.164.0', '0.165.0', '0.167.0']),
  // Input sent into the running native turn.
  steer: Object.freeze(['0.163.0', '0.164.0', '0.165.0', '0.167.0']),
  // The attached terminal goes through NAW's bridge instead of the raw socket.
  terminalBridge: Object.freeze(['0.163.0', '0.164.0', '0.165.0', '0.166.0', '0.167.0']),
  // Images forwarded from a shared space into a native turn.
  spaceImages: Object.freeze(['0.166.0', '0.167.0']),
  // The workspace message tool called from a native turn.
  addressedTool: Object.freeze(['0.164.0', '0.165.0', '0.166.0', '0.167.0']),
  // Automatic continuation after a capacity failure.
  capacity: Object.freeze(['0.164.0', '0.165.0', '0.166.0', '0.167.0']),
});
const CAPABILITIES = Object.freeze(Object.keys(STATIC));

// Decisions written by automatic qualification: version -> { capabilities: { name: true } }.
let automatic = Object.create(null);

function allows(capability, version) {
  if (!Object.hasOwn(STATIC, capability)) throw Error(`Unknown Codex capability ${capability}`);
  if (typeof version !== 'string') return false;
  return STATIC[capability].includes(version) || automatic[version]?.capabilities?.[capability] === true;
}
function setAutomatic(table) { automatic = Object.assign(Object.create(null), table || {}); }

module.exports = { STATIC, CAPABILITIES, allows, setAutomatic };
