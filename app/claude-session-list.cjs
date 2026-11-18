'use strict';

// Claude sessions the person can continue from the new-session dialog (survey 2026-11-18 §3:
// 「Claude 会话自动列出来，点一下就接上」). Continuing one goes through the existing importHistory.
//
// Running sessions come from the official `claude agents --json --all`. Exited ones come from the
// transcripts Claude keeps at <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<folder>/<session id>.jsonl,
// the path compaction-count.cjs reads. Only four facts are taken from a transcript: the session ID,
// its folder (the `cwd` of its own rows), the file's modification time and a title. The title is the
// newest custom-title row (a /rename or --name), else the newest ai-title row, else the first 60
// characters of the first message the person typed.
//
// A transcript is Claude's internal format, so nothing is read unless the installed Claude is a version
// NAW has qualified (claude-pin QUALIFIED, or a passed claude-qualification record). A file without
// rows of the expected shape is skipped and counted, never guessed at; the dialog then points to
// pasting the session ID. Titles stay in memory and in the reply to the dialog: this module never
// logs, stores or forwards them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const claudePin = require('./claude-pin.cjs');
const qualification = require('./claude-qualification.cjs');
const { nativeEnvironment } = require('./platform.cjs');
const { uiError } = require('./ui-errors.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const PAGE = 30;
// Transcripts one call may read. A search looks through this many and offers 更多 for the rest.
const READS_PER_CALL = 500;
// The first rows hold the folder, the first message and a --name title; the last rows hold later
// renames and the generated title. Measured on 2.1.327: an attachment row can be tens of kilobytes.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const TITLE_CHARS = 60;
const COMMAND_MS = 5000;
// Background rows `--all` adds once they ended. Any other status counts as still running:
// continuing is checked again by importHistory, which refuses an active session.
const ENDED = new Set(['completed', 'complete', 'done', 'finished', 'failed', 'error', 'errored', 'stopped', 'killed', 'cancelled', 'canceled', 'exited']);

function projectsRoot(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

// One line of plain text, at most 60 characters, or null.
function clean(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return Array.from(flat).slice(0, TITLE_CHARS).join('');
}

// What the person typed in a top-level user row; null for commands, tool results and meta rows.
function typedText(row) {
  if (row.type !== 'user' || row.isMeta === true || row.isSidechain === true) return null;
  if (!row.message || row.message.role !== 'user') return null;
  const content = row.message.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content.filter(part => part && part.type === 'text' && typeof part.text === 'string');
    text = parts.map(part => part.text).join(' ');
  }
  // Slash commands and their output are tagged (<command-name>, <local-command-stdout>, ...).
  if (!text.trim() || text.trimStart().startsWith('<')) return null;
  return text;
}

// A user or assistant row in the shape Claude writes; IDs and a folder alone prove no format.
function conversational(row) {
  if (row.type !== 'user' && row.type !== 'assistant') return false;
  const message = row.message;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== row.type) return false;
  return typeof message.content === 'string' || Array.isArray(message.content);
}

function readText(fd, start, length) {
  const buffer = Buffer.alloc(length);
  const count = fs.readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, count).toString('utf8');
}

// Whole lines only: a range that starts or ends inside a line drops that piece.
function parseLines(text, tornStart, tornEnd) {
  const lines = text.split('\n');
  if (tornStart) lines.shift();
  if (tornEnd) lines.pop();
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      // Not one complete row; it proves nothing.
    }
  }
  return rows;
}

