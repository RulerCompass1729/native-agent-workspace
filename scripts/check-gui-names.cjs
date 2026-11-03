#!/usr/bin/env node
// T-146: GUI scripts find controls by their visible or accessible name. When the interface renames
// one, a script that still uses the old name stops at that step and its later checks never run.
// This check runs no interface. It lists every name a GUI script or fixture looks up and compares it
// with the strings that exist in the application source; a name nothing in the source can produce is
// reported.
//   exact lookups    the whole name must equal one source string, or fully match one source template
//                    that has fixed words of its own (`加入 ${x}`; a hole that only chooses between fixed
//                    strings counts as those strings), or a concatenation ('复制：' + x). An exact button
//                    lookup must not name something that only exists as a menu item.
//   other lookups    the name must occur inside one source string or such a template; digits are data.
//   /^…/ lookups     the regular expression's fixed start must begin some source string or template.
// Lookups are found in getByRole/getByText/getByLabel/getByTitle/getByPlaceholder/getByAltText, hasText,
// text=, one-parameter helpers whose body looks the parameter up by name (item('复制')), and
// for (const name of [...]) loops that do. A name the script or a fixture also uses as data comes from the
// test, not the interface, and is not checked (see lookups() for how a control lookup is kept). Names in variables and other regular expressions are not checked, an
// aria-label that replaces an element's text is not seen, and a name that two controls share cannot tell
// which one a script means. Usage: node scripts/check-gui-names.cjs [--json]; exit 1 when anything is reported.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');

// Reads the string literals of JavaScript source: quotes, templates (fixed parts, holes and the strings
// inside holes) and regular expressions, with the operators next to them; comments are skipped.
function literals(source) {
  const out = []; let i = 0, last = '';
  const prevAllowsRegex = () => !last || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(return|typeof|case|in|of|delete|void|throw|new)$/.test(last);
  const unescape = text => text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) =>
    e[0] === 'u' ? String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16)) : e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16))
      : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' })[e] ?? e);
  const before = start => { let j = start - 1; while (j >= 0 && /\s/.test(source[j])) j--; return source[j] || ''; };
  const after = end => { let j = end; while (j < source.length && /\s/.test(source[j])) j++; return source[j] || ''; };
  while (i < source.length) {
    const c = source[i], d = source[i + 1];
    if (c === '/' && d === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && d === '*') { i = source.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '\'' || c === '"') {
      const start = i; let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out.push({ kind: 'string', text: unescape(source.slice(i + 1, j)), start, end: j + 1, plusBefore: before(start) === '+', plusAfter: after(j + 1) === '+' });
      i = j + 1; last = 'x'; continue;
    }
    if (c === '`') {
      const start = i, parts = [], holes = []; let j = i + 1, part = '';
      while (j < source.length && source[j] !== '`') {
        if (source[j] === '\\') { part += source.slice(j, j + 2); j += 2; continue; }
        if (source[j] === '$' && source[j + 1] === '{') {
          parts.push(unescape(part)); part = ''; let depth = 1; j += 2; const holeStart = j;
          while (j < source.length && depth) {
            if (source[j] === '`') { j++; while (j < source.length && source[j] !== '`') { if (source[j] === '\\') j++; j++; } }
            else if (source[j] === '\'' || source[j] === '"') { const q = source[j++]; while (j < source.length && source[j] !== q) { if (source[j] === '\\') j++; j++; } }
            else if (source[j] === '{') depth++; else if (source[j] === '}') depth--;
            j++;
          }
          holes.push([holeStart, j - 1]);
          continue;
        }
        part += source[j++];
      }
      parts.push(unescape(part));
      out.push({ kind: parts.length > 1 ? 'template' : 'string', text: parts.join(''), parts, holes: holes.map(([from, to]) => source.slice(from, to)), start, end: j + 1, plusBefore: before(start) === '+', plusAfter: after(j + 1) === '+' });
      for (const [from, to] of holes) for (const inner of literals(source.slice(from, to))) out.push({ ...inner, start: inner.start + from, end: inner.end + from, inHole: true });
      i = j + 1; last = 'x'; continue;
    }
    if (c === '/' && prevAllowsRegex()) {
      const start = i; let j = i + 1, inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) { if (source[j] === '\\') j++; else if (source[j] === '[') inClass = true; else if (source[j] === ']') inClass = false; j++; }
      out.push({ kind: 'regex', text: source.slice(start + 1, j), start, end: j + 1 });
      i = j + 1; while (/[a-z]/.test(source[i] || '')) i++; last = 'x'; continue;
    }
    if (!/\s/.test(c)) last = /[\w$]/.test(c) ? (/[\w$]/.test(last.slice(-1)) ? last + c : c) : c;
    i++;
  }
  return out;
}
const texts = list => list.filter(l => l.kind !== 'regex');

