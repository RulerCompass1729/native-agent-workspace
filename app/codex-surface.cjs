// The part of the Codex app-server protocol NAW uses, and how a new version's
// schema is compared with it (B3). Only the closure of what NAW sends or reads
// is extracted; union types keep only the variants NAW sends or reads.
// Rules (b3-spec.md 1.4): in what NAW sends, a new optional field or value is
// safe; in what NAW reads, a new optional field is safe but a new variant
// counts as touched; any other difference counts as touched. The permission
// surface (requests NAW relays to the person) never opens or closes a gate:
// any change there becomes a record for a person to look at.
const fs = require('node:fs'), path = require('node:path');

const VARIANTS = Object.freeze({
  // NAW sends text and localImage (space-images.cjs), reads text, image and localImage (native-images.cjs).
  UserInput: ['text', 'image', 'localImage'],
  // NAW reads only text parts of content items (codex-tool-content.cjs).
  ContentItem: ['input_text', 'output_text'],
});
const request = method => ({ schema: 'ClientRequest', method });
const notice = method => ({ schema: 'ServerNotification', method });
const turnEvents = ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta'].map(notice);
const MANIFEST = Object.freeze({
  history: [request('thread/list'), request('thread/read'), request('thread/items/list'), request('thread/turns/list')],
  steer: [request('turn/steer'), ...turnEvents],
  terminalBridge: [request('initialize'), request('thread/start'), request('thread/resume'), notice('thread/started'), notice('thread/status/changed')],
  spaceImages: [request('turn/start'), notice('item/started'), notice('item/completed')],
  addressedTool: [{ schema: 'ServerRequest', method: 'item/tool/call' }],
  capacity: [request('turn/start'), notice('turn/completed'), notice('thread/status/changed')],
});
// NAW relays every server request to the person (adapters.cjs: anything ending in
// /requestUserInput waits for input, everything else is an approval).
const PERMISSION = Object.freeze(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'applyPatchApproval', 'execCommandApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
  'account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read']);

const tag = alt => alt?.properties?.type?.enum?.[0] ?? alt?.title ?? JSON.stringify(alt);
function loadSchema(dir, name) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const entries = Object.create(null);
  for (const alt of doc.oneOf || []) { const m = alt?.properties?.method?.enum?.[0]; if (m) entries[m] = alt; }
  return { entries, definitions: doc.definitions || {} };
}
function responses(dir) {
  const out = Object.create(null);
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), name = e.name.slice(0, -5);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('Response.json')) { if (name in out) throw Error(`Two reply schemas named ${name}`); out[name] = JSON.parse(fs.readFileSync(p, 'utf8')); }
  } };
  walk(dir); return out;
}
// The definitions reachable from node, with filtered unions; refs keep their names.
function closure(node, definitions) {
  const out = Object.create(null);
  const visit = n => {
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!n || typeof n !== 'object') return;
    const ref = typeof n.$ref === 'string' && n.$ref.startsWith('#/definitions/') ? n.$ref.slice(14) : null;
    if (ref && !(ref in out)) {
      let def = definitions[ref];
      // Keep only the variants NAW uses, but remember every tag so a new one is still seen.
      if (def && VARIANTS[ref]) for (const key of ['oneOf', 'anyOf']) if (Array.isArray(def[key])) def = { ...def, [key]: def[key].filter(a => VARIANTS[ref].includes(tag(a))), nawVariantTags: def[key].map(tag).sort() };
      out[ref] = def ?? null; visit(def);
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(node); return out;
}
function entrySurface(dir, schemas, replies, { schema, method }) {
  const s = schemas[schema], root = s.entries[method];
  if (!root) return null;
  const surface = { root, definitions: closure(root, s.definitions) };
  // A method's reply schema is named after its params definition: ThreadListParams -> ThreadListResponse.
  const params = root.properties?.params?.$ref?.replace(/^#\/definitions\//, '');
  const reply = params && params.endsWith('Params') ? replies[params.slice(0, -6) + 'Response'] : undefined;
  // A reply file embeds its whole definitions table; only the referenced closure is part of the surface.
  if (reply) { const { definitions = {}, ...replyRoot } = reply; surface.response = { root: replyRoot, definitions: closure(replyRoot, definitions) }; }
  return surface;
}
// Only the surface NAW uses, from a bundle written by `codex app-server generate-json-schema`.
function extract(dir, version) {
  const schemas = { ClientRequest: loadSchema(dir, 'ClientRequest'), ServerNotification: loadSchema(dir, 'ServerNotification'), ServerRequest: loadSchema(dir, 'ServerRequest') };
  const replies = responses(dir), entries = Object.create(null);
  const add = item => { const key = `${item.schema}:${item.method}`; if (!(key in entries)) entries[key] = entrySurface(dir, schemas, replies, item); };
  for (const items of Object.values(MANIFEST)) items.forEach(add);
  for (const method of PERMISSION) add({ schema: 'ServerRequest', method });
  // NAW relays every server request, so a new request type is a permission-surface change.
  const serverRequests = Object.keys(schemas.ServerRequest.entries).sort();
  return { version, serverRequests, entries: JSON.parse(JSON.stringify(entries)) };
}

// Annotations that are not contract. Inside a properties or definitions map the keys are
// field and type names, never annotations, so they are always kept.
const IGNORED = new Set(['description', 'title', '$schema', 'examples']);
const MAPS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);
const strip = (n, map = false) => Array.isArray(n) ? n.map(x => strip(x)) : n && typeof n === 'object'
  ? Object.fromEntries(Object.entries(n).filter(([k]) => map || !IGNORED.has(k)).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, strip(v, !map && MAPS.has(k))])) : n;
