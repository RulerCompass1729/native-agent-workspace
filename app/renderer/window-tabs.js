// The tab strip for local pages declared with "tab": true. The page itself is a native view that the main process
// lays below the strip; this file only draws the tabs and asks main to switch. With no tab page there is no strip.
(function (global) {
  function mount({ api, text, onLanguage, onError, documentRef = document, windowRef = window }) {
    if (!api?.localPageTabs || !api.onLocalPageTabs) return { dispose() {} };
    const body = documentRef.body;
    let state = { tabs: [], active: null }, strip = null, reported = null;
    const call = (...args) => api.localPageTabs(...args).catch(onError);

    function report() {
      if (!strip) return;
      const top = strip.getBoundingClientRect().bottom, key = `${top}:${windowRef.devicePixelRatio}`;
      if (key === reported) return;
      reported = key;
      call('layout', top);
    }
    function tab(id, label, selected) {
      const item = documentRef.createElement('button');
      item.type = 'button'; item.className = 'window-tab'; item.setAttribute('role', 'tab');
      item.dataset.tab = id ?? '';
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      item.textContent = label;
      item.onclick = () => { if (!selected) call('show', id); };
      return item;
    }
    function render() {
      if (!state.tabs.length) {
        strip?.remove(); strip = null; reported = null;
        body.classList.remove('has-window-tabs');
        return;
      }
      if (!strip) {
        strip = documentRef.createElement('div'); strip.id = 'window-tabs';
        const list = documentRef.createElement('div'); list.className = 'window-tab-list'; list.setAttribute('role', 'tablist');
        list.onkeydown = event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          const items = [...list.children], at = items.indexOf(documentRef.activeElement);
          if (at < 0) return;
          event.preventDefault();
          items[(at + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
        };
        const reload = documentRef.createElement('button');
        reload.type = 'button'; reload.className = 'window-tab-reload'; reload.textContent = '↻';
        reload.onclick = () => { if (state.active) call('reload', state.active); };
        strip.append(list, reload);
        body.prepend(strip);
        body.classList.add('has-window-tabs');
      }
      const [list, reload] = strip.children;
      list.setAttribute('aria-label', text('localPage.tabs'));
      list.replaceChildren(tab(null, text('localPage.workspaceTab'), !state.active), ...state.tabs.map(page => tab(page.id, page.title, page.id === state.active)));
      const shown = state.tabs.find(page => page.id === state.active);
      reload.hidden = !shown;
      if (shown) { const name = text('localPage.reloadTab', { title: shown.title }); reload.setAttribute('aria-label', name); reload.title = name; }
      report();
    }
    function accept(value) {
      if (!value || !Array.isArray(value.tabs)) return;
      state = { tabs: value.tabs.filter(page => page && typeof page.id === 'string' && typeof page.title === 'string'), active: typeof value.active === 'string' ? value.active : null };
      render();
    }
    const refresh = () => api.localPageTabs('list').then(accept, () => {});
    const stop = [api.onLocalPageTabs(accept), onLanguage?.(render)];
    // Picks up edits to local-pages.json when the person comes back to the window.
    windowRef.addEventListener('focus', refresh);
    windowRef.addEventListener('resize', report);
    refresh();
    return {
      dispose() {
        for (const fn of stop) if (typeof fn === 'function') fn();
        windowRef.removeEventListener('focus', refresh); windowRef.removeEventListener('resize', report);
        strip?.remove(); body.classList.remove('has-window-tabs');
      },
    };
  }
  const api = { mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.nativeWorkspaceWindowTabs = api;
})(typeof window === 'undefined' ? globalThis : window);
