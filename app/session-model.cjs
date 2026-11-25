// Changing the model of one session, never the person's defaults (N5). Claude is stopped once it is
// proven idle and resumed as the same native session with other flags; Codex takes the change over its
// own protocol, from the next turn on.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { uiError } = require('./ui-errors.cjs');

const CAPABILITY = 'sessionModelV1';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,119}$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
// Claude names no list of its own to ask for.
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NATIVE_DEFAULT = '原生默认';
const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'manual'];
const BYPASS = 'bypassPermissions';
const TAIL_BYTES = 256 * 1024;
// Whether the change was made is not known, or it was and the session did not come back.
const UNSURE_KEYS = ['error.modelChange.unconfirmed', 'error.modelChange.stopped'];

function validValue(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'effort,model' &&
    (value.model === null || typeof value.model === 'string' && MODEL_PATTERN.test(value.model)) &&
    (value.effort === null || typeof value.effort === 'string' && EFFORT_PATTERN.test(value.effort));
}

// What the session runs now; null where it has not said.
function current(record) {
  const settings = record.nativeSettings?.nativeId === record.nativeId ? record.nativeSettings : null;
  const model = settings?.model || record.model;
  const effort = record.provider === 'codex' ? settings?.effort : record.nativeEffort;
  return { model: typeof model === 'string' && MODEL_PATTERN.test(model) ? model : null,
    effort: typeof effort === 'string' && EFFORT_PATTERN.test(effort) ? effort : null };
}

function claudeChoices(record) {
  const now = current(record);
  const names = now.model && !CLAUDE_MODELS.includes(now.model) ? [now.model, ...CLAUDE_MODELS] : CLAUDE_MODELS;
  return { provider: 'claude', current: now, nativeDefault: true,
    models: names.map(model => ({ model, efforts: CLAUDE_EFFORTS })) };
}

// A Claude value as its launch flags: null is the person's own native default. Native takes any model name without
// a word, so it has to be one the session can choose.
function claudeValue(value, record) {
  if (!validValue(value) || value.effort !== null && !CLAUDE_EFFORTS.includes(value.effort) ||
      value.model !== null && !claudeChoices(record).models.some(entry => entry.model === value.model)) {
    throw uiError('error.modelChange.unknown', { model: String(value?.model ?? '') });
  }
  return { model: value.model, effort: value.effort };
}
// What the session's own transcript says: whether there is a conversation to resume, and the permission mode it was
// last in (written as Claude exits, also when no turn followed the change). Null when it cannot be read.
function claudeTranscript(record) {
  const file = record.nativeTranscript;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== `${record.nativeId}.jsonl`) return null;
  let text, whole;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return null;
      const { size } = stat, buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      text = buffer.toString('utf8'); whole = size <= TAIL_BYTES;
    } finally { fs.closeSync(fd); }
  } catch (error) { return error.code === 'ENOENT' ? { conversation: false, permissionMode: null } : null; }
  const result = { conversation: !whole, permissionMode: null };
  for (const line of text.split('\n')) {
    let entry; try { entry = JSON.parse(line); } catch { continue; } // a tail's first line may be cut
    if (['user', 'assistant'].includes(entry?.type)) result.conversation = true;
    if (entry?.type === 'permission-mode' && entry.sessionId === record.nativeId && typeof entry.permissionMode === 'string') result.permissionMode = entry.permissionMode;
  }
  return result;
}
// The mode a resume asks for by name, null where Claude comes back by itself: it does in the mode it was left in, except
// from bypass, and from default where the person's own default is another mode. Never bypass unless NAW knew it in it.
function resumeMode(record) {
  const known = record.nativePermissionMode, left = claudeTranscript(record)?.permissionMode;
  if (known === BYPASS) return CLAUDE_MODES.includes(left) ? left : BYPASS;
  if (left === BYPASS) return CLAUDE_MODES.includes(known) ? known : null;
  return left === 'default' ? left : null;
}
function applyClaude(record, value) {
  const requested = { ...record.requestedSettings };
  if (value.model === null) {
    delete requested.model;
    record.model = NATIVE_DEFAULT;
  } else {
    requested.model = value.model;
    record.model = value.model;
  }
  if (value.effort === null) {
    delete requested.effort;
    record.nativeEffort = undefined;
  } else {
    requested.effort = value.effort;
    record.nativeEffort = value.effort;
  }
  if (Object.keys(requested).length) record.requestedSettings = requested;
  else delete record.requestedSettings;
  delete record.modelUiMessage;
}

// Why a change cannot be asked for at all, or null. Which models Codex has is only known when it is made.
function refused(session, capabilities, value) {
  if (!session || session.archived || session.state === 'ended') return uiError('error.modelChange.unavailable');
  if (!['claude', 'codex'].includes(session.provider) || session.provider === 'codex' && session.vendor && session.vendor !== 'openai' || session.requestedSettings?.profile) return uiError('error.modelChange.unsupported');
  if (!capabilities?.includes(CAPABILITY)) return uiError('error.modelChange.backend');
  try {
    if (session.provider === 'claude') claudeValue(value, session);
    else if (!validValue(value) || value.model === null || value.effort === null) throw uiError('error.modelChange.unknown', { model: String(value?.model ?? '') });
  } catch (error) { return error; }
  return null;
}

// Native accepts a model it does not know without a word, so it has to be one native lists.
function codexValue(value, models) {
  const model = validValue(value) && models.find(entry => entry.model === value.model);
  if (!model || value.effort === null || !model.efforts.includes(value.effort)) {
    throw uiError('error.modelChange.unknown', { model: [value?.model, value?.effort].filter(Boolean).join(' · ') });
  }
  return { model: value.model, effort: value.effort };
}
function codexModels(rows) {
  const models = [];
  for (const row of rows) {
    if (!row || row.hidden === true || typeof row.model !== 'string' || !MODEL_PATTERN.test(row.model) || !Array.isArray(row.supportedReasoningEfforts)) continue;
    const efforts = row.supportedReasoningEfforts.map(entry => entry?.reasoningEffort).filter(effort => typeof effort === 'string' && EFFORT_PATTERN.test(effort));
    if (!efforts.length || models.some(entry => entry.model === row.model)) continue;
    models.push({ model: row.model, efforts, ...(efforts.includes(row.defaultReasoningEffort) ? { defaultEffort: row.defaultReasoningEffort } : {}) });
  }
  return models;
}

module.exports = { CAPABILITY, CLAUDE_MODELS, CLAUDE_EFFORTS, CLAUDE_MODES, NATIVE_DEFAULT, UNSURE_KEYS, validValue, current, claudeChoices, claudeValue, claudeTranscript, resumeMode, applyClaude, refused, codexValue, codexModels };
