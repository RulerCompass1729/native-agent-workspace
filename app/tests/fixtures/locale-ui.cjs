// VM fixtures use the production display bindings, without booting an app or provider.
const fs = require('node:fs'), vm = require('node:vm');
const locale = require('../../ui-locale.js');
const source = fs.readFileSync(require.resolve('../../dsh/bootstrap.js'), 'utf8');
const start = source.indexOf('    function createDisplayBindings(');
const end = source.indexOf('    function mountWorkspace(', start);
if (start < 0 || end < start) throw new Error('Production display bindings were not found');
const createBindings = vm.runInNewContext('(' + source.slice(start, end).trim() + ')');
module.exports = function localeUI(language = 'zh') {
  const uiText = (key, params) => locale.format(language, key, params);
  const display = createBindings(uiText);
  const ui = {
    display, language: { text: uiText, getSnapshot: () => ({ active: language }) },
    createError: locale.createError,
    displayText: (raw, message) => locale.displayText(language, raw, message),
    showError(el, error) { display.unbind(el); el.textContent = locale.errorText(language, error); },
  };
  return { ui, uiText, setLanguage(value) { language = value; }, uiError: locale.createError, uiLocale: locale, displayText: ui.displayText, displayLanguage: () => language };
};
