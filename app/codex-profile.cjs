// A Codex session can start from one of the person's Codex profiles (DeepSeek pro / flash):
// `codex --profile <name>` reads <CODEX_HOME>/<name>.config.toml. NAW runs one shared Codex
// service for all Codex sessions, and its thread/start takes no profile (a `profile` key in the
// thread's config is refused as legacy, Codex 0.168 measured), so a session started from a
// profile gets the file's top-level keys as that thread's config overrides. Measured on 0.168
// against a loopback fixture: model, model_provider, model_catalog_json and
// model_reasoning_effort given that way select the provider, its key variable and the catalog's
// context window and tools.
//
// A resumed thread keeps its provider, model and effort, but not the catalog (fallback context
// window, no apply_patch tool), so a resume passes the catalog again: catalogConfig().
//
// Only the flat part before the first [table] is read: strings, numbers and booleans. Tables
// (trust entries Codex adds) are not settings of the model. A line that cannot be read is
// refused, so a profile is never applied in part. Of the keys, only those choosing the model are
// taken (model, model_provider, model_catalog_json, model_reasoning_effort, ...): permission,
// sandbox and privacy settings stay those NAW gives every session, so a profile cannot loosen
// them unseen. Values are not logged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uiError } = require('./ui-errors.cjs');

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MODEL_KEY = /^model(?:_[a-z]+)*$/;
const MAX_BYTES = 64 * 1024;

function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function parseString(text, quote) {
  // Returns [value, rest] for a one-line basic ("...") or literal ('...') string.
  let value = '', index = 1;
  while (index < text.length) {
    const char = text[index];
    if (char === quote) {
      return [value, text.slice(index + 1)];
    }
    if (quote === '"' && char === '\\') {
      const next = text[index + 1];
      const simple = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
      if (next in simple) {
        value += simple[next];
        index += 2;
        continue;
      }
      if (next === 'u' && /^[0-9A-Fa-f]{4}$/.test(text.slice(index + 2, index + 6))) {
        value += String.fromCharCode(parseInt(text.slice(index + 2, index + 6), 16));
        index += 6;
        continue;
      }
      return null;
    }
    value += char;
    index += 1;
  }
  return null;
}

function parseValue(text) {
  const trimmed = text.trim();
  let value, rest;
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    return undefined;
  }
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const parsed = parseString(trimmed, trimmed[0]);
    if (!parsed) {
      return undefined;
    }
    [value, rest] = parsed;
  } else {
    const match = /^([^\s#]+)(.*)$/.exec(trimmed);
    if (!match) {
      return undefined;
    }
    [, value, rest] = match;
    if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else if (/^[+-]?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    } else {
      return undefined;
    }
  }
  rest = rest.trim();
  if (rest && !rest.startsWith('#')) {
    return undefined;
  }
  return value;
}

// The profile's top-level model keys, as a thread config object. Throws a UI error when the
// profile name is not a plain name, the file is missing or too large, a line cannot be read, or
// no model key is set.
function readCodexProfile(name, env = process.env) {
  if (typeof name !== 'string' || !PROFILE_PATTERN.test(name)) {
    throw uiError('error.workspace.invalidSettings');
  }
  let text;
  try {
    const file = path.join(codexHome(env), `${name}.config.toml`);
    if (fs.statSync(file).size > MAX_BYTES) {
      throw Error('too large');
    }
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw uiError('error.workspace.invalidSettings');
  }
  const config = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('[')) {
      break;
    }
    const equals = line.indexOf('=');
    const key = equals > 0 ? line.slice(0, equals).trim() : '';
    const value = equals > 0 ? parseValue(line.slice(equals + 1)) : undefined;
    if (!KEY_PATTERN.test(key) || value === undefined || key === 'profile') {
      throw uiError('error.workspace.invalidSettings');
    }
    if (MODEL_KEY.test(key)) {
      config[key] = value;
    }
  }
  if (!Object.keys(config).length) {
    throw uiError('error.workspace.invalidSettings');
  }
  return config;
}

// What a resumed thread must be given again: the catalog only. Its provider, model and effort
// stay as native recorded them, including changes the person made in the session.
function catalogConfig(name, env = process.env) {
  const config = readCodexProfile(name, env);
  return typeof config.model_catalog_json === 'string' ? { model_catalog_json: config.model_catalog_json } : null;
}

// The person's profiles that run another vendor's model, for the new-session dialog: name, model
// and vendor only. A profile that cannot be read is left out; so is one without a model or vendor,
// or one on OpenAI (that is plain Codex). At most MAX_PROFILES, in name order.
const MAX_PROFILES = 16;
function listCodexProfiles(env = process.env) {
  let names;
  try {
    names = fs.readdirSync(codexHome(env));
  } catch {
    return [];
  }
  const profiles = [];
  for (const file of names.sort()) {
    const match = /^(.+)\.config\.toml$/.exec(file);
    if (!match || !PROFILE_PATTERN.test(match[1])) {
      continue;
    }
    let config;
    try {
      config = readCodexProfile(match[1], env);
    } catch {
      continue;
    }
    const { model, model_provider: modelProvider } = config;
    if (typeof model !== 'string' || !model || typeof modelProvider !== 'string' || !PROFILE_PATTERN.test(modelProvider) || modelProvider === 'openai') {
      continue;
    }
    profiles.push({ name: match[1], model, modelProvider });
    if (profiles.length === MAX_PROFILES) {
      break;
    }
  }
  return profiles;
}

module.exports = { readCodexProfile, catalogConfig, listCodexProfiles, codexHome, PROFILE_PATTERN };
