'use strict';

// How many times each native session's own conversation has been compacted, read from the
// native record the CLI writes (queue 794d3cd7: the person, 2026-11-13, 「compact conversation
// 的次数过多我觉得也需要继承然后新开继承之后的会话了」), and how large and how warm a Claude conversation
// is after its last request. Only counts leave this module; no text.
//
// Claude: the record the CLI itself reported (hooks' transcript_path, kept as nativeTranscript), else
// ~/.claude/projects/<cwd with every character other than a letter or digit as "-">/<native id>.jsonl
// (under CLAUDE_CONFIG_DIR when set) for the folder as stored and as resolved: the CLI names it after
// the resolved one (/var is /private/var on macOS), as claude-pin.cjs looks. One line per compaction,
// {"type":"system","subtype":"compact_boundary","sessionId":<native id>,"isSidechain":false,...}.
// Codex: <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl; one
// top-level line per compaction, {"timestamp":...,"ordinal":...,"type":"compacted","payload":...}.
//
// Each file is read once from where the last pass stopped, so a pass costs what was appended. A
// first pass over a large file is spread over passes by a byte budget.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Measured 2026-11-13: the longest line in the person's records was 4.2 MB (a Codex compaction
// carrying its replacement history). A longer line is skipped unread.
const LINE_CAP_BYTES = 32 * 1024 * 1024;
// One read per file per pass; larger than the line cap, so every read finishes a line or skips one.
const READ_BYTES = 48 * 1024 * 1024;
// All files together per pass (records measured up to 343 MB catch up in a few minutes).
const PASS_BYTES = 96 * 1024 * 1024;
const SAMPLE_MS = 30 * 1000;
// A Codex record not found yet (the CLI writes it with the first turn) is looked for again after this.
const MISSING_RETRY_MS = 10 * 60 * 1000;
const CLAUDE_MARKER = Buffer.from('"subtype":"compact_boundary"');
const CLAUDE_USAGE = Buffer.from('"cache_read_input_tokens"');
const CODEX_LINE = /^\{"timestamp":"[^"\\]{1,64}",(?:"ordinal":\d{1,20},)?"type":"compacted","payload":/;

// Where Claude keeps its records: <CLAUDE_CONFIG_DIR or ~/.claude>/projects.
function claudeProjects(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

// The places the session's record may be, in the order looked at (also the model a successor
// starts with, queue-dispatch.cjs transcriptModel).
function claudeFiles(root, session) {
  if (!session || !NATIVE_ID.test(session.nativeId || '')) return [];
  const name = `${session.nativeId}.jsonl`, files = [];
  const reported = session.nativeTranscript;
  if (typeof reported === 'string' && path.isAbsolute(reported) && path.basename(reported) === name) files.push(reported);
  if (typeof session.cwd === 'string' && session.cwd) {
    const folders = [session.cwd];
    try {
      folders.push(fs.realpathSync(session.cwd));
    } catch {
      // The folder may be gone.
    }
    for (const folder of folders) files.push(path.join(root, folder.replace(/[^a-zA-Z0-9]/g, '-'), name));
  }
  return [...new Set(files)];
}

// One complete line (without its newline): whether it records one compaction of this session.
function compactionLine(line, provider, nativeId) {
  if (provider === 'codex') {
    return CODEX_LINE.test(line.subarray(0, 256).toString('latin1'));
  }
  if (line.indexOf(CLAUDE_MARKER) === -1) return false;
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return false;
  }
  // Only the session's own main conversation, as transcriptModel and NAW's Claude reader filter.
  return Boolean(entry) && entry.type === 'system' && entry.subtype === 'compact_boundary' &&
    entry.sessionId === nativeId && entry.isSidechain === false;
}

