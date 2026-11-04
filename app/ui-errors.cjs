// Startup never displays an upstream Error.message: Electron load errors contain the
// entire URL, including the private DSH access token. Only fixed codes map to
// application-owned display text in the shared catalog.
const { startupMessage: formatStartup, createError: uiError, createNotice: uiNotice } = require('./ui-locale.js');
function startupMessage(error, language = 'zh') { return formatStartup(language, error?.code); }
function uiActivity(key, params) { const notice = uiNotice(key, params); return [notice.text, notice.uiMessage]; }
function setActivity(record, text, uiMessage) {
  record.activity = text;
  if (uiMessage) record.activityUiMessage = uiMessage; else delete record.activityUiMessage;
}
function setWarning(record, field, key) {
  const error = uiError(key);
  record[field] = error.message; record[field + 'UiMessage'] = error.uiMessage;
}
module.exports = { startupMessage, uiError, uiNotice, uiActivity, setActivity, setWarning };
