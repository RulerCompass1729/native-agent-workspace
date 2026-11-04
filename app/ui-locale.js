// Read-only formatting shared by the native shell and startup page. DSH owns
// the preference and the renderer's locale service; this module stores neither.
(function (root) {
  const messages = typeof module === 'object' && module.exports ? require('./ui-messages.js') : root.nativeWorkspaceMessages;
  const tag = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
  function validPreference(value) { return value === null || typeof value === 'string' && tag.test(value); }
  function validSnapshot(value) {
    return value !== null && typeof value === 'object' && Array.isArray(value.languages) &&
      value.languages.every(language => typeof language === 'string') && validPreference(value.preference);
  }
  function snapshot(value, fallback = { languages: [], preference: null }) {
    const selected = validSnapshot(value) ? value : validSnapshot(fallback) ? fallback : { languages: [], preference: null };
    return Object.freeze({ languages: Object.freeze([...selected.languages]), preference: selected.preference });
  }
  function language(value) {
    const safe = snapshot(value);
    const explicit = safe.preference?.toLowerCase();
    if (explicit === 'zh' || explicit === 'en') return explicit;
    // Match the pinned DSH runtime: exact explicit ids; primary system tags.
    for (const requested of safe.languages) {
      const primary = requested.toLowerCase().split('-')[0];
      if (primary === 'zh' || primary === 'en') return primary;
    }
    return 'en';
  }
  function format(locale, key, params) {
    const template = messages[locale]?.[key] ?? messages.en[key];
    if (typeof template !== 'string') throw new Error('Unknown NAW display message');
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match) : template;
  }
  // Optional display metadata never changes the raw error or its control flags.
  // Unknown/future/older-backend values fall back to the original message.
  function readDisplayMessage(value, prefix, depth, budget) {
    try {
      if (--budget.remaining < 0 || depth > 3 || !['error.', 'notice.'].includes(prefix) || !value || value.version !== 1 || typeof value.key !== 'string' || !value.key.startsWith(prefix) || !Object.hasOwn(messages.en, value.key)) return null;
      const params = value.params ?? {};
      if (typeof params !== 'object' || Array.isArray(params)) return null;
      const names = [...new Set([...messages.en[value.key].matchAll(/\{(\w+)\}/g)].map(match => match[1]))];
      const entries = Object.entries(params);
      if (names.length !== entries.length || entries.some(([name, item]) => !names.includes(name) ||
        !(item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && item.length <= 16000))) return null;
      const message = { version: 1, key: value.key, params: Object.freeze(Object.fromEntries(entries)) };
      const hasCause = Object.hasOwn(value, 'cause'), hasParts = Object.hasOwn(value, 'parts');
      if (hasCause || hasParts || Object.hasOwn(value, 'causeParam') || Object.hasOwn(value, 'separator')) {
        if (prefix !== 'error.' || typeof value.causeParam !== 'string' || !names.includes(value.causeParam)) return null;
        if (hasCause === hasParts) return null;
        if (hasCause) {
          if (Object.hasOwn(value, 'separator')) return null;
          const cause = readDisplayMessage(value.cause, prefix, depth + 1, budget);
          if (!cause || !matchesOriginal(cause, message.params[value.causeParam])) return null;
          message.cause = cause;
        } else {
          if (!Array.isArray(value.parts) || !value.parts.length || value.parts.length > 64 || !['\n', ' '].includes(value.separator)) return null;
          const parts = [];
          for (const part of value.parts) {
            if (--budget.remaining < 0 || !part || typeof part.message !== 'string' || part.message.length > 16000) return null;
            const child = part.uiMessage == null ? null : readDisplayMessage(part.uiMessage, prefix, depth + 1, budget);
            if (part.uiMessage != null && (!child || !matchesOriginal(child, part.message))) return null;
            parts.push(Object.freeze({ message: part.message, uiMessage: child }));
          }
          if (parts.map(part => part.message).join(value.separator) !== message.params[value.causeParam]) return null;
          message.parts = Object.freeze(parts); message.separator = value.separator;
        }
        // Composition must describe the exact complete raw parameter. It may
        // never replace another field or hide an unknown original reason.
        message.causeParam = value.causeParam;
      }
      return Object.freeze(message);
    } catch { return null; }
  }
  function displayMessage(value, prefix = 'error.', raw) {
    const message = readDisplayMessage(value, prefix, 0, { remaining: 256 });
    return message && (arguments.length < 3 || matchesOriginal(message, raw)) ? message : null;
  }
  function matchesOriginal(message, raw) { return ['zh', 'en'].some(locale => format(locale, message.key, message.params) === raw); }
  function createError(key, params, options) {
    if (typeof key !== 'string' || !key.startsWith('error.') || !Object.hasOwn(messages.en, key)) throw new Error('Invalid NAW error display message');
    let rawLanguage = 'zh';
    try { if (options?.rawLanguage === 'en') rawLanguage = 'en'; } catch {}
    const error = new Error(format(rawLanguage, key, params));
    let uiMessage = displayMessage({ version: 1, key, params });
    if (!uiMessage || !matchesOriginal(uiMessage, error.message)) return error;
    try {
      const cause = options?.cause, param = options?.param;
      const causeMessage = displayMessage(cause?.uiMessage);
      if (causeMessage && typeof param === 'string' && Object.hasOwn(uiMessage.params, param) &&
        uiMessage.params[param] === cause.message && matchesOriginal(causeMessage, cause.message)) {
        uiMessage = displayMessage({ ...uiMessage, cause: causeMessage, causeParam: param }) || uiMessage;
      }
      if (!uiMessage.cause && Array.isArray(options?.parts) && options.parts.length > 0 && options.parts.length <= 64) {
        const parts = options.parts.map(part => {
          const child = displayMessage(part?.uiMessage);
          return { message: part?.message, uiMessage: child && matchesOriginal(child, part.message) ? child : null };
        });
        uiMessage = displayMessage({ ...uiMessage, parts, causeParam: param, separator: options.separator }) || uiMessage;
      }
    } catch { /* Optional display metadata must not replace the original error. */ }
    return Object.assign(error, { uiMessage });
  }
  function createNotice(key, params) {
    const uiMessage = displayMessage({ version: 1, key, params }, 'notice.');
    if (!uiMessage) throw new Error('Invalid NAW notice display message');
    return { text: format('zh', key, uiMessage.params), uiMessage };
  }
  function renderMessage(locale, value) {
    const replacement = value.cause ? renderMessage(locale, value.cause) : value.parts?.map(part => part.uiMessage ? renderMessage(locale, part.uiMessage) : part.message).join(value.separator);
    const params = value.cause || value.parts ? { ...value.params, [value.causeParam]: replacement } : value.params;
    return format(locale, value.key, params);
  }
  function displayText(locale, raw, value) {
    const message = displayMessage(value, 'notice.') || displayMessage(value);
    return message && matchesOriginal(message, raw) ? renderMessage(locale, message) : raw;
  }
  function errorText(locale, error, fallback = 'error.operation') {
    const message = displayMessage(error?.uiMessage);
    return message && matchesOriginal(message, error?.message) ? renderMessage(locale, message) : typeof error?.message === 'string' && error.message ? error.message : format(locale, fallback);
  }
  const startupKeys = Object.freeze({ NAW_NODE_MISSING: 'startup.nodeMissing', NAW_UI_BUSY: 'startup.uiBusy', NAW_UI_RECORD: 'startup.uiRecord', NAW_VIEW_RECORD: 'startup.viewRecord' });
  const startupCode = code => typeof code === 'string' && Object.hasOwn(startupKeys, code) ? code : null;
  const startupMessage = (locale, code) => format(locale, startupKeys[startupCode(code)] || 'startup.generic') + '\n' + format(locale, 'startup.nativeRetained');
  const api = Object.freeze({ validPreference, validSnapshot, snapshot, language, format, displayMessage, displayText, createError, createNotice, errorText, startupCode, startupMessage });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceLocale = api;
})(globalThis);
