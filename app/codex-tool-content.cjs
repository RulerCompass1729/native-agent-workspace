// Public native item fields only: no metadata, raw reasoning, media fetches or
// parsing of terminal text. Item IDs and lifecycle stay with the native adapter.
const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput', 'webSearch']);
const json = value => value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
// The native protocol separates user-readable summaries from raw reasoning.
// Never fall back to `content`, `text`, encrypted content or metadata here.
function summaryText(item) {
  return item?.type === 'reasoning' && Array.isArray(item.summary) && item.summary.every(part => typeof part === 'string')
    ? item.summary.join('\n\n') : '';
}
function nativeTextContent(item) {
  if (item?.type === 'reasoning') return { kind: 'summary', title: '', text: summaryText(item) };
  if (item?.type === 'plan') return { kind: 'plan', title: '', text: typeof item.text === 'string' ? item.text : '' };
  return null;
}
function nativeTextItemId(message, nativeId) {
  const prefix = `native:${nativeId}:${message.kind}:`;
  return ['summary', 'plan', 'tool'].includes(message.kind) && message.id?.startsWith(prefix) ? message.id.slice(prefix.length) : message.nativeItemId || message.id;
}
function contentText(content) {
  if (typeof content === 'string') return { text: content, incomplete: false };
  if (!Array.isArray(content)) return { text: '', incomplete: content !== null && content !== undefined };
  let incomplete = false;
  const text = content.map(part => {
    if (['text', 'inputText', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string') return part.text;
    if (part?.type === 'resource' && typeof part.resource?.text === 'string') return [part.resource.uri, part.resource.text].filter(v => typeof v === 'string').join('\n');
    if (part?.type === 'resource_link') return [part.name, part.uri, part.description].filter(v => typeof v === 'string').join('\n');
    incomplete = true;
    return ''; // Missing media is a display gap, not invented native text.
  }).join('\n');
  return { text, incomplete };
}
function fileChanges(changes) {
  if (!Array.isArray(changes)) return { text: '', incomplete: true };
  let incomplete = false;
  const text = changes.map(change => {
    if (typeof change?.path !== 'string' || typeof change.diff !== 'string') { incomplete = true; return ''; }
    const kind = typeof change.kind?.type === 'string' ? change.kind.type : '';
    const destination = typeof change.kind?.move_path === 'string' ? ` → ${change.kind.move_path}` : '';
    return `${kind} ${change.path}${destination}\n${change.diff}`;
  }).join('\n\n');
  return { text, incomplete };
}
// Match the native 0.163/0.164 WebSearchCell summary. The raw action remains
// expandable; do not localize native words or turn its JSON into a preview.
function webSearchTitle(action, query, completed) {
  const type = action?.type;
  let detail = type === 'search' ? action.query || action.queries?.join(', ') || ''
    : type === 'openPage' ? action.url || ''
    : type === 'findInPage' ? action.pattern ? "'" + action.pattern + "'" + (action.url ? ' in ' + action.url : '') : action.url || '' : '';
  detail ||= query || '';
  const header = type === 'openPage' ? (completed ? detail ? 'Opened' : 'Opened page' : detail ? 'Opening' : 'Opening page')
    : type === 'findInPage' ? (completed ? action.pattern ? 'Searched for' : 'Searched page' : action.pattern ? 'Searching for' : 'Searching page')
    : !completed && !detail && (!type || type === 'other') ? 'Browsing the web' : completed ? 'Searched the web' : 'Searching the web';
  return header + (detail ? (type === 'openPage' || type === 'findInPage' ? ' ' : ' for ') + detail : '');
}
// Command semantics come only from native commandActions. Unknown/new or malformed
// actions remain ordinary commands; private/extension metadata is never projected.
function commandActions(value) {
  if (!Array.isArray(value)) return undefined;
  const fields = { read: ['command', 'name', 'path'], listFiles: ['command', 'path'], search: ['command', 'query', 'path'], unknown: ['command'] };
  const result = [];
  for (const action of value) {
    const keys = typeof action?.type === 'string' && Object.hasOwn(fields, action.type) ? fields[action.type] : null;
    if (!keys || typeof action.command !== 'string') return undefined;
    if (keys.some(key => !(typeof action[key] === 'string' || action.type !== 'read' && ['path', 'query'].includes(key) && action[key] === null))) return undefined;
    result.push(Object.fromEntries(['type', ...keys].map(key => [key, action[key]])));
  }
  return result;
}
function toolContent(item, completed = item?.status === 'completed') {
  if (!item || !toolTypes.has(item.type)) return null;
  // Question history does not carry isSecret. Only the live request-aware
  // private answer reader may project its result; generic hydration must not.
  if (item.type === 'functionCallOutput' && ['request_user_input', 'request_user_input_async'].includes(item.name)) return null;
  const result = {};
  if (item.type === 'commandExecution') {
    result.title = item.command || '';
    if (typeof item.command === 'string') result.input = item.command;
    const actions = commandActions(item.commandActions);
    if (Object.hasOwn(item, 'commandActions')) result.commandActions = actions;
    if (typeof item.source === 'string') result.commandSource = item.source;
    if (Number.isSafeInteger(item.exitCode)) result.exitCode = item.exitCode;
    if (typeof item.aggregatedOutput === 'string') result.text = item.aggregatedOutput;
  } else if (item.type === 'webSearch') {
    const action = item.action;
    result.title = webSearchTitle(action, item.query, completed);
    result.input = action?.type === 'search' ? action.query || action.queries?.join('\n') || item.query || ''
      : action?.type === 'findInPage' ? [action.url, action.pattern].filter(v => typeof v === 'string').join('\n') : action?.url || item.query || '';
    result.text = json({ action: action ?? null, ...(Array.isArray(item.results) ? { results: item.results } : {}) });
  } else if (item.type === 'fileChange') {
    result.title = ''; Object.assign(result, fileChanges(item.changes));
  } else if (item.type === 'functionCallOutput') {
    result.title = [item.namespace, item.name].filter(Boolean).join('.') || '';
    Object.assign(result, contentText(item.output));
  } else {
    result.title = [item.type === 'mcpToolCall' ? item.server : item.namespace, item.tool].filter(Boolean).join('.') || '';
    if (item.arguments !== undefined) result.input = json(item.arguments);
    if (item.type === 'dynamicToolCall' && Array.isArray(item.contentItems)) Object.assign(result, contentText(item.contentItems));
    if (item.type === 'mcpToolCall' && item.result) {
      Object.assign(result, contentText(item.result.content));
      const structured = json(item.result.structuredContent);
      if (structured) result.text = [result.text, structured].filter(Boolean).join('\n');
    }
    if (typeof item.error?.message === 'string') result.text = [result.text, item.error.message].filter(Boolean).join('\n');
  }
  return result;
}
function toolStatus(item, completed) {
  if (item.status === 'failed' || item.success === false || item.error) return 'failed';
  if (item.status === 'declined') return 'declined';
  if (item.status === 'interrupted') return 'interrupted';
  return completed ? 'completed' : 'running';
}
module.exports = { commandActions, webSearchTitle, contentText, fileChanges, toolContent, toolStatus, toolTypes, summaryText, nativeTextContent, nativeTextItemId };
