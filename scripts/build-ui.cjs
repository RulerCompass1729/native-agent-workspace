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
let css = read('app/renderer/styles.css') + '\n' + read('app/renderer/collaboration-overview.css') + '\n' + read('app/renderer/collaboration-panorama.css') + '\n' + read('app/renderer/sidebar-layout.css') + '\n' + read('app/renderer/native-images.css');
// Keep the original palette declarations for both the standalone document and
// DSH surfaces. Foreground and background must follow the same theme snapshot.
const palette = css.match(/:root\{([^}]*)\}/)[1];
css = css.replace(/:root\{[^}]*\}/, '').replace(/body\{[^}]*\}/, '');
css = `.naw{${palette};font-size:14px;height:100%;min-height:0;overflow:hidden;${css}}\n.naw>.sidebar{width:100%;height:100%}.naw>main{height:100%}`;
const bootstrap = read('app/dsh/bootstrap.js');
const renderer = read('app/collaboration-spaces.cjs') + '\n' + read('app/room-mention.js') + '\n' + read('app/native-usage.js') + '\n' + read('app/room-threads.js') + '\n' + read('app/approval-policy.js') + '\n' + ['sidebar-layout.js', 'fleet-observation.js', 'local-search.js', 'native-images.js', 'reading-list.js', 'search-view.js', 'session-composer.js', 'collaboration-overview.js', 'coordinator-context.js', 'collaboration-panorama.js', 'context-menu.js', 'renderer.js'].map(name => read(`app/renderer/${name}`)).join('\n');
const licensed = (name, entry) => `/*!\n${read(`node_modules/${name}/LICENSE`)}\n*/\n${read(`node_modules/${name}/${entry}`)}`;
// xterm 6.0 keeps wider alternate-screen backing cells when columns shrink.
// DomRendererRowFactory must stop at the active grid, including link-hover
// redraws. Keep those backing cells intact; only bound the bundled DOM painter.
// A retained double-width cell straddling the edge cannot be drawn completely.
let xterm = licensed('@xterm/xterm', 'lib/xterm.js');
if (JSON.parse(read('node_modules/@xterm/xterm/package.json')).version !== '6.0.0') throw Error('Requalify the terminal DOM column fix for this xterm version.');
// Returning to the same cell must resolve the current buffer's link. Leaving
// clears hover, but upstream keeps both the last cell and the old line cache.
const linkLeave = 'this._isMouseOut=!0,this._clearCurrentLink()';
if (xterm.split(linkLeave).length !== 2) throw Error('Requalify native link reentry for this terminal source.');
xterm = xterm.replace(linkLeave, 'this._isMouseOut=!0,this._lastBufferCell=void 0,this._activeLine=-1,this._clearCurrentLink()');
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
const terminal = xterm + '\n' + licensed('@xterm/addon-fit', 'lib/addon-fit.js');
const source = bootstrap
  .replace('/* SIDEBAR_TEMPLATE */', () => JSON.stringify(sidebar))
  .replace('/* MAIN_TEMPLATE */', () => JSON.stringify(main))
  .replace('/* LOCAL_STYLES */', () => JSON.stringify(css + '\n' + read('node_modules/@xterm/xterm/css/xterm.css')))
  .replace('/* WORKSPACE_VIEW */', () => renderer);
new (require('node:vm').Script)(terminal + '\n' + source, { filename: 'dsh/client.js' });
fs.writeFileSync(path.join(root, 'app/dsh/client.js'), terminal + '\n' + source);
console.log('Built DSH native-workspace client plugin');
