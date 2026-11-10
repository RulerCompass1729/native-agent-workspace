/* Explicit local setup, inside the existing setup dialog. Opening is read-only. */
(function (global) {
  'use strict';
  // Text comes from the catalog (mobile.*). The renderer passes its interface-language text and display bindings, so a
  // language switch repaints the panel in place; without them (unit tests) the Chinese catalog text is used.
  function bind({ container, document, api, getSessions, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, text, display }) {
    const locale = global.nativeWorkspaceLocale || (typeof require === 'function' ? require('../ui-locale.js') : null);
    const format = text || ((key, params) => locale.format('zh', key, params));
    const say = (el, key, params) => { if (display) display.text(el, key, params); else el.textContent = format(key, params); return el; };
    const quiet = el => { if (display) display.unbind(el); el.textContent = ''; };
    const node = (tag, key) => { const el = document.createElement(tag); if (key !== undefined) say(el, key); return el; };
    const raw = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
    // A label holding an input keeps its text in its own leaf, which the display bindings can repaint.
    const labelled = (key, input) => { const box = document.createElement('label'); box.append(node('span', key), input); return box; };
    const section = node('details'), summary = node('summary', 'mobile.title'); section.append(summary);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    section.append(node('p', 'mobile.intro'));
    const field = (key, id, type = 'text') => { const input = document.createElement('input'); input.id = id; input.type = type; section.append(labelled(key, input)); return input; };
    const origin = field('mobile.origin', 'mobile-origin', 'url'); origin.placeholder = 'https://device.example.ts.net'; origin.autocomplete = 'off'; origin.maxLength = 2048;
    const actor = field('mobile.actor', 'mobile-actor'); actor.autocomplete = 'off'; actor.maxLength = 320;
    const port = field('mobile.port', 'mobile-port', 'number'); port.min = '0'; port.max = '65535'; port.value = '0';
    const carrier = field('mobile.carrier', 'mobile-carrier', 'checkbox');
    const choices = document.createElement('fieldset'); choices.append(node('legend', 'mobile.sessions')); section.append(choices);
    const replace = field('mobile.replace', 'mobile-replace', 'checkbox');
    section.append(node('p', 'mobile.note'));
    const prepare = node('button', 'mobile.prepare'), revoke = node('button', 'mobile.revoke'); prepare.type = revoke.type = 'button'; prepare.id = 'mobile-prepare'; revoke.id = 'mobile-revoke';
    const link = document.createElement('input'); link.id = 'mobile-pair-link'; link.readOnly = true; link.autocomplete = 'off';
    const linkBox = labelled('mobile.link', link); linkBox.hidden = true;
    section.append(prepare, revoke, linkBox, status); container.append(section);
    let revision = 0, timer, opened = false, busy = false, selections = [];
    const clearLink = () => { clearTimer(timer); timer = undefined; link.value = ''; linkBox.hidden = true; };
    function open() {
      revision++; opened = true; busy = false; prepare.disabled = false; clearLink(); selections = [];
      choices.replaceChildren(node('legend', 'mobile.sessions'));
      for (const record of getSessions()) {
        if (record.archived || record.nativeContextPending || !record.nativeId) continue;
        const box = document.createElement('div'), label = document.createElement('label'), read = document.createElement('input'); read.type = 'checkbox';
        label.append(read, raw('span', `${record.name || record.id} · ${record.id.slice(0, 6)}`));
        const send = document.createElement('input'); send.type = 'checkbox';
        const answer = document.createElement('input'); answer.type = 'checkbox';
        box.append(label, labelled('mobile.allowSend', send), labelled('mobile.allowAnswer', answer)); choices.append(box); selections.push({ id: record.id, nativeId: record.nativeId, read, send, answer });
      }
      say(status, 'mobile.idle');
    }
    async function pair() {
      if (!opened || busy) return;
      clearLink();
      const current = getSessions(), selected = selections.filter(s => s.read.checked);
      let site, listenPort;
      try {
        site = new URL(origin.value.trim()); listenPort = Number(port.value);
        if (site.protocol !== 'https:' || site.origin !== origin.value.trim() || site.username || site.password || !actor.value.trim() || !carrier.checked || !selected.length ||
            !/^\d+$/.test(port.value) || !Number.isInteger(listenPort) || listenPort > 65535 || listenPort !== 0 && listenPort < 1024 ||
            selected.some(s => !current.some(row => row.id === s.id && row.nativeId === s.nativeId && !row.archived && !row.nativeContextPending))) throw Error('invalid');
      } catch { say(status, 'mobile.invalid'); return; }
      const ticket = ++revision; busy = true; prepare.disabled = true; say(status, 'mobile.preparing');
      try {
        const result = await api.mobilePairing({ actor: actor.value.trim(), origin: site.origin, port: listenPort, carrierConfirmed: true, replace: replace.checked,
          selection: selected.map(s => ({ sessionId: s.id, actions: ['read', ...(s.send.checked ? ['send'] : []), ...(s.answer.checked ? ['answer'] : [])] })) });
        if (!opened || revision !== ticket) return;
        if (typeof result.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.secret) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) throw Error('unconfirmed');
        link.value = site.origin + '/mobile/#pair=' + result.secret; linkBox.hidden = false;
        if (result.localAddress) say(status, 'mobile.ready', { address: result.localAddress }); else say(status, 'mobile.readyUnconfirmed');
        timer = setTimer(() => { if (revision !== ticket) return; clearLink(); say(status, 'mobile.expired'); }, Math.min(120000, result.expiresAt - now()));
      } catch { if (opened && revision === ticket) say(status, 'mobile.unconfirmed'); }
      finally { if (opened && revision === ticket) { busy = false; prepare.disabled = false; } }
    }
    async function stop() {
      if (!opened) return;
      const ticket = ++revision; clearLink(); busy = false; prepare.disabled = false; say(status, 'mobile.revoking');
      try {
        const result = await api.mobileRevoke();
        if (opened && revision === ticket) say(status, result.authorizationRevoked ? 'mobile.revoked' : 'mobile.revokeUnconfirmed');
      } catch { if (opened && revision === ticket) say(status, 'mobile.revokeFailed'); }
    }
    function close() {
      revision++; opened = false; busy = false; clearLink(); origin.value = actor.value = ''; port.value = '0'; carrier.checked = replace.checked = false;
      selections = []; choices.replaceChildren(); quiet(status); prepare.disabled = false; section.open = false;
    }
    prepare.addEventListener('click', pair); revoke.addEventListener('click', stop);
    return { open, close, dispose() { close(); section.remove(); } };
  }
  const value = { bind };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceMobileSetup = value;
})(globalThis);
