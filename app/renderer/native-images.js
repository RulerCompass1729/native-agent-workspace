// An image belongs to its original reader row. Only opaque preview tokens
// cross the clipboard/expand boundary; the renderer never requests a file path.
(function (root) {
  function mount(host, api, options = {}) {
    const doc = host.ownerDocument, display = options.display, widgets = new Set(); let revision = '', closed = false;
    const element = (tag, cls, text) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
    const release = token => { if (token) Promise.resolve(api.releaseImage(token)).catch(() => {}); };
    const clear = () => { for (const widget of widgets) widget.dispose(); widgets.clear(); host.replaceChildren(); };
    function update(images, source, owner, status) {
      const key = JSON.stringify([images, source, status]);
      if (closed) return;
      if (revision === key) { for (const widget of widgets) widget.relabel(owner); return; }
      revision = key; clear();
      const ready = ['complete', 'submitted'].includes(status) || ['space-draft', 'space-message'].includes(source.kind) && status === 'preview';
      if (!Array.isArray(images)) return;
      images.forEach((ref, index) => {
        const sourceKey = { ...source, index }, label = () => ref.kind === 'space-upload' ? ref.name : ref.path?.split('/').at(-1) || options.text('image.nameless', { number: index + 1 });
        const item = element('div', 'native-image'), toggle = element('button', 'native-image-toggle'),
          image = element('img'), caption = element('div', 'native-image-caption'), controls = element('div', 'native-image-controls'),
          copy = element('button', 'native-image-copy'), note = element('span', 'native-image-note');
        item.dataset.imageIndex = String(index); toggle.type = copy.type = 'button';
        let imageOwner;
        const labelParams = () => ({ owner: typeof imageOwner === 'function' ? imageOwner() : imageOwner, label: label() });
        const relabel = value => { imageOwner = value; display.attribute(toggle, 'aria-label', 'image.view', labelParams); display.attribute(copy, 'aria-label', 'image.copyFor', labelParams); };
        display.computed(toggle, 'text', label); display.computed(caption, 'text', label); display.text(copy, 'image.copy');
        relabel(owner); toggle.setAttribute('aria-expanded', 'false'); copy.disabled = true;
        display.computed(toggle, 'title', () => ref.path || label()); note.setAttribute('role', 'status');
        controls.append(copy, note); item.append(toggle, caption, controls); host.append(item);
        let remove;
        if (source.kind === 'space-draft' && options.remove) {
          remove = element('button', 'native-image-remove', '×'); remove.type = 'button';
          display.attribute(remove, 'aria-label', 'roomImages.remove', () => ({ name: label() }));
          remove.onclick = () => { if (current()) return options.remove(ref); };
          item.append(remove);
        }
        let alive = true, token, foldKey, thumb, full, loading, expanding, wantsOpen = false, interacted = false, observer;
        const current = () => alive && !closed && revision === key && host.isConnected;
        function markOpen(open, remember) {
          options.beforeLayout?.(); wantsOpen = open;
          item.dataset.expanded = String(open); toggle.setAttribute('aria-expanded', String(open));
          if (!open) full = null;
          if (thumb) image.src = open && full ? full : thumb;
          if (remember && foldKey) options.onOpen?.(foldKey, open);
          options.onLayout?.();
        }
        function failure(error) {
          if (!current()) return;
          display.computed(note, 'text', () => options.text('image.unavailable', { reason: options.displayText(String(error.message || error), error.uiMessage) }));
          display.computed(caption, 'text', () => ref.path || label()); caption.title = ref.path || '';
          copy.disabled = true;
          if (!thumb) display.text(toggle, 'image.retry');
        }
        async function expand(remember = false) {
          if (!current() || !token || !wantsOpen || expanding) return;
          const ownToken = token; toggle.setAttribute('aria-busy', 'true');
          expanding = (async () => {
            try {
              const result = await api.expandImage(ownToken);
              if (!current() || token !== ownToken || !wantsOpen) return;
              if (typeof result !== 'string' || !result.startsWith('data:image/png;base64,')) throw options.createError('error.imagePreviewFormat');
              full = result; markOpen(true, remember); display.unbind(note); note.textContent = '';
            } catch (error) { if (current()) { release(token); token = null; wantsOpen = false; markOpen(false, false); failure(error); } }
            finally { expanding = null; if (current()) toggle.removeAttribute('aria-busy'); }
          })();
          return expanding;
        }
        async function load() {
          if (!current() || loading || token || !ready) return loading;
          toggle.setAttribute('aria-busy', 'true'); display.text(note, 'image.loading');
          loading = (async () => {
            try {
              const result = await api.previewImage(sourceKey);
              if (!current()) { release(result.token); return; }
              if (typeof result.thumbnail !== 'string' || !result.thumbnail.startsWith('data:image/png;base64,')) { release(result.token); throw options.createError('error.imageThumbnailFormat'); }
              token = result.token; foldKey = result.key; thumb = result.thumbnail;
              if (!interacted) wantsOpen = options.isOpen?.(foldKey) === true;
              else options.onOpen?.(foldKey, wantsOpen);
              image.src = thumb; image.width = result.width; image.height = result.height;
              display.computed(image, 'alt', label); display.unbind(toggle); toggle.replaceChildren(image); copy.disabled = false; display.unbind(note); note.textContent = '';
              display.computed(toggle, 'title', () => options.text('image.dimensions', { label: ref.path || label(), width: result.width, height: result.height }));
              options.onLayout?.(); if (wantsOpen) await expand(false);
            } catch (error) { failure(error); }
            finally { loading = null; if (current()) toggle.removeAttribute('aria-busy'); }
          })();
          return loading;
        }
        image.onload = () => { if (current()) options.onLayout?.(); };
        toggle.onclick = async () => {
          if (ref.unavailable || !ready) return;
          interacted = true; wantsOpen = !wantsOpen;
          if (!wantsOpen) { markOpen(false, true); return; }
          if (foldKey) options.onOpen?.(foldKey, true);
          await load(); if (current() && wantsOpen) await expand(true);
        };
        item.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || !wantsOpen) return;
          event.preventDefault(); event.stopPropagation(); interacted = true; markOpen(false, true); toggle.focus({ preventScroll: true });
        });
        copy.onclick = async () => {
          if (!current() || !token) return;
          const ownToken = token; copy.disabled = true;
          try { await api.copyImage(ownToken); if (current() && token === ownToken) display.text(note, 'image.copied', () => ({ label: label() })); }
          catch (error) { release(token); token = null; failure(error); }
          finally { if (current()) copy.disabled = !token; }
        };
        const widget = { relabel, dispose() { alive = false; observer?.disconnect(); release(token); token = null; image.onload = null; image.removeAttribute('src'); full = thumb = null; if (remove) display.unbind(remove, 'aria-label'); for (const [el, slots] of [[toggle, ['text', 'aria-label', 'title']], [caption, ['text']], [copy, ['text', 'aria-label']], [image, ['alt']], [note, ['text']]]) for (const slot of slots) display.unbind(el, slot); } };
        widgets.add(widget);
        if (ref.unavailable) { toggle.disabled = true; display.computed(note, 'text', () => options.text('image.unavailable', { reason: options.displayText(ref.unavailable, ref.unavailableUiMessage) })); display.computed(caption, 'text', () => ref.path || label()); }
        else if (!ready) { toggle.disabled = true; display.text(note, 'image.waiting'); }
        else if (typeof root.IntersectionObserver === 'function') {
          observer = new root.IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } }, { root: host.closest('.messages'), rootMargin: '200px' });
          observer.observe(item);
        } else load();
      });
    }
    return { update, dispose() { closed = true; clear(); } };
  }
  root.nativeWorkspaceImages = { mount };
})(window);
