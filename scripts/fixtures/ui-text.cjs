// GUI scripts wait for the app's own text: a pattern from the zh catalog template (tests run in Chinese), each
// {param} matching any text. No wording is hard-coded, so a reworded or reverted string fails the wait.
const path = require('node:path');
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function textPattern(key, code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..')) {
  const template = require(path.join(code, 'app/ui-messages.js')).zh[key];
  if (typeof template !== 'string') throw Error('Unknown catalog key ' + key);
  return new RegExp('^' + template.split(/\{\w+\}/).map(literal).join('.+') + '$');
}
module.exports = { textPattern };
