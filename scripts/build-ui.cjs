// Assemble our DSH client plugin from local source and pinned terminal packages.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
// Runtime retains the stock serializer on an unqualified pin; builds must fail.
if (JSON.parse(read('node_modules/@xterm/headless/package.json')).version !== '6.0.0' ||
    JSON.parse(read('node_modules/@xterm/addon-serialize/package.json')).version !== '0.14.0' ||
    require('node:crypto').createHash('sha256').update(read('node_modules/@xterm/addon-serialize/lib/addon-serialize.js')).digest('hex') !== '65d8dd7c2b3b37a77f583ea5e0d14a23bbcc846e4ae0d6bb534ae12a380aea0d') throw Error('Requalify native hyperlink snapshots for this terminal serializer.');
const html = read('app/renderer/index.html');
const body = html.split('<body>')[1].split('<script')[0];
const sidebarEnd = body.indexOf('</aside>') + '</aside>'.length;
const sidebar = body.slice(0, sidebarEnd);
const main = body.slice(sidebarEnd);
let css = read('app/renderer/styles.css') + '\n' + read('app/renderer/regular-popup.css') + '\n' + read('app/renderer/collaboration-overview.css') + '\n' + read('app/renderer/task-board.css') + '\n' + read('app/renderer/collaboration-panorama.css') + '\n' + read('app/renderer/sidebar-layout.css') + '\n' + read('app/renderer/native-images.css') + '\n' + read('app/renderer/butler-review.css') + '\n' + read('app/renderer/sidebar-look.css') + '\n' + read('app/renderer/sidebar-hierarchy.css') + '\n' + read('app/renderer/activity-stream.css') + '\n' + read('app/renderer/sidebar-hover-card.css') + '\n' + read('app/renderer/speech-stream.css') + '\n' + read('app/renderer/space-feed.css') + '\n' + read('app/renderer/agent-distribution.css');
// Keep the original palette declarations for both the standalone document and
// DSH surfaces. Foreground and background must follow the same theme snapshot.
const palette = css.match(/:root\{([^}]*)\}/)[1];
css = css.replace(/:root\{[^}]*\}/, '').replace(/body\{[^}]*\}/, '');
css = `.naw{${palette};font-size:14px;height:100%;min-height:0;overflow:hidden;${css}}\n.naw>.sidebar{width:100%;height:100%}.naw>main{height:100%}`;
// DSH lays its bottom slot (shell.bottom, where a panel plugin the person installs
// sits) under all three columns, and the columns shrink by its height: an expanded
// panel squeezed NAW's session list to a sliver. Keep the sidebar column full height
// and lay the bottom slot under the columns to its right, as an editor's bottom panel
// sits beside its navigator. With no occupant the slot is 0px tall and nothing moves.
const frame = read('node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js');
if (frame.split('grid-template-rows:minmax(0,1fr) auto;').length !== 2 || !/_bottomRow\{[^}]*grid-column:1\/-1;/.test(frame) || frame.split('"data-shell-bottom": true').length !== 2) throw Error('Pinned DSH frame changed; requalify the full-height sidebar beside the bottom slot.');
// Match the same fixed shell nodes with the original specificity, without
// making terminal/text mutations invalidate ancestors through a broad :has.
css += '\n:root [data-naw-shell-frame] > [data-naw-shell-sidebar]{grid-row:1/-1}:root [data-naw-shell-frame] > [data-shell-bottom]{grid-column:2/-1}';
// The local page tab strip sits above both .naw slots, outside the nesting, so it carries its own palette.
css += `\n#window-tabs{${palette}}\n` + read('app/renderer/window-tabs.css');
const bootstrap = read('app/dsh/bootstrap.js');
const renderer = read('app/collaboration-spaces.cjs') + '\n' + read('app/room-mention.js') + '\n' + read('app/native-usage.js') + '\n' + read('app/room-threads.js') + '\n' + read('app/approval-policy.js') + '\n' + read('app/terminal-continuation.js') + '\n' + read('app/butler-entry-view.js') + '\n' + read('app/butler-reads-view.js') + '\n' + read('app/butler-review-policy.js') + '\n' + read('app/task-stream.js') + '\n' + read('app/mobile-identity.js') + '\n' + ['butler-review-model.js', 'butler-review-adapter.js', 'butler-review.js', 'sidebar-layout.js', 'fleet-observation.js', 'local-search.js', 'cmd-links.js', 'native-images.js', 'reading-list.js', 'search-view.js', 'session-composer.js', 'collaboration-overview.js', 'coordinator-context.js', 'collaboration-panorama.js', 'context-menu.js', 'mobile-setup.js', 'butler-entry.js', 'butler-reads.js', 'disclosure-list.js', 'record-reminders.js', 'task-board.js', 'regular-popup.js', 'steward-record.js', 'model-dialog.js', 'handoff-queue.js', 'confirmation-batch.js', 'window-tabs.js', 'session-timers.js', 'speech-stream.js', 'space-feed.js', 'resume-all.js', 'activity-stream.js', 'sidebar-hover-card.js', 'agent-distribution.js', 'renderer.js'].map(name => read(`app/renderer/${name}`)).join('\n');
const licensed = (name, entry) => `/*!\n${read(`node_modules/${name}/LICENSE`)}\n*/\n${read(`node_modules/${name}/${entry}`)}`;
// xterm 6.0 keeps wider alternate-screen backing cells when columns shrink.
// DomRendererRowFactory must stop at the active grid, including link-hover
// redraws. Keep those backing cells intact; only bound the bundled DOM painter.
// A retained double-width cell straddling the edge cannot be drawn completely.
let xterm = licensed('@xterm/xterm', 'lib/xterm.js');
if (JSON.parse(read('node_modules/@xterm/xterm/package.json')).version !== '6.0.0') throw Error('Requalify the terminal DOM column fix for this xterm version.');
// Flush the native OSC8 run with an empty end-of-line sentinel. Upstream's
// early continue skips a link that starts on the final trimmed cell, including
// a different link immediately after another. Do not change URI policy.
for (const [before, after] of [
  ['for(let t=0;t<a;t++)if(-1!==c||i.hasContent(t)){if(i.loadCell(t,o),', 'for(let t=0;t<=a;t++)if(-1!==c||t<a&&i.hasContent(t)){if(t===a)d=!0;else if(i.loadCell(t,o),'],
  ['if(d||-1!==c&&t===a-1){const i=this._oscLinkService.getLinkData(h)?.uri;', 'if(d){const i=this._oscLinkService.getLinkData(h)?.uri;'],
  ['d=!1,o.hasExtendedAttrs()&&o.extended.urlId?(c=t,h=o.extended.urlId)', 'd=!1,t<a&&o.hasExtendedAttrs()&&o.extended.urlId?(c=t,h=o.extended.urlId)'],
]) {
  if (xterm.split(before).length !== 2) throw Error('Pinned native link provider changed; requalify end-of-line links.');
  xterm = xterm.replace(before, after);
}
// Returning to the same cell must resolve the current buffer's link. Leaving
// clears hover, but upstream keeps both the last cell and the old line cache.
const linkLeave = 'this._isMouseOut=!0,this._clearCurrentLink()';
if (xterm.split(linkLeave).length !== 2) throw Error('Requalify native link reentry for this terminal source.');
xterm = xterm.replace(linkLeave, 'this._isMouseOut=!0,this._lastBufferCell=void 0,this._activeLine=-1,this._clearCurrentLink()');
// Cached row replies also survive a gap hover. Keep the existing render
// callback for the Linkifier lifetime so output refreshes the current target
// even while no link is hovered. There is still one render listener per pane.
const cachedLinkRender = 'this._linkCacheDisposables.push(this._renderService.onRenderedViewportChange((e=>{if(!this._currentLink)return;const t=0===e.start?0:e.start+1+this._bufferService.buffer.ydisp,i=this._bufferService.buffer.ydisp+1+e.end;if(this._currentLink.link.range.start.y>=t&&this._currentLink.link.range.end.y<=i&&(this._clearCurrentLink(t,i),this._lastMouseEvent)){const e=this._positionFromMouseEvent(this._lastMouseEvent,this._element,this._mouseService);e&&this._askForLink(e,!1)}})))';
const linkResizeRegistration = 'this._register(this._bufferService.onResize((()=>{this._clearCurrentLink(),this._wasResized=!0})))';
const liveLinkRender = `this._register(this._renderService.onRenderedViewportChange(event => {
  const start = event.start === 0 ? 0 : event.start + 1 + this._bufferService.buffer.ydisp;
  const end = this._bufferService.buffer.ydisp + 1 + event.end;
  const overlaps = link => link.range.start.y <= end && link.range.end.y >= start;
  const cachedOverlap = [...(this._activeProviderReplies?.values() || [])].some(reply => reply?.some(value => overlaps(value.link)));
  if (!(this._activeLine >= start && this._activeLine <= end) && !cachedOverlap && !(this._currentLink && overlaps(this._currentLink.link))) return;
  this._lastBufferCell = undefined;
  this._activeLine = -1;
  this._clearCurrentLink();
  if (this._isMouseOut || !this._lastMouseEvent) return;
  const position = this._positionFromMouseEvent(this._lastMouseEvent, this._element, this._mouseService);
  if (position) this._askForLink(position, false);
}))`;
for (const marker of [cachedLinkRender, linkResizeRegistration]) {
  if (xterm.split(marker).length !== 2) throw Error('Pinned terminal link lifecycle changed; requalify live link refresh.');
}
xterm = xterm.replace(cachedLinkRender, 'void 0').replace(linkResizeRegistration, linkResizeRegistration + ',' + liveLinkRender);
const columnFix = [
  ['createRow(e,t,i,s,r,a,l,c,u,f,g){', 'createRow(e,t,i,s,r,a,l,c,u,f,g,nawColumns=Infinity){'],
  ['let b,C=e.getNoBgTrimmedLength();', 'let b,C=Math.min(e.getNoBgTrimmedLength(),nawColumns);'],
  ['const W=this._isCellInSelection(x,t),H=i&&x===a,K=P&&x>=f&&x<=g;', 'if(x+C>nawColumns)continue;const W=this._isCellInSelection(x,t),H=i&&x===a,K=P&&x>=f&&x<=g;'],
  ['this._rowFactory.createRow(h,e,e===s,o,a,r,n,this.dimensions.css.cell.width,this._widthCache,-1,-1)', 'this._rowFactory.createRow(h,e,e===s,o,a,r,n,this.dimensions.css.cell.width,this._widthCache,-1,-1,this._bufferService.cols)'],
  ['this._rowFactory.createRow(p,_,_===l,d,u,h,c,this.dimensions.css.cell.width,this._widthCache,n?o===i?e:0:-1,n?(o===s?t:r)-1:-1)', 'this._rowFactory.createRow(p,_,_===l,d,u,h,c,this.dimensions.css.cell.width,this._widthCache,n?o===i?e:0:-1,n?(o===s?t:r)-1:-1,this._bufferService.cols)'],
  // Link hover and leave must keep native cursor overrides, as ordinary rows do.
  ['c=this._optionsService.rawOptions.cursorBlink,d=this._optionsService.rawOptions.cursorStyle,', 'c=this._coreService.decPrivateModes.cursorBlink??this._optionsService.rawOptions.cursorBlink,d=this._coreService.decPrivateModes.cursorStyle??this._optionsService.rawOptions.cursorStyle,'],
];
for (const [before, after] of columnFix) {
  if (xterm.split(before).length !== 2) throw Error('Pinned terminal DOM source changed; requalify the column fix.');
  xterm = xterm.replace(before, after);
}
// The legacy viewport fills the fit remainder below the newer scrolling layer.
// Reuse the same theme update so palette and native OSC backgrounds both apply.
const viewportBackground = 'this._scrollableElement.getDomNode().style.backgroundColor=n.colors.background.css';
if (xterm.split(viewportBackground).length !== 2) throw Error('Pinned terminal viewport source changed; requalify background coverage.');
xterm = xterm.replace(viewportBackground, viewportBackground + ',e.querySelector(".xterm-viewport").style.backgroundColor=n.colors.background.css');
const localeSource = read('app/ui-messages.js') + '\n' + read('app/ui-locale.js');
const terminal = xterm + '\n' + licensed('@xterm/addon-fit', 'lib/addon-fit.js');
const source = bootstrap
  .replace('/* SIDEBAR_TEMPLATE */', () => JSON.stringify(sidebar))
  .replace('/* MAIN_TEMPLATE */', () => JSON.stringify(main))
  .replace('/* LOCAL_STYLES */', () => JSON.stringify(css + '\n' + read('node_modules/@xterm/xterm/css/xterm.css')))
  .replace('/* WORKSPACE_VIEW */', () => renderer);
new (require('node:vm').Script)(terminal + '\n' + localeSource + '\n' + source, { filename: 'dsh/client.js' });
fs.writeFileSync(path.join(root, 'app/dsh/client.js'), terminal + '\n' + localeSource + '\n' + source);
console.log('Built DSH native-workspace client plugin');
