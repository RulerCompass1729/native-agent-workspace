// Pages served on this machine that the person declares in local-pages.json open
// in their own NAW window, or with "tab": true as a tab of the main window. Either is a plain browser page: a separate
// session per declared page, no preload (so no window.workspace), sandboxed,
// every permission refused, and requests limited to the declared origin. The
// main window's session and its request filter are not touched here.
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'local-pages.json', BOUNDS_FILE = 'local-page-windows.json';
const MAX_BYTES = 64 * 1024, MAX_PAGES = 50, MAX_PATH = 2048;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const HOSTS = new Set(['127.0.0.1', 'localhost']);
// A tab page hidden this long is closed; showing it again loads it again.
const RELEASE_MS = 20 * 60 * 1000, MAX_STRIP = 120;

// A declared address: http on 127.0.0.1 or localhost, any port, no credentials.
function localUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_PATH) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || !HOSTS.has(url.hostname) || url.username || url.password) return null;
  return url;
}

// Reads the declarations again on every open, so an edit needs no restart.
// One invalid entry rejects the whole file, naming the entry and the problem.
function readDeclarations(dataDir, uiError) {
  const file = path.join(dataDir, FILE);
  let raw;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw uiError('error.localPage.shape');
    if (stat.size > MAX_BYTES) throw uiError('error.localPage.shape');
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.uiMessage) throw error;
    if (error?.code === 'ENOENT') throw uiError('error.localPage.noDeclarations');
    throw uiError('error.localPage.unreadable');
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw uiError('error.localPage.unreadable'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.pages) || data.pages.length > MAX_PAGES) throw uiError('error.localPage.shape');
  // Ids that differ only in case would share one partition folder on a case-insensitive disk.
  const pages = new Map(), folded = new Set();
  data.pages.forEach((entry, i) => {
    const index = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !ID.test(entry.id)) throw uiError('error.localPage.entryId', { index });
    if (folded.has(entry.id.toLowerCase())) throw uiError('error.localPage.entryDuplicate', { index, id: entry.id });
    folded.add(entry.id.toLowerCase());
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title || [...title].length > 100) throw uiError('error.localPage.entryTitle', { index });
    const url = localUrl(entry.url);
    if (!url) throw uiError('error.localPage.entryUrl', { index });
    if (entry.tab !== undefined && typeof entry.tab !== 'boolean') throw uiError('error.localPage.entryTab', { index });
    pages.set(entry.id, { id: entry.id, title, url: url.href, origin: url.origin, ...(entry.tab ? { tab: true } : {}) });
  });
  return pages;
}

// A plugin may give a path and query (for example "/?tab=x"). It is resolved
// under the declared origin only; a full address or another origin is refused.
function pageUrl(page, requested, uiError) {
  if (requested === undefined || requested === null) return page.url;
  if (typeof requested !== 'string' || requested.length > MAX_PATH || !requested.startsWith('/') || requested.startsWith('//') ||
      /[\\\u0000-\u001f\u007f]/u.test(requested)) throw uiError('error.localPage.path');
  let url;
  try { url = new URL(requested, page.origin); } catch { throw uiError('error.localPage.path'); }
  if (url.origin !== page.origin) throw uiError('error.localPage.path');
  return url.href;
}

// The partition's only network peer is the declared origin (and a WebSocket to
// the same host and port). Inline data: and same-origin blob: contact no server.
function allowedRequest(origin, address) {
  let url;
  try { url = new URL(address); } catch { return false; }
  if (url.protocol === 'data:') return true;
  if (url.origin === origin) return true;
  return url.protocol === 'ws:' && `http://${url.host}` === origin;
}

