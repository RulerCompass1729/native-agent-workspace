// An image belongs to its original reader row. Only opaque preview tokens
// cross the clipboard/expand boundary; the renderer never requests a file path.
(function (root) {
  function mount(host, api, options = {}) {
    const doc = host.ownerDocument, widgets = new Set(); let revision = '', closed = false;
    const element = (tag, cls, text) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
    const release = token => { if (token) Promise.resolve(api.releaseImage(token)).catch(() => {}); };
    const clear = () => { for (const widget of widgets) widget.dispose(); widgets.clear(); host.replaceChildren(); };
    function update(images, source, owner, status) {
      const key = JSON.stringify([images, source, status]);
      if (closed) return;
      if (revision === key) { for (const widget of widgets) widget.relabel(owner); return; }
      revision = key; clear();
      if (!Array.isArray(images)) return;
      images.forEach((ref, index) => {
        const sourceKey = { ...source, index }, label = ref.path?.split('/').at(-1) || `原生图片 ${index + 1}`;
        const item = element('div', 'native-image'), toggle = element('button', 'native-image-toggle', label),
          image = element('img'), caption = element('div', 'native-image-caption', label), controls = element('div', 'native-image-controls'),
          copy = element('button', 'native-image-copy', '复制图片'), note = element('span', 'native-image-note');
        item.dataset.imageIndex = String(index); toggle.type = copy.type = 'button';
        const relabel = value => { toggle.setAttribute('aria-label', `查看图片（${value}）${label}`); copy.setAttribute('aria-label', `复制图片（${value}）${label}`); };
        relabel(owner); toggle.setAttribute('aria-expanded', 'false'); copy.disabled = true;
        image.alt = label; toggle.title = ref.path || label; note.setAttribute('role', 'status');
        controls.append(copy, note); item.append(toggle, caption, controls); host.append(item);
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
          note.textContent = `图片不可用 · ${error.message || error}`;
          caption.textContent = ref.path || label; caption.title = ref.path || '';
          copy.disabled = true;
          if (!thumb) toggle.textContent = '重试图片预览';
        }
        async function expand(remember = false) {
          if (!current() || !token || !wantsOpen || expanding) return;
          const ownToken = token; toggle.setAttribute('aria-busy', 'true');
          expanding = (async () => {
            try {
              const result = await api.expandImage(ownToken);
              if (!current() || token !== ownToken || !wantsOpen) return;
              if (typeof result !== 'string' || !result.startsWith('data:image/png;base64,')) throw Error('图片预览格式无效。');
              full = result; markOpen(true, remember); note.textContent = '';
            } catch (error) { if (current()) { release(token); token = null; wantsOpen = false; markOpen(false, false); failure(error); } }
            finally { expanding = null; if (current()) toggle.removeAttribute('aria-busy'); }
          })();
          return expanding;
        }
        async function load() {
          if (!current() || loading || token || !['complete', 'submitted'].includes(status)) return loading;
          toggle.setAttribute('aria-busy', 'true'); note.textContent = '正在读取图片…';
          loading = (async () => {
            try {
              const result = await api.previewImage(sourceKey);
              if (!current()) { release(result.token); return; }
              if (typeof result.thumbnail !== 'string' || !result.thumbnail.startsWith('data:image/png;base64,')) { release(result.token); throw Error('图片缩略图格式无效。'); }
              token = result.token; foldKey = result.key; thumb = result.thumbnail;
              if (!interacted) wantsOpen = options.isOpen?.(foldKey) === true;
              else options.onOpen?.(foldKey, wantsOpen);
              image.src = thumb; image.width = result.width; image.height = result.height;
              toggle.replaceChildren(image); copy.disabled = false; note.textContent = '';
              toggle.title = `${ref.path || label}\n${result.width} × ${result.height}`;
              options.onLayout?.(); if (wantsOpen) await expand(false);
            } catch (error) { failure(error); }
            finally { loading = null; if (current()) toggle.removeAttribute('aria-busy'); }
          })();
          return loading;
        }
        image.onload = () => { if (current()) options.onLayout?.(); };
        toggle.onclick = async () => {
          if (ref.unavailable || !['complete', 'submitted'].includes(status)) return;
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
          try { await api.copyImage(ownToken); if (current() && token === ownToken) note.textContent = `已复制图片 · ${label}`; }
          catch (error) { release(token); token = null; failure(error); }
          finally { if (current()) copy.disabled = !token; }
        };
        const widget = { relabel, dispose() { alive = false; observer?.disconnect(); release(token); token = null; image.onload = null; image.removeAttribute('src'); full = thumb = null; } };
        widgets.add(widget);
        if (ref.unavailable) { toggle.disabled = true; note.textContent = `图片不可用 · ${ref.unavailable}`; caption.textContent = ref.path || label; }
        else if (!['complete', 'submitted'].includes(status)) { toggle.disabled = true; note.textContent = '等待原生确认图片'; }
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
