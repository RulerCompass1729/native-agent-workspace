// Outside history is a provider capability, separate from live attachment.
const path = require('node:path');
const { executable } = require('./platform.cjs');
const serverVersion = result => typeof result?.userAgent === 'string' ? result.userAgent.match(/^[^/\s]+\/(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] || null : null;
const verifiedCodexProtocol = rpc => ['0.163.0', '0.164.0'].includes(rpc?.nativeVersion);
function codexVersionInfo(rpc, connected = true) {
  const version = typeof rpc?.nativeVersion === 'string' && /^\d+\.\d+\.\d+$/.test(rpc.nativeVersion) ? rpc.nativeVersion : null;
  const current = connected && rpc?.ws?.readyState === 1 && Object.hasOwn(rpc, 'nativeVersion');
  return { nativeVersion: version, nativeVersionStatus: current ? verifiedCodexProtocol(rpc) ? 'verified' : 'unverified' : version ? 'last-known' : 'unreported' };
}
function nativeId(value) {
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) throw Error('无效的原生会话标识。');
  return value;
}
function metadata(thread) {
  nativeId(thread?.id);
  if (typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd) || thread.cwd.length > 4096) throw Error('原生工作目录未能确认。');
  if (thread.parentThreadId || thread.canAcceptDirectInput === false || thread.ephemeral) throw Error('这个原生记录不是可独立恢复的会话。');
  // Reuse the native title/preview. Never generate a title with another model.
  const label = typeof thread.name === 'string' && thread.name.trim() ? thread.name : thread.preview;
  return { nativeId: thread.id, name: typeof label === 'string' ? label.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) : '',
    cwd: thread.cwd, updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
    model: typeof thread.model === 'string' ? thread.model.slice(0, 200) : '原生默认' };
}
class NativeHistory {
  constructor(host) { this.host = host; }
  async ready() {
    const host = this.host, binary = executable('codex');
    if (!binary || (host.codexBinary && host.codexBinary !== binary)) throw Error('请先在安装设置中核对 Codex；已有后台不会切换程序。');
    host.binaries.codex = binary;
    await host.startCodex();
    if (host.codexBinary !== binary) throw Error('Codex 连接已变化，请重新打开历史列表。');
    // The running server's handshake is authoritative. A binary replaced at
    // the same path cannot lend its version to an older still-running process.
    if (!verifiedCodexProtocol(host.rpc)) throw Error('已有历史接入目前仅验证 Codex 0.163.0 / 0.164.0 的运行后台；请暂时在原生界面继续。');
    return host.rpc;
  }
  async list(options = {}) {
    const { cursor, search = '' } = options;
    if (typeof search !== 'string' || search.length > 100 || (cursor != null && (typeof cursor !== 'string' || cursor.length > 2048))) throw Error('无效的历史查询。');
    const rpc = await this.ready();
    const result = await rpc.call('thread/list', { limit: 30, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true,
      ...(search.trim() ? { searchTerm: search.trim() } : {}), ...(cursor ? { cursor } : {}) });
    if (rpc !== this.host.rpc || !Array.isArray(result.data) || result.data.length > 30) throw Error('原生历史列表未能确认，请重新查询。');
    const data = [];
    for (const thread of result.data) { try { data.push(metadata(thread)); } catch {} }
    if (result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048 || result.nextCursor === cursor)) throw Error('原生历史分页未能确认。');
    return { data, nextCursor: result.nextCursor || null };
  }
  async read(id) {
    nativeId(id); const rpc = await this.ready();
    const result = await rpc.call('thread/read', { threadId: id, includeTurns: false });
    if (rpc !== this.host.rpc || result.thread?.id !== id) throw Error('原生会话身份未能确认，没有恢复。');
    return metadata(result.thread);
  }
}
module.exports = { NativeHistory, nativeId, metadata, serverVersion, verifiedCodexProtocol, codexVersionInfo };