const same = (a, b, map = false) => JSON.stringify(strip(a, map)) === JSON.stringify(strip(b, map));
// 'same' < 'field' (new optional property or relaxed value set) < 'variant' (new alternative) < 'breaking'.
const RANK = { same: 0, field: 1, variant: 2, breaking: 3 };
const worst = (...k) => k.reduce((x, y) => RANK[y] > RANK[x] ? y : x, 'same');
// notes collects where each non-safe change is, for the decision record.
function classify(a, b, at = '', notes = []) {
  if (same(a, b)) return 'same';
  const note = (change, kind) => { notes.push({ at: at || '(root)', change }); return kind; };
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return note(!a ? 'added' : !b ? 'removed' : 'type changed', 'breaking');
  let kind = 'same';
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => !IGNORED.has(k)));
  for (const key of keys) {
    const x = a[key], y = b[key], here = at ? `${at}.${key}` : key;
    // A properties map's keys are field names: compare it as a map, not as a schema.
    if (same(x, y, MAPS.has(key))) continue;
    if (key === 'properties') {
      for (const p of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
        const field = `${at}.${p}`;
        if (!(p in (y || {}))) { notes.push({ at: field, change: 'field removed' }); return 'breaking'; }
        if (!(p in (x || {}))) {
          if ((b.required || []).includes(p)) { notes.push({ at: field, change: 'required field added' }); return 'breaking'; }
          notes.push({ at: field, change: 'optional field added' }); kind = worst(kind, 'field');
        } else kind = worst(kind, classify(x[p], y[p], field, notes));
      }
    } else if (key === 'required') {
      if ((y || []).some(r => !(x || []).includes(r) && (a.properties || {})[r] !== undefined)) return note('field became required', 'breaking');
      if ((x || []).some(r => !(y || []).includes(r))) return note('field became optional', 'breaking');
    } else if (key === 'enum') {
      if (!(x || []).every(v => (y || []).includes(v))) return note('value removed', 'breaking');
      notes.push({ at: here, change: 'value added' }); kind = worst(kind, 'variant');
    } else if (key === 'nawVariantTags') {
      const added = (y || []).filter(t => !(x || []).includes(t));
      if (added.length) { notes.push({ at: here, change: `new variant ${added.join(', ')}` }); kind = worst(kind, 'variant'); }
    } else if (key === 'oneOf' || key === 'anyOf') {
      const old = new Map((x || []).map(alt => [tag(alt), alt])), now = new Map((y || []).map(alt => [tag(alt), alt]));
      for (const [t, alt] of old) { if (!now.has(t)) { notes.push({ at: `${here}[${t}]`, change: 'variant removed' }); return 'breaking'; } kind = worst(kind, classify(alt, now.get(t), `${here}[${t}]`, notes)); }
      const added = [...now.keys()].filter(t => !old.has(t));
      if (added.length) { notes.push({ at: here, change: `new variant ${added.join(', ')}` }); kind = worst(kind, 'variant'); }
    } else if (key === 'items' || key === 'additionalProperties') kind = worst(kind, classify(x, y, here, notes));
    else return note(`${key} changed`, 'breaking');
  }
  return kind;
}
// One entry's change. NAW sends its own requests' params and server requests' replies; it reads the rest.
function compareEntry(a, b, schema, notes = []) {
  // An entry the manifest names must exist; missing on either side is not a pass.
  if (!a || !b) { notes.push({ at: '(entry)', change: !a && !b ? 'missing in both' : !b ? 'removed' : 'added' }); return 'breaking'; }
  const part = (x, y, reading, label) => {
    // A definition that only the new closure reaches is judged where it is referenced.
    const local = [];
    let k = classify(x?.root, y?.root, label, local);
    for (const d of Object.keys(x?.definitions || {})) {
      if (d in (y?.definitions || {})) k = worst(k, classify(x.definitions[d], y.definitions[d], d, local));
      else { local.push({ at: d, change: 'type no longer reachable' }); k = 'breaking'; }
    }
    const result = reading && k === 'variant' ? 'breaking' : k === 'variant' ? 'field' : k;
    if (result === 'breaking') for (const n of local) notes.push({ ...n, side: reading ? 'NAW reads' : 'NAW sends' });
    return result;
  };
  const own = schema === 'ClientRequest';
  const params = part(a, b, !own, 'params'), response = a.response || b.response ? part(a.response, b.response, own, 'reply') : 'same';
  return worst(params, response);
}
// Per capability: open if nothing NAW uses changed beyond safe additions; plus permission records.
function decide(baseline, candidate) {
  const capabilities = {}, touched = {}, records = [];
  for (const [capability, items] of Object.entries(MANIFEST)) {
    touched[capability] = [];
    for (const item of items) {
      const key = `${item.schema}:${item.method}`;
      const notes = [], kind = compareEntry(baseline.entries[key], candidate.entries[key], item.schema, notes);
      if (kind === 'breaking') touched[capability].push({ entry: key, changes: notes.filter(n => n.change !== 'optional field added').slice(0, 20) });
    }
    capabilities[capability] = touched[capability].length === 0;
  }
  for (const method of PERMISSION) {
    const key = `ServerRequest:${method}`;
    if (!same(baseline.entries[key], candidate.entries[key])) records.push({ kind: 'permission-surface-changed', entry: key });
  }
  const known = new Set(baseline.serverRequests || []);
  for (const method of candidate.serverRequests || []) if (!known.has(method)) records.push({ kind: 'permission-surface-changed', entry: `ServerRequest:${method}`, added: true });
  for (const [capability, entries] of Object.entries(touched)) if (entries.length) records.push({ kind: 'capability-held', capability, entries });
  return { basis: baseline.version, version: candidate.version, capabilities, records };
}

