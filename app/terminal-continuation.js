// Optional native snapshot continuation for the pinned xterm 6 implementation.
// This restores an existing receiving terminal only; it never writes to the PTY.
(function (root) {
  const MAX_BYTES = 4 * 1024 * 1024, MAX_LINES = 10400;
  const names = ['normal', 'alt'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const bits = value => integer(value, -2147483648, 4294967295);
  const fail = () => { throw Error('Invalid native terminal continuation'); };
  function frameBytes(value) {
    const text = JSON.stringify(value);
    return typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : new TextEncoder().encode(text).byteLength;
  }
  function map(value) {
    if (value === null) return true;
    if (!object(value) || Object.keys(value).length > 128) return false;
    return Object.entries(value).every(([key, text]) => key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126 && typeof text === 'string' && [...text].length === 1);
  }
  const copyMap = value => value == null ? null : { ...value };
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_BYTES && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  function validate(state) {
    if (state == null) return false;
    if (!object(state)) fail();
    if (state.version !== 1) return false; // Newer frames remain legacy-compatible.
    if (frameBytes(state) > MAX_BYTES || !integer(state.cols, 1, 400) || !integer(state.rows, 1, 200) || !names.includes(state.active) || !object(state.pen) || !object(state.buffers) || !object(state.charset)) fail();
    const pen = state.pen;
    if (!bits(pen.fg) || !bits(pen.bg) || !bits(pen.ext) || typeof pen.unresolved !== 'boolean') fail();
    for (const name of names) {
      const b = state.buffers[name];
      if (!object(b) || !integer(b.baseY, 0, MAX_LINES) || !integer(b.lineCount, 0, MAX_LINES) || !integer(b.currentX, 0, state.cols) || !integer(b.currentY, 0, 199) || !integer(b.x, 0, 400) || !integer(b.y, 0, MAX_LINES) || !bits(b.fg) || !bits(b.bg) || !map(b.charset)) fail();
      if (b.currentY >= state.rows || (b.lineCount ? b.lineCount < state.rows || b.baseY > b.lineCount - state.rows : b.baseY !== 0 || name === state.active)) fail();
    }
    const c = state.charset;
    if (!integer(c.glevel, 0, 3) || !Array.isArray(c.slots) || c.slots.length > 4 || !c.slots.every(map) || !map(c.current) || !map(c.legacySaved)) fail();
    const links = state.links ?? [];
    if (!Array.isArray(links) || links.length > MAX_LINES) fail();
    const identities = new Map();
    for (const link of [pen.link, ...links]) {
      if (link === null) continue;
      if ((link === pen.link && pen.unresolved) || !object(link) || !text(link.id) || !text(link.uri) || !Array.isArray(link.markers) || !link.markers.length || link.markers.length > MAX_LINES) fail();
      const seen = new Set();
      for (const marker of link.markers) {
        if (!object(marker) || !names.includes(marker.buffer) || !integer(marker.line, 0, state.buffers[marker.buffer].lineCount - 1)) fail();
        const key = marker.buffer + ':' + marker.line;
        if (seen.has(key)) fail();
        seen.add(key);
      }
      const identity = JSON.stringify([link.id, link.uri]), markers = [...seen].sort().join('|');
      if (identities.has(identity) && identities.get(identity) !== markers) fail();
      identities.set(identity, markers);
    }
    for (const name of names) {
      const b = state.buffers[name];
      if (b.repairRows === undefined) continue;
      if (!Array.isArray(b.repairRows) || b.repairRows.length !== b.lineCount) fail();
      for (const [y, row] of b.repairRows.entries()) {
        if (!object(row) || !integer(row.width, 1, 400) || typeof row.wrapped !== 'boolean' || !Array.isArray(row.cells) || row.cells.length > row.width) fail();
        let end = 0;
        for (const cell of row.cells) {
          if (!Array.isArray(cell) || cell.length !== 7) fail();
          const [x, chars, width, fg, bg, ext, link] = cell;
          if (!integer(x, end, row.width - 1) || typeof chars !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(chars) || !bits(fg) || !bits(bg) || !bits(ext) || !integer(link, -1, links.length - 1)) fail();
          if (link >= 0 && !links[link].markers.some(marker => marker.buffer === name && marker.line === y)) fail();
          if (width === 'r') {
            if (!/^[ -~]+$/.test(chars) || x + chars.length > row.width) fail();
            end = x + chars.length;
          } else {
            if (!integer(width, 0, 2)) fail();
            end = x + 1; // A clipped width-2 cell is intentionally representable.
          }
        }
      }
    }
    return true;
  }
  function coreOf(terminal) {
    const core = terminal?._core, buffers = core?._bufferService?.buffers;
    if (!core?._inputHandler?._curAttrData?.extended?.clone || !buffers?.normal || !buffers.alt || !core._charsetService || !core._oscLinkService?._dataByLinkId || !core._oscLinkService._entriesWithId || typeof core._oscLinkService._removeMarkerFromLink !== 'function') fail();
    for (const name of names) if (!Array.isArray(buffers[name].markers) || typeof buffers[name].addMarker !== 'function' || !buffers[name].savedCurAttrData) fail();
    return { core, buffers, service: core._oscLinkService };
  }
  function markerBuffer(buffers, marker) {
    return names.find(name => buffers[name].markers.includes(marker));
  }
  function capture(terminal, wireLink) {
    const { core, buffers, service } = coreOf(terminal), pen = core._inputHandler._curAttrData;
    const extended = pen.extended.clone(), sourceId = extended.urlId;
    extended.urlId = 0; // Read the raw style bits from a clone, without URL styling.
    const sourceLinks = new Map(), links = [];
    function captureLink(id) {
      const data = service.getLinkData(id);
      if (!data) return null;
      const entry = service._dataByLinkId.get(id), wire = wireLink(id, data);
      if (!entry || !Array.isArray(entry.lines)) fail();
      return { id: wire.id, uri: wire.uri, markers: entry.lines.map(marker => ({ buffer: markerBuffer(buffers, marker), line: marker.line })) };
    }
    const link = sourceId ? captureLink(sourceId) : null;
    let repairBytes = 0;
    function repairRows(name) {
      const api = terminal.buffer[name === 'normal' ? 'normal' : 'alternate'];
      let needed = false;
      for (let y = 0; y < api.length; y++) {
        const row = api.getLine(y);
        if (row.length !== terminal.cols || row.getCell(row.length - 1)?.getWidth() === 2) { needed = true; break; }
      }
      if (!needed) return undefined;
      // ANSI cannot express cells outside the current grid or a clipped wide
      // cell. Only those buffers need bounded rows in the SAME paired frame.
      const result = [];
      for (let y = 0; y < api.length; y++) {
        const row = api.getLine(y), cells = [];
        for (let x = 0; x < row.length; x++) {
          const cell = row.getCell(x), chars = cell.getChars(), width = cell.getWidth();
          const attr = cell.extended.clone(), id = cell.hasExtendedAttrs() ? attr.urlId : 0;
          attr.urlId = 0;
          let ref = -1;
          if (id) {
            if (!sourceLinks.has(id)) {
              const value = captureLink(id);
              sourceLinks.set(id, value ? links.push(value) - 1 : -1);
            }
            ref = sourceLinks.get(id);
          }
          if (!chars && width === 1 && !cell.fg && !cell.bg && !attr.ext && ref === -1) continue;
          const previous = cells[cells.length - 1];
          if (width === 1 && /^[ -~]$/.test(chars)) {
            if (previous?.[2] === 'r' && previous[0] + previous[1].length === x && previous[3] === cell.fg && previous[4] === cell.bg && previous[5] === attr.ext && previous[6] === ref) previous[1] += chars;
            else cells.push([x, chars, 'r', cell.fg, cell.bg, attr.ext, ref]);
          } else cells.push([x, chars, width, cell.fg, cell.bg, attr.ext, ref]);
        }
        const captured = { width: row.length, wrapped: row.isWrapped, cells };
        repairBytes += frameBytes(captured);
        if (repairBytes > MAX_BYTES) fail(); // No partially qualified repair rows.
        result.push(captured);
      }
      return result;
    }
    const state = {
      version: 1, cols: terminal.cols, rows: terminal.rows, active: terminal.buffer.active.type === 'alternate' ? 'alt' : 'normal',
      pen: { fg: pen.fg, bg: pen.bg, ext: extended.ext, link, unresolved: Boolean(sourceId && !link) },
      buffers: Object.fromEntries(names.map(name => {
        const b = buffers[name];
        return [name, { baseY: b.ybase, lineCount: b.lines.length, currentX: b.x, currentY: b.y, x: b.savedX, y: b.savedY, fg: b.savedCurAttrData.fg, bg: b.savedCurAttrData.bg, charset: copyMap(b.savedCharset), repairRows: repairRows(name) }];
      })),
      charset: { current: copyMap(core._charsetService.charset), glevel: core._charsetService.glevel,
        slots: Array.from(core._charsetService._charsets, copyMap), legacySaved: copyMap(core._inputHandler._savedCharset) },
    };
    if (links.length) state.links = links;
    validate(state);
    return state;
  }
  function restore(terminal, state) {
    if (!validate(state)) return false;
    const { core, buffers, service } = coreOf(terminal);
    if (terminal.cols !== state.cols || terminal.rows !== state.rows || (terminal.buffer.active.type === 'alternate' ? 'alt' : 'normal') !== state.active) fail();
    const Cell = terminal.buffer.normal.getNullCell().constructor;
    const blank = new Cell(); blank.setFromCharData([0, '', 1, 0]);
    const rebuilt = {};
    for (const name of names) {
      const b = buffers[name], saved = state.buffers[name];
      if (saved.repairRows) {
        if (saved.lineCount > b.lines.maxLength || typeof b.getBlankLine !== 'function') fail();
        rebuilt[name] = saved.repairRows.map(row => {
          const line = b.getBlankLine(blank, row.wrapped);
          line.resize(row.width, blank);
          return line;
        });
      } else if (b.ybase !== saved.baseY || b.lines.length !== saved.lineCount) fail();
    }
    for (const name of names) if (rebuilt[name]) {
      const b = buffers[name], saved = state.buffers[name], follow = b.ydisp === b.ybase;
      b.lines.length = rebuilt[name].length;
      rebuilt[name].forEach((line, y) => b.lines.set(y, line));
      b.ybase = saved.baseY; b.ydisp = follow ? b.ybase : Math.min(b.ydisp, b.ybase);
    }
    function resolveLink(link) {
      if (!link) return 0;
      // Resolve the exact wire pair already replayed by this SAME snapshot.
      // URI-only registration and source numeric IDs do not preserve grouping.
      let entry = service._entriesWithId.get(link.id + ';;' + link.uri);
      if (!entry) entry = service._dataByLinkId.get(service.registerLink({ id: link.id, uri: link.uri }));
      const keep = new Set();
      for (const ref of link.markers) {
        let marker = entry.lines.find(candidate => !candidate.isDisposed && candidate.line === ref.line && markerBuffer(buffers, candidate) === ref.buffer);
        if (!marker) {
          marker = buffers[ref.buffer].addMarker(ref.line);
          entry.lines.push(marker);
          marker.onDispose(() => service._removeMarkerFromLink(entry, marker));
        }
        keep.add(marker);
      }
      // Add source lifetime refs before removing replay/registration refs.
      for (const marker of [...entry.lines]) if (!keep.has(marker)) marker.dispose();
      return entry.id;
    }
    const linkIds = (state.links ?? []).map(resolveLink);
    for (const name of names) if (rebuilt[name]) {
      const cell = new Cell();
      state.buffers[name].repairRows.forEach((row, y) => {
        for (const [x, chars, width, fg, bg, ext, ref] of row.cells) {
          const values = width === 'r' ? [...chars] : [chars];
          values.forEach((value, i) => {
            cell.setFromCharData([0, value, width === 'r' ? 1 : width, 0]);
            const extended = cell.extended.clone(); extended.ext = ext; extended.urlId = linkIds[ref] ?? 0;
            cell.extended = extended; cell.fg = fg; cell.bg = bg;
            rebuilt[name][y].setCell(x + i, cell);
          });
        }
      });
    }
    const linkId = resolveLink(state.pen.link);
    const pen = core._inputHandler._curAttrData, extended = pen.extended.clone();
    extended.ext = state.pen.ext; extended.urlId = linkId;
    pen.extended = extended; pen.fg = state.pen.fg; pen.bg = state.pen.bg;
    // Do not call updateExtended(): a native cursor restore may intentionally
    // leave a raw link hidden until a later native SGR reactivates it.
    for (const name of names) {
      const b = buffers[name], saved = state.buffers[name];
      b.x = saved.currentX; b.y = saved.currentY;
      b.savedX = saved.x; b.savedY = saved.y;
      b.savedCurAttrData.fg = saved.fg; b.savedCurAttrData.bg = saved.bg;
      b.savedCharset = copyMap(saved.charset) ?? undefined;
    }
    core._charsetService._charsets = state.charset.slots.map(value => copyMap(value) ?? undefined);
    core._charsetService.glevel = state.charset.glevel;
    core._charsetService.charset = copyMap(state.charset.current) ?? undefined;
    core._inputHandler._savedCharset = copyMap(state.charset.legacySaved) ?? undefined;
    if (Object.keys(rebuilt).length) terminal.refresh?.(0, terminal.rows - 1);
    return true;
  }
  const api = Object.freeze({ MAX_BYTES, frameBytes, capture, validate, restore });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceTerminalContinuation = api;
})(globalThis);
