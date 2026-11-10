const { uiError, uiNotice } = require('./ui-errors.cjs');
// Outside history is a provider capability, separate from live attachment.
const path = require('node:path');
const { executable } = require('./platform.cjs');
const serverVersion = result => typeof result?.userAgent === 'string' ? result.userAgent.match(/^[^/\s]+\/(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] || null : null;
const verifiedCodexProtocol = rpc => ['0.163.0', '0.164.0', '0.165.0', '0.167.0'].includes(rpc?.nativeVersion);
function codexVersionInfo(rpc, connected = true) {
  const version = typeof rpc?.nativeVersion === 'string' && /^\d+\.\d+\.\d+$/.test(rpc.nativeVersion) ? rpc.nativeVersion : null;
  const current = connected && rpc?.ws?.readyState === 1 && Object.hasOwn(rpc, 'nativeVersion');
  return { nativeVersion: version, nativeVersionStatus: current ? verifiedCodexProtocol(rpc) ? 'verified' : 'unverified' : version ? 'last-known' : 'unreported' };
}
function nativeId(value) {
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) throw uiError("error.history.invalidNativeId");
  return value;
}
function metadata(thread) {
  nativeId(thread?.id);
  if (typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd) || thread.cwd.length > 4096) throw uiError("error.history.workingDirectoryUnconfirmed");
  if (thread.parentThreadId || thread.canAcceptDirectInput === false || thread.ephemeral) throw uiError("error.history.notIndependentSession");
  // Reuse the native title/preview. Never generate a title with another model.
  const label = typeof thread.name === 'string' && thread.name.trim() ? thread.name : thread.preview;
  return { nativeId: thread.id, name: typeof label === 'string' ? label.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) : '',
    cwd: thread.cwd, updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
    model: typeof thread.model === 'string' ? thread.model.slice(0, 200) : '原生默认',
    ...(typeof thread.model === 'string' ? {} : { modelUiMessage: uiNotice('notice.model.nativeDefault').uiMessage }) };
}
function claudeMetadata(id, options) {
  nativeId(id);
  if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd) || options.cwd.length > 4096 || options.cwd.includes('\0')) throw uiError("error.history.selectOriginalDirectory");
  if (options.name != null && (typeof options.name !== 'string' || options.name.length > 60 || /[\x00-\x1f\x7f]/.test(options.name))) throw uiError("error.history.invalidSessionName");
  if (options.skipPermissions != null && typeof options.skipPermissions !== 'boolean') throw uiError("error.history.invalidPermissions");
  return { nativeId: id.toLowerCase(), cwd: options.cwd, name: options.name?.trim() || 'Claude 历史会话', autoName: !options.name?.trim(), model: '原生默认', modelUiMessage: uiNotice('notice.model.nativeDefault').uiMessage, skipPermissions: options.skipPermissions === true };
}
class NativeHistory {
  constructor(host) { this.host = host; }
  async ready() {
    const host = this.host, binary = executable('codex');
    if (!binary || (host.codexBinary && host.codexBinary !== binary)) throw uiError("error.history.checkCodexLocation");
    host.binaries.codex = binary;
    await host.startCodex();
    if (host.codexBinary !== binary) throw uiError("error.history.codexConnectionChanged");
    // The running server's handshake is authoritative. A binary replaced at
    // the same path cannot lend its version to an older still-running process.
    if (!verifiedCodexProtocol(host.rpc)) throw uiError("error.history.codexVersionUnqualified");
    return host.rpc;
  }
  async list(options = {}) {
    const { cursor, search = '' } = options;
    if (typeof search !== 'string' || search.length > 100 || (cursor != null && (typeof cursor !== 'string' || cursor.length > 2048))) throw uiError("error.history.invalidQuery");
    const rpc = await this.ready();
    const result = await rpc.call('thread/list', { limit: 30, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true,
      ...(search.trim() ? { searchTerm: search.trim() } : {}), ...(cursor ? { cursor } : {}) });
    if (rpc !== this.host.rpc || !Array.isArray(result.data) || result.data.length > 30) throw uiError("error.history.listUnconfirmed");
    const data = [];
    for (const thread of result.data) { try { data.push(metadata(thread)); } catch {} }
    if (result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048 || result.nextCursor === cursor)) throw uiError("error.history.paginationUnconfirmed");
    return { data, nextCursor: result.nextCursor || null };
  }
  async read(id) {
    nativeId(id); const rpc = await this.ready();
    const result = await rpc.call('thread/read', { threadId: id, includeTurns: false });
    if (rpc !== this.host.rpc || result.thread?.id !== id) throw uiError("error.history.identityUnconfirmed");
    return metadata(result.thread);
  }
}
module.exports = { claudeMetadata, NativeHistory, nativeId, metadata, serverVersion, verifiedCodexProtocol, codexVersionInfo };