// { cwd, name } from one transcript, or null when its rows are not the expected shape.
function describe(file, id, size) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const headLength = Math.min(size, HEAD_BYTES);
    const head = parseLines(readText(fd, 0, headLength), false, size > headLength);
    let tail = [];
    if (size > HEAD_BYTES) {
      const start = Math.max(HEAD_BYTES, size - TAIL_BYTES);
      tail = parseLines(readText(fd, start, size - start), true, false);
    }
    let cwd = null, customTitle = null, aiTitle = null, firstTyped = null;
    for (const row of [...head, ...tail]) {
      if (typeof row.sessionId !== 'string' || row.sessionId.toLowerCase() !== id) continue;
      if (!cwd && conversational(row) && typeof row.cwd === 'string' && path.isAbsolute(row.cwd)) cwd = row.cwd;
      if (row.type === 'custom-title' && clean(row.customTitle)) customTitle = clean(row.customTitle);
      if (row.type === 'ai-title' && clean(row.aiTitle)) aiTitle = clean(row.aiTitle);
    }
    for (const row of head) {
      if (typeof row.sessionId !== 'string' || row.sessionId.toLowerCase() !== id) continue;
      const typed = typedText(row);
      if (typed) { firstTyped = clean(typed); break; }
    }
    if (!cwd) return null;
    return { cwd, name: customTitle || aiTitle || firstTyped || null };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Top-level <session id>.jsonl files only (subagent transcripts sit in subfolders), newest first.
