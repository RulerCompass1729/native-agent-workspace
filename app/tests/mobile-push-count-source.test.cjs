const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const os=require('node:os'),path=require('node:path');
for (const [count, shown] of [[0,false],[37,false],[0,true],[37,true]]) test(`encrypted N equals desktop and phone totals: records=${count}, temp=${shown}`, async t => {
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'), commands = {};
  const start = source.indexOf('let mobileBroker;'), end = source.indexOf('const startupFile =', start);
  const records = source.indexOf("  register('records',"), recordsEnd = source.indexOf('\n  });', records) + '\n  });'.length;
  assert.ok(start >= 0 && end > start && records >= 0 && recordsEnd > records);
  const temp = { id: 'naw-temp-files', version:1, checkedAt:1000, shown, directories:shown?1:0, bytes:0, oldestDay:null, result:null, ticket:'PRIVATE_TICKET', candidates:['PRIVATE_PATH'] };
  const tempSource=require('../temp-reminders.cjs');
  const context = vm.createContext({ dataDir: '/synthetic-profile', operationsUnavailable: null, stewardRecord: null,
    recordReminders: { status: () => ({ count, records: [], privateName: 'PRIVATE_NAME' }), RECORDS: [] },
    tempSummary:tempSource.tempSummary, readTempSummary:()=>tempSource.tempSummary(temp), tempReminders:{cached:temp},
    currentTempReminders:()=>({present:async()=>temp}),
    roomState: {}, sessionLabels: { labels: new Map() }, broadcastRoom: async () => {},
    isCurrentHumanContext: () => true, register: (name, fn) => { commands[name] = fn; },
    require: name => { assert.equal(name, './mobile-workspace.cjs'); return { MobileWorkspace: class { constructor(options) { Object.assign(this, options); } } }; },
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(source.slice(records, recordsEnd), context);
  const workspace = context.appMobileWorkspace(), curve = crypto.createECDH('prime256v1'); curve.generateKeys();
  let body;
  const push = new (require('../mobile-push.cjs').MobilePush)({ authority: () => 'current-device',
    count: () => workspace.records.status().count, transport: async details => { body = details.body; return 201; } });
  t.after(() => push.close());
  const auth = crypto.randomBytes(16).toString('base64url');
  push.configuration(); push.subscribe({ endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth } });
  {
    await push.refresh();
    const desktop = await commands.records({}, 'status');
    const payload = JSON.parse(require('http_ece').decrypt(body, { version: 'aes128gcm', privateKey: curve, authSecret: auth }));
    const phone=workspace.records.status();
    assert.equal(desktop.count,count+(shown?1:0));
    assert.equal(phone.count,desktop.count);
    assert.deepEqual(payload, { count: desktop.count });
    assert.equal(desktop.temp.ticket,'PRIVATE_TICKET','Only the human desktop status retains the cleanup ticket');
    assert.doesNotMatch(JSON.stringify(phone.temp || {}),/PRIVATE_/);
  }
});
for(const count of [0,37])test(`present storage failure keeps desktop, phone and encrypted push counts equal: records=${count}`,async t=>{
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-count-failure-'))),profile=path.join(base,'profile');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(profile,{mode:0o700});
  const tempSource=require('../temp-reminders.cjs');let notices=0;
  const manager=new tempSource.TempReminders({dataDir:profile,registryDir:path.join(base,'registry'),roots:[base],now:()=>1000,
    inspect:async()=>({opened:[],mounted:[]}),isPerson:c=>c.human===true,changed:()=>{notices++;}});
  await manager.status();assert.equal(manager.cached.shown,false);const beforeFailure=notices,save=manager.save;
  manager.save=()=>{throw Error('synthetic storage unavailable');};
  const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8'),commands={};
  const start=source.indexOf('let mobileBroker;'),end=source.indexOf('const startupFile =',start);
  const records=source.indexOf("  register('records',"),recordsEnd=source.indexOf('\n  });',records)+'\n  });'.length;
  const context=vm.createContext({dataDir:profile,operationsUnavailable:null,stewardRecord:null,
    recordReminders:{status:()=>({count,records:[]}),RECORDS:[]},tempSummary:tempSource.tempSummary,
    readTempSummary:()=>tempSource.readSummary(profile),tempReminders:manager,currentTempReminders:()=>manager,
    roomState:{},sessionLabels:{labels:new Map()},broadcastRoom:async()=>{},
    isCurrentHumanContext:c=>c.human===true,uiError:key=>Error(key),register:(name,fn)=>{commands[name]=fn;},
    require:name=>{assert.equal(name,'./mobile-workspace.cjs');return {MobileWorkspace:class{constructor(options){Object.assign(this,options);}}};},
  });
  vm.runInContext(source.slice(start,end),context);vm.runInContext(source.slice(records,recordsEnd),context);
  const workspace=context.appMobileWorkspace(),person={human:true},desktop=await commands.records(person,'status',true);
  const phone=workspace.records.status();
  const curve=crypto.createECDH('prime256v1');curve.generateKeys();const auth=crypto.randomBytes(16).toString('base64url');let body;
  const push=new (require('../mobile-push.cjs').MobilePush)({authority:()=> 'synthetic-device',count:()=>workspace.records.status().count,
    transport:async details=>{body=details.body;return 201;}});t.after(()=>push.close());
  push.configuration();push.subscribe({endpoint:'https://web.push.apple.com/synthetic',expirationTime:null,keys:{p256dh:curve.getPublicKey().toString('base64url'),auth}});
  await push.refresh();const payload=JSON.parse(require('http_ece').decrypt(body,{version:'aes128gcm',privateKey:curve,authSecret:auth}));
  t.diagnostic(JSON.stringify({records:count,desktop:desktop.count,phone:phone.count,push:payload.count}));
  assert.equal(desktop.count,count+1);assert.equal(phone.count,desktop.count,'A failed present cannot leave the phone on the old quiet cache');
  assert.deepEqual(payload,{count:desktop.count});assert.equal(phone.temp.state,'unavailable');assert.equal(Object.hasOwn(phone.temp,'ticket'),false);
  assert.equal(JSON.stringify(phone.temp).includes(base),false);
  assert.equal(notices,beforeFailure+1,'Publish the changed count once so push and other windows can refresh');
  await commands.records(person,'status',true);assert.equal(notices,beforeFailure+1,'Repeated failures must not create a refresh feedback loop');
  manager.save=save;const recovered=await commands.records(person,'status');
  assert.equal(recovered.count,count,'An ordinary read retries after storage recovers instead of caching the failure for a day');
  assert.equal(workspace.records.status().count,count);await push.refresh();
  assert.deepEqual(JSON.parse(require('http_ece').decrypt(body,{version:'aes128gcm',privateKey:curve,authSecret:auth})),{count});
  await assert.rejects(commands.records({human:false},'status'),/personOnly/);
});
