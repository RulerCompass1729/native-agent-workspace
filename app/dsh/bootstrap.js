/* Original extension using DSH's published client-plugin and slot protocol. */
window.__ModuleLoader__.load({
  id: '@rulercompass/native-workspace',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom/client');
    const { MarkdownText, MarkdownDelegateProvider, Menu } = require('@deepseek-ai/dsh-client-ui-primitives');
    const templates = { sidebar: /* SIDEBAR_TEMPLATE */, main: /* MAIN_TEMPLATE */ };
    const styles = /* LOCAL_STYLES */;
    // Only project-template nodes registered before native content is inserted
    // can be refreshed. An identical attribute in a native reply grants nothing.
    function createDisplayBindings(translate) {
      const owned = new WeakMap();
      const attributes = ['aria-label', 'title', 'placeholder', 'aria-description', 'data-order-hint', 'alt'];
      const marker = 'data-naw-i18n-bound';
      const paint = (element, slot, entry) => {
        const value = entry.read ? entry.read() : translate(entry.key, typeof entry.params === 'function' ? entry.params() : entry.params);
        if (slot === 'text') {
          if (element.childElementCount) throw new Error('NAW display text must target a leaf node.');
          if (element.textContent !== value) element.textContent = value;
        } else if (element.getAttribute(slot) !== value) element.setAttribute(slot, value);
      };
      function bind(element, slot, key, params, read) {
        if (slot !== 'text' && !attributes.includes(slot)) throw new Error('Unsupported NAW display attribute.');
        const entry = { key, params, read };
        paint(element, slot, entry);
        let slots = owned.get(element);
        if (!slots) { slots = new Map(); owned.set(element, slots); element.setAttribute(marker, ''); }
        slots.set(slot, entry);
      }
      function unbind(element, slot = 'text') {
        const slots = owned.get(element);
        slots?.delete(slot);
        if (!slots?.size) { owned.delete(element); element.removeAttribute(marker); }
      }
      function template(root) {
        for (const element of root.querySelectorAll('[data-naw-text], [data-naw-aria-label], [data-naw-title], [data-naw-placeholder], [data-naw-aria-description], [data-naw-data-order-hint]')) {
          for (const slot of ['text', ...attributes]) {
            const attribute = 'data-naw-' + slot;
            if (!element.hasAttribute(attribute)) continue;
            bind(element, slot, element.getAttribute(attribute)); element.removeAttribute(attribute);
          }
        }
      }
      function refresh(root) {
        for (const element of root.querySelectorAll('[' + marker + ']')) {
          for (const [slot, entry] of owned.get(element) || []) paint(element, slot, entry);
        }
      }
      return { text: (element, key, params) => bind(element, 'text', key, params),
        // Project callbacks format own compound labels and recorded dates. They
        // must be pure; never pass a native action, actor or API call here.
        computed: (element, slot, read) => bind(element, slot, undefined, undefined, read),
        attribute: bind, unbind, template, refresh };
    }
    function mountWorkspace(ui) {
      /* WORKSPACE_VIEW */
    }
    return {
      inject: ['slots', 'layout', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('naw', window.nativeWorkspaceMessages));
        const t = ctx.locale.bind('naw');
        const subscribeLocale = callback => ctx.locale.subscribe(callback);
        const localeSnapshot = () => ctx.locale.getSnapshot();
        const display = createDisplayBindings(t);
        ctx.effect(() => subscribeLocale(() => display.refresh(document)));
        const errorText = error => window.nativeWorkspaceLocale.errorText(localeSnapshot().active, error);
        const displayText = (raw, message) => window.nativeWorkspaceLocale.displayText(localeSnapshot().active, raw, message);
        function showError(element, error) {
          const candidate = window.nativeWorkspaceLocale.displayMessage(error?.uiMessage);
          const message = candidate && ['zh', 'en'].some(locale => window.nativeWorkspaceLocale.format(locale, candidate.key, candidate.params) === error?.message) ? candidate : null;
          if (message?.cause || message?.parts) {
            const original = { message: error.message, uiMessage: message };
            display.computed(element, 'text', () => errorText(original));
          }
          else if (message) display.text(element, message.key, message.params);
          else {
            display.unbind(element);
            if (typeof error?.message === 'string' && error.message) element.textContent = error.message;
            else display.text(element, 'error.operation');
          }
        }
        const language = {
          text: t, subscribe: subscribeLocale, getSnapshot: localeSnapshot,
          preference: () => ctx.configForms.get('locale').getSnapshot().value?.preference,
          async set(id) {
            if (!['zh', 'en'].includes(id)) throw new Error(t('locale.notSaved'));
            let accepted = false;
            try { accepted = await ctx.configForms.get('locale').set('preference', id); } catch {}
            // LocaleRuntime adopts only the Host's accepted mirror. Never call
            // its optimistic setLocale or treat changed paint as a save receipt.
            if (accepted !== true) throw new Error(t('locale.notSaved'));
          },
        };
        // The workspace occupies a DSH global panel. It has native sessions,
        // not DSH model-loop sessions; expose explicit absence to the shell.
        if (!ctx.get('uiSession')) {
          const empty = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
          const source = value => ({ getSnapshot: () => value, subscribe: () => () => {} });
          const absent = source(empty);
          ctx.effect(() => ctx.slots.installScope('session', {
            current: absent,
            bindingSource: target => { if (target !== undefined) throw new Error('Native sessions belong to the workspace panel.'); return absent; },
            renderArea: (_binding, options) => options.empty?.() ?? null,
          }));
          ctx.effect(() => ctx.slots.provideRoot({ hooks: { sessions: source({ byId: {} }) } }));
        }
        // Keep the existing menu and its focused item mounted. Only its label
        // child observes locale; action IDs, enablement and callbacks stay fixed.
        function MenuMessage({ item }) {
          React.useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot);
          return item.labelRead ? item.labelRead() : t(item.labelKey, item.labelParams);
        }
        let mounted = 0, cleanup;
        const markdownRoots = new Map();
        function MessageMarkdown({ text, streaming, onLayout, source }) {
          React.useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot);
          const pendingCopy = React.useRef(new WeakSet());
          const pendingFile = React.useRef(null), alive = React.useRef(true);
          const [fileStatus, setFileStatus] = React.useState(''), [fileBusy, setFileBusy] = React.useState(false);
          const sourceKey = JSON.stringify(source || null), visible = React.useRef(null);
          visible.current = { sourceKey, text };
          React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
          React.useLayoutEffect(() => { pendingFile.current = null; setFileBusy(false); setFileStatus(''); }, [sourceKey, text]);
          React.useLayoutEffect(() => { onLayout?.(); });
          const stillVisible = () => alive.current && visible.current?.sourceKey === sourceKey && visible.current?.text === text;
          const openFile = (file, options) => {
            if (pendingFile.current) return;
            const request = {}; pendingFile.current = request; setFileBusy(true); setFileStatus('');
            const requestVisible = () => pendingFile.current === request && stillVisible();
            const original = source && { ...source };
            Promise.resolve().then(() => window.workspace.openMessageFile(original, file, options)).then(result => {
              if (result?.accepted !== true) throw window.nativeWorkspaceLocale.createError('error.markdownOpenUnconfirmed');
              if (requestVisible() && options?.line) setFileStatus({ key: 'markdown.fileOpened' });
            }).catch(error => { if (requestVisible()) setFileStatus({ key: 'markdown.openFileFailed', error: error?.message ? error : { message: String(error) } }); }).finally(() => {
              const current = requestVisible();
              if (pendingFile.current === request) pendingFile.current = null;
              if (current) setFileBusy(false);
            });
          };
          const showTarget = event => {
            const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
            if (anchor && event.currentTarget.contains(anchor)) anchor.title = anchor.getAttribute('href') || '';
          };
          const copy = event => {
            const button = event.target instanceof Element ? event.target.closest('[data-code-block-banner] button') : null;
            const block = button?.closest('.md-code-block'), banner = button?.closest('[data-code-block-banner]');
            const code = block?.querySelector('[data-code-block-content] pre');
            // The pinned Markdown component exposes no clipboard delegate.
            // Adapt only its single Copy action, preserving the native renderer.
            if (!code || !event.currentTarget.contains(block) || banner.querySelectorAll('button').length !== 1) return;
            event.preventDefault(); event.stopPropagation();
            if (pendingCopy.current.has(button)) return;
            pendingCopy.current.add(button); button.setAttribute('aria-busy', 'true');
            ui.copyCode(code.textContent).catch(() => {}).finally(() => {
              pendingCopy.current.delete(button); button.removeAttribute('aria-busy');
            });
          };
          return React.createElement('div', { className: 'naw-markdown', onClickCapture: copy, onMouseOverCapture: showTarget, onFocusCapture: showTarget, 'aria-busy': fileBusy || undefined },
            React.createElement(MarkdownDelegateProvider, { openFile, openExternalLink: href => {
              Promise.resolve().then(() => window.workspace.openExternal(href)).catch(error => { if (stillVisible()) setFileStatus({ key: 'markdown.openLinkFailed', error: error?.message ? error : { message: String(error) } }); });
            } }, React.createElement(MarkdownText, { text, streaming, className: 'dsh-markdown', labels: { code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') }, footnotes: t('markdown.footnotes') } })),
            fileStatus ? React.createElement('p', { role: 'status' }, t(fileStatus.key, fileStatus.error ? { error: errorText(fileStatus.error) } : undefined)) : null);
        }
        const ui = {
          language, display, displayText, errorText, showError, createError: window.nativeWorkspaceLocale.createError, createNotice: window.nativeWorkspaceLocale.createNotice,
          revealSidebar() {
            if (document.querySelector('.naw[data-native-surface="sidebar"]')?.dataset.collapsed === 'true') ctx.layout.toggleSidebar();
          },
          // Reuse the pinned DSH menu's positioning, theme and arrow navigation.
          menu({ items, getAnchorRect, onSelect, onClose, contextElement }) {
            const opener = document.activeElement;
            const modal = contextElement?.closest('dialog[open]') || opener?.closest('dialog[open]');
            const host = document.createElement('div'); (modal || document.body).append(host);
            // A body portal is inert beneath a modal dialog. Keep the same DSH
            // menu inline in that dialog; no second menu implementation.
            // A body portal host must not add document height or resize the terminal.
            Object.assign(host.style, { position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px', zIndex: '1000' });
            const root = ReactDOM.createRoot(host); let closed = false;
            const position = () => {
              const menu = modal && host.querySelector('[role="menu"]');
              if (!menu || closed) return;
              const anchor = getAnchorRect(), bounds = modal.getBoundingClientRect(), rect = menu.getBoundingClientRect();
              const left = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - rect.width - 8));
              const below = anchor.bottom + 4;
              const top = Math.max(bounds.top + 8, Math.min(below + rect.height <= bounds.bottom - 8 ? below : anchor.top - rect.height - 4, bounds.bottom - rect.height - 8));
              host.style.left = `${parseFloat(host.style.left) + left - rect.left}px`;
              host.style.top = `${parseFloat(host.style.top) + top - rect.top}px`;
            };
            const close = () => {
              if (closed) return; closed = true;
              document.removeEventListener('keydown', tab, true);
              if (modal) { modal.removeEventListener('close', close); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); }
              root.unmount(); host.remove(); onClose();
            };
            // DSH currently activates the focused item on Tab. In a session
            // menu Tab should leave without renaming or opening a window.
            const tab = event => { if (event.key === 'Tab') { event.stopPropagation(); close(); } };
            document.addEventListener('keydown', tab, true);
            if (modal) { modal.addEventListener('close', close); window.addEventListener('resize', position); document.addEventListener('scroll', position, true); }
            function SessionMenu({ items }) {
              React.useEffect(() => {
                // A newly mounted portal starts hidden until DSH positions it.
                // Its first autofocus can run too early; retry after layout,
                // only if the person has not already moved focus elsewhere.
                const frame = requestAnimationFrame(() => {
                  position();
                  if (!closed && document.activeElement === opener) (modal ? host : document).querySelector('.naw-session-menu [role="menuitem"]:not(:disabled)')?.focus();
                });
                return () => cancelAnimationFrame(frame);
              }, []);
              return React.createElement(Menu, {
                open: true, portal: !modal, autoFocus: true, items: items.map(item => item.labelKey || item.labelRead ? { ...item, [item.type === 'label' ? 'text' : 'label']: React.createElement(MenuMessage, { item }) } : item), getAnchorRect,
                listClassName: 'naw-session-menu', onClose: close,
                onSelect: action => { close(); onSelect(action); },
              });
            }
            // update() re-renders the same open menu with new items (same ids keep focus); it does not reopen it.
            const update = next => { if (!closed) root.render(React.createElement(SessionMenu, { items: next })); };
            update(items);
            return Object.assign(close, { update });
          },
          markdown(el, text, streaming, onLayout, source) {
            let root = markdownRoots.get(el);
            if (!root) { root = ReactDOM.createRoot(el); markdownRoots.set(el, root); }
            root.render(React.createElement(MessageMarkdown, { text, streaming, onLayout, source }));
          },
          clearMarkdown(el) { for (const [target, root] of markdownRoots) if (el.contains(target)) { root.unmount(); markdownRoots.delete(target); } },
        };
        function Surface({ kind, collapsed }) {
          const ref = React.useRef(null);
          React.useLayoutEffect(() => {
            // These templates are build-time project markup, never model text.
            const parsed = new DOMParser().parseFromString(templates[kind], 'text/html');
            display.template(parsed.body);
            ref.current.replaceChildren(...parsed.body.childNodes);
            mounted++;
            if (mounted === 2) cleanup = mountWorkspace(ui);
            return () => { cleanup?.(); cleanup = undefined; mounted--; };
          }, [kind]);
          return React.createElement('div', { ref, className: 'naw', 'data-native-surface': kind, 'data-collapsed': Boolean(collapsed), style: collapsed ? { overflow: 'hidden' } : undefined });
        }
        ctx.effect(() => {
          const style = document.createElement('style'); style.textContent = styles + '\n.naw-session-menu [role="presentation"]{white-space:pre-line;overflow-wrap:anywhere;max-width:min(380px,calc(100vw - 40px))}'; document.head.append(style);
          return () => { cleanup?.(); for (const root of markdownRoots.values()) root.unmount(); markdownRoots.clear(); style.remove(); };
        });
        ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar' }, props => React.createElement(Surface, { kind: 'sidebar', collapsed: props.collapsed })));
        ctx.slots.inject('main', () => {
          const dispose = ctx.slots.register({ name: 'main', key: 'native-workspace' }, () => React.createElement(Surface, { kind: 'main' }));
          ctx.layout.selectPanel('native-workspace');
          return dispose;
        });
      },
    };
  },
});
