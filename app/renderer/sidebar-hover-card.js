// Hover details for sidebar session rows and space headings. Display only: the renderer builds the card from the
// state the sidebar already has; nothing here selects, sends, polls or calls a model.
(function (global) {
  const DELAY = 600, GRACE = 120, MARGIN = 8, GAP = 8;

  // Beside the item, top-aligned, past the sidebar's own edge so the card never covers the row's buttons or the
  // sidebar scrollbar. With no room to the right it goes below the item, or above; it stays MARGIN inside the window.
  function place(anchor, sidebar, card, view) {
    let left = Math.max(anchor.right, sidebar.right) + GAP, top = anchor.top;
    if (left + card.width > view.width - MARGIN) {
      left = Math.max(MARGIN, Math.min(anchor.left, view.width - card.width - MARGIN));
      const below = anchor.bottom + GAP, above = anchor.top - GAP - card.height;
      top = below + card.height <= view.height - MARGIN || view.height - anchor.bottom >= anchor.top ? below : above;
    }
    top = Math.max(MARGIN, Math.min(top, view.height - card.height - MARGIN));
    return { left: Math.round(left), top: Math.round(top) };
  }

  // Timing only. An item is a key; pointer and keyboard focus are tracked apart, so leaving with one keeps the card
  // for the other. The first card waits `delay`; while one is open (or just closing) another item switches at once.
  // A dismissal (click, Esc, menu, drag, scroll, blur, language) keeps that item quiet until it is left.
  function controller({ delay = DELAY, grace = GRACE, schedule = setTimeout, cancel = clearTimeout, show, hide }) {
    let hovered = null, focused = null, last = null, open = null, pending = null, pendingKey = null, closing = null, quiet = null;
    const stop = timer => { if (timer) cancel(timer); return null; };
    const wanted = () => { const key = last && (last === hovered || last === focused) ? last : hovered || focused; return key === quiet ? null : key; };
    function sync() {
      const key = wanted();
      if (key && key === open) { closing = stop(closing); pending = stop(pending); pendingKey = null; return; }
      if (!key) {
        pending = stop(pending); pendingKey = null;
        if (open && !closing) closing = schedule(() => { closing = null; open = null; hide(); }, grace);
        return;
      }
      if (open) { closing = stop(closing); pending = stop(pending); pendingKey = null; open = key; show(key); return; }
      if (pendingKey === key) return;
      pending = stop(pending); pendingKey = key;
      pending = schedule(() => { pending = null; pendingKey = null; open = key; show(key); }, delay);
    }
    return {
      enter(key, how) { if (how === 'focus') focused = key; else hovered = key; last = key; sync(); },
      leave(key, how) {
        if (how === 'focus') { if (focused === key) focused = null; } else if (hovered === key) hovered = null;
        if (quiet === key && hovered !== key && focused !== key) quiet = null;
        sync();
      },
      dismiss() {
        const key = open || pendingKey || wanted();
        if (key) quiet = key;
        pending = stop(pending); pendingKey = null; closing = stop(closing);
        if (open) { open = null; hide(); }
      },
      // The open item may be gone after a re-render: close without keeping anything quiet.
      drop() { pending = stop(pending); pendingKey = null; closing = stop(closing); hovered = focused = last = null; if (open) { open = null; hide(); } },
      get open() { return open; },
      get pending() { return pendingKey; },
    };
  }

  // DOM wiring. `resolve(element, how)` names the item under an element ({ key } or null); `build(key)` returns
  // { anchor, kind, content } for an item that still exists, or null.
  function mount({ root, surface, resolve, build, delay, grace }) {
    const card = document.createElement('div');
    card.id = 'naw-hover-card'; card.setAttribute('aria-hidden', 'true'); card.hidden = true;
    const popover = typeof card.showPopover === 'function';
    if (popover) card.setAttribute('popover', 'manual');
    (surface || document.body).append(card);
    function paint(key) {
      const item = build(key);
      if (!item || !item.anchor?.isConnected) { control.drop(); return; }
      card.dataset.kind = item.kind; card.replaceChildren(...item.content.filter(Boolean));
      card.hidden = false;
      if (popover && !card.matches(':popover-open')) card.showPopover();
      const a = item.anchor.getBoundingClientRect(), s = (surface || item.anchor).getBoundingClientRect(), c = card.getBoundingClientRect();
      const at = place(a, s, c, { width: innerWidth, height: innerHeight });
      card.style.left = at.left + 'px'; card.style.top = at.top + 'px';
    }
    function hide() {
      if (popover && card.matches(':popover-open')) card.hidePopover();
      card.hidden = true; card.replaceChildren(); delete card.dataset.kind;
    }
    const control = controller({ delay, grace, show: paint, hide });
    const keyOf = (element, how) => element instanceof Element ? resolve(element, how)?.key || null : null;
    // The card stays click-through, so its own pointerenter cannot keep it open.
    // Treat its visible rectangle as part of the open item's hover surface.
    let cardPointer = null;
    const overCard = event => {
      if (!control.open || card.hidden || event.pointerType === 'touch' || event.buttons) return false;
      const r = card.getBoundingClientRect();
      return event.clientX >= r.left && event.clientX < r.right && event.clientY >= r.top && event.clientY < r.bottom;
    };
    function leaveCard() {
      const key = cardPointer; cardPointer = null;
      if (key) control.leave(key, 'pointer');
    }
    const listeners = [
      [root, 'pointerover', event => {
        if (event.pointerType === 'touch' || event.buttons || overCard(event)) return;
        const key = keyOf(event.target, 'pointer'); if (key) control.enter(key, 'pointer');
      }],
      [root, 'pointerout', event => {
        const key = keyOf(event.target, 'pointer'); if (!key || keyOf(event.relatedTarget, 'pointer') === key) return;
        control.leave(key, 'pointer');
      }],
      [document, 'pointermove', event => {
        if (overCard(event)) { cardPointer = control.open; control.enter(cardPointer, 'pointer'); }
        else if (cardPointer) {
          leaveCard();
          if (event.pointerType !== 'touch' && !event.buttons && root.contains(event.target)) {
            const key = keyOf(event.target, 'pointer'); if (key) control.enter(key, 'pointer');
          }
        }
      }, true],
      [document, 'pointerout', event => { if (!event.relatedTarget) leaveCard(); }, true],
      [root, 'focusin', event => {
        const key = keyOf(event.target, 'focus'); if (key && event.target.matches(':focus-visible')) control.enter(key, 'focus');
      }],
      [root, 'focusout', event => { const key = keyOf(event.target, 'focus'); if (key) control.leave(key, 'focus'); }],
      [document, 'pointerdown', () => control.dismiss(), true],
      [document, 'contextmenu', () => control.dismiss(), true],
      [document, 'dragstart', () => control.dismiss(), true],
      [document, 'scroll', event => { if (event.target instanceof Node && root.contains(event.target)) control.dismiss(); }, true],
      [document, 'keydown', event => {
        if (['Escape', 'Enter', ' ', 'ContextMenu'].includes(event.key) || event.shiftKey && event.key === 'F10') control.dismiss();
      }, true],
      [window, 'blur', () => control.dismiss()],
    ];
    for (const [target, type, listener, capture] of listeners) target.addEventListener(type, listener, Boolean(capture));
    return {
      element: card,
      dismiss: () => control.dismiss(),
      // A re-render repaints the open card from current state; nothing is fetched for it.
      refresh() { if (control.open) paint(control.open); },
      get open() { return control.open; },
      dispose() { control.drop(); for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, Boolean(capture)); card.remove(); },
    };
  }

  const api = { DELAY, GRACE, place, controller, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.nativeWorkspaceHoverCard = api;
})(typeof window === 'object' ? window : globalThis);
