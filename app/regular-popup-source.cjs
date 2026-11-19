'use strict';
const https = require('node:https');
const MAX_BYTES = 2 * 1024 * 1024, SOURCE = 'https://github.com/trending';
const plain = value => value.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
  const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  if (!entity.startsWith('#')) return names[entity.toLowerCase()];
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
}).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
function parseTrending(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) throw Error('source-invalid');
  const articles = [...html.matchAll(/<article\b[^>]*class=["'][^"']*\bBox-row\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)];
  if (!articles.length || articles.length > 30) throw Error('source-invalid');
  const seen = new Set();
  return articles.map((article, index) => {
    const heading = article[1].match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1], href = heading?.match(/<a\b[^>]*href=["'](\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["']/i)?.[1];
    if (!href || href.split('/').some(p => p === '.' || p === '..') || seen.has(href)) throw Error('source-invalid');
    seen.add(href); const title = href.slice(1), description = plain(article[1].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '').slice(0, 400);
    if (title.length > 140) throw Error('source-invalid');
    return { id: 'repo-' + index, title, description, url: 'https://github.com' + href };
  });
}
function readSource({ signal } = {}, { get = https.get, timeoutMs = 15000 } = {}) {
  if (signal?.aborted) return Promise.reject(Error('source-cancelled'));
  return new Promise((resolve, reject) => {
    let request, response, done = false, bytes = 0; const chunks = [];
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { response?.destroy(); request?.destroy(); reject(Error('source-unavailable')); } else resolve(value); };
    const abort = () => finish(Error()), timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true });
    try { request = get(SOURCE, { agent: false, headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'Native-Agent-Workspace-Discoveries' } }, res => {
      response = res;
      if (res.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(res.headers['content-type'] || '') || Number(res.headers['content-length'] || 0) > MAX_BYTES) { finish(Error()); return; }
      res.on('error', () => finish(Error())); res.on('aborted', () => finish(Error()));
      res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) finish(Error()); else if (!done) chunks.push(Buffer.from(chunk)); });
      res.on('end', () => { if (done) return; try { finish(null, parseTrending(Buffer.concat(chunks).toString('utf8'))); } catch { finish(Error()); } });
    }); request.on('error', () => finish(Error())); } catch { finish(Error()); }
  });
}
module.exports = { parseTrending, readSource, MAX_BYTES, SOURCE };
