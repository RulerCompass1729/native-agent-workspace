// Sidebar geometry is display metadata. It never selects or controls an agent.
(function (global) {
  const defaults = [5000, 3000, 2000], sashSize = 8, minimumBody = 32;
  const same = (a, b) => a.every((n, i) => n === b[i]);
  function weights(value) {
    return Array.isArray(value) && value.length === 3 && Array.from(value).every(n => Number.isInteger(n) && n > 0 && n < 9999) && value.reduce((a, b) => a + b, 0) === 10000 ? [...value] : [...defaults];
  }
  function geometry(height, headers, collapsed, preference) {
    preference = weights(preference);
    const open = [0, 1, 2].filter(i => !collapsed[i]);
    const available = Math.max(0, (Number.isFinite(height) ? height : 0) - headers.reduce((a, b) => a + b, 0) - 2 * sashSize);
    const minimum = open.length ? Math.min(minimumBody, available / open.length) : 0;
    const flexible = Math.max(0, available - minimum * open.length), total = open.reduce((sum, i) => sum + preference[i], 0);
    const bodies = headers.map((_, i) => collapsed[i] ? 0 : minimum + flexible * preference[i] / total);
    const pairs = [0, 1].map(i => collapsed[i] ? null : (() => { const next = open.find(n => n > i); return next === undefined ? null : [i, next]; })());
    return { sizes: bodies.map((body, i) => body + headers[i]), bodies, pairs, minimum, flexible };
  }
  function resize(preference, layout, index, delta) {
    const next = weights(preference), pair = layout.pairs[index];
    if (!pair || layout.flexible < 0.01 || typeof delta !== 'number' || Number.isNaN(delta)) return next;
    const [left, right] = pair, sum = next[left] + next[right];
    const space = layout.bodies[left] + layout.bodies[right] - 2 * layout.minimum;
    const first = Math.max(0, Math.min(space, layout.bodies[left] - layout.minimum + delta));
    next[left] = Math.max(1, Math.min(sum - 1, Math.round(sum * first / space)));
    next[right] = sum - next[left];
    return next;
  }
  function separatorValues(layout, index) {
    const pair = layout.pairs[index];
    if (!pair || layout.flexible < 0.01) return null;
    const [left, right] = pair, total = layout.bodies[left] + layout.bodies[right];
    return { now: Math.round(layout.bodies[left] / total * 100), min: Math.round(layout.minimum / total * 100), max: Math.round((total - layout.minimum) / total * 100) };
  }
  function bind({ navigation, groups, sashes, onCommit, onError }) {
    let preference = [...defaults], external = [...defaults], collapsed = [false, false, true], layout;
    let gesture, keyboard, pending, sequence = 0, disposed = false;
    const removers = [];
    const listen = (el, name, fn) => { el.addEventListener(name, fn); removers.push(() => el.removeEventListener(name, fn)); };
    const headers = () => groups.map(group => group.querySelector('.nav-label').getBoundingClientRect().height);
    const rail = () => navigation.closest('.naw')?.dataset.collapsed === 'true';
    const height = () => { const css = getComputedStyle(navigation); return Math.max(0, navigation.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)); };
    function apply() {
      if (disposed) return;
      if (rail()) { for (const group of groups) group.style.height = ''; return; }
      layout = geometry(height(), headers(), collapsed, preference);
      groups.forEach((group, i) => { group.style.height = `${layout.sizes[i]}px`; });
      sashes.forEach((sash, i) => {
        const candidate = layout.pairs[i], pair = candidate && layout.flexible >= 0.01 ? candidate : null; sash.tabIndex = pair ? 0 : -1; sash.setAttribute('aria-disabled', String(!pair));
        if (!pair) return;
        const [left, right] = pair, values = separatorValues(layout, i);
        const label = groups[left].querySelector('.nav-label span[id]'), other = groups[right].querySelector('.nav-label span[id]');
        sash.setAttribute('aria-labelledby', label.id); sash.setAttribute('aria-controls', groups[left].querySelector('.sidebar-group-body').id);
        sash.setAttribute('aria-valuenow', String(values.now));
        sash.setAttribute('aria-valuemin', String(values.min));
        sash.setAttribute('aria-valuemax', String(values.max));
        sash.title = `拖动调整${label.textContent}与${other.textContent}的高度；上下键调整，Home/End 到边界，双击均分`;
      });
    }
    function revealEditor() {
      const active = document.activeElement;
      if (navigation.contains(active) && active.matches('input,textarea')) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function commit() {
      const id = ++sequence, attempted = [...preference], before = [...external]; pending = id;
      Promise.resolve().then(() => onCommit(attempted)).then(() => {
        if (disposed || pending !== id) return;
        pending = null;
        if (!gesture && !keyboard) { preference = same(external, before) ? attempted : [...external]; apply(); }
      }, error => {
        if (!disposed && pending === id) { pending = null; if (!gesture && !keyboard) { preference = [...external]; apply(); } }
        if (!disposed) onError(error);
      });
    }
    function cancel() { keyboard = null; preference = [...external]; apply(); }
    sashes.forEach((sash, index) => {
      listen(sash, 'pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || gesture || !layout?.pairs[index] || rail()) return;
        event.preventDefault(); keyboard = null;
        const start = event.clientY, original = [...preference], initial = layout, shape = [height(), ...collapsed];
        gesture = { index, id: event.pointerId, shape, width: navigation.clientWidth }; sash.setPointerCapture(event.pointerId);
        const move = e => { if (gesture?.id !== e.pointerId) return; preference = resize(original, initial, index, e.clientY - start); apply(); revealEditor(); };
        const finish = save => {
          if (!gesture || gesture.id !== event.pointerId) return;
          gesture = null; sash.removeEventListener('pointermove', move); sash.removeEventListener('pointerup', up); sash.removeEventListener('pointercancel', stop); sash.removeEventListener('lostpointercapture', stop);
          if (sash.hasPointerCapture(event.pointerId)) sash.releasePointerCapture(event.pointerId);
          if (save && !same(preference, original)) commit(); else { preference = save ? original : [...external]; apply(); }
        };
        const up = e => { if (e.pointerId === event.pointerId) finish(true); }, stop = e => { if (!e || e.pointerId === event.pointerId) finish(false); };
        gesture.cancel = stop;
        sash.addEventListener('pointermove', move); sash.addEventListener('pointerup', up); sash.addEventListener('pointercancel', stop); sash.addEventListener('lostpointercapture', stop);
      });
      listen(sash, 'keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || rail()) return;
        if (event.key === 'Escape' && (gesture || keyboard)) { event.preventDefault(); if (gesture) gesture.cancel(); else cancel(); return; }
        if (!layout?.pairs[index] || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); keyboard ||= [...preference];
        preference = resize(preference, layout, index, event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : (event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 32 : 8));
        apply(); revealEditor();
      });
      const finishKey = () => { if (!keyboard) return; const original = keyboard; keyboard = null; if (!same(preference, original)) commit(); };
      listen(sash, 'keyup', finishKey); listen(sash, 'blur', finishKey);
      listen(sash, 'dblclick', event => {
        if (event.button !== 0 || !layout?.pairs[index] || rail()) return;
        const [left, right] = layout.pairs[index]; preference = resize(preference, layout, index, (layout.bodies[right] - layout.bodies[left]) / 2); apply(); commit();
      });
    });
    const observer = new ResizeObserver(() => { if (gesture && (height() !== gesture.shape[0] || navigation.clientWidth !== gesture.width || rail())) gesture.cancel(); if (keyboard) cancel(); apply(); }); observer.observe(navigation);
    const update = value => {
      const next = weights(value?.weights), folded = [Boolean(value?.sessionsCollapsed), Boolean(value?.workspaceCollapsed), value?.archiveCollapsed !== false];
      if (gesture && folded.some((v, i) => v !== gesture.shape[i + 1])) gesture.cancel();
      const changed = !same(external, next); external = next; collapsed = folded;
      if (!gesture && !keyboard && !pending && changed) preference = [...external];
      apply();
    };
    apply();
    return { update, dispose() { gesture?.cancel(); disposed = true; observer.disconnect(); removers.forEach(remove => remove()); } };
  }
  const api = { defaults: Object.freeze(defaults), geometry, resize, separatorValues, bind };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.nativeWorkspaceSidebar = api;
})(typeof window === 'object' ? window : globalThis);