function transcripts(root) {
  let folders;
  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, folder.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.isFile() ? SESSION_FILE.exec(entry.name) : null;
      if (!match) continue;
      const file = path.join(root, folder.name, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.uid !== process.getuid()) continue;
      found.push({ id: match[1].toLowerCase(), file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // The same ID in two folders: the newer file is the one Claude writes now.
  const seen = new Set();
  return found.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const options = { env: nativeEnvironment(), encoding: 'utf8', timeout: COMMAND_MS, maxBuffer: 4 * 1024 * 1024 };
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Map of session ID -> { running, cwd, name, startedAt } from Claude itself, or null when unreadable.
function runningRows(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length > 1000) return null;
  const sessions = new Map();
  for (const row of rows) {
    if (!row || !['interactive', 'background'].includes(row.kind)) continue;
    if (typeof row.sessionId !== 'string' || !UUID.test(row.sessionId)) continue;
    const ended = [row.state, row.status].some(value => typeof value === 'string' && ENDED.has(value.toLowerCase()));
    const id = row.sessionId.toLowerCase();
    const previous = sessions.get(id);
    sessions.set(id, {
      running: !ended || Boolean(previous?.running),
      cwd: typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? row.cwd : previous?.cwd || null,
      name: clean(row.name) || previous?.name || null,
      startedAt: Number.isFinite(row.startedAt) ? row.startedAt : previous?.startedAt || null,
    });
  }
  return sessions;
}

function validQuery(options) {
  if (options == null) return { search: '', offset: 0 };
  if (typeof options !== 'object' || Array.isArray(options)) throw uiError('error.history.invalidQuery');
  const { search = '', cursor = null } = options;
  if (typeof search !== 'string' || search.length > 100) throw uiError('error.history.invalidQuery');
  if (cursor != null && (typeof cursor !== 'string' || !/^\d{1,7}$/.test(cursor))) throw uiError('error.history.invalidQuery');
  return { search: search.trim().toLocaleLowerCase(), offset: cursor == null ? 0 : Number(cursor) };
}

class ClaudeSessions {
  // launcher(): the Claude program NAW runs (host.binaries.claude); file: claude-qualification.json.
  constructor({ launcher, file, root, env = process.env, runCommand = run } = {}) {
    this.launcher = launcher;
    this.file = file;
    this.root = root || projectsRoot(env);
    this.runCommand = runCommand;
    this.cache = new Map();
    this.versions = new Map();
  }

  // The version the launcher runs now: its versions/<x.y.z> link, else what --version prints.
  async version(launcher) {
    const installed = claudePin.installed(launcher);
    if (installed) return installed;
    let stat;
    try {
      stat = fs.statSync(launcher);
    } catch {
      return null;
    }
    const key = `${launcher}\n${stat.mtimeMs}\n${stat.size}`;
    if (!this.versions.has(key)) {
      let version = null;
      try {
        const match = /^(\d+\.\d+\.\d+)(?:\s|$)/.exec((await this.runCommand(launcher, ['--version'])).trim());
        if (match) version = match[1];
      } catch {
        version = null;
      }
      this.versions.clear();
      this.versions.set(key, version);
    }
    const version = this.versions.get(key);
    return version ? { dir: null, version } : null;
  }

  qualified(current) {
    if (claudePin.QUALIFIED.includes(current.version)) return true;
    if (!current.dir || !this.file) return false;
    try {
      return qualification.approvedVersions(this.file, current.dir).includes(current.version);
    } catch {
      return false;
    }
  }

  cached(item) {
    const hit = this.cache.get(item.file);
    if (hit && hit.size === item.size && hit.mtimeMs === item.mtimeMs) return hit.result;
    const result = describe(item.file, item.id, item.size);
    this.cache.set(item.file, { size: item.size, mtimeMs: item.mtimeMs, result });
    return result;
  }

  async list(options) {
    const { search, offset } = validQuery(options);
    const launcher = typeof this.launcher === 'function' ? this.launcher() : this.launcher;
    const current = launcher ? await this.version(launcher) : null;
    if (!current) return { data: [], nextCursor: null, unavailable: { reason: 'version', version: '' } };
    if (!this.qualified(current)) return { data: [], nextCursor: null, unavailable: { reason: 'version', version: current.version } };

    let running = null;
    try {
      running = runningRows(await this.runCommand(launcher, ['agents', '--json', '--all']));
    } catch {
      running = null;
    }
    const files = transcripts(this.root);
    const live = new Set(files.map(item => item.file));
    for (const file of this.cache.keys()) {
      if (!live.has(file)) this.cache.delete(file);
    }

    // Every candidate in display order: transcripts by modification time, plus running sessions
    // that have not written one yet (Claude writes it with the first message).
    const byId = new Map(files.map(item => [item.id, item]));
    const candidates = files.map(item => ({ id: item.id, item, time: item.mtimeMs }));
    for (const [id, row] of running || []) {
      if (!byId.has(id) && row.running && row.cwd) candidates.push({ id, item: null, time: row.startedAt || 0 });
    }
    candidates.sort((a, b) => b.time - a.time);

    const data = [];
    let index = offset, reads = 0, skipped = 0, recognized = 0;
    while (index < candidates.length && data.length < PAGE && reads < READS_PER_CALL) {
      const candidate = candidates[index];
      index += 1;
      const native = running?.get(candidate.id) || null;
      let found = null;
      if (candidate.item) {
        reads += 1;
        if (reads % 25 === 0) await new Promise(resolve => setImmediate(resolve));
        found = this.cached(candidate.item);
        if (!found) { skipped += 1; continue; }
        recognized += 1;
      } else {
        found = { cwd: native.cwd, name: null };
      }
      const row = {
        nativeId: candidate.id,
        name: found.name || native?.name || null,
        cwd: found.cwd,
        updatedAt: Math.floor(candidate.time / 1000),
        running: Boolean(native?.running),
      };
      if (search && ![row.name, row.cwd].some(value => value && value.toLocaleLowerCase().includes(search))) continue;
      data.push(row);
    }
    const result = { data, nextCursor: index < candidates.length ? String(index) : null, skipped };
    if (running === null) result.runningUnknown = true;
    // Not one transcript had the expected rows: the format changed, so list nothing rather than guess.
    if (skipped > 0 && recognized === 0 && data.length === 0 && offset === 0) {
      return { data: [], nextCursor: null, unavailable: { reason: 'format', count: skipped } };
    }
    return result;
  }
}

module.exports = { ClaudeSessions, describe, transcripts, runningRows, typedText, clean, projectsRoot, PAGE, READS_PER_CALL, HEAD_BYTES, TAIL_BYTES };
