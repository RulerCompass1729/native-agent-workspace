// Current source reporting the capabilities of a backend that predates other
// collaboration spaces; never an old binary. Only the `initial` reply changes.
require('./collaboration-overview.cjs');
const path = require('node:path');
const transport = require(path.join(process.env.NAW_TEST_APP_ROOT, 'app/service-transport.cjs'));
const createWriter = transport.createWriter, removed = new Set(['collaborationSpacesV1', 'spaceMergeV1']);
transport.createWriter = (...args) => {
  const writer = createWriter(...args), send = writer.send;
  writer.send = (value, key) => send(value?.ok && Array.isArray(value.value?.capabilities)
    ? { ...value, value: { ...value.value, capabilities: value.value.capabilities.filter(name => !removed.has(name)) } } : value, key);
  return writer;
};