// Stored form: descriptions dropped (comparison ignores them), each definition kept once.
const DROPPED = new Set(['description', 'examples', '$schema']);
const lean = (n, map = false) => Array.isArray(n) ? n.map(x => lean(x)) : n && typeof n === 'object'
  ? Object.fromEntries(Object.entries(n).filter(([k]) => map || !DROPPED.has(k)).map(([k, v]) => [k, lean(v, !map && MAPS.has(k))])) : n;
function pack(surface, provenance) {
  const definitions = Object.create(null);
  const part = x => {
    if (!x) return x;
    for (const [name, def] of Object.entries(x.definitions)) {
      const kept = lean(def);
      if (name in definitions && JSON.stringify(definitions[name]) !== JSON.stringify(kept)) throw Error(`Two different definitions named ${name}; snapshot not written`);
      definitions[name] = kept;
    }
    return { root: lean(x.root), definitions: Object.keys(x.definitions) };
  };
  const entries = Object.fromEntries(Object.entries(surface.entries).map(([key, e]) => [key, e && { ...part(e), ...(e.response ? { response: part(e.response) } : {}) }]));
  return { version: surface.version, provenance, serverRequests: surface.serverRequests, definitions, entries };
}
function unpack(stored) {
  const part = x => x && { root: x.root, definitions: Object.fromEntries(x.definitions.map(n => [n, stored.definitions[n]])) };
  return { version: stored.version, serverRequests: stored.serverRequests, entries: Object.fromEntries(Object.entries(stored.entries).map(([key, e]) => [key, e && { ...part(e), ...(e.response ? { response: part(e.response) } : {}) }])) };
}

module.exports = { VARIANTS, MANIFEST, PERMISSION, extract, classify, compareEntry, decide, pack, unpack };
