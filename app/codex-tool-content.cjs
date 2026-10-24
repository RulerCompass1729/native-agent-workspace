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
  if (item?.type === 'reasoning') return { kind: 'summary', title: '过程摘要', text: summaryText(item) };
  if (item?.type === 'plan') return { kind: 'plan', title: '计划', text: typeof item.text === 'string' ? item.text : '' };
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
    return '〔非文本内容，请在原生终端查看〕';
  }).join('\n');
  return { text, incomplete };
}
function fileChanges(changes) {
  if (!Array.isArray(changes)) return { text: '', incomplete: true };
  let incomplete = false;
  const text = changes.map(change => {
    if (typeof change?.path !== 'string' || typeof change.diff !== 'string') { incomplete = true; return '〔文件修改内容未完整同步〕'; }
    const kind = { add: '新增', delete: '删除', update: '修改' }[change.kind?.type] || '文件变更';
    const destination = typeof change.kind?.move_path === 'string' ? ` → ${change.kind.move_path}` : '';
    return `${kind} ${change.path}${destination}\n${change.diff}`;
  }).join('\n\n');
  return { text, incomplete };
}
function toolContent(item) {
  if (!item || !toolTypes.has(item.type)) return null;
  // Question history does not carry isSecret. Only the live request-aware
  // private answer reader may project its result; generic hydration must not.
  if (item.type === 'functionCallOutput' && ['request_user_input', 'request_user_input_async'].includes(item.name)) return null;
  const result = {};
  if (item.type === 'commandExecution') {
    result.title = item.command || '命令';
    if (typeof item.aggregatedOutput === 'string') result.text = item.aggregatedOutput;
  } else if (item.type === 'webSearch') {
    const action = item.action;
    result.title = { openPage: '打开网页', findInPage: '页内查找' }[action?.type] || '搜索网页';
    result.input = action?.type === 'search' ? action.query || action.queries?.join('\n') || item.query || ''
      : action?.type === 'findInPage' ? [action.url, action.pattern].filter(v => typeof v === 'string').join('\n') : action?.url || item.query || '';
    result.text = json({ action: action ?? null, ...(Array.isArray(item.results) ? { results: item.results } : {}) });
  } else if (item.type === 'fileChange') {
    result.title = '文件修改'; Object.assign(result, fileChanges(item.changes));
  } else if (item.type === 'functionCallOutput') {
    result.title = [item.namespace, item.name].filter(Boolean).join('.') || '工具结果';
    Object.assign(result, contentText(item.output));
  } else {
    result.title = [item.type === 'mcpToolCall' ? item.server : item.namespace, item.tool].filter(Boolean).join('.') || '工具';
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
module.exports = { contentText, fileChanges, toolContent, toolStatus, toolTypes, summaryText, nativeTextContent, nativeTextItemId };