// The conversation after one Claude request: { tokens, at, ttlMs, cached }, or null for any other line. ttlMs is
// the lifetime that request's cache write was billed at (one hour within the plan, five minutes beyond it), or
// null when it wrote nothing. cached: whether it read or wrote the cache at all.
function contextLine(line, nativeId) {
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
  const usage = entry?.message?.usage;
  if (!usage || entry.type !== 'assistant' || entry.sessionId !== nativeId || entry.isSidechain !== false ||
      entry.message.model === '<synthetic>') return null;
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  const tokens = parts.reduce((sum, part) => sum + part, 0), at = Date.parse(entry.timestamp);
  if (!parts.every(part => Number.isSafeInteger(part) && part >= 0) || !tokens || !Number.isFinite(at)) return null;
  const written = usage.cache_creation || {};
  const ttlMs = written.ephemeral_5m_input_tokens > 0 ? 5 * 60 * 1000 : written.ephemeral_1h_input_tokens > 0 ? 60 * 60 * 1000 : null;
  return { tokens, at, ttlMs, cached: parts[1] + parts[2] > 0 };
}

// Reads on from state.offset; returns the bytes read. state: { dev, ino, offset, count, skipping, context, whole }.
// whole: this read reached the end of the record. context is null from an unread line until a request after it.
async function readOn(state, file, provider, nativeId, maxBytes, lineCap) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return -1;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return -1;
    // Another file at the path, or one cut shorter: counted again from its start.
    if (state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.offset) {
      Object.assign(state, { dev: stat.dev, ino: stat.ino, offset: 0, count: 0, skipping: false, context: null });
    }
    const length = Math.min(stat.size - state.offset, maxBytes);
    if (length <= 0) {
      state.whole = true;
      return 0;
    }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, state.offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const data = buffer.subarray(0, read);
    let start = 0;
    let requests = [];
    for (;;) {
      const end = data.indexOf(10, start);
      if (end === -1) break;
      if (state.skipping) {
        state.skipping = false;
      } else if (compactionLine(data.subarray(start, end), provider, nativeId)) {
        state.count += 1;
        // What was requested before a compaction is no longer the conversation's size.
        requests = [];
        state.context = null;
      } else if (provider === 'claude' && data.subarray(start, end).includes(CLAUDE_USAGE)) {
        requests.push([start, end]);
      }
      start = end + 1;
    }
    // The last request, and the lifetime last written at, so usually one line is parsed however much was read. A
    // request that neither read nor wrote the cache ends the search: no lifetime from before it still holds.
    let latest = null, ttlMs;
    for (const [from, to] of requests.reverse()) {
      const request = contextLine(data.subarray(from, to), nativeId);
      if (!request) continue;
      latest ||= request;
      if (request.ttlMs === null && request.cached) continue;
      ttlMs = request.ttlMs;
      break;
    }
    if (latest) state.context = { tokens: latest.tokens, at: latest.at, ttlMs: ttlMs === undefined ? state.context?.ttlMs ?? null : ttlMs };
    // The rest is a line still being written, read again next time; one longer than the cap is skipped.
    if (state.skipping || (start === 0 && data.length >= lineCap)) {
      state.skipping = true;
      start = data.length;
      // It may be a request or a compaction: neither the size nor the lifetime from before it is known to hold.
      state.context = null;
    }
    state.offset += start;
    state.whole = state.offset === stat.size;
    return read;
  } finally {
    await handle.close().catch(() => {});
  }
}

