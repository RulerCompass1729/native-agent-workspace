// Header agent squares (11-22): one square per agent, coloured by the sidebar corner dot's own classes.
// Display only: reads the presentation the sidebar already computed; never sends, polls or calls a model.
(function (global) {
  const MODES = ['status', 'model', 'space'];
  const STATUS = ['waiting', 'stuck', 'working', 'idle'];

  // The one status → look mapping shared by the sidebar corner dot and the header square.
  function look(presentation) {
    return `state-dot ${presentation.tone}${presentation.workTone ? ' ' + presentation.workTone : ''}`;
  }

  function group(presentation) {
    const { tone, workTone } = presentation;
    if (tone === 'disconnected') return 'stuck';
    if (tone === 'approval') return presentation.waiting ? 'waiting' : 'stuck';
    if (workTone === 'goal-stopped') return 'stuck';
    if (tone === 'working' || workTone === 'bg-work' || workTone === 'goal-enabled') return 'working';
    return 'idle';
  }

  const TOOLS = new Set(['workspace_control', 'workspace_message', 'workspace_sessions', 'workspace_report', 'workspace_open',
    'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'Task']);
  // The Claude hook reports a raw tool name (Bash, mcp__server__tool); the header says it in words. Other text stays.
  function plainActivity(raw, text) {
    const value = String(raw || '').trim();
    if (!/^[A-Za-z][\w.-]*$/.test(value)) return value;
    const mcp = /^mcp__(.+?)__(.+)$/.exec(value), tool = mcp ? mcp[2] : value;
    if (TOOLS.has(tool)) return text('activity.tool.' + tool);
    if (mcp) return text('activity.tool.mcp', { server: mcp[1].replace(/_/g, ' ') });
    return /[_A-Z]/.test(value) ? text('activity.tool.other') : value;
  }

  // entries: [{ id, name, look, status, statusText, model, rooms: [{ id, name }] }]
  function groupBy(entries, mode, text) {
    if (mode === 'model') {
      const byModel = new Map();
      for (const entry of entries) {
        const key = entry.model || '';
        // Short model names (opus-5-5, not claude-opus-5-5) keep the group on one line; the full name is in each square's label.
        if (!byModel.has(key)) byModel.set(key, { key: 'model:' + key, label: key.replace(/^claude-/, '') || text('modelUnknown'), members: [] });
        byModel.get(key).members.push(entry);
      }
      return [...byModel.values()].sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
    }
    if (mode === 'space') {
      const bySpace = new Map(), independent = { key: 'space:', label: text('independent'), members: [] };
      for (const entry of entries) {
        if (!entry.rooms.length) independent.members.push(entry);
        for (const room of entry.rooms) {
          if (!bySpace.has(room.id)) bySpace.set(room.id, { key: 'space:' + room.id, label: room.name, members: [] });
          bySpace.get(room.id).members.push(entry);
        }
      }
      return [...bySpace.values(), independent].filter(item => item.members.length);
    }
    return STATUS.map(key => ({ key: 'status:' + key, status: key, label: text('status.' + key), members: entries.filter(entry => entry.status === key) }))
      .filter(item => item.members.length);
  }

  function bind({ host, document: doc, text, onSession, mode: initial = 'status', onMode }) {
    const make = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };
    const t = (key, params) => text('distribution.' + key, params);
    let mode = MODES.includes(initial) ? initial : 'status', entries = [], excluded = { archived: 0, other: 0 }, signature = '';
    const strip = make('div', 'agent-strip'); strip.setAttribute('role', 'group');
    const toggle = make('button', 'agent-strip-toggle'); toggle.type = 'button'; toggle.textContent = '⌄';
    const panel = make('section', 'agent-strip-panel'); panel.id = 'agent-strip-panel'; panel.hidden = true;
    panel.setAttribute('popover', 'auto'); toggle.setAttribute('aria-controls', panel.id); toggle.setAttribute('aria-expanded', 'false');
    host.classList.add('agent-distribution'); host.append(strip, toggle, panel);
    const open = () => { draw(true); panel.hidden = false; if (!panel.matches(':popover-open')) panel.showPopover({ source: toggle }); place(); toggle.setAttribute('aria-expanded', 'true'); };
    const close = () => { if (panel.matches(':popover-open')) panel.hidePopover(); };
    panel.addEventListener('toggle', () => { const shown = panel.matches(':popover-open'); panel.hidden = !shown; toggle.setAttribute('aria-expanded', String(shown)); });
    toggle.onclick = () => panel.matches(':popover-open') ? close() : open();
    function place() {
      const r = toggle.getBoundingClientRect(), width = Math.min(340, innerWidth - 16);
      panel.style.width = width + 'px';
      panel.style.left = Math.max(8, Math.min(r.right - width, innerWidth - width - 8)) + 'px';
      panel.style.top = (r.bottom + 6) + 'px';
    }
    function jump(id) { close(); onSession?.(id); }
    function cell(entry) {
      const b = make('button', 'agent-cell ' + entry.look); b.type = 'button';
      b.dataset.sessionId = entry.id; b.dataset.agentStatus = entry.status;
      b.setAttribute('aria-label', [entry.name, entry.statusText, entry.model || t('modelUnknown')].join(' · '));
      b.onclick = () => jump(entry.id);
      return b;
    }
    function drawStrip(groups) {
      const parts = groups.map(item => {
        const g = make('span', 'agent-group'); g.dataset.group = item.key;
        const label = make('span', 'agent-group-label');
        label.textContent = item.label;
        const count = make('span', 'agent-group-count'); count.textContent = String(item.members.length);
        const cells = make('span', 'agent-group-cells'); cells.append(...item.members.map(cell));
        g.append(label, count, cells);
        return g;
      });
      strip.replaceChildren(...parts);
      const summary = groups.map(item => item.label + ' ' + item.members.length).join(' · ');
      strip.setAttribute('aria-label', t('aria', { count: entries.length, summary }));
      toggle.setAttribute('aria-label', t('open', { mode: t('mode.' + mode) }));
      toggle.title = t('open', { mode: t('mode.' + mode) });
      host.hidden = !entries.length;
    }
    function drawPanel(groups) {
      const head = make('div', 'agent-strip-modes'); head.setAttribute('role', 'radiogroup'); head.setAttribute('aria-label', t('modes'));
      for (const value of MODES) {
        const b = make('button', 'agent-strip-mode'); b.type = 'button'; b.textContent = t('mode.' + value);
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(value === mode)); b.dataset.mode = value;
        b.onclick = () => { if (mode === value) return; mode = value; onMode?.(value); signature = ''; draw(true); };
        head.append(b);
      }
      const lists = groups.map(item => {
        const section = make('section', 'agent-strip-group'), h = make('h3'); h.textContent = item.label + ' ' + item.members.length;
        const ul = make('ul');
        for (const entry of item.members) {
          const li = make('li'), b = make('button', 'agent-strip-member'); b.type = 'button'; b.dataset.sessionId = entry.id;
          const dot = make('span', entry.look); dot.setAttribute('aria-hidden', 'true');
          const name = make('span', 'agent-strip-member-name'); name.textContent = entry.name;
          const detail = make('span', 'agent-strip-member-detail'); detail.textContent = mode === 'status' ? entry.model || t('modelUnknown') : entry.statusText;
          b.append(dot, name, detail); b.onclick = () => jump(entry.id); li.append(b); ul.append(li);
        }
        section.append(h, ul); return section;
      });
      const legend = make('div', 'agent-strip-legend');
      for (const key of ['working', 'background', 'waiting', 'offline', 'unknown', 'idle']) {
        const item = make('span'), swatch = make('span', 'agent-legend-swatch ' + key); swatch.setAttribute('aria-hidden', 'true');
        item.append(swatch, doc.createTextNode(t('legend.' + key))); legend.append(item);
      }
      const note = make('p', 'agent-strip-note');
      note.textContent = excluded.archived || excluded.other ? t('excluded', { archived: excluded.archived, other: excluded.other }) : t('excludedNone');
      panel.replaceChildren(head, legend, ...lists, note);
    }
    function draw(force = false) {
      const groups = groupBy(entries, mode, t);
      const next = JSON.stringify([mode, entries, excluded, text('distribution.mode.status')]);
      if (!force && next === signature) return;
      signature = next;
      drawStrip(groups);
      if (panel.matches(':popover-open') || force) drawPanel(groups);
    }
    return {
      element: host,
      update(list, skipped = excluded) { entries = list; excluded = skipped; draw(); },
      setMode(value) { if (MODES.includes(value) && value !== mode) { mode = value; signature = ''; draw(); } },
      get mode() { return mode; },
      close,
    };
  }

  const api = { MODES, STATUS, look, group, groupBy, plainActivity, bind };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.nativeWorkspaceAgentDistribution = api;
})(typeof window === 'object' ? window : globalThis);
