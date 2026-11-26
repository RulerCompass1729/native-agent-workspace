#!/usr/bin/env node
'use strict';
// Local check of the sandbox NAW puts around pi (app/pi-tui.cjs sandboxProfile): no pi, no model, no
// network beyond this machine's loopback. Each probe runs a small command under the profile and expects
// a refusal, with a control that shows the same command works without it. No probe opens a window,
// sends an Apple Event or writes outside its own folders; a probe file or launchd job that appears
// anyway is removed. The launchd probe has no control: it would create a job outside the sandbox.
//   node scripts/pi-tui-sandbox-check.cjs [--work-parent <folder outside the temporary folders>]
// With --work-parent the working folder is made there, so the working-folder rule is tested on its own
// rather than through the temporary-folder rule.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const piTui = require('../app/pi-tui.cjs');

const results = [];
const home = os.homedir();
const tag = crypto.randomBytes(6).toString('hex');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function check(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--work-parent' && argv[index + 1] && path.isAbsolute(argv[index + 1])) {
      options.workParent = argv[++index];
    } else {
      throw Error('usage: pi-tui-sandbox-check.cjs [--work-parent <absolute folder>]');
    }
  }
  return options;
}

function run(profile, argv) {
  const command = profile ? [SANDBOX_EXEC, '-p', profile, ...argv] : argv;
  const done = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 15000 });
  return { status: done.status, signal: done.signal, out: `${done.stdout || ''}${done.stderr || ''}` };
}

// A node one-liner under the profile; it prints one word so no file content leaves the probe.
function nodeProbe(profile, source, ...args) {
  return run(profile, [process.execPath, '-e', source, ...args]);
}

const WRITE = `try { require('fs').writeFileSync(process.argv[1], 'probe'); console.log('written'); } catch (e) { console.log(e.code); }`;
const APPEND_OPEN = `try { require('fs').closeSync(require('fs').openSync(process.argv[1], 'a')); console.log('opened'); } catch (e) { console.log(e.code); }`;
const READ = `try { require('fs').readFileSync(process.argv[1]); console.log('read'); } catch (e) { console.log(e.code); }`;
const CONNECT = `const s = require('net').connect(Number(process.argv[1]), '127.0.0.1', () => { console.log('connected'); s.destroy(); }); s.on('error', e => console.log(e.code));`;
const LISTEN = `const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log('listening'); s.close(); }); s.on('error', e => console.log(e.code));`;
const LINK = `try { require('fs').linkSync(process.argv[1], process.argv[2]); console.log('linked'); } catch (e) { console.log(e.code); }`;
const UNLINK = `try { require('fs').unlinkSync(process.argv[1]); console.log('removed'); } catch (e) { console.log(e.code); }`;
const RENAME = `try { require('fs').renameSync(process.argv[1], process.argv[2]); console.log('renamed'); } catch (e) { console.log(e.code); }`;
// bootstrap_look_up is how a process reaches a macOS service by name.
const LOOKUP_SERVICE = [
  'import ctypes, sys',
  "libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
  "bootstrap = ctypes.c_uint.in_dll(libc, 'bootstrap_port')",
  'for name in sys.argv[1:]:',
  '    port = ctypes.c_uint(0)',
  '    found = libc.bootstrap_look_up(bootstrap, name.encode(), ctypes.byref(port)) == 0',
  "    print(name, 'found' if found else 'refused')",
].join('\n');
const SERVICES = ['com.apple.coreservices.launchservicesd', 'com.apple.nsurlsessiond', 'com.apple.lsd.mapdb', 'com.apple.lsd.open'];
const REACHABLE_SERVICE = 'com.apple.cfprefsd.daemon';
const LOOKUP = `require('dns').lookup('api.deepseek.com', (e, address) => console.log(e ? e.code : 'resolved'));`;

