// NAW's tool gate for pi, loaded with -e. pi starts with --no-builtin-tools and this file turns them on,
// so a gate that fails to load leaves the model without tools instead of without confirmation.
// Reading and searching inside the working folder run at once; every other call (commands, writing,
// editing, reading elsewhere, any tool not listed) waits for the person in pi's own terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write', 'ls'];
// grep and find need rg and fd, which pi does not download offline.
const SEARCH_TOOLS = { grep: 'rg', find: 'fd' };
const READ_ONLY = new Set(['read', 'ls', 'grep', 'find']);
// "No" first: a stray Enter while the dialog opens declines.
const CHOICES = ['No', 'Yes'];
const UNICODE_SPACES = /[  -   　]/g;
// Control and direction characters could make the dialog show something other than what runs.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

export function visible(text) {
  return String(text).replace(HIDDEN, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function onPath(program) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir === '') continue;
    try {
      fs.accessSync(path.join(dir, program), fs.constants.X_OK);
      return true;
    } catch {
      // Not in this folder.
    }
  }
  return false;
}

export function toolsToEnable() {
  const tools = [...DEFAULT_TOOLS];
  for (const [tool, program] of Object.entries(SEARCH_TOOLS)) {
    if (onPath(program)) tools.push(tool);
  }
  return tools;
}

// pi's own path resolution (utils/paths.js resolvePath with normalizeUnicodeSpaces and stripAtPrefix).
function resolveLikePi(given, cwd) {
  let target = given.replace(UNICODE_SPACES, ' ');
  if (target.startsWith('@')) target = target.slice(1);
  if (target === '~') {
    target = os.homedir();
  } else if (target.startsWith('~/')) {
    target = path.join(os.homedir(), target.slice(2));
  } else if (/^file:\/\//.test(target)) {
    target = fileURLToPath(target);
  }
  return path.resolve(cwd, target);
}

// Only an existing path whose real location is in the working folder counts: a link out of it, or a
// missing file pi might match to a near-identical name, is asked about.
export function insideFolder(given, cwd) {
  if (typeof given !== 'string' || typeof cwd !== 'string') return false;
  try {
    const folder = fs.realpathSync(cwd);
    const target = fs.realpathSync(resolveLikePi(given, cwd));
    return target === folder || target.startsWith(folder + path.sep);
  } catch {
    return false;
  }
}

function lineCount(text) {
  if (typeof text !== 'string' || text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// The question for a call, or null when it runs without asking.
export function question(toolName, input, cwd) {
  const given = input && typeof input === 'object' ? input : {};
  if (READ_ONLY.has(toolName)) {
    const target = toolName === 'read' ? given.path : given.path || '.';
    if (insideFolder(target, cwd)) return null;
    return { title: `Allow ${toolName} outside the working folder?`, detail: String(target) };
  }
  if (toolName === 'bash') return { title: 'Allow this command?', detail: String(given.command) };
  if (toolName === 'write') return { title: 'Allow writing this file?', detail: `${given.path} (${lineCount(given.content)} lines)` };
  if (toolName === 'edit') {
    const count = Array.isArray(given.edits) ? given.edits.length : 0;
    return { title: 'Allow this edit?', detail: `${given.path} (${count} ${count === 1 ? 'change' : 'changes'})` };
  }
  let detail = JSON.stringify(given);
  if (detail.length > 2000) detail = `${detail.slice(0, 2000)}…`;
  return { title: `Allow ${toolName}?`, detail };
}

export default function nawConfirm(pi) {
  pi.on('session_start', () => {
    pi.setActiveTools(toolsToEnable());
  });
  pi.on('tool_call', async (event, ctx) => {
    const asked = question(event.toolName, event.input, ctx.cwd);
    if (asked === null) return undefined;
    const refused = { block: true, terminate: true, reason: `The person did not allow this ${event.toolName} call.` };
    if (!ctx.hasUI) return refused;
    const choice = await ctx.ui.select(`${visible(asked.title)}\n${visible(asked.detail)}`, CHOICES, {
      signal: ctx.signal,
      blockedKind: 'permission',
    });
    return choice === 'Yes' ? undefined : refused;
  });
}
