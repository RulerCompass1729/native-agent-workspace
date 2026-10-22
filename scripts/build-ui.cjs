// Assemble our DSH client plugin from local source and pinned terminal packages.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('app/renderer/index.html');
const body = html.split('<body>')[1].split('<script')[0];
const sidebarEnd = body.indexOf('</aside>') + '</aside>'.length;
const sidebar = body.slice(0, sidebarEnd);
const main = body.slice(sidebarEnd);
let css = read('app/renderer/styles.css');
// Keep the original palette declarations for both the standalone document and
// DSH surfaces. Foreground and background must follow the same theme snapshot.
const palette = css.match(/:root\{([^}]*)\}/)[1];
css = css.replace(/:root\{[^}]*\}/, '').replace(/body\{[^}]*\}/, '');
css = `.naw{${palette};font-size:14px;height:100%;min-height:0;overflow:hidden;${css}}\n.naw>.sidebar{width:100%;height:100%}.naw>main{height:100%}`;
const bootstrap = read('app/dsh/bootstrap.js');
const renderer = read('app/room-threads.js') + '\n' + read('app/approval-policy.js') + '\n' + ['fleet-observation.js', 'local-search.js', 'reading-list.js', 'search-view.js', 'renderer.js'].map(name => read(`app/renderer/${name}`)).join('\n');
const licensed = (name, entry) => `/*!\n${read(`node_modules/${name}/LICENSE`)}\n*/\n${read(`node_modules/${name}/${entry}`)}`;
const terminal = licensed('@xterm/xterm', 'lib/xterm.js') + '\n' + licensed('@xterm/addon-fit', 'lib/addon-fit.js');
const source = bootstrap
  .replace('/* SIDEBAR_TEMPLATE */', JSON.stringify(sidebar))
  .replace('/* MAIN_TEMPLATE */', JSON.stringify(main))
  .replace('/* LOCAL_STYLES */', JSON.stringify(css + '\n' + read('node_modules/@xterm/xterm/css/xterm.css')))
  .replace('/* WORKSPACE_VIEW */', renderer);
fs.writeFileSync(path.join(root, 'app/dsh/client.js'), terminal + '\n' + source);
console.log('Built DSH native-workspace client plugin');
