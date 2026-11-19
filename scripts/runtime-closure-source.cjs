'use strict';
const targets = ['names', 'pluginFiles', 'pluginTests'];
const unsupported = () => { throw Error('Unconfirmed bootstrap definition'); };
const word = (token, value) => token?.kind === 'word' && token.value === value;
const punct = (token, value) => token?.kind === 'punct' && token.value === value;
function tokens(source) {
  const out = []; let i = 0;
  const add = (kind, value) => { if (out.length >= 200000) unsupported(); out.push({ kind, value }); };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { i += 2; while (i < source.length && !/[\r\n\u2028\u2029]/.test(source[i])) i++; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) unsupported(); i = end + 2; continue; }
    if (c === "'" || c === '"') {
      const start = ++i;
      while (i < source.length && source[i] !== c) {
        if (/[\r\n\u2028\u2029]/.test(source[i])) unsupported();
        if (source[i] === '\\') i++;
        i++;
      }
      if (i >= source.length) unsupported(); add('string', source.slice(start, i++)); continue;
    }
    if (c === '`') {
      if (out.at(-1)?.kind === 'word' || punct(out.at(-1), ')') || punct(out.at(-1), ']')) unsupported();
      i++;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source.startsWith('${', i)) {
          const end = source.indexOf('}', i + 2), reference = source.slice(i + 2, end).trim();
          if (end < 0 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(reference) || targets.includes(reference)) unsupported();
          i = end + 1; continue;
        }
        i++;
      }
      if (i >= source.length) unsupported(); i++; add('opaque', 'template'); continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++; while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      const value = source.slice(start, i); if (['eval', 'Function', 'with'].includes(value)) unsupported(); add('word', value); continue;
    }
    if (/[0-9]/.test(c)) { const start = i++; while (i < source.length && /[0-9]/.test(source[i])) i++; add('number', source.slice(start, i)); continue; }
    // Regex/division and escaped identifiers need a fuller grammar; never guess their boundaries.
    if (!'{}()[];,.?:=!+-*%&|<>~^'.includes(c)) unsupported();
    add('punct', c); i++;
  }
  return out;
}
function matching(list, start, open, close) {
  let depth = 0;
  for (let i = start; i < list.length; i++) { if (punct(list[i], open)) depth++; if (punct(list[i], close) && --depth === 0) return i; }
  return unsupported();
}
function literalLists(source) {
  const list = tokens(source), scopes = [];
  for (let i = 0; i < list.length; i++) {
    list[i].scope = scopes.at(-1) ?? -1;
    if (punct(list[i], '{')) scopes.push(i);
    if (punct(list[i], '}')) { if (!scopes.length) unsupported(); scopes.pop(); }
  }
  if (scopes.length) unsupported();
  const hosts = list.map((t, i) => word(t, 'function') && word(list[i + 1], 'ensureServiceAt') ? i : -1).filter(i => i >= 0);
  if (hosts.length !== 1) unsupported();
  const host = hosts[0], before = word(list[host - 1], 'async') ? host - 2 : host - 1;
  if (list[host].scope !== -1 || before >= 0 && !punct(list[before], ';') && !punct(list[before], '}') || !punct(list[host + 2], '(')) unsupported();
  const body = matching(list, host + 2, '(', ')') + 1;
  if (!punct(list[body], '{')) unsupported();
  matching(list, body, '{', '}');
  const result = {};
  for (const name of targets) {
    let definitions = 0, references = 0;
    for (let i = 0; i < list.length; i++) {
      if (!word(list[i], name)) continue;
      if (punct(list[i + 1], ':') && (punct(list[i - 1], ',') || punct(list[i - 1], '{'))) continue;
      if (list[i].scope !== body) unsupported();
      if (word(list[i - 1], 'const')) {
        if (++definitions !== 1 || ![';', '{', '}'].some(p => punct(list[i - 2], p)) || !punct(list[i + 1], '=') || !punct(list[i + 2], '[')) unsupported();
        const values = []; let j = i + 3;
        while (!punct(list[j], ']')) {
          if (list[j]?.kind !== 'string' || !/^[A-Za-z0-9_./@-]+$/.test(list[j].value)) unsupported();
          values.push(list[j++].value);
          if (punct(list[j], ']')) break;
          if (!punct(list[j++], ',')) unsupported();
        }
        if (!values.length || !punct(list[j + 1], ';')) unsupported(); result[name] = values;
      } else {
        if (!word(list[i - 5], 'for') || !punct(list[i - 4], '(') || !word(list[i - 3], 'const') || !word(list[i - 2], 'name') || !word(list[i - 1], 'of') || !punct(list[i + 1], ')')) unsupported();
        references++;
      }
    }
    if (definitions !== 1 || references !== 2) unsupported();
  }
  return result;
}
module.exports = { literalLists };