const escapeHtml = value => String(value).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Shown instead of a blank window when the page cannot load. No script runs in
// it; the retry link is an ordinary same-origin navigation.
function errorPage({ title, heading, detail, retry, url }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
    `<title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}` +
    `body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:560px;padding:24px}` +
    `h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;opacity:.8;overflow-wrap:anywhere}a{font-weight:600}</style></head>` +
    `<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p><a href="${escapeHtml(url)}">${escapeHtml(retry)}</a></main></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function readBounds(dataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, BOUNDS_FILE), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function validBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isSafeInteger) || width < 320 || height < 240 || width > 20000 || height > 20000) return null;
  return { x, y, width, height };
}

// Test launches keep the hidden window painting (backgroundThrottling) for screenshots.
function createLocalPages({ dataDir, BrowserWindow, WebContentsView, session, shell, screen, uiError, displayText, windowDefaults = {}, present, backgroundThrottling = true,
  notify = () => {}, timers = { set: setTimeout, clear: clearTimeout } }) {
  const open = new Map(), origins = new Map(), prepared = new Set();
  // Tab pages: id -> { view, page, host, timer, retry }; hosts: main window context -> { active, top }.
  const tabbed = new Map(), hosts = new Map(), resume = new Map();
  const show = present || (win => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); });

  function onScreen(bounds) {
    try {
      return screen.getAllDisplays().some(({ workArea: a }) => bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
    } catch { return false; }
  }
  function saveBounds(id, bounds) {
    const all = readBounds(dataDir);
    all[id] = bounds;
    const file = path.join(dataDir, BOUNDS_FILE), temporary = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(all), { mode: 0o600 }); fs.renameSync(temporary, file); }
    catch { fs.rmSync(temporary, { force: true }); /* The next open uses the default size. */ }
  }
  function prepare(id) {
    const partition = `persist:naw-local-page-${id}`;
    const ses = session.fromPartition(partition);
    if (!prepared.has(partition)) {
      prepared.add(partition);
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(origins.get(id), details.url) }));
    }
    return partition;
  }
  function preferences(id) {
    return {
      partition: prepare(id), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webviewTag: false, navigateOnDragDrop: false, safeDialogs: true, spellcheck: false,
      ...(backgroundThrottling === false ? { backgroundThrottling: false } : {}),
    };
  }
  const sameOrigin = (id, address) => { try { return new URL(address).origin === origins.get(id); } catch { return false; } };
  // The same limits for a page window and a tab page.
  function guard(wc, entry) {
    // WebRTC does not pass through the request filter; keep it off direct UDP.
    if (typeof wc.setWebRTCIPHandlingPolicy === 'function') wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    wc.setWindowOpenHandler(({ url }) => {
      try { const u = new URL(url); if (u.protocol === 'http:' || u.protocol === 'https:') Promise.resolve(shell.openExternal(u.href)).catch(() => {}); } catch { /* Not a link. */ }
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => { if (!sameOrigin(entry.page.id, url)) event.preventDefault(); });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is an interrupted load, normally a newer navigation; never replace it.
      if (!isMainFrame || code === -3 || String(url).startsWith('data:')) return;
      const target = sameOrigin(entry.page.id, url) ? url : entry.page.url;
      entry.retry = target;
      wc.loadURL(errorPage({
        title: entry.page.title, url: target, retry: displayText('localPage.retry'),
        heading: displayText('localPage.unavailable', { title: entry.page.title }),
        detail: displayText('localPage.unavailableDetail', { origin: entry.page.origin, reason: String(description || code).slice(0, 120) }),
      })).catch(() => {});
    });
  }
  function create(page, target) {
    const saved = validBounds(readBounds(dataDir)[page.id]);
    const bounds = saved && onScreen(saved) ? saved : saved ? { width: saved.width, height: saved.height } : {};
    const win = new BrowserWindow({
      title: page.title, width: 1180, height: 820, minWidth: 480, minHeight: 360, ...bounds, ...windowDefaults,
      webPreferences: preferences(page.id),
    });
    const entry = { win, page };
    open.set(page.id, entry);
    const wc = win.webContents;
    guard(wc, entry);
    wc.on('page-title-updated', event => { event.preventDefault(); win.setTitle(entry.page.title); });
    win.on('close', () => { try { saveBounds(page.id, win.getNormalBounds()); } catch { /* Default size next time. */ } });
    win.on('closed', () => { if (open.get(page.id) === entry) open.delete(page.id); });
    wc.loadURL(target).catch(() => { /* did-fail-load shows the reason in the window. */ });
    return entry;
  }

  function tabPages() {
    try { return [...readDeclarations(dataDir, uiError).values()].filter(page => page.tab); } catch { return []; }
  }
  function state(owner) {
    return { tabs: tabPages().map(({ id, title }) => ({ id, title })), active: hosts.get(owner)?.active ?? null };
  }
  const tell = owner => { if (!owner.win.isDestroyed()) notify(owner, state(owner)); };
  // Control-Tab and Control-Shift-Tab step through NAW and the tab pages, from NAW or from inside a page.
  function step(owner, event, input) {
    if (input.type !== 'keyDown' || input.key !== 'Tab' || !input.control || input.alt || input.meta) return;
    const ids = [null, ...tabPages().map(page => page.id)];
    if (ids.length < 2) return;
    event.preventDefault();
    const at = Math.max(0, ids.indexOf(hosts.get(owner)?.active ?? null));
    try { select(owner, ids[(at + (input.shift ? -1 : 1) + ids.length) % ids.length]); } catch { /* The declarations changed meanwhile. */ }
  }
  function host(owner) {
    let entry = hosts.get(owner);
    if (!entry) {
      entry = { active: null, top: 30 };
      hosts.set(owner, entry);
      owner.win.on('resize', () => place(owner));
      owner.win.webContents.on('before-input-event', (event, input) => step(owner, event, input));
    }
    return entry;
  }
  function place(owner) {
    const entry = tabbed.get(hosts.get(owner)?.active);
    if (!entry?.view || owner.win.isDestroyed()) return;
    const { width, height } = owner.win.getContentBounds();
    const y = Math.round(hosts.get(owner).top * owner.win.webContents.getZoomFactor());
    entry.view.setBounds({ x: 0, y, width, height: Math.max(0, height - y) });
  }
  function release(entry) {
    timers.clear(entry.timer);
    if (tabbed.get(entry.page.id) === entry) tabbed.delete(entry.page.id);
    const wc = entry.view.webContents;
    if (!wc.isDestroyed()) {
      const url = wc.getURL();
      if (sameOrigin(entry.page.id, url)) resume.set(entry.page.id, url);
    }
    if (entry.host && !entry.host.win.isDestroyed()) entry.host.win.contentView.removeChildView(entry.view);
    if (entry.host && hosts.get(entry.host)?.active === entry.page.id) hosts.get(entry.host).active = null;
    if (!wc.isDestroyed()) wc.close();
  }
  function conceal(owner) {
    const current = hosts.get(owner), entry = tabbed.get(current?.active);
    if (!current?.active) return;
    current.active = null;
    if (!entry) return;
    entry.view.setVisible(false);
    entry.timer = timers.set(() => release(entry), RELEASE_MS);
  }
  function createView(page, target) {
    const view = new WebContentsView({ webPreferences: preferences(page.id) });
    const entry = { view, page, host: null, timer: null, retry: null };
    tabbed.set(page.id, entry);
    guard(view.webContents, entry);
    view.webContents.on('before-input-event', (event, input) => { if (entry.host) step(entry.host, event, input); });
    view.webContents.loadURL(target).catch(() => { /* did-fail-load shows the reason in the page. */ });
    return entry;
  }
  // Shows NAW (id null) or a tab page in this window. A page shown in another window moves here as it is.
  function select(owner, id, target) {
    const current = host(owner);
    if (id === null) {
      conceal(owner);
      owner.win.webContents.focus();
      tell(owner);
      return state(owner);
    }
    const page = tabPages().find(item => item.id === id);
    if (!page) throw uiError('error.localPage.unknown', { id: typeof id === 'string' ? id.slice(0, 64) : '' });
    origins.set(page.id, page.origin);
    let entry = tabbed.get(page.id);
    if (entry) entry.page = page;
    else entry = createView(page, target || resume.get(page.id) || page.url);
    if (current.active !== page.id) conceal(owner);
    timers.clear(entry.timer); entry.timer = null;
    const previous = entry.host;
    if (previous !== owner) {
      if (previous && !previous.win.isDestroyed()) {
        previous.win.contentView.removeChildView(entry.view);
        if (hosts.get(previous)?.active === page.id) { hosts.get(previous).active = null; tell(previous); }
      }
      entry.host = owner;
      owner.win.contentView.addChildView(entry.view);
    }
    current.active = page.id;
    entry.view.setVisible(true);
    place(owner);
    entry.view.webContents.focus();
    tell(owner);
    return state(owner);
  }

  return {
    tabs(owner) {
      const current = host(owner), result = state(owner);
      // A page taken out of the declarations, or no longer a tab, stops covering NAW.
      if (current.active && !result.tabs.some(tab => tab.id === current.active)) { conceal(owner); return state(owner); }
      return result;
    },
    show: (owner, id) => select(owner, id),
    reload(owner, id) {
      const entry = tabbed.get(id);
      if (!entry || entry.host !== owner) return select(owner, id);
      const wc = entry.view.webContents;
      if (wc.getURL().startsWith('data:') && entry.retry) wc.loadURL(entry.retry).catch(() => {});
      else wc.reload();
      return state(owner);
    },
    // The renderer reports the strip height in CSS pixels; the page starts below it.
    layout(owner, top) {
      if (typeof top !== 'number' || !Number.isFinite(top) || top < 0 || top > MAX_STRIP) throw new TypeError('Tab strip height out of range');
      host(owner).top = top;
      place(owner);
    },
    closeOwner(owner) {
      for (const entry of [...tabbed.values()]) if (entry.host === owner) release(entry);
      hosts.delete(owner);
    },
    async open(id, requested, { background = false, owner = null } = {}) {
      if (background) throw uiError('error.localPage.background');
      const pages = readDeclarations(dataDir, uiError);
      const page = typeof id === 'string' ? pages.get(id) : undefined;
      if (!page) throw uiError('error.localPage.unknown', { id: typeof id === 'string' ? id.slice(0, 64) : '' });
      const target = pageUrl(page, requested, uiError);
      const given = requested !== undefined && requested !== null;
      if (page.tab && owner) {
        const existing = tabbed.get(page.id);
        if (existing) {
          const moved = origins.get(page.id) !== page.origin;
          origins.set(page.id, page.origin);
          if (given || moved) existing.view.webContents.loadURL(target).catch(() => {});
          select(owner, page.id);
          return { id: page.id, url: target, reused: true, tab: true };
        }
        select(owner, page.id, given ? target : null);
        return { id: page.id, url: target, reused: false, tab: true };
      }
      const current = open.get(page.id);
      if (current && !current.win.isDestroyed()) {
        const moved = origins.get(page.id) !== page.origin;
        origins.set(page.id, page.origin); current.page = page; current.win.setTitle(page.title);
        if (requested !== undefined && requested !== null || moved) current.win.webContents.loadURL(target).catch(() => {});
        show(current.win);
        return { id: page.id, url: target, reused: true };
      }
      origins.set(page.id, page.origin);
      const entry = create(page, target);
      show(entry.win);
      return { id: page.id, url: target, reused: false };
    },
    windows: () => [...open.values()].map(entry => entry.win).filter(win => !win.isDestroyed()),
  };
}

module.exports = { createLocalPages, readDeclarations, pageUrl, allowedRequest, errorPage, FILE, BOUNDS_FILE, RELEASE_MS };
