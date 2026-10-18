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
css = css.replace(/:root\{[^}]*\}/, '').replace(/body\{[^}]*\}/, '');
css = `.naw{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:var(--dsw-alias-label-primary,#232723);--border:var(--dsw-alias-border-l1,#e1e5dc);--muted:var(--dsw-alias-label-secondary,#777e73);--green:#365744;--soft:#eef2e9;height:100%;min-height:0;overflow:hidden;${css}}\n.naw>.sidebar{width:100%;height:100%}.naw>main{height:100%}.naw .message-body:has(.dsh-markdown){white-space:normal}`;
const bootstrap = read('app/dsh/bootstrap.js');
const renderer = read('app/renderer/renderer.js');
const licensed = (name, entry) => `/*!\n${read(`node_modules/${name}/LICENSE`)}\n*/\n${read(`node_modules/${name}/${entry}`)}`;
const terminal = licensed('@xterm/xterm', 'lib/xterm.js') + '\n' + licensed('@xterm/addon-fit', 'lib/addon-fit.js');
const source = bootstrap
  .replace('/* SIDEBAR_TEMPLATE */', JSON.stringify(sidebar))
  .replace('/* MAIN_TEMPLATE */', JSON.stringify(main))
  .replace('/* LOCAL_STYLES */', JSON.stringify(css + '\n' + read('node_modules/@xterm/xterm/css/xterm.css')))
  .replace('/* WORKSPACE_VIEW */', renderer);
fs.writeFileSync(path.join(root, 'app/dsh/client.js'), terminal + '\n' + source);
console.log('Built DSH native-workspace client plugin');
