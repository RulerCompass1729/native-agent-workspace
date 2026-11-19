/* Explicit local setup, inside the existing setup dialog. Opening is read-only. */
(function (global) {
  'use strict';
  // Text comes from the catalog (mobile.*). The renderer passes its interface-language text and display bindings, so a
  // language switch repaints the panel in place; without them (unit tests) the Chinese catalog text is used.
  // remembered/remember carry the last checked address, Tailscale user and port across restarts. Never secrets or links.
  function bind({ container, document, api, getSessions, getRooms = () => [], now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, text, display, remembered = () => null, remember = () => {} }) {
    const oneStep = typeof api.mobileConnect === 'function';
    const renewable = oneStep && typeof api.mobileSetupStatus === 'function';
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const { validActor } = global.nativeWorkspaceMobileIdentity || (typeof require === 'function' ? require('../mobile-identity.js') : {});
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, params); return el; };
    const quiet = el => { if (display) display.unbind(el); el.textContent = ''; };
    const attribute = (el, name, key) => { if (display) display.attribute(el, name, key); else el.setAttribute(name, format(key)); };
    const node = (tag, key) => { const el = document.createElement(tag); if (key !== undefined) say(el, key); return el; };
    const raw = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
    // A label holding an input keeps its text in its own leaf, which the display bindings can repaint.
    const labelled = (key, input) => { const box = document.createElement('label'); box.append(node('span', key), input); return box; };
    // A checkbox sits left of its own text on one line, so it cannot look like it belongs to the row above.
    const checkbox = id => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      if (id) input.id = id;
      return input;
    };
    const checkRow = (input, words) => {
      const box = document.createElement('label');
      box.className = 'mobile-check';
      box.append(input, words);
      return box;
    };
    const section = node('details'), summary = node('summary', 'mobile.title'); section.append(summary);
    section.addEventListener('toggle', () => { if (section.open) summary.scrollIntoView?.({ block: 'start' }); else if (renewable && opened) invalidatePairing(); });
    const status = document.createElement('p'); status.id = 'mobile-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    section.append(node('p', 'mobile.introCompact'));
    const advanced = node('details'), advancedTitle = node('summary', 'mobile.advanced'); advanced.id = 'mobile-advanced'; advancedTitle.id = 'mobile-advanced-title'; advanced.append(advancedTitle);
    const hint = key => { const el = node('p', key); el.className = 'quiet'; advanced.append(el); };
    const check = (key, id, parent = advanced) => { const input = checkbox(id), row = checkRow(input, node('span', key)); parent.append(row); return input; };
    const field = (key, id, type, parent) => { const input = document.createElement('input'); input.id = id; input.type = type; parent.append(labelled(key, input)); return input; };
    const connection = document.createElement('div'), connectionFields = document.createElement('div'); connection.id = 'mobile-connection-summary'; connection.className = 'mobile-connection-summary'; connectionFields.id = 'mobile-connection-fields';
    const endpoint = document.createElement('span'); endpoint.className = 'mobile-endpoint';
    const endpointHost = raw('span', ''), endpointActor = raw('span', ''), endpointPort = raw('span', '');
    endpointHost.id = 'mobile-endpoint-host'; endpointActor.id = 'mobile-endpoint-actor'; endpointPort.id = 'mobile-endpoint-port';
    endpoint.append(endpointHost, raw('span', ' · '), endpointActor, raw('span', ' · '), endpointPort);
    const editConnection = node('button', 'mobile.editConnection'); editConnection.type = 'button'; editConnection.id = 'mobile-edit-connection'; connection.append(endpoint, editConnection);
    section.append(connection, connectionFields);
    const origin = field('mobile.origin', 'mobile-origin', 'url', connectionFields); origin.placeholder = 'https://device.example.ts.net'; origin.autocomplete = 'off'; origin.maxLength = 2048;
    const actor = field('mobile.actor', 'mobile-actor', 'text', connectionFields); actor.autocomplete = 'off'; actor.maxLength = 320;
    let actorInvalid = false;
    function clearActorError() { actorInvalid = false; actor.setAttribute('aria-invalid', 'false'); actor.setAttribute('aria-describedby', ''); }
    clearActorError();
    actor.addEventListener('input', () => { invalidatePairing(); if (actorInvalid && validActor(actor.value.trim())) { clearActorError(); quiet(status); } });
    origin.addEventListener('input', invalidatePairing);
    const port = field('mobile.port', 'mobile-port', 'number', advanced); port.min = '0'; port.max = '65535'; port.value = '0';
    const carrier = checkbox('mobile-carrier'), carrierRow = checkRow(carrier, node('span', 'mobile.carrierCompact')); section.append(carrierRow); attribute(carrier, 'title', 'mobile.carrier');
    editConnection.addEventListener('click', () => { connection.hidden = true; connectionFields.hidden = false; origin.focus?.(); });
    // About 90 sessions: a search narrows the list, chosen sessions stay listed first, and each one's
    // send/answer choices appear only after it is chosen.
    const choices = document.createElement('fieldset'); choices.className = 'mobile-sessions'; section.append(choices);
    const search = document.createElement('input'); search.type = 'search'; search.id = 'mobile-session-filter'; search.autocomplete = 'off'; search.maxLength = 200;
    attribute(search, 'placeholder', 'mobile.sessionSearch'); attribute(search, 'aria-label', 'mobile.sessionSearch');
    const count = document.createElement('p'); count.className = 'quiet mobile-count'; count.setAttribute('aria-live', 'polite');
    const list = document.createElement('div'); list.className = 'mobile-session-list';
    const noMatch = node('p', 'mobile.noMatch'); noMatch.className = 'quiet'; noMatch.hidden = true;
    const spaces = document.createElement('fieldset'); spaces.className = 'mobile-spaces'; spaces.append(node('legend', 'mobile.spaces')); advanced.append(spaces);
    const records = checkbox('mobile-records'), recordsRow = checkRow(records, node('span', 'mobile.allowRecords')); advanced.append(recordsRow);
    hint('mobile.workspaceNote');
    const replace = check('mobile.replace', 'mobile-replace');
    hint('mobile.note');
    const prepare = node('button', 'mobile.prepare'), revoke = node('button', 'mobile.revoke'); prepare.type = revoke.type = 'button'; prepare.id = 'mobile-prepare'; revoke.id = 'mobile-revoke';
    const link = document.createElement('input'); link.id = 'mobile-pair-link'; link.readOnly = true; link.autocomplete = 'off';
    const linkBox = labelled('mobile.link', link); linkBox.hidden = true;
    const actions = document.createElement('div'); actions.className = 'mobile-pair-actions'; actions.append(prepare, revoke);
    section.append(advanced, actions, linkBox, status); container.append(section);
    // Sensitive approvals start folded: they are off by default and come after pairing.
    const approval = document.createElement('details'), approvalTitle = document.createElement('summary'); approval.id = 'mobile-approval-section'; say(approvalTitle, 'mobile.approvalTitle'); approval.append(approvalTitle);
    const approvalInfo = document.createElement('p'), fingerprint = document.createElement('output'); fingerprint.id = 'mobile-approval-fingerprint';
    const approvalBegin = say(document.createElement('button'), 'mobile.approvalBegin'), approvalRefresh = say(document.createElement('button'), 'mobile.approvalRefresh'), approvalConfirm = say(document.createElement('button'), 'mobile.approvalConfirm'), approvalRevoke = say(document.createElement('button'), 'mobile.approvalRevoke');
    for (const [button, id] of [[approvalBegin, 'begin'], [approvalRefresh, 'refresh'], [approvalConfirm, 'confirm'], [approvalRevoke, 'revoke']]) { button.type = 'button'; button.id = 'mobile-approval-' + id; }
    const matched = checkbox('mobile-approval-matched'), enabled = checkbox('mobile-approval-enabled');
    approval.append(approvalInfo, labelled('mobile.approvalFingerprint', fingerprint), approvalBegin, approvalRefresh, checkRow(matched, node('span', 'mobile.approvalMatched')), approvalConfirm, checkRow(enabled, node('span', 'mobile.approvalEnable')), approvalRevoke); advanced.append(approval);
    const allSessions = checkbox('mobile-all-sessions'), sharedHost = checkbox('mobile-shared-host'), qr = document.createElement('img');
    const sharedError=node('div'),sharedErrorTitle=node('strong','mobile.sharedHostBlocked'),sharedErrorBody=node('p');
    sharedError.id='mobile-shared-error';sharedError.className='mobile-shared-error';sharedError.hidden=true;sharedError.setAttribute('role','alert');sharedError.append(sharedErrorTitle,sharedErrorBody);
    const renewalHint=node('p');renewalHint.className='quiet mobile-renewal-hint';renewalHint.hidden=true;
    const qrTrust=node('p','mobile.qrTrust');qrTrust.className='quiet';qrTrust.hidden=true;
    qr.id = 'mobile-pair-qr'; qr.hidden = true; attribute(qr, 'alt', 'mobile.qrAlt');
    const fullScope = node('p', 'mobile.fullScope'), fullBoundary = node('p', 'mobile.fullStage1');
    fullScope.className = fullBoundary.className = 'quiet';
    function showScope() {
      if (!oneStep) return;
      const all = allSessions.checked;
      choices.hidden = carrierRow.hidden = spaces.hidden = recordsRow.hidden = all; connection.hidden = connectionFields.hidden = all;
      if (port.parentElement) port.parentElement.hidden = all;
      fullScope.hidden = fullBoundary.hidden = !all;
      if (!all) showConnection(recall());
      say(prepare, all ? setupId && renewable ? 'mobile.refreshQr' : approvalValue?.paired ? 'mobile.replacePhone' : 'mobile.connect' : 'mobile.prepare');
      if(oneStep)say(fullBoundary,approvalValue?.paired?'mobile.replaceAfterComplete':'mobile.fullStage2');
    }
    if (oneStep) {
      allSessions.checked = true;
      advanced.prepend(checkRow(allSessions, node('span', 'mobile.scopeAll')), sharedError, checkRow(sharedHost, node('span', 'mobile.sharedHost')));
      advanced.append(connection, connectionFields, carrierRow, choices);
      section.insertBefore(fullScope, advanced); section.insertBefore(fullBoundary, advanced); section.insertBefore(status,actions);section.insertBefore(renewalHint,actions);section.append(qr,qrTrust);
      allSessions.addEventListener('change', () => { invalidatePairing(); showScope(); });
      sharedHost.addEventListener('change', invalidatePairing);
    }
    let approvalValue = null;
    function showApproval(value) {
      approvalValue = value; matched.checked = false; enabled.indeterminate = false; enabled.checked = value?.enabled === true;
      enabled.disabled = !value?.registered; approvalConfirm.disabled = true; approvalBegin.disabled = !value?.paired;
      fingerprint.value = ((value?.pending?.fingerprint || value?.fingerprint || '').match(/.{1,8}/g) || []).join(' ');
      if (value?.pending) say(approvalInfo, 'mobile.approvalCode', { code: value.pending.code }); else say(approvalInfo, value?.paired ? 'mobile.approvalHelp' : 'mobile.approvalPairFirst');
      updateAdvanced();showScope();
    }
    async function approvalAction(method, value) {
      if (!opened || typeof api[method] !== 'function') return;
      const ticket = revision;
      try { await api[method](value); const next = await api.mobileApprovalStatus(); if (opened && revision === ticket) showApproval(next); }
      catch { if (opened && revision === ticket) { enabled.indeterminate = true; enabled.disabled = true; approvalConfirm.disabled = true; say(approvalInfo, 'mobile.approvalUnconfirmed'); updateAdvanced(); } }
    }
    approvalBegin.addEventListener('click', () => approvalAction('mobileApprovalBegin'));
    approvalRefresh.addEventListener('click', () => approvalAction('mobileApprovalStatus'));
    approvalRevoke.addEventListener('click', () => approvalAction('mobileApprovalRevoke'));
    matched.addEventListener('change', () => { approvalConfirm.disabled = !(matched.checked && approvalValue?.pending?.ready); updateAdvanced(); });
    approvalConfirm.addEventListener('click', () => {
      const pending = approvalValue?.pending;
      if (matched.checked && pending?.ready) approvalAction('mobileApprovalConfirm', { registrationId: pending.registrationId, fingerprint: pending.fingerprint });
    });
    enabled.addEventListener('change', () => { updateAdvanced(); approvalAction('mobileApprovalEnable', { enabled: enabled.checked, registrationId: approvalValue?.registrationId }); });
    let revision = 0, timer, opened = false, busy = false, selections = [], roomSelections = [],setupId=null;
    let renewUntil=0,qrUntil=0,nextCheck=0,renewedAt=0,enrollment=false;
    function updateAdvanced() {
      const count = Number(port.value !== '0') + roomSelections.filter(r => r.input.checked).length + Number(records.checked) + Number(replace.checked) +
        Number(matched.checked) + Number(enabled.checked || enabled.indeterminate) + Number(Boolean(approvalValue?.registered || approvalValue?.pending));
      say(advancedTitle, count ? 'mobile.advancedActive' : 'mobile.advanced', { count });
    }
    const configurationChanged = () => { invalidatePairing(); updateAdvanced(); };
    port.addEventListener('input', configurationChanged); port.addEventListener('change', configurationChanged);
    records.addEventListener('change', configurationChanged); replace.addEventListener('change', configurationChanged);
    carrier.addEventListener('change', invalidatePairing);
    const cancelCode = id => {if(id && typeof api.mobileCancelSetup==='function')Promise.resolve(api.mobileCancelSetup({setupId:id})).catch(()=>{});};
    const clearLink = (cancel=true) => { if(cancel){const old=setupId;setupId=null;renewUntil=0;enrollment=false;cancelCode(old);}clearTimer(timer); timer = undefined; link.value = ''; linkBox.hidden = true; if (oneStep) { qr.removeAttribute('src'); qr.hidden = true;qrTrust.hidden=true; } };
    function invalidatePairing() {
      revision++; clearLink(); hideSharedError();quiet(renewalHint);renewalHint.hidden=true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');busy = false; prepare.disabled = false;showScope();
      if (opened) say(status, oneStep && allSessions.checked ? 'mobile.autoReady' : 'mobile.idle');
    }
    function hideSharedError() {
      sharedError.hidden=true;sharedHost.setAttribute('aria-invalid','false');sharedHost.setAttribute('aria-describedby','');quiet(sharedErrorBody);
    }
    function sharedHostError(error) {
      const value=error?.uiMessage?.params?.ports;
      const ports=typeof value==='string' && /^\d{1,5}(?:, \d{1,5}){0,31}$/.test(value) && value.split(', ').every(p=>Number(p)>0 && Number(p)<=65535)?value:null;
      advanced.open=true;say(sharedErrorBody,ports?'error.mobile.sharedHostPorts':'error.mobile.sharedHost',ports?{ports}:undefined);
      sharedError.hidden=false;sharedHost.setAttribute('aria-invalid','true');sharedHost.setAttribute('aria-describedby',sharedError.id);quiet(status);
      sharedHost.focus?.();sharedHost.scrollIntoView?.({block:'center'});
    }
    function renewalState(key,hint) {
      status.className='mobile-renewal-state'+(key==='mobile.renewPaused'?' mobile-renewal-paused':'');status.setAttribute('role','status');status.setAttribute('aria-live','polite');say(status,key);
      renewalHint.hidden=!hint;if(hint)say(renewalHint,hint);else quiet(renewalHint);
    }
    function countdown() {
      const seconds=Math.max(0,Math.ceil((qrUntil-now())/1000)),time=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
      status.className='mobile-countdown';status.setAttribute('role','timer');status.setAttribute('aria-live','off');
      const fresh=renewedAt>0 && now()-renewedAt<5000;say(status,fresh?'mobile.qrRenewed':'mobile.qrCountdown',{time});
      renewalHint.hidden=false;say(renewalHint,fresh?'mobile.qrOldInvalid':'mobile.autoRenewHint');
    }
    async function completedEnrollment(ticket,id) {
      let value;try{value=await api.mobileApprovalStatus();}catch{}
      if(!opened || !section.open || revision!==ticket || setupId!==id)return;
      clearLink(false);enrollment=false;prepare.disabled=false;
      if(value?.paired===true) {setupId=null;showApproval(value);renewalState('mobile.connected');}
      else renewalState('mobile.renewUnconfirmed');
    }
    async function enrollmentTick(ticket,id) {
      timer=undefined;
      if(!opened || !section.open || revision!==ticket || setupId!==id)return;
      let info;try{info=await api.mobileSetupStatus({setupId:id});}catch{}
      if(!opened || !section.open || revision!==ticket || setupId!==id)return;
      if(info?.setupId===id && info.state==='complete') {await completedEnrollment(ticket,id);return;}
      if(info?.setupId!==id || info.state!=='redeemed' || info.redeemed!==true || !Number.isSafeInteger(info.expiresAt) || info.expiresAt<=now()) {
        clearLink(false);enrollment=false;prepare.disabled=false;renewalState('mobile.renewUnconfirmed');return;
      }
      timer=setTimer(()=>enrollmentTick(ticket,id),Math.min(5000,info.expiresAt-now()));
    }
    function pauseRenewal() {clearLink(false);setupId=null;renewalState('mobile.renewPaused','mobile.renewContinue');say(prepare,'mobile.refreshQr');}
    async function renewalTick(ticket) {
      timer=undefined;
      if(!opened || !section.open || revision!==ticket || !setupId)return;
      const id=setupId;
      if(now()>=nextCheck || now()>=qrUntil || now()>=renewUntil) {
        let info;try{info=await api.mobileSetupStatus({setupId:id});}catch{}
        if(!opened || !section.open || revision!==ticket || setupId!==id)return;
        if(info?.setupId===id && info.state==='complete') {await completedEnrollment(ticket,id);return;}
        if(info?.setupId!==id || !['waiting','expired','redeemed'].includes(info.state) || typeof info.redeemed!=='boolean') {
          if(now()>=renewUntil)pauseRenewal();else {clearLink(false);renewUntil=0;renewalState('mobile.renewUnconfirmed');}return;
        }
        if(info.redeemed) {
          clearLink(false);
          if(info.state!=='redeemed' || !Number.isSafeInteger(info.expiresAt) || info.expiresAt<=now()) {enrollment=false;prepare.disabled=false;renewalState('mobile.renewUnconfirmed');return;}
          enrollment=true;prepare.disabled=true;renewalState('mobile.enrollmentActive','mobile.enrollmentHint');timer=setTimer(()=>enrollmentTick(ticket,id),Math.min(5000,info.expiresAt-now()));return;
        }
        nextCheck=now()+5000;
      }
      if(now()>=renewUntil) {pauseRenewal();return;}
      if(now()>=qrUntil) {await pair(true);return;}
      countdown();timer=setTimer(()=>renewalTick(ticket),Math.min(1000,qrUntil-now()));
    }
    function counted() {
      say(count, 'mobile.selectedCount', { count: selections.filter(s => s.read.checked).length, total: selections.length });
    }
    // Reorders only when the search changes, never under the pointer while a box is being ticked.
    function filter() {
      const query = search.value.trim().toLowerCase();
      const chosen = selections.filter(s => s.read.checked);
      const others = selections.filter(s => !s.read.checked);
      let shown = 0;
      for (const s of selections) {
        s.row.hidden = !s.read.checked && query !== '' && !s.words.includes(query);
        if (!s.row.hidden) shown++;
      }
      list.replaceChildren(...chosen.map(s => s.row), ...others.map(s => s.row));
      noMatch.hidden = shown > 0 || query === '';
      counted();
    }
    search.addEventListener('input', filter);
    function recall() {
      const saved = remembered();
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.origin === 'string' && !origin.value) origin.value = saved.origin;
      if (validActor(saved.actor) && !actor.value) actor.value = saved.actor;
      if (typeof saved.port === 'string' && /^\d{1,5}$/.test(saved.port) && port.value === '0') port.value = saved.port;
      return saved;
    }
    function showConnection(saved) {
      let valid = false, site;
      try {
        site = new URL(origin.value.trim()); const listenPort = Number(port.value);
        valid = Boolean(saved && saved.origin === origin.value && saved.actor === actor.value && saved.port === port.value &&
          site.protocol === 'https:' && site.origin === origin.value && !site.username && !site.password && validActor(actor.value) &&
          /^\d+$/.test(port.value) && Number.isInteger(listenPort) && listenPort <= 65535 && (listenPort === 0 || listenPort >= 1024));
      } catch { /* Invalid or incomplete remembered values stay editable. */ }
      connection.hidden = !valid; connectionFields.hidden = valid;
      endpointHost.textContent = valid ? site.host : ''; endpointActor.textContent = valid ? actor.value : '';
      if (valid) say(endpointPort, port.value === '0' ? 'mobile.endpointPortAuto' : 'mobile.endpointPort', { port: port.value }); else quiet(endpointPort);
      endpoint.setAttribute('title', valid ? `${origin.value} · ${actor.value} · ${port.value}` : '');
    }
    function open() {
      revision++; opened = true; busy = false; prepare.disabled = false; clearLink();hideSharedError();renewalHint.hidden=true;status.className='';status.setAttribute('role','status');status.setAttribute('aria-live','polite'); selections = [];
      records.checked = false; search.value = ''; approval.open = advanced.open = false; showConnection(recall());
      choices.replaceChildren(node('legend', 'mobile.sessionsCompact'), search, count, list, noMatch);
      roomSelections = []; spaces.replaceChildren(node('legend', 'mobile.spaces'));
      for (const room of getRooms()) {
        if (!room?.id || room.archived) continue;
        const input = checkbox();
        spaces.append(checkRow(input, raw('span', room.name || room.id))); roomSelections.push({ id: room.id, input });
        input.addEventListener('change', configurationChanged);
      }
      for (const record of getSessions()) {
        if (record.archived || record.nativeContextPending || !record.nativeId) continue;
        const row = document.createElement('div'), actions = document.createElement('div');
        const read = checkbox(), send = checkbox(), answer = checkbox();
        const name = `${record.name || record.id} · ${record.id.slice(0, 6)}`;
        row.className = 'mobile-session'; actions.className = 'mobile-session-actions'; actions.hidden = true;
        actions.append(checkRow(send, node('span', 'mobile.allowSend')), checkRow(answer, node('span', 'mobile.allowAnswer')));
        const nameLabel = raw('span', name); nameLabel.setAttribute('title', name);
        row.append(checkRow(read, nameLabel), actions);
        // Unticking a session also clears its hidden send/answer choices, so no grant stays out of sight.
        read.addEventListener('change', () => {
          invalidatePairing();
          actions.hidden = !read.checked;
          if (!read.checked) send.checked = answer.checked = false;
          counted();
        });
        send.addEventListener('change', invalidatePairing); answer.addEventListener('change', invalidatePairing);
        selections.push({ id: record.id, nativeId: record.nativeId, read, send, answer, row, words: name.toLowerCase() });
      }
      filter();
      if (oneStep) { allSessions.checked = true; sharedHost.checked = false; showScope(); }
      say(status, oneStep ? 'mobile.autoReady' : 'mobile.idle');
      showApproval(null); approvalAction('mobileApprovalStatus');
    }
    async function pair(automatic=false) {
      automatic=automatic===true;
      if (!opened || busy || enrollment || renewable && !section.open) return;
      const previous=setupId;
      if(renewable && oneStep && allSessions.checked) {
        if(automatic && (!previous || now()>=renewUntil))return;
        if(!automatic)renewUntil=now()+600000;
        clearLink(false);hideSharedError();
      } else clearLink();
      if (oneStep && allSessions.checked) {
        const ticket = ++revision; busy = true; prepare.disabled = true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');renewalHint.hidden=true; say(status, 'mobile.preparing');
        try {
          const result = await api.mobileConnect({ sharedHostConfirmed: sharedHost.checked,...(approvalValue?.paired?{replace:true}:{}),...(renewable?{renew:true,...(previous?{refreshOf:previous}:{}),...(automatic?{automatic:true}:{})}:{}) });
          if (!opened || revision !== ticket) {cancelCode(result.setupId);return;}
          if (typeof result.qr !== 'string' || result.qr.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.qr) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) throw Error('unconfirmed');
          setupId=result.setupId || null;advanced.open=false;qr.src = result.qr; qr.hidden = false;qrTrust.hidden=false;
          if(renewable && setupId) {
            qrUntil=Math.min(result.expiresAt,now()+120000);nextCheck=now();renewedAt=automatic?now():0;
            say(prepare,'mobile.refreshQr');countdown();timer=setTimer(()=>renewalTick(ticket),Math.min(1000,qrUntil-now()));
          } else {say(status, 'mobile.qrReady');timer = setTimer(() => { if (revision === ticket) { clearLink(false); say(status, 'mobile.expired'); } }, Math.min(120000, result.expiresAt - now()));}
        } catch (error) {
          if(opened && revision===ticket && typeof api.mobileApprovalStatus==='function'){
            try{const current=await api.mobileApprovalStatus();if(opened && revision===ticket)showApproval(current);}catch{}
          }
          if (opened && revision === ticket) {
            if (['error.mobile.sharedHost','error.mobile.sharedHostPorts'].includes(error?.uiMessage?.key)) sharedHostError(error);
            else if (error?.uiMessage?.key === 'error.mobile.enrollmentActive' && renewable && previous) {
              enrollment = true;
              renewalState('mobile.enrollmentActive', 'mobile.enrollmentHint');
              await enrollmentTick(ticket, previous);
            }
            else renewalState(renewable?'mobile.renewUnconfirmed':'mobile.connectUnavailable');
          }
        } finally { if (opened && revision === ticket) { busy = false; prepare.disabled = enrollment; } }
        return;
      }
      const account = actor.value.trim();
      if (!validActor(account)) {
        actorInvalid = true; actor.setAttribute('aria-invalid', 'true'); actor.setAttribute('aria-describedby', status.id);
        connection.hidden = true; connectionFields.hidden = false;
        say(status, 'mobile.invalidActor'); actor.focus?.(); return;
      }
      clearActorError();
      const current = getSessions(), selected = selections.filter(s => s.read.checked);
      let site, listenPort;
      try {
        site = new URL(origin.value.trim()); listenPort = Number(port.value);
        if (site.protocol !== 'https:' || site.origin !== origin.value.trim() || site.username || site.password || !carrier.checked || !selected.length ||
            !/^\d+$/.test(port.value) || !Number.isInteger(listenPort) || listenPort > 65535 || listenPort !== 0 && listenPort < 1024 ||
            selected.some(s => !current.some(row => row.id === s.id && row.nativeId === s.nativeId && !row.archived && !row.nativeContextPending))) throw Error('invalid');
      } catch { say(status, 'mobile.invalid'); return; }
      try { remember({ origin: site.origin, actor: account, port: String(listenPort) }); } catch {}
      const ticket = ++revision; busy = true; prepare.disabled = true; say(status, 'mobile.preparing');
      try {
        const result = await api.mobilePairing({ actor: account, origin: site.origin, port: listenPort, carrierConfirmed: true, replace: replace.checked,
          ...(roomSelections.some(r => r.input.checked) || records.checked ? { workspace: { roomIds: roomSelections.filter(r => r.input.checked).map(r => r.id), records: records.checked } } : {}),
          selection: selected.map(s => ({ sessionId: s.id, actions: ['read', ...(s.send.checked ? ['send'] : []), ...(s.answer.checked ? ['answer'] : [])] })) });
        if (!opened || revision !== ticket) return;
        if (typeof result.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.secret) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) throw Error('unconfirmed');
        link.value = site.origin + '/mobile/#pair=' + result.secret; linkBox.hidden = false;
        if (result.localAddress) say(status, 'mobile.ready', { address: result.localAddress }); else say(status, 'mobile.readyUnconfirmed');
        timer = setTimer(() => { if (revision !== ticket) return; clearLink(); say(status, 'mobile.expired'); }, Math.min(120000, result.expiresAt - now()));
      } catch { if (opened && revision === ticket) say(status, 'mobile.unconfirmedAdvanced'); }
      finally { if (opened && revision === ticket) { busy = false; prepare.disabled = false; } }
    }
    async function stop() {
      if (!opened) return;
      const ticket = ++revision; clearLink(); busy = false; prepare.disabled = false;status.setAttribute('role','status');status.setAttribute('aria-live','polite'); say(status, 'mobile.revoking');
      try {
        const result = await api.mobileRevoke();
        if (opened && revision === ticket) say(status, result.authorizationRevoked ? 'mobile.revoked' : 'mobile.revokeUnconfirmed');
      } catch { if (opened && revision === ticket) say(status, 'mobile.revokeFailed'); }
    }
    function close() {
      revision++; opened = false; busy = false; clearLink();hideSharedError();quiet(renewalHint);renewalHint.hidden=true; origin.value = actor.value = search.value = ''; port.value = '0'; carrier.checked = replace.checked = false;
      clearActorError();
      selections = []; roomSelections = []; records.checked = false; spaces.replaceChildren(); choices.replaceChildren(); list.replaceChildren(); quiet(status); quiet(count); prepare.disabled = false; section.open = false; approval.open = advanced.open = false;
      connection.hidden = true; connectionFields.hidden = false; endpointHost.textContent = endpointActor.textContent = ''; quiet(endpointPort); endpoint.setAttribute('title', '');
      showApproval(null);
    }
    prepare.addEventListener('click', () => pair(false)); revoke.addEventListener('click', stop);
    return { open, close, dispose() { close(); section.remove(); } };
  }
  const value = { bind };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceMobileSetup = value;
})(globalThis);
