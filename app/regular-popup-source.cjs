'use strict';
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const MAX_BYTES = 2 * 1024 * 1024, SOURCE = 'https://github.com/trending';
const plain = value => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
  const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  if (!entity.startsWith('#')) return names[entity.toLowerCase()];
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
}).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
function attributes(tag, start) {
  const result = Object.create(null); let i = start;
  while (i < tag.length - 1) {
    while (/\s/.test(tag[i] || '') && i < tag.length) i++;
    if (tag[i] === '/' || tag[i] === '>') break;
    const begin = i; while (i < tag.length && !/[\s=/>]/.test(tag[i])) i++;
    if (i === begin) throw Error('source-invalid');
    const name = tag.slice(begin, i).toLowerCase(); while (/\s/.test(tag[i] || '') && i < tag.length) i++;
    let value = '';
    if (tag[i] === '=') {
      i++; while (/\s/.test(tag[i] || '') && i < tag.length) i++;
      const quote = tag[i] === '"' || tag[i] === "'" ? tag[i++] : null, begin = i;
      if (quote) { while (i < tag.length && tag[i] !== quote) i++; if (i === tag.length) throw Error('source-invalid'); value = tag.slice(begin, i++); }
      else { while (i < tag.length && !/[\s>]/.test(tag[i])) i++; value = tag.slice(begin, i); }
    }
    if (Object.hasOwn(result, name)) throw Error('source-invalid'); result[name] = value;
  }
  return result;
}
function parseTrending(html, { deadline = Infinity } = {}) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) throw Error('source-invalid');
  const check = () => { if (performance.now() >= deadline) throw Error('source-deadline'); }; check();
  const rawEnds = { script: /<\/script(?=[\s>])/gi, style: /<\/style(?=[\s>])/gi }, rows = [], seen = new Set(); let cursor = 0, row = null, tags = 0;
  while (cursor < html.length) {
    check(); const start = html.indexOf('<', cursor);
    if (row?.inParagraph) row.parts.push(html.slice(cursor, start < 0 ? html.length : start));
    if (start < 0) break;
    if (html.startsWith('<!--', start)) { const end = html.indexOf('-->', start + 4); if (end < 0) throw Error('source-invalid'); cursor = end + 3; continue; }
    if (++tags > 100000) throw Error('source-invalid');
    let end = start + 1, quote = null;
    // The cursor never rewinds; oversized or unfinished tags fail closed.
    for (; end < html.length && end - start < 4096; end++) {
      if ((end & 1023) === 0) check(); const c = html[end];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      else if (c === '<') throw Error('source-invalid');
    }
    if (html[end] !== '>' || quote) throw Error('source-invalid');
    const tag = html.slice(start, end + 1), head = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(tag); cursor = end + 1;
    if (!head) continue;
    const name = head[2].toLowerCase(), closing = Boolean(head[1]), attr = closing ? null : attributes(tag, head[0].length);
    if (!closing && ['script', 'style'].includes(name)) {
      const pattern = rawEnds[name]; pattern.lastIndex = cursor; const close = pattern.exec(html);
      if (!close) throw Error('source-invalid'); cursor = close.index; continue;
    }
    if (name === 'article') {
      if (!closing) { if (row) throw Error('source-invalid'); if ((attr.class || '').split(/\s+/).includes('Box-row')) row = { parts: [], inHeading: false, heading: false, inParagraph: false, paragraph: false, href: null }; }
      else if (row) {
        const href = row.href;
        if (!row.heading || row.inHeading || row.inParagraph || !href || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(href) || href.split('/').some(p => p === '.' || p === '..') || seen.has(href) || href.length > 141 || rows.length === 30) throw Error('source-invalid');
        seen.add(href); rows.push({ id: 'repo-' + rows.length, title: href.slice(1), description: plain(row.parts.join(' ')).slice(0, 400), url: 'https://github.com' + href }); row = null;
      }
    } else if (row && name === 'h2') {
      if (closing) { if (!row.inHeading) throw Error('source-invalid'); row.inHeading = false; row.heading = true; }
      else { if (row.inHeading || row.heading) throw Error('source-invalid'); row.inHeading = true; }
    } else if (row?.inHeading && name === 'a' && !closing) {
      if (row.href) throw Error('source-invalid'); row.href = attr.href;
    } else if (row && name === 'p') {
      if (closing && row.inParagraph) { row.inParagraph = false; row.paragraph = true; }
      else if (!closing && !row.paragraph) { if (row.inParagraph) throw Error('source-invalid'); row.inParagraph = true; }
    }
  }
  check(); if (row || !rows.length) throw Error('source-invalid'); return rows;
}
function readSource({ signal } = {}, { get = https.get, timeoutMs = 15000 } = {}) {
  if (signal?.aborted) return Promise.reject(Error('source-cancelled'));
  return new Promise((resolve, reject) => {
    let request, response, done = false, bytes = 0; const chunks = [], deadline = performance.now() + timeoutMs;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { response?.destroy(); request?.destroy(); reject(Error('source-unavailable')); } else resolve(value); };
    const abort = () => finish(Error()), timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true });
    try { request = get(SOURCE, { agent: false, headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'Native-Agent-Workspace-Discoveries' } }, res => {
      response = res; if (done) { res.destroy(); return; }
      if (res.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(res.headers['content-type'] || '') || Number(res.headers['content-length'] || 0) > MAX_BYTES) { finish(Error()); return; }
      res.on('error', () => finish(Error())); res.on('aborted', () => finish(Error()));
      res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) finish(Error()); else if (!done) chunks.push(Buffer.from(chunk)); });
      res.on('end', () => { if (done) return; try { finish(null, parseTrending(Buffer.concat(chunks).toString('utf8'), { deadline })); } catch { finish(Error()); } });
    }); request.on('error', () => finish(Error())); } catch { finish(Error()); }
  });
}
module.exports = { parseTrending, readSource, MAX_BYTES, SOURCE };
