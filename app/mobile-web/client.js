/* Same-origin phone UI. No native/provider calls, polling or automatic resend. */
(function (global) {
  'use strict';
  const KEY = 'naw.mobile.v1', LIMIT = 512 * 1024;
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const text = value => typeof value === 'string' && value.length <= 16000 && value.isWellFormed();
  const terminal = status => ['submitted', 'reply-written', 'not-sent'].includes(status);
  const labels = {
    prepared: '请求已保留，尚未确认发送', 'awaiting-native': '等待原生接收确认', submitted: '已提交给原生会话',
    unconfirmed: '结果未确认，请查原回执，勿重复发送', 'not-sent': '未发送，草稿保留', 'reply-written': '回答已写入；原生处理仍待确认',
  };
  const failure = code => Object.assign(new Error(code), { code });
  // Same rule as the broker (mobile-broker.cjs): these prefixes have native terminal meaning, also after leading
  // invisible characters or in full-width form.
  const nativePrefix = value => /^[!#/]/.test(value.normalize('NFKC').replace(/^[\s\p{Cc}\p{Default_Ignorable_Code_Point}]+/u, ''));
  function createMobileClient({ request, storage, newId, onChange = () => {} }) {
    const state = { authorization: 0, session: null, selected: null, row: null, draft: '', revision: 0, busy: false, notice: '', storageError: false, drafts: [], pending: [] };
    let readEpoch = 0, startEpoch = 0, pairing = false, unreadableStorage = false;
    try {
      const raw = storage.getItem(KEY);
      if (raw) {
        if (new TextEncoder().encode(raw).length > LIMIT) throw Error('limit');
        const saved = JSON.parse(raw);
        if (saved.version !== 1 || !Array.isArray(saved.drafts) || saved.drafts.length > 8 || !Array.isArray(saved.pending) || saved.pending.length > 16 ||
            saved.drafts.some(d => !uuid(d.deviceId) || typeof d.sessionId !== 'string' || !text(d.text) || !Number.isSafeInteger(d.revision) || d.revision < 0) ||
            saved.pending.some(p => !uuid(p.deviceId) || typeof p.sessionId !== 'string' || !uuid(p.requestId) || !['send', 'answer'].includes(p.action) ||
              !Number.isSafeInteger(p.revision) || p.revision < 0 || !text(p.text) || typeof p.status !== 'string') ||
            new Set(saved.drafts.map(d => d.deviceId + '/' + d.sessionId)).size !== saved.drafts.length || new Set(saved.pending.map(p => p.requestId)).size !== saved.pending.length) throw Error('invalid');
        state.drafts = saved.drafts; state.pending = saved.pending;
      }
    } catch { unreadableStorage = true; state.storageError = true; state.notice = '此浏览器的草稿存储不可用。处理存储问题并重新加载后才能发送。'; }
    function changed() { onChange(state); }
    function persist() {
      try {
        if (unreadableStorage) throw Error('unreadable original pending state');
        const raw = JSON.stringify({ version: 1, drafts: state.drafts, pending: state.pending });
        if (state.drafts.length > 8 || state.pending.length > 16 || new TextEncoder().encode(raw).length > LIMIT) throw Error('limit');
        storage.setItem(KEY, raw); state.storageError = false; return true;
      } catch { state.storageError = true; state.notice = '草稿未能保存到此浏览器；发送已暂停，请保留输入内容。'; return false; }
    }
    const currentDraft = () => state.drafts.find(d => d.deviceId === state.session?.deviceId && d.sessionId === state.selected);
    const unresolved = () => state.pending.some(p => p.deviceId === state.session?.deviceId && p.sessionId === state.selected && !terminal(p.status));
    async function call(route, value) { return request(route, value, state.session?.csrf); }
    function explain(error) {
      const messages = { MOBILE_PAIR_LIMIT: '本次配对的请求记录已满，请先核对全部未确认回执，再回 Mac 撤销并重新配对。',
        MOBILE_RECEIPT_UNKNOWN: '原回执不可用，结果仍未知。不会自动重发；请回 Mac 核对。',
        MOBILE_CONTEXT_UNAVAILABLE: '原阅读上下文已失效，请刷新原文后再操作。',
        MOBILE_REQUEST_CONFLICT: '请求记录冲突，未替换或重发原请求。' };
      return messages[error?.code] || '访问或结果未确认。请保留草稿，刷新配对状态或回 Mac 核对。';
    }
    const grantKey = session => JSON.stringify([session.deviceId, session.csrf, session.workspace, session.candidate,
      [session.consent?.registered, session.consent?.enabled, session.consent?.verified],
      session.sessions.map(s => [s.id, s.nativeId, s.available, [...(s.actions || [])].sort()]).sort((a, b) => a[0].localeCompare(b[0]))]);
    function clearAuthorization() {
      ++readEpoch; ++state.authorization;
      state.session = null; state.selected = null; state.row = null; state.draft = ''; state.revision = 0; state.busy = false;
    }
    async function start(pairSecret) {
      if (pairSecret === undefined && pairing) return state;
      if (pairSecret !== undefined) { pairing = true; clearAuthorization(); changed(); }
      const epoch = ++startEpoch, authorization = state.authorization;
      try {
        if (pairSecret !== undefined) { if (!token(pairSecret)) throw failure('MOBILE_BAD_PAIR'); await call('/mobile/pair', { secret: pairSecret }); }
        if (epoch !== startEpoch || authorization !== state.authorization) { if (epoch === startEpoch) pairing = false; return state; }
        const session = await call('/mobile/session');
        if (epoch !== startEpoch || authorization !== state.authorization) { if (epoch === startEpoch) pairing = false; return state; }
        if (!uuid(session.deviceId) || !token(session.csrf) || !Array.isArray(session.sessions)) throw failure('MOBILE_BAD_SESSION');
        if (state.session && grantKey(state.session) !== grantKey(session)) clearAuthorization();
        state.session = session;
        if (!state.storageError) state.notice = state.pending.some(p => p.deviceId !== session.deviceId && !terminal(p.status)) ? '旧配对仍有未确认记录；不会在新配对中重发，请回 Mac 核对。' : '已配对。请选择会话查看原文。';
      } catch (error) { if (epoch === startEpoch && authorization === state.authorization) state.notice = explain(error); }
      if (epoch === startEpoch) pairing = false;
      changed(); return state;
    }
    async function select(id) {
      if (!state.session?.sessions.some(s => s.id === id && s.available !== false)) throw failure('MOBILE_SESSION_UNAVAILABLE');
      state.selected = id; state.row = null; const draft = currentDraft(); state.draft = draft?.text || ''; state.revision = draft?.revision || 0; changed();
      return refresh(false);
    }
    async function refresh(receipts = true) {
      if (!state.session || !state.selected) return;
      const epoch = ++readEpoch, id = state.selected, deviceId = state.session.deviceId, authorization = state.authorization;
      try {
        const row = await call('/mobile/read/' + encodeURIComponent(id));
        if (authorization === state.authorization && epoch === readEpoch && id === state.selected && deviceId === state.session?.deviceId) {
          if (row.id !== id || !token(row.contextId)) throw failure('MOBILE_BAD_CONTEXT');
          state.row = row;
        }
      } catch (error) { if (epoch === readEpoch) state.notice = explain(error); }
      // A queued send hears back early; the person's refresh also asks once for this session's open receipts
      // (read-only, the same route as the receipt button: no polling, no resend). Opening a session alone does not.
      for (const p of receipts ? state.pending.filter(p => p.action === 'send' && p.deviceId === deviceId && p.sessionId === id && !terminal(p.status)) : []) {
        if (epoch !== readEpoch || state.busy) break;
        try { recordResult(p, await call('/mobile/receipt', { requestId: p.requestId })); } catch { /* The row keeps its status; its receipt button stays. */ }
      }
      changed();
    }
    function setDraft(value) {
      if (!state.session || !state.selected || !text(value)) throw failure('MOBILE_DRAFT_INVALID');
      state.draft = value; state.revision++;
      let draft = currentDraft();
      if (!draft) { draft = { deviceId: state.session.deviceId, sessionId: state.selected, text: '', revision: 0 }; state.drafts.push(draft); }
      draft.text = value; draft.revision = state.revision; const saved = persist(); changed(); return saved;
    }
    function recordResult(pending, result, authorization) {
      if (result.requestId !== pending.requestId || result.sessionId !== pending.sessionId || result.action !== pending.action || !Object.hasOwn(labels, result.status)) throw failure('MOBILE_RECEIPT_UNKNOWN');
      pending.status = result.status;
      // A late ACK cannot clear edits or a draft in a different reading view.
      if (authorization === state.authorization && pending.action === 'send' && result.status === 'submitted' && state.session?.deviceId === pending.deviceId && state.selected === pending.sessionId &&
          state.draft === pending.text && state.revision === pending.revision) {
        const draft = currentDraft();
        if (draft && draft.text === pending.text && draft.revision === pending.revision) { state.draft = ''; state.revision++; draft.text = ''; draft.revision = state.revision; }
      }
      if (persist() && authorization === state.authorization) state.notice = labels[result.status] + (result.storageWarning ? '；回执保存未确认，请回 Mac 核对。' : '');
    }
    async function submit(action, answers) {
      if (state.busy || state.storageError || !state.session?.sessions.some(s => s.id === state.selected && s.available !== false) || !state.row || state.row.id !== state.selected || unresolved() ||
          action === 'send' && (!state.row.canSend || !state.draft.trim()) || action === 'answer' && !state.row.question) throw failure('MOBILE_INPUT_UNAVAILABLE');
      if (action === 'send' && nativePrefix(state.draft)) {
        state.notice = '手机端不发送以 !、# 或 / 开头的文字：在原生终端里它们会被当成命令、记忆或斜杠命令。草稿已保留，请改写开头或回 Mac 输入。'; changed(); return;
      }
      const requestId = newId(); if (!uuid(requestId)) throw failure('MOBILE_BAD_REQUEST_ID');
      const contextId = state.row.contextId, deviceId = state.session.deviceId, csrf = state.session.csrf, authorization = state.authorization;
      const pending = { deviceId, sessionId: state.selected, requestId, action, text: action === 'send' ? state.draft : '', revision: state.revision, status: 'unconfirmed' };
      const value = { contextId, requestId, ...(action === 'send' ? { text: state.draft } : { answers }) };
      state.pending.push(pending);
      if (!persist()) { state.pending.pop(); changed(); throw failure('MOBILE_DRAFT_UNSAVED'); }
      state.busy = true; changed();
      try { recordResult(pending, await request('/mobile/' + action, value, csrf), authorization); }
      catch (error) { if (authorization === state.authorization) state.notice = explain(error); }
      finally { if (authorization === state.authorization) state.busy = false; changed(); }
    }
    async function receipt(requestId) {
      const pending = state.pending.find(p => p.requestId === requestId);
      if (!pending || pending.deviceId !== state.session?.deviceId || state.busy) throw failure('MOBILE_RECEIPT_UNAVAILABLE');
      const authorization = state.authorization;
      state.busy = true; changed();
      try { recordResult(pending, await call('/mobile/receipt', { requestId }), authorization); }
      catch (error) { if (authorization === state.authorization) state.notice = explain(error); }
      finally { if (authorization === state.authorization) state.busy = false; changed(); }
    }
    function forget(requestId) {
      const pending = state.pending.find(p => p.requestId === requestId);
      if (!pending || !terminal(pending.status)) throw failure('MOBILE_PENDING_UNCONFIRMED');
      state.pending = state.pending.filter(p => p !== pending); persist(); changed();
    }
    async function logout() {
      if (!state.session || state.busy) return;
      const authorization = state.authorization;
      state.busy = true; changed();
      try {
        const result = await call('/mobile/logout', {});
        if (authorization !== state.authorization) return;
        state.notice = result.authorizationRevoked ? '此手机访问已撤销；已经写入的原生工作可能继续。' : '撤销未获确认，请在 Mac 核对；已经写入的原生工作可能继续。';
      } catch { if (authorization === state.authorization) state.notice = '撤销未获确认，请在 Mac 核对。'; }
      finally { if (authorization === state.authorization) { clearAuthorization(); changed(); } }
    }
    return { state, start, select, refresh, invalidate: () => { clearAuthorization(); changed(); }, setDraft, send: () => submit('send'), answer: answers => submit('answer', answers), receipt, forget, logout, labels };
  }
  function mount(document, location, history, storage, fetch, crypto) {
    // Consume a pairing fragment before any fetch, renderer callback or storage.
    const fragment = location.hash; if (fragment) history.replaceState(null, '', location.pathname);
    const pairSecret = fragment ? fragment.startsWith('#pair=') ? fragment.slice(6) : '' : undefined;
    const el = id => document.getElementById(id), node = (tag, value, className) => { const n = document.createElement(tag); if (value !== undefined) n.textContent = value; if (className) n.className = className; return n; };
    let sessionKey = '', row = null, receiptKey = '';
    const run = action => Promise.resolve().then(action).catch(() => { el('notice').textContent = '操作未执行，请保留草稿并核对当前会话。'; });
    const api = async (route, value, csrf) => {
      const response = await fetch(route, { method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-NAW-Mobile': '1', ...(value === undefined ? {} : { 'Content-Type': 'application/json', ...(csrf ? { 'X-NAW-CSRF': csrf } : {}) }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      const result = await response.json(); if (!response.ok) throw failure(result.error || 'MOBILE_DENIED'); return result;
    };
    const client = createMobileClient({ request: api, storage, newId: () => crypto.randomUUID(), onChange: render });
    function render(state) {
      el('notice').textContent = state.notice; el('draft').disabled = !state.session || !state.selected;
      if (el('draft').value !== state.draft) el('draft').value = state.draft;
      el('draft-status').textContent = state.storageError ? '此浏览器未保存草稿，发送已暂停。请保留输入。' : '草稿只保存在此浏览器，不同步 Mac 的草稿。';
      el('send').disabled = state.busy || state.storageError || !state.row?.canSend || !state.draft.trim() || state.pending.some(p => p.deviceId === state.session?.deviceId && p.sessionId === state.selected && !terminal(p.status));
      el('refresh').disabled = !state.session || !state.selected; el('logout').disabled = !state.session || state.busy;
      const nextSessionKey = JSON.stringify([state.session?.deviceId, state.session?.sessions, state.selected]);
      if (nextSessionKey !== sessionKey) {
        sessionKey = nextSessionKey; el('sessions').replaceChildren();
        for (const s of state.session?.sessions || []) {
          const b = node('button', `${s.name || s.id} · ${s.state || '状态未知'}`); b.type = 'button'; b.setAttribute('aria-current', String(s.id === state.selected));
          b.addEventListener('click', () => run(() => client.select(s.id))); el('sessions').append(b);
        }
      }
      if (state.row !== row) {
        row = state.row; el('messages').replaceChildren(); el('questions').replaceChildren();
        el('member-title').textContent = row ? row.name || row.id : '请选择会话'; el('member-state').textContent = row ? `读取时状态：${row.state || '状态未知'} · ${row.canSend ? '可发送' : '当前只读或不可发送'}` : '';
        el('omissions').textContent = row ? `较早消息未显示：${row.earlierMessagesOmitted || 0}。${row.questionOmitted ? '当前问题不能在手机处理，请回 Mac。' : ''}` : '';
        for (const message of row?.messages || []) {
          const article = node('article', undefined, 'message'); article.append(node('p', `${message.kind || ''} · ${message.status || '状态未知'}`, 'meta'), node('div', message.text, 'original'));
          if (message.textOmitted || message.unsupportedAttachments) article.append(node('p', '部分原文或附件未显示，请回 Mac 查看。', 'meta')); el('messages').append(article);
        }
        if (row?.question) {
          const form = node('form'), fields = [];
          for (const q of row.question.questions) {
            const fieldset = node('fieldset'); fieldset.append(node('legend', q.question)); const inputs = [];
            for (const option of q.options) {
              const label = node('label'), input = node('input'); input.type = q.multiSelect ? 'checkbox' : 'radio'; input.name = 'q' + fields.length; input.value = option.label;
              label.append(input, node('span', option.label + (option.description ? ' · ' + option.description : ''))); fieldset.append(label); inputs.push(input);
            }
            let other;
            if (q.isOther) { const label = node('label', '其他回答'); other = node('input'); other.type = 'text'; other.maxLength = 16000; label.append(other); fieldset.append(label); }
            fields.push({ key: q.id ?? q.question, inputs, other }); form.append(fieldset);
          }
          const b = node('button', '提交所选回答'); b.type = 'submit'; form.append(b);
          form.addEventListener('submit', event => { event.preventDefault(); run(() => client.answer(Object.fromEntries(fields.map(f => [f.key, [...f.inputs.filter(i => i.checked).map(i => i.value), ...(f.other?.value.trim() ? [f.other.value] : [])]])))); });
          el('questions').append(form);
        }
      }
      for (const b of el('questions').querySelectorAll('button')) b.disabled = state.busy || state.storageError || state.pending.some(p => p.deviceId === state.session?.deviceId && p.sessionId === state.selected && !terminal(p.status));
      const nextReceiptKey = JSON.stringify([state.session?.deviceId, state.pending, state.busy]);
      if (nextReceiptKey !== receiptKey) {
        receiptKey = nextReceiptKey; el('receipts').replaceChildren();
        for (const p of state.pending) {
          const item = node('div', undefined, 'receipt'); item.append(node('p', `${p.sessionId} · ${labels[p.status] || labels.unconfirmed}`));
          if (p.deviceId !== state.session?.deviceId) item.append(node('p', '属于旧配对，请回 Mac 核对。不会自动重发。'));
          else { const b = node('button', '查询原回执'); b.type = 'button'; b.disabled = state.busy; b.addEventListener('click', () => run(() => client.receipt(p.requestId))); item.append(b); }
          if (terminal(p.status)) { const b = node('button', '移除已确认记录'); b.type = 'button'; b.disabled = state.busy; b.addEventListener('click', () => run(() => client.forget(p.requestId))); item.append(b); }
          el('receipts').append(item);
        }
      }
    }
    el('draft').addEventListener('input', () => { try { client.setDraft(el('draft').value); } catch { el('notice').textContent = '输入未保存，请检查会话或文字长度。'; } });
    el('compose').addEventListener('submit', event => { event.preventDefault(); run(() => client.send()); });
    el('refresh').addEventListener('click', () => run(() => client.refresh())); el('logout').addEventListener('click', () => run(() => client.logout()));
    render(client.state); client.ready = client.start(pairSecret); return client;
  }
  const exported = { createMobileClient, mount, KEY };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else { global.NAWMobile = exported; if (!global.document.documentElement.hasAttribute('data-workspace-ui')) mount(global.document, global.location, global.history,
    { getItem: key => global.localStorage.getItem(key), setItem: (key, value) => global.localStorage.setItem(key, value) }, global.fetch.bind(global), global.crypto); }
})(globalThis);