const normal = text => text.replace(/\s+/g, ' ').trim();
const spaced = text => text.replace(/\s+/g, ' ');
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordy = text => /[\p{L}\p{N}]/u.test(text);
// A hole that only chooses between fixed strings (c ? '离开' : '加入', or { a: '失败', b: '已中断' }[k], or
// one string) can only produce those strings; any other hole stands for data.
function holeChoices(expr) {
  const strings = texts(literals(expr)), stripped = expr.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, 'S');
  if (/^\s*S\s*$/.test(stripped) || /^\s*\{(\s*[\w$]+\s*:\s*S\s*,?)+\s*\}\s*\[[^\]]*\]\s*$/.test(stripped)) return strings.map(l => l.text);
  const ternary = /\?\s*S\s*:\s*S\s*$/.test(stripped) && !/\?[^?]*\?/.test(stripped.replace(/^[^?]*\?/, '?'));
  return ternary && strings.length >= 2 ? strings.slice(-2).map(l => l.text) : null;
}
// A template's fixed parts keep their inner spaces (`加入 ${name}` is not `加入${name}`); only the
// whole template's ends are trimmed, as an accessible name is.
function template(parts, holes = []) {
  const fixed = parts.map(spaced); fixed[0] = fixed[0].trimStart(); fixed[fixed.length - 1] = fixed[fixed.length - 1].trimEnd();
  const choices = holes.map(holeChoices);
  const pattern = fixed.map((p, i) => escapeRe(p) + (i < choices.length ? (choices[i] ? `(?:${choices[i].map(c => escapeRe(spaced(c))).join('|')})` : '[\\s\\S]*?') : '')).join('');
  return { text: normal(parts.join('')), first: fixed[0], regex: new RegExp('^' + pattern + '$'), wordy: wordy(parts.join('')) || choices.some(c => c && c.some(wordy)) };
}
// The text of index.html: element text, including an element's whole text over its child elements,
// and the attribute values that give an accessible or visible name.
function htmlStrings(html) {
  const out = new Set();
  for (const m of html.matchAll(/\s(?:aria-label|title|placeholder|alt|value|label)="([^"]*)"/g)) out.add(normal(m[1]));
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  for (const m of text.matchAll(/>([^<]+)</g)) if (normal(m[1])) out.add(normal(m[1]));
  for (const m of text.matchAll(/<(button|summary|label|h[1-6]|option|a|legend|span|strong|p)\b[^>]*>([\s\S]*?)<\/\1>/g)) { const whole = normal(m[2].replace(/<[^>]+>/g, '')); if (whole) out.add(whole); }
  return out;
}
// A menu item is an object like { id: 'detach', label: '脱出协作' }: the string follows label: and the same
// object has an id. Other objects with a label (a send button's state, for one) are not menu items.
function menuLabel(source, start) {
  const before = source.slice(Math.max(0, start - 160), start), open = before.lastIndexOf('{');
  return /\blabel\s*:\s*$/.test(before) && open >= 0 && /\bid\s*:/.test(before.slice(open)) && !before.slice(open).includes('}');
}
function interfaceSource(dir = root) {
  // menuOnly: strings that only ever appear as a menu item's label. A button lookup for one of them finds
  // nothing: the control is a menu item, as 脱出协作 became.
  const strings = new Set(), templates = [], prefixes = new Set(), suffixes = new Set(), labels = new Set(), others = new Set();
  const files = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name), rel = path.relative(dir, file);
      if (entry.isDirectory()) { if (!['tests', 'node_modules'].includes(entry.name) && rel !== path.join('app', 'dsh', 'vendor')) walk(file); continue; }
      if (rel === path.join('app', 'dsh', 'client.js')) continue; // built from the renderer sources
      if (/\.(c|m)?js$/.test(entry.name) || entry.name.endsWith('.html')) files.push(file);
    }
  })(path.join(dir, 'app'));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.html')) { for (const s of htmlStrings(source)) { strings.add(s); others.add(s); } for (const m of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) collect(m[1]); continue; }
    collect(source);
  }
  function collect(source) {
    for (const l of texts(literals(source))) {
      const text = normal(l.text); if (!text) continue;
      if (l.kind === 'template') templates.push(template(l.parts, l.holes));
      else { strings.add(text); (menuLabel(source, l.start) ? labels : others).add(text); }
      if (l.plusAfter) prefixes.add(normal(l.text).trimStart());
      if (l.plusBefore) suffixes.add(normal(l.text).trimEnd());
    }
  }
  const menuOnly = new Set([...labels].filter(text => !others.has(text)));
  return { strings, templates: templates.filter(t => t.wordy), menuOnly, prefixes: [...prefixes].filter(p => p.length >= 2), suffixes: [...suffixes].filter(s => s.length >= 2), files: files.length };
}

