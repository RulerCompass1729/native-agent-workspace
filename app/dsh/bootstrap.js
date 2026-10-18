/* Original extension using DSH's published client-plugin and slot protocol. */
window.__ModuleLoader__.load({
  id: '@rulercompass/native-workspace',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom/client');
    const { MarkdownText, MarkdownDelegateProvider, Menu } = require('@deepseek-ai/dsh-client-ui-primitives');
    const templates = { sidebar: /* SIDEBAR_TEMPLATE */, main: /* MAIN_TEMPLATE */ };
    const styles = /* LOCAL_STYLES */;
    function mountWorkspace(ui) {
      /* WORKSPACE_VIEW */
    }
    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
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
        let mounted = 0, cleanup;
        const markdownRoots = new Map();
        const ui = {
          // Reuse the pinned DSH menu's positioning, theme and arrow navigation.
          menu({ items, getAnchorRect, onSelect, onClose }) {
            const opener = document.activeElement;
            const host = document.createElement('div'); document.body.append(host);
            const root = ReactDOM.createRoot(host); let closed = false;
            const close = () => {
              if (closed) return; closed = true;
              document.removeEventListener('keydown', tab, true);
              root.unmount(); host.remove(); onClose();
            };
            // DSH currently activates the focused item on Tab. In a session
            // menu Tab should leave without renaming or opening a window.
            const tab = event => { if (event.key === 'Tab') { event.stopPropagation(); close(); } };
            document.addEventListener('keydown', tab, true);
            function SessionMenu() {
              React.useEffect(() => {
                // A newly mounted portal starts hidden until DSH positions it.
                // Its first autofocus can run too early; retry after layout,
                // only if the person has not already moved focus elsewhere.
                const frame = requestAnimationFrame(() => {
                  if (!closed && document.activeElement === opener) document.querySelector('.naw-session-menu [role="menuitem"]')?.focus();
                });
                return () => cancelAnimationFrame(frame);
              }, []);
              return React.createElement(Menu, {
                open: true, portal: true, autoFocus: true, items, getAnchorRect,
                listClassName: 'naw-session-menu', onClose: close,
                onSelect: action => { close(); onSelect(action); },
              });
            }
            root.render(React.createElement(SessionMenu));
            return close;
          },
          markdown(el, text, streaming) {
            let root = markdownRoots.get(el);
            if (!root) { root = ReactDOM.createRoot(el); markdownRoots.set(el, root); }
            root.render(React.createElement(MarkdownDelegateProvider, { openExternalLink: href => window.workspace.openExternal(href) },
              React.createElement(MarkdownText, { text, streaming, className: 'dsh-markdown', labels: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' } })));
          },
          clearMarkdown(el) { for (const [target, root] of markdownRoots) if (el.contains(target)) { root.unmount(); markdownRoots.delete(target); } },
        };
        function Surface({ kind, collapsed }) {
          const ref = React.useRef(null);
          React.useLayoutEffect(() => {
            // These templates are build-time project markup, never model text.
            const parsed = new DOMParser().parseFromString(templates[kind], 'text/html');
            ref.current.replaceChildren(...parsed.body.childNodes);
            mounted++;
            if (mounted === 2) cleanup = mountWorkspace(ui);
            return () => { cleanup?.(); cleanup = undefined; mounted--; };
          }, [kind]);
          return React.createElement('div', { ref, className: 'naw', 'data-native-surface': kind, 'data-collapsed': Boolean(collapsed), style: collapsed ? { overflow: 'hidden' } : undefined });
        }
        ctx.effect(() => {
          const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
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