class CompactionCounter {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.claudeRoot = options.claudeRoot || claudeProjects(env);
    this.codexRoot = options.codexRoot || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    this.passBytes = options.passBytes ?? PASS_BYTES;
    this.readBytes = options.readBytes ?? READ_BYTES;
    this.lineCap = options.lineCap ?? LINE_CAP_BYTES;
    this.sampleMs = options.sampleMs ?? SAMPLE_MS;
    this.missingRetryMs = options.missingRetryMs ?? MISSING_RETRY_MS;
    this.states = new Map();
    // Session id -> { tokens, at, ttlMs } after its last request, Claude only; renewed by each sample. Only of a
    // record that sample read to its end: an earlier size may be from before a compaction.
    this.contexts = new Map();
    this.codexFiles = new Map();
    this.turn = 0;
    this.last = null;
  }

  // Map of session id -> compactions counted so far. A count still catching up on a large file is
  // lower than the truth, never higher: it only grows while one file is read on.
  async sample(sessions, now) {
    if (this.last && now - this.last.at < this.sampleMs) return this.last.counts;
    const listed = [];
    for (const session of sessions || []) {
      if (!session || !['claude', 'codex'].includes(session.provider) || !NATIVE_ID.test(session.nativeId || '')) continue;
      listed.push(session);
    }
    const ids = new Set(listed.map(session => session.id));
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
    // A Codex session that is no longer listed is forgotten, so the map stays as small as the list.
    const threads = new Set(listed.filter(session => session.provider === 'codex').map(session => session.nativeId));
    for (const thread of this.codexFiles.keys()) if (!threads.has(thread)) this.codexFiles.delete(thread);
    // Each pass starts one session further on, so a large first read does not always go to the same one.
    const order = listed.length ? listed.slice(this.turn % listed.length).concat(listed.slice(0, this.turn % listed.length)) : [];
    this.turn += 1;
    let budget = this.passBytes;
    const counts = new Map(), contexts = new Map();
    for (const session of order) {
      const file = await this.fileOf(session, now);
      let state = this.states.get(session.id);
      if (!file) {
        this.states.delete(session.id);
        continue;
      }
      if (!state || state.file !== file || state.nativeId !== session.nativeId) {
        state = { file, nativeId: session.nativeId, provider: session.provider, dev: null, ino: null, offset: 0, count: 0, skipping: false, context: null, whole: false };
        this.states.set(session.id, state);
      }
      state.whole = false;
      if (budget > 0) {
        const read = await readOn(state, file, session.provider, session.nativeId, Math.min(this.readBytes, Math.max(budget, this.lineCap + 1)), this.lineCap);
        if (read < 0) {
          this.states.delete(session.id);
          // A rollout found but not readable is looked for again only after the same wait as one not found.
          if (session.provider === 'codex') this.codexFiles.set(session.nativeId, { missAt: now });
          continue;
        }
        budget -= read;
      }
      if (state.dev !== null) counts.set(session.id, state.count);
      if (state.context && state.whole) contexts.set(session.id, state.context);
    }
    this.contexts = contexts;
    this.last = { at: now, counts };
    return counts;
  }

  async fileOf(session, now) {
    if (session.provider === 'claude') {
      for (const file of claudeFiles(this.claudeRoot, session)) {
        try {
          if ((await fs.promises.stat(file)).isFile()) return file;
        } catch {
          // Not there: the next place.
        }
      }
      return null;
    }
    const known = this.codexFiles.get(session.nativeId);
    if (known && known.file) return known.file;
    if (known && now - known.missAt < this.missingRetryMs) return null;
    const file = await findRollout(this.codexRoot, session.nativeId);
    this.codexFiles.set(session.nativeId, file ? { file } : { missAt: now });
    return file;
  }
}

// The newest day folders first: a running session's record is usually among them.
async function findRollout(root, threadId) {
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  const names = async (dir, pattern) => {
    try {
      return (await fs.promises.readdir(dir)).filter(name => pattern.test(name)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of await names(root, /^\d{4}$/)) {
    for (const month of await names(path.join(root, year), /^\d{2}$/)) {
      for (const day of await names(path.join(root, year, month), /^\d{2}$/)) {
        const dir = path.join(root, year, month, day);
        const found = (await names(dir, /^rollout-.*\.jsonl$/)).find(name => name.toLowerCase().endsWith(suffix));
        if (found) return path.join(dir, found);
      }
    }
  }
  return null;
}

module.exports = { CompactionCounter, compactionLine, readOn, findRollout, claudeFiles, claudeProjects, LINE_CAP_BYTES, READ_BYTES, PASS_BYTES };
