/* No permission prompt, service worker or push subscription until a person clicks. */
(function (global) {
  'use strict';
  function create({ request, session }) {
    const state = { enabled: false, state: 'off', lastSubmittedAt: null, busy: false };
    let workerPolicy;
    const supported = () => Boolean(global.isSecureContext && global.navigator?.serviceWorker && global.PushManager && global.Notification);
    function capture() { const s = session(); return s && { deviceId: s.deviceId, csrf: s.csrf }; }
    const same = original => original && session()?.deviceId === original.deviceId && session()?.csrf === original.csrf;
    async function read() {
      const original = capture(), result = await request('/mobile/push');
      if (!same(original)) throw Error('unconfirmed');
      Object.assign(state, result); return state;
    }
    async function localSubscription() {
      const registration = await global.navigator?.serviceWorker?.getRegistration('/mobile/');
      return registration?.pushManager.getSubscription();
    }
    async function enable() {
      if (!supported() || state.busy) return;
      const original = capture(); if (!original) return;
      const csrf = original.csrf, current = () => same(original);
      state.busy = true;
      // Must run in the click handler, before any await (including an API read).
      try {
        const permission = global.Notification.requestPermission();
        if (await permission !== 'granted') { state.state = 'denied'; return; }
        if (!current()) throw Error('unconfirmed');
        const info = await request('/mobile/push');
        if (!current()) throw Error('unconfirmed');
        if (typeof info.publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(info.publicKey)) throw Error('unconfirmed');
        let scriptURL = '/mobile/sw.js';
        if (global.trustedTypes) {
          const policy = workerPolicy ||= global.trustedTypes.createPolicy('naw-mobile-worker', {
            createScriptURL: value => { if (value !== '/mobile/sw.js') throw Error('Invalid worker'); return value; },
          });
          scriptURL = policy.createScriptURL('/mobile/sw.js');
        }
        const registration = await global.navigator.serviceWorker.register(scriptURL, { scope: '/mobile/' });
        await global.navigator.serviceWorker.ready;
        if (!current()) throw Error('unconfirmed');
        const previous = await registration.pushManager.getSubscription();
        if (!current()) throw Error('unconfirmed');
        if (previous && !await previous.unsubscribe()) throw Error('unconfirmed');
        if (!current()) throw Error('unconfirmed');
        const publicKey = Uint8Array.from(global.atob(info.publicKey.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
        const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
        try {
          if (!current()) throw Error('unconfirmed');
          const result = await request('/mobile/push', { action: 'subscribe', subscription: sub.toJSON() }, csrf);
          if (!current()) throw Error('unconfirmed');
          Object.assign(state, result);
        }
        catch (error) { try { await sub.unsubscribe(); } catch { /* Unknown is shown, never claimed off. */ } throw error; }
      } catch { state.state = 'unconfirmed'; }
      finally { state.busy = false; }
    }
    async function disable() {
      if (state.busy) return;
      const original = capture(); if (!original) return;
      state.busy = true;
      try {
        const result = await request('/mobile/push', { action: 'unsubscribe' }, original.csrf);
        if (!same(original)) throw Error('unconfirmed');
        Object.assign(state, result);
        const sub = await localSubscription();
        if (!same(original)) throw Error('unconfirmed');
        await sub?.unsubscribe();
        if (!same(original)) throw Error('unconfirmed');
      } catch { state.state = 'unconfirmed'; }
      finally { state.busy = false; }
    }
    return { state, supported, read, enable, disable };
  }
  global.NAWMobilePush = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(typeof window !== 'undefined' ? window : globalThis);