function removeIfThere(file) {
  try {
    if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function listen() {
  return new Promise(resolve => {
    const server = net.createServer(socket => socket.end());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function probeWrite(profile, label, file, expectWritten) {
  const inside = nodeProbe(profile, WRITE, file).out.trim();
  const stray = removeIfThere(file);
  if (expectWritten) {
    check(`write ${label}: allowed`, inside === 'written', inside);
  } else {
    check(`write ${label}: refused`, inside === 'EPERM' && !stray, inside);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-pi-sandbox-check-'));
  const workParent = options.workParent || dir;
  const work = fs.mkdtempSync(path.join(workParent, 'naw-pi-sandbox-work-'));
  const servers = [];
  try {
    const dataDir = path.join(dir, 'data', 'backends', 'abc');
    const where = piTui.paths(dataDir);
    for (const folder of [where.home, where.sessionDir, where.gateDir, where.root, path.join(path.dirname(dataDir), 'other')]) fs.mkdirSync(folder, { recursive: true });
    const proxy = await listen();
    const other = await listen();
    servers.push(proxy, other);
    const nonce = `naw-pi-${crypto.randomBytes(12).toString('hex')}`;
    const profile = piTui.sandboxProfile({ proxyPort: proxy.address().port, nonce, where, cwd: work });
    console.log(`working folder ${workParent === dir ? 'in the temporary folder' : 'outside the temporary folders'}`);

    // Writes pi needs.
    probeWrite(profile, 'in the working folder', path.join(work, `probe-${tag}`), true);
    probeWrite(profile, 'in pi\'s home', path.join(where.home, `probe-${tag}`), true);
    probeWrite(profile, 'in pi\'s sessions', path.join(where.sessionDir, `probe-${tag}`), true);

    // Writes a program outside the sandbox could later run or trust. Controls write the same synthetic files.
    for (const [label, file] of [
      ['in the NAW data folder', path.join(path.dirname(path.dirname(dataDir)), `runtime-locations-${tag}.json`)],
      ['in another backend', path.join(path.dirname(dataDir), 'other', `probe-${tag}`)],
      ['in the pi runtime', path.join(where.root, `probe-${tag}`)],
      ['in the tool gate\'s folder', path.join(where.gateDir, `probe-${tag}`)],
    ]) {
      const control = nodeProbe(null, WRITE, file).out.trim();
      removeIfThere(file);
      check(`control: write ${label} works without the sandbox`, control === 'written', control);
      probeWrite(profile, label, file, false);
    }

    // The tool gate pi loads at its next start: neither replaced, removed nor moved aside from the sandbox.
    fs.writeFileSync(where.gateFile, 'gate');
    const gateWrite = nodeProbe(profile, WRITE, where.gateFile).out.trim();
    const gateRemove = nodeProbe(profile, UNLINK, where.gateFile).out.trim();
    const moved = path.join(where.base, `gate-${tag}`);
    const gateMove = nodeProbe(profile, RENAME, where.gateDir, moved).out.trim();
    const kept = fs.existsSync(where.gateFile) && fs.readFileSync(where.gateFile, 'utf8') === 'gate' && !fs.existsSync(moved);
    check('replace the tool gate: refused', gateWrite === 'EPERM' && kept, gateWrite);
    check('remove the tool gate: refused', gateRemove === 'EPERM' && kept, gateRemove);
    check('move the tool gate\'s folder aside: refused', gateMove === 'EPERM' && kept, gateMove);
    if (fs.existsSync(moved)) fs.renameSync(moved, where.gateDir);

    // The person's launch agents, caches and shell startup files: the control only tests access, the probe
    // file name is unique and removed if it appears.
    for (const [label, folder] of [['in ~/Library/LaunchAgents', path.join(home, 'Library', 'LaunchAgents')], ['in ~/Library/Caches', path.join(home, 'Library', 'Caches')]]) {
      if (!fs.existsSync(folder)) {
        check(`${label}: folder exists for the probe`, false, 'missing');
        continue;
      }
      fs.accessSync(folder, fs.constants.W_OK);
      probeWrite(profile, label, path.join(folder, `naw-pi-probe-${tag}.plist`), false);
    }
    for (const name of ['.zshrc', '.zprofile', '.bash_profile', '.gitconfig']) {
      const file = path.join(home, name);
      if (!fs.existsSync(file)) continue;
      fs.accessSync(file, fs.constants.W_OK);
      const opened = nodeProbe(profile, APPEND_OPEN, file).out.trim();
      check(`open ~/${name} for writing: refused`, opened === 'EPERM', opened);
    }

    // Programs that hand work to processes outside the sandbox. Each command is harmless if it ran.
    const handOffs = [
      ['open', '/usr/bin/open', ['--help']],
      ['osascript', '/usr/bin/osascript', ['-e', 'return 1']],
      ['automator', '/usr/bin/automator', [path.join(work, `none-${tag}.workflow`)]],
      ['shortcuts', '/usr/bin/shortcuts', ['--help']],
      ['launchctl', '/bin/launchctl', ['version']],
    ];
    for (const [label, program, args] of handOffs) {
      const argv = [program, ...args];
      const control = run(null, argv);
      check(`control: ${label} runs without the sandbox`, !/not permitted/i.test(control.out) && control.status !== 126, `exit ${control.status}`);
      const inside = run(profile, ['/bin/sh', '-c', '"$@"', 'probe', ...argv]);
      check(`run ${label}: refused`, inside.status === 126 && /not permitted/i.test(inside.out), `exit ${inside.status}`);
    }

    // Hard links: a link where pi may write, to a file where it may not, would let it write there.
    const linked = path.join(path.dirname(path.dirname(dataDir)), `linked-${tag}.json`);
    fs.writeFileSync(linked, 'kept');
    for (const [label, folder] of [['into pi\'s home', where.home], ['into the working folder', work]]) {
      const link = path.join(folder, `link-${tag}`);
      const control = nodeProbe(null, LINK, linked, link).out.trim();
      removeIfThere(link);
      check(`control: hard link ${label} works without the sandbox`, control === 'linked', control);
      const inside = nodeProbe(profile, LINK, linked, link).out.trim();
      const stray = removeIfThere(link);
      check(`hard link ${label} to a file in the NAW data folder: refused`, inside === 'EPERM' && !stray && fs.readFileSync(linked, 'utf8') === 'kept', inside);
    }

    // macOS stops copies of these programs, sandbox or not, so a copy does not get past the rule above.
    for (const [label, from, args] of handOffs) {
      const copy = path.join(work, `${label}-${tag}`);
      fs.copyFileSync(from, copy);
      fs.chmodSync(copy, 0o755);
      const outside = run(null, [copy, ...args]);
      const inside = run(profile, [copy, ...args]);
      fs.unlinkSync(copy);
      check(`a copy of ${label} is stopped by macOS, with or without the sandbox`, outside.signal === 'SIGKILL' && inside.signal === 'SIGKILL', `${outside.signal || outside.status}/${inside.signal || inside.status}`);
    }

    // Each refused service on its own. The reachable one shows the lookup itself works in the sandbox.
    const python = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(file => fs.existsSync(file));
    if (!python) {
      check('service lookups: a python3 for the probe', false, 'none found');
    } else {
      const names = [...SERVICES, REACHABLE_SERVICE];
      const outside = run(null, [python, '-I', '-c', LOOKUP_SERVICE, ...names]).out.trim().split('\n');
      const inside = run(profile, [python, '-I', '-c', LOOKUP_SERVICE, ...names]).out.trim().split('\n');
      check('control: every service is found without the sandbox', names.every(name => outside.includes(`${name} found`)), outside.join(', '));
      for (const name of SERVICES) check(`look up ${name}: refused`, inside.includes(`${name} refused`));
      check(`control: ${REACHABLE_SERVICE} is found in the sandbox`, inside.includes(`${REACHABLE_SERVICE} found`));
    }

    // launchd: launchctl creates no job from the sandbox. This also holds without the profile's launchd
    // rule, so it shows the route is closed, not that the rule closes it.
    const label = `naw-pi-probe-${tag}`;
    const loose = profile.split('\n').filter(line => !line.startsWith('(deny process-exec')).join('\n');
    const submitted = run(loose, ['/bin/launchctl', 'submit', '-l', label, '--', '/usr/bin/true']);
    const listed = run(null, ['/bin/launchctl', 'list', label]).status === 0;
    if (listed) run(null, ['/bin/launchctl', 'remove', label]);
    check('launchctl submits no launchd job from the sandbox', submitted.status !== 0 && !listed, `exit ${submitted.status}`);

    // LaunchServices: lsappinfo asks the same service `open` would.
    const front = run(null, ['/usr/bin/lsappinfo', 'front']).out.trim();
    check('control: LaunchServices answers without the sandbox', /^ASN:/.test(front), front.slice(0, 12));
    const frontInside = run(profile, ['/usr/bin/lsappinfo', 'front']).out.trim();
    check('LaunchServices: refused', !/^ASN:/.test(frontInside), frontInside.slice(0, 12));

    // Network: only the proxy port, no listening, no name lookups.
    check('connect to the proxy port: allowed', nodeProbe(profile, CONNECT, String(proxy.address().port)).out.trim() === 'connected');
    check('control: another loopback port answers without the sandbox', nodeProbe(null, CONNECT, String(other.address().port)).out.trim() === 'connected');
    const otherInside = nodeProbe(profile, CONNECT, String(other.address().port)).out.trim();
    check('connect to another loopback port: refused', otherInside === 'EPERM', otherInside);
    const listening = nodeProbe(profile, LISTEN).out.trim();
    check('listen: refused', listening === 'EPERM', listening);
    const control = nodeProbe(null, LOOKUP).out.trim();
    check('control: name lookup works without the sandbox', control === 'resolved', control);
    const lookup = nodeProbe(profile, LOOKUP).out.trim();
    check('name lookup: refused', lookup !== 'resolved', lookup);

    // The person's agent homes and rule files. The control only checks that the file exists.
    for (const file of [path.join(home, 'CLAUDE.md'), path.join(home, '.claude', 'settings.json'), path.join(home, '.codex', 'config.toml')]) {
      if (!fs.existsSync(file)) continue;
      const read = nodeProbe(profile, READ, file).out.trim();
      check(`read ~/${path.relative(home, file)}: refused`, read === 'EPERM', read);
    }
  } finally {
    for (const server of servers) server.close();
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter(item => !item.passed);
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`pi-tui-sandbox-check: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
