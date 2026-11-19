// Synthetic browser transport; no pairing, provider, or daily profile.
const fs = require('node:fs'), path = require('node:path');
const { devices, ...browsers } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const engine = process.env.NAW_NAV_ENGINE || 'webkit', results = [], errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(20); } throw Error('Synthetic navigation did not settle'); }
const check = (name, pass, actual) => { results.push({ name, pass: Boolean(pass), actual }); console.log(JSON.stringify(results.at(-1))); };
const sessions = ['claude', 'codex'].map(id => ({ id, nativeId: 'native-' + id, provider: id, name: 'Synthetic ' + id, available: true, state: 'idle', messages: [{ role: 'assistant', name: 'Synthetic '+id, text: 'WORKSPACE-'+id }] }));
let browser;
async function scene(language, options = {}) {
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: language === 'zh' ? 'zh-CN' : 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage(), held = [], writes = [];
  let hold = options.deep ? '/mobile/read/claude' : null;
  page.on('pageerror', e => errors.push(e.message));
  const row = id => ({ id, contextId: (id==='claude'?'K':'L').repeat(43), canSend: true, messages: [{text:'READ-'+id}], question: null });
  const session = { deviceId: '00000000-0000-4000-8000-000000000001', csrf: 'A'.repeat(43), sessions, workspace: options.workspace !== false };
  const workspace = { sessions, rooms: [], confirmations: [], reminders: { count: 0, records: [] }, capabilities: { push: false }, syncedAt: 1 };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'https://phone.invalid') { errors.push('Unexpected external request'); return route.abort(); }
    if (request.method() === 'POST') writes.push({path:url.pathname,body:request.postDataJSON()});
    if(url.pathname==='/mobile/pair'){session.deviceId='00000000-0000-4000-8000-000000000002';session.csrf='D'.repeat(43);session.sessions=[sessions[1]];workspace.sessions=[sessions[1]];return route.fulfill({json:{paired:true}});}
    if(url.pathname.startsWith('/mobile/read/')&&!session.sessions.some(s=>s.id===decodeURIComponent(url.pathname.slice('/mobile/read/'.length))))return route.fulfill({status:403,json:{error:'MOBILE_DENIED'}});
    const data = url.pathname === '/mobile/session' ? session : url.pathname === '/mobile/workspace' ? workspace :
      url.pathname.startsWith('/mobile/read/') ? row(decodeURIComponent(url.pathname.slice('/mobile/read/'.length))) :
      url.pathname === '/mobile/send' ? { requestId: request.postDataJSON().requestId, sessionId: request.postDataJSON().contextId==='L'.repeat(43)?'codex':'claude', action: 'send', status: 'submitted' } : null;
    const frozenData=data?structuredClone(data):null; const fulfill = () => frozenData ? route.fulfill({ json: frozenData }) : route.fulfill({ status: 404, body: '' });
    if (url.pathname === hold) { held.push({ route, fulfill }); return; }
    if (data) return fulfill();
    const file = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
    if (!['index.html', 'client.js', 'workspace.js', 'passkeys.js', 'push.js', 'style.css', 'manifest.webmanifest'].includes(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, 'app/mobile-web', file)) });
  });
  await page.goto('https://phone.invalid/mobile/#' + language + (options.deep ? '/chat/claude' : '/home'));
  if (options.deep) await until(() => held.length);
  else await page.waitForFunction(() => document.documentElement.dataset.loading === 'false' && document.querySelector('#content a[href$="/chat/claude"]'));
  return { page, writes, held, hold(value) { hold = value; }, async release(only) {
    if (!only) hold = null;
    for (const item of [...held]) if (!only || new URL(item.route.request().url()).pathname === only) { held.splice(held.indexOf(item), 1); await item.fulfill(); }
  },
    async close() { for (const item of held.splice(0)) await item.route.abort().catch(() => {}); await context.close(); } };
}
(async()=>{try{
 browser=await browsers[engine].launch({headless:true,executablePath:process.env.NAW_BROWSER_EXECUTABLE});const s=await scene('zh');
 try{
  s.hold('/mobile/workspace');await s.page.locator('#content a[href="#zh/chat/claude"]').tap();await until(()=>s.held.length);await s.page.locator('#message').fill('OLD-A-DRAFT');
  check('positive control: old grant and A content are visible',await s.page.evaluate(()=>nawPhone.client.state.session.sessions.some(s=>s.id==='claude')&&document.querySelector('.thread').textContent.includes('WORKSPACE-claude')));
  await s.page.evaluate(()=>location.hash='#pair='+'P'.repeat(43));await s.page.waitForFunction(()=>nawPhone.client.state.session?.deviceId==='00000000-0000-4000-8000-000000000002'&&document.documentElement.dataset.loading==='false');
  const home=await s.page.evaluate(()=>({scopes:nawPhone.client.state.session.sessions.map(s=>s.id),oldLink:document.querySelectorAll('#content a[href="#zh/chat/claude"]').length,loading:document.documentElement.dataset.loading}));
  check('new grant forbids A and hides its link',home.scopes.length===1&&home.scopes[0]==='codex'&&home.oldLink===0,home);
  if(home.oldLink){await s.page.locator('#content a[href="#zh/chat/claude"]').tap();await s.page.waitForFunction(()=>document.documentElement.dataset.page==='chat'&&document.documentElement.dataset.loading==='false');}
  const observe=()=>s.page.evaluate(()=>({scopes:nawPhone.client.state.session.sessions.map(s=>s.id),page:document.documentElement.dataset.page,thread:document.querySelector('.thread')?.textContent,selected:nawPhone.client.state.selected,row:nawPhone.client.state.row?.id,sendEnabled:!!document.querySelector('#send-message')&&!document.querySelector('#send-message').disabled}));
  let state=await observe();check('new grant never exposes A while old workspace is pending',!state.thread?.includes('WORKSPACE-claude')&&!state.sendEnabled,state);
  await s.release();await s.page.waitForTimeout(100);state=await observe();check('late old workspace cannot repopulate A under new grant',!state.thread?.includes('WORKSPACE-claude')&&!state.sendEnabled,state);
  await s.page.route('https://phone.invalid/mobile/session', route => route.fulfill({status:403,json:{error:'MOBILE_DENIED'}}));
  await s.page.evaluate(()=>nawPhone.client.start());
  check('a current authorization rejection clears the live reading state',await s.page.evaluate(()=>
    nawPhone.client.state.session===null&&nawPhone.client.state.selected===null&&nawPhone.client.state.row===null&&
    !document.querySelector('.thread')&&!document.querySelector('#send-message')));
  check('the old device draft stays scoped in browser storage',await s.page.evaluate(()=>
    nawPhone.client.state.drafts.some(d=>d.deviceId==='00000000-0000-4000-8000-000000000001'&&d.sessionId==='claude'&&d.text==='OLD-A-DRAFT')));
  check('no native or send action is attempted',s.writes.every(w=>w.path==='/mobile/pair'),s.writes.map(w=>w.path));
 }finally{await s.close();}
 check('no page errors or external requests',errors.length===0,errors);
 }finally{await browser?.close();}
 const summary={pass:results.filter(r=>r.pass).length,fail:results.filter(r=>!r.pass).length,skipped:0};console.log('SUMMARY '+JSON.stringify(summary));if(process.env.NAW_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR,'auth-results.json'),JSON.stringify({results,errors,summary},null,2));process.exitCode=summary.fail?1:0;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