// The fixed text a /^…/ expression always starts with: up to the first class, group or alternative; a
// character that a ?, * or {0 makes optional is not part of it.
function regexStart(body) {
  if (body[0] !== '^') return '';
  let out = '';
  for (let i = 1; i < body.length; i++) {
    let c = body[i];
    if (c === '\\') { if (/[sdwbSDWBpPu]/.test(body[i + 1])) break; c = body[++i]; }
    else if ('.*+?()[]{}|$'.includes(c)) break;
    if ('?*'.includes(body[i + 1]) || /^\{0/.test(body.slice(i + 1))) break;
    out += c;
  }
  return out;
}
// Every name a script looks up, with whether the lookup is exact.
function rawLookups(source) {
  const all = literals(source), found = [];
  const lineOf = index => source.slice(0, index).split('\n').length;
  const literalAt = index => all.find(l => l.start === index);
  const optionsAt = open => { let depth = 0, j = open; for (; j < source.length; j++) { if (source[j] === '{') depth++; else if (source[j] === '}' && !--depth) break; } return source.slice(open, j + 1); };
  // A lookup written as a template, or as a string followed by + …, has holes; they stand for data.
  const add = (lit, method, role, exact) => {
    if (!lit) return;
    if (lit.kind === 'regex') {
      const start = regexStart(lit.text);
      if (start.length >= 2) found.push({ method, role, exact: false, prefix: true, name: start, parts: null, start: lit.start, line: lineOf(lit.start) });
      return;
    }
    found.push({ method, role, exact, name: normal(lit.text), parts: lit.kind === 'template' ? lit.parts : lit.plusAfter ? [lit.text, ''] : null, holes: lit.kind === 'template' ? lit.holes : [], start: lit.start, line: lineOf(lit.start) });
  };
  for (const m of source.matchAll(/getByRole\(\s*(['"`])([\w-]+)\1\s*,\s*\{/g)) {
    const open = m.index + m[0].length - 1, options = optionsAt(open), exact = /\bexact\s*:\s*true\b/.test(options);
    const name = /\bname\s*:\s*/.exec(options), at = name ? open + name.index + name[0].length : -1;
    if (name && ['\'', '"', '`', '/'].includes(source[at])) { add(literalAt(at), 'getByRole', m[2], exact); continue; }
    // The name is a variable: a one-parameter helper (item('复制')) or a for…of over fixed names.
    const variable = name ? /^[\w$]+/.exec(source.slice(at))?.[0] : /\bname\b/.test(options) ? 'name' : null;
    if (!variable) continue;
    const before = source.slice(Math.max(0, m.index - 400), m.index);
    const helper = [...before.matchAll(new RegExp(`(?:(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:async\\s*)?(?:\\(\\s*${variable}\\b[^)]*\\)|${variable})\\s*=>|function\\s+([\\w$]+)\\s*\\(\\s*${variable}\\b)`, 'g'))].at(-1);
    const loop = [...before.matchAll(new RegExp(`for\\s*\\(\\s*const\\s+${variable}\\s+of\\s+\\[`, 'g'))].at(-1);
    if (loop && (!helper || loop.index > helper.index)) {
      const from = m.index - before.length + loop.index + loop[0].length, to = source.indexOf(']', from);
      for (const lit of all.filter(l => l.start >= from && l.start < to)) add(lit, 'getByRole', m[2], exact);
    } else if (helper) {
      const helperName = helper[1] || helper[2];
      for (const call of source.matchAll(new RegExp(`(?<![\\w$.])${helperName}\\(\\s*(?=['"\`])`, 'g'))) add(literalAt(call.index + call[0].length), helperName + '()', m[2], exact);
    }
  }
  for (const m of source.matchAll(/getBy(Text|Label|Title|Placeholder|AltText)\(\s*(?=['"`/])/g)) {
    const at = m.index + m[0].length, lit = literalAt(at); if (!lit) continue;
    const rest = source.slice(lit.end, lit.end + 120); add(lit, 'getBy' + m[1], null, /^(?:\s*\+\s*[\w$.()[\]'"`, -]+?)?\s*,\s*\{[^}]*\bexact\s*:\s*true/.test(rest));
  }
  for (const m of source.matchAll(/hasText\s*:\s*(?=['"`/])/g)) add(literalAt(m.index + m[0].length), 'hasText', null, false);
  for (const lit of all) {
    const t = lit.kind === 'string' && /^text=("?)(.+?)\1$/.exec(lit.text); if (t) found.push({ method: 'text=', role: null, exact: t[1] === '"', name: normal(t[2]), parts: null, start: lit.start, line: lineOf(lit.start) });
  }
  const seen = new Set(); return found.filter(f => !seen.has(f.start) && seen.add(f.start));
}
// Data: a string the script or a fixture uses outside a lookup (a session name it creates, a message a
// fixture emits). A control lookup (an exact getByRole of a control role) is only taken for data when the same whole string
// or a template of the script produces it; content lookups (getByText, hasText, …) also when a data
// string contains the name, since content is shown in pieces. So a sentence that mentions a renamed
// control's old name cannot hide that lookup.
const fixturesData = (dir = root) => fs.readdirSync(path.join(dir, 'scripts', 'fixtures')).filter(f => f.endsWith('.cjs')).flatMap(f => {
  // A string a fixture also looks up is an interface name, wherever else the fixture passes it.
  const source = fs.readFileSync(path.join(dir, 'scripts', 'fixtures', f), 'utf8'), own = rawLookups(source);
  const starts = new Set(own.map(l => l.start)), names = new Set(own.map(l => l.name));
  return texts(literals(source)).filter(l => !starts.has(l.start) && !names.has(normal(l.text)));
});
// Roles of controls the interface itself names; links, headings, cells and the like carry content.
const CONTROLS = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'separator', 'dialog']);
function lookups(source, fixtures = [], isFixture = false) {
  const found = rawLookups(source), starts = new Set(found.map(f => f.start)), names = new Set(found.map(f => f.name));
  // In a fixture, a string it also looks up is an interface name; in a script it is usually the data shown.
  const own = texts(literals(source)).filter(l => !starts.has(l.start) && !(isFixture && names.has(normal(l.text)))).concat(fixtures);
  const data = own.map(l => normal(l.text)).filter(Boolean);
  const patterns = own.filter(l => l.kind === 'template' && l.parts.join('').replace(/\s/g, '').length >= 3).map(l => template(l.parts, l.holes).regex);
  return found.filter(f => {
    if (f.prefix) return true;
    const control = f.exact && CONTROLS.has(f.role);
    if (!f.parts && patterns.some(r => r.test(f.name))) return false;
    if (control) return !data.includes(f.name);
    return !data.some(d => d === f.name || (f.name.length >= 3 && d.includes(f.name)) || (d.length >= 3 && !f.parts && f.name.includes(d) && /[A-Za-z0-9_]{3}/.test(d)));
  });
}
const HOLE = '\u2063'; // an invisible separator stands for a hole in a name
// The names an exact lookup with holes stands for: every choice of the holes that choose between fixed
// strings, a placeholder for the others.
function expansions(lookup) {
  const choices = (lookup.holes || []).map(holeChoices);
  let names = [''];
  lookup.parts.forEach((part, i) => { names = names.flatMap(n => i < lookup.parts.length - 1 ? (choices[i] || [HOLE]).map(c => n + part + c) : [n + part]); });
  return names.map(normal);
}
// The first name an exact lookup with holes stands for that the interface cannot produce, shown with … for a hole.
function missingName(ui, lookup) {
  const name = expansions(lookup).find(n => !produces(ui, { ...lookup, parts: null, holes: [], name: n }));
  return name === undefined ? null : name.split(HOLE).join('…');
}
function produces(ui, lookup) {
  if (lookup.prefix) {
    const starts = s => s.startsWith(lookup.name);
    return [...ui.strings].some(starts) || ui.prefixes.some(starts) || ui.templates.some(t => t.first && (starts(t.first) || (t.first.length >= 2 && lookup.name.startsWith(t.first))));
  }
  if (lookup.parts) {
    // A name written with holes. An exact one is filled with a placeholder and must fully match; any
    // other must have each fixed part occur in one interface string or template.
    if (lookup.exact) return !missingName(ui, lookup);
    const pieces = lookup.parts.map(p => normal(p)).filter(p => p.length >= 2);
    return pieces.every(p => [...ui.strings].some(s => s.includes(p)) || ui.templates.some(t => t.text.includes(p)));
  }
  const name = lookup.name, lower = name.toLowerCase();
  if (!lookup.exact && /\d/.test(name) && name.replace(/\d+/g, '').trim() && produces(ui, { ...lookup, name: normal(name.replace(/\d+/g, ' ')) })) return true;
  if (lookup.exact) {
    if (lookup.role === 'button' && ui.menuOnly.has(name) && !ui.templates.some(t => t.regex.test(name))) return false;
    if (ui.strings.has(name) || ui.templates.some(t => t.regex.test(name))) return true;
    return ui.prefixes.some(p => name.startsWith(p) && name.length > p.length) || ui.suffixes.some(s => name.endsWith(s) && name.length > s.length);
  }
  for (const s of ui.strings) if (s.toLowerCase().includes(lower)) return true;
  return ui.templates.some(t => t.text.toLowerCase().includes(lower) || new RegExp(t.regex.source.slice(1, -1), 'i').test(name)) ||
    ui.prefixes.some(p => lower.startsWith(p.toLowerCase())) || ui.suffixes.some(s => lower.endsWith(s.toLowerCase()));
}
function check(dir = root) {
  const ui = interfaceSource(dir), list = folder => fs.readdirSync(path.join(dir, folder)).filter(f => f.endsWith('.cjs') && f !== 'check-gui-names.cjs').map(f => path.join(folder, f));
  const scripts = [...list('scripts'), ...list(path.join('scripts', 'fixtures'))];
  const missing = []; let checked = 0;
  const fixtures = fixturesData(dir);
  for (const file of scripts) for (const lookup of lookups(fs.readFileSync(path.join(dir, file), 'utf8'), fixtures, file.startsWith(path.join('scripts', 'fixtures') + path.sep))) {
    checked++; if (produces(ui, lookup)) continue;
    const name = lookup.prefix ? `/^${lookup.name}/` : lookup.parts && lookup.exact ? missingName(ui, lookup) : lookup.name;
    missing.push({ file, line: lookup.line, method: lookup.method, role: lookup.role, exact: lookup.exact, name });
  }
  return { checked, scripts: scripts.length, sourceFiles: ui.files, missing };
}

module.exports = { literals, lookups, rawLookups, interfaceSource, produces, check };
if (require.main === module) {
  const result = check();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const m of result.missing) console.log(`${m.file}:${m.line}  ${m.method}${m.role ? `('${m.role}')` : ''}${m.exact ? ' exact' : ''}  「${m.name}」`);
    console.log(`${result.missing.length} name(s) not found in the interface source; ${result.checked} lookups in ${result.scripts} scripts checked against ${result.sourceFiles} source files.`);
  }
  process.exitCode = result.missing.length ? 1 : 0;
}
