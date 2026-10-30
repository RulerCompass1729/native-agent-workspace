// One session keeps one composer node while it moves between Solo and a column.
// Native input, ownership and persistence stay in the workspace callbacks.
(function (target, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else target.nativeWorkspaceComposer = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  function create(options) {
    const form = options.form, input = form.querySelector('textarea');
    const send = form.querySelector('.session-send-button'), hint = form.querySelector('.session-compose-hint');
    const native = form.ownerDocument.createElement('button');
    native.type = 'button'; native.textContent = '原生输入'; native.className = 'session-native-button'; native.hidden = true;
    send.before(native);
    const listeners = []; let composing = false, confirmingEnter = false, disposed = false;
    const on = (el, event, fn, capture = false) => { el.addEventListener(event, fn, capture); listeners.push(() => el.removeEventListener(event, fn, capture)); };
    const run = action => { if (!disposed) { try { Promise.resolve(action()).catch(options.onError); } catch (error) { options.onError(error); } } };
    const images = transfer => Array.from(transfer?.files || []).filter(file => file.type.startsWith('image/'));
    const binding = {
      form, input, send, hint, native,
      get composing() { return composing; },
      setValue(text) {
        if (composing || disposed) return false;
        if (input.value !== text) input.value = text;
        return true;
      },
      update(view) {
        input.readOnly = view.readOnly; input.disabled = false;
        input.placeholder = view.placeholder; input.setAttribute('aria-label', view.inputLabel);
        send.textContent = view.label; send.type = view.submit ? 'submit' : 'button'; send.disabled = view.disabled;
        if (view.actionLabel) send.setAttribute('aria-label', view.actionLabel); else send.removeAttribute('aria-label');
        hint.textContent = view.hint; hint.hidden = !view.hint;
        native.hidden = !view.showNative; native.disabled = view.nativeDisabled;
        if (view.nativeLabel) native.setAttribute('aria-label', view.nativeLabel);
      },
      suspend() { if (form.contains(form.ownerDocument.activeElement)) form.ownerDocument.activeElement.blur(); },
      dispose() { disposed = true; for (const remove of listeners) remove(); },
    };
    on(input, 'compositionstart', () => { composing = true; });
    on(input, 'compositionend', () => { composing = false; options.onCompositionEnd?.(binding); });
    on(input, 'input', () => options.onInput(binding));
    on(input, 'focus', () => options.onFocus?.(binding));
    on(input, 'keydown', event => {
      if (event.key !== 'Enter') return;
      if (!event.repeat) confirmingEnter = composing || event.isComposing || event.keyCode === 229;
      if (confirmingEnter || event.isComposing || event.shiftKey || input.readOnly) return;
      event.preventDefault(); if (!send.disabled && send.type === 'submit') form.requestSubmit();
    });
    on(input, 'keyup', event => { if (event.key === 'Enter') confirmingEnter = false; });
    on(send, 'click', () => { if (!send.disabled && send.type === 'button') run(() => options.onAction(binding)); });
    on(native, 'click', () => { if (!native.disabled) run(() => options.onNative(binding)); });
    on(form, 'submit', event => {
      event.preventDefault();
      if (!send.disabled && send.type === 'submit' && !input.readOnly && !composing) run(() => options.onSubmit(binding));
    });
    on(input, 'paste', event => {
      const files = images(event.clipboardData); if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); run(() => options.onImages(binding, files));
    }, true);
    on(input, 'dragover', event => {
      if (Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
    });
    on(input, 'drop', event => {
      const files = images(event.dataTransfer); if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); run(() => options.onImages(binding, files));
    });
    return binding;
  }
  return { create };
});
