// Actual renderSessions and locale bindings in a real browser DOM. Synthetic
// state/helpers isolate name, short ID and time writes; no model or daily app.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'app/dsh/bootstrap.js'), 'utf8');
const slice = (text, from, to) => { const a = text.indexOf(from), b = text.indexOf(to, a); assert.ok(a >= 0 && b > a); return text.slice(a, b); };
let browser, passed = 0;
const check = (name, yes) => { assert.ok(yes, name); console.log('PASS', name); passed++; };
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.NAW_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext(); await context.route('**/*', route => route.abort());
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<main></main>');
  await page.addScriptTag({ content: `
    let language = 'zh', idPrefix = '';
    const node = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
    const elements = new Map(), $ = id => { if (!elements.has(id)) { const n = node('div'); n.id = id; document.querySelector('main').append(n); elements.set(id, n); } return elements.get(id); };
    const uiText = key => key === 'butler.name' ? (language === 'zh' ? '大管家' : 'Butler') : key;
    ${slice(bootstrap, 'function createDisplayBindings(', 'function mountWorkspace(')}
    const ui = { display: createDisplayBindings(uiText) };
    const people = Array.from({ length: 6 }, (_, i) => ({ id: 'synthetic-session-' + i, name: '合成成员 ' + i, state: 'working', timeText: '14:03' }));
    const state = { sessions: people, appVersion: 'synthetic' }, sessionRows = new Map(), sidebarGroups = new Map();
    const sidebarView = 'flat', sessionMenu = null, renameTarget = null, selected = '', hoverSpace = '';
    function seed(key, record) { const row = { element: node('div') };
      for (const field of ['avatar', 'link', 'name', 'shortId', 'status', 'badges', 'version', 'more', 'time', 'dot', 'marker']) {
        row[field] = node('span'); row.element.append(row[field]);
      } sessionRows.set(key, row);
    }
    for (const p of people) seed(p.id, p); seed('steward:' + people[0].id, people[0]);
    const renderVersions = () => {}, renderSidebarGroups = () => {}, sidebarSessions = () => people, allSpaces = () => [];
    const stewardRecord = () => people[0], renderStewardEntry = () => {}, sameNameSessions = () => new Set();
    const paintVendorMark = () => {}, makerLabel = () => 'Codex', sessionShortId = id => idPrefix + id.slice(-1);
    const sidebarPresentation = () => ({ full: 'working', compact: 'working', tone: 'working', marker: '' });
    const backendVersionNotice = () => null, sidebarDetails = () => [], sessionTimes = () => 'Synthetic time';
    const sessionActivityTime = record => record.timeText, highlightSpace = () => {};
    ${slice(source, 'function renderSessions(', 'function createReadiness(')}
    renderSessions();
    const targets = new Map(); for (const row of sessionRows.values()) for (const field of ['name', 'shortId', 'time']) targets.set(row[field], field);
    const observer = new MutationObserver(() => {}); for (const el of targets.keys()) observer.observe(el, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    const sample = fn => { observer.takeRecords(); fn(); const count = { name: 0, shortId: 0, time: 0 };
      for (const m of observer.takeRecords()) { const field = targets.get(m.target) || targets.get(m.target.parentElement); if (field) count[field]++; } return count; };
    window.probe = { repeat: () => sample(() => { for (let i = 0; i < 50; i++) renderSessions(); }),
      change: () => { const writes = sample(() => { people[1].name = '新名字'; idPrefix = 'new-'; people[0].timeText = '14:04'; renderSessions(); });
        return { writes, name: sessionRows.get(people[1].id).name.textContent, shortId: sessionRows.get(people[1].id).shortId.textContent, time: sessionRows.get(people[0].id).time.textContent }; },
      translate: () => { language = 'en'; ui.display.refresh(document.body); return { butler: sessionRows.get('steward:' + people[0].id).name.textContent, name: sessionRows.get(people[1].id).name.textContent }; } };
  ` });
  const counts = await page.evaluate(() => probe.repeat());
  console.log('MUTATIONS', JSON.stringify({ renders: 50, regularRows: 6, butlerRows: 1, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }));
  for (const field of ['name', 'shortId', 'time']) check('unchanged ' + field + ' produces zero DOM text mutations', counts[field] === 0);
  const changed = await page.evaluate(() => probe.change());
  console.log('CHANGED', JSON.stringify(changed));
  check('a changed name updates once', changed.name === '新名字' && changed.writes.name === 1);
  check('changed short IDs still update', changed.shortId === 'new-1' && changed.writes.shortId === 6);
  check('changed time updates both occurrences', changed.time === '14:04' && changed.writes.time === 2);
  const labels = await page.evaluate(() => probe.translate());
  check('butler localization still updates without translating the original name', labels.butler === 'Butler' && labels.name === '新名字');
  check('zero browser errors', errors.length === 0);
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); console.log(`SIDEBAR TEXT PASS ${passed} FAIL ${process.exitCode ? 1 : 0} SKIP 0`);
});
