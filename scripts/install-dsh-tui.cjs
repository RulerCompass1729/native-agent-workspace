#!/usr/bin/env node
'use strict';
// Installs NAW's pinned DSH TUI runtime into <data-dir>/dsh-tui/runtime.
//   node scripts/install-dsh-tui.cjs --data-dir <NAW data directory> [--cache <dir>] [--offline]
// - Exactly the committed lockfile (npm ci): every package is checked against
//   its recorded integrity, the TUI tarball against the pinned sha512.
// - No install scripts, no audit/fund/update-notifier requests, and none of
//   the person's npm settings (an empty userconfig, the public registry).
// - Built in a staging folder and checked (versions, one DeepSeek LLM copy,
//   the digests of the two files NAW patches) before it moves into place.
//   An existing runtime is never replaced or deleted; remove it yourself first.
// It touches neither the person's global `dsh` nor ~/.dsh.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dshTui = require('../app/dsh-tui.cjs');

const SOURCE = path.join(__dirname, 'dsh-tui-runtime');
const TUI_LOCK_KEY = `node_modules/${dshTui.TUI_PACKAGE}`;
const DSH_LOCK_KEY = `node_modules/${dshTui.DSH_PACKAGE}`;

function parseArguments(argv) {
  const options = { dataDir: null, cache: null, offline: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--data-dir') {
      index++;
      options.dataDir = argv[index];
    } else if (argument === '--cache') {
      index++;
      options.cache = argv[index];
    } else if (argument === '--offline') {
      options.offline = true;
    } else {
      throw Error(`unknown argument: ${argument}`);
    }
  }
  if (typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir)) throw Error('--data-dir must be an absolute path');
  if (options.cache !== null && !path.isAbsolute(options.cache)) throw Error('--cache must be an absolute path');
  return options;
}

// The committed manifest and lock must name exactly the pinned versions.
function checkLock() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package-lock.json'), 'utf8'));
  const wanted = { [dshTui.DSH_PACKAGE]: dshTui.DSH_VERSION, [dshTui.TUI_PACKAGE]: dshTui.TUI_VERSION };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(manifest.dependencies, wanted)) throw Error('runtime package.json does not name the pinned versions');
  if (!same(lock.packages[''].dependencies, wanted)) throw Error('lockfile root does not name the pinned versions');
  const tui = lock.packages[TUI_LOCK_KEY];
  if (tui.version !== dshTui.TUI_VERSION || tui.integrity !== dshTui.TUI_INTEGRITY) throw Error('lockfile TUI entry is not the pinned tarball');
  if (lock.packages[DSH_LOCK_KEY].version !== dshTui.DSH_VERSION) throw Error('lockfile DSH entry is not the pinned version');
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.inBundle) continue;
    if (entry.resolved === undefined && key.startsWith(`${TUI_LOCK_KEY}/node_modules/`)) continue; // bundled in the TUI tarball
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) throw Error(`lockfile entry outside the public registry: ${key}`);
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw Error(`lockfile entry without sha512 integrity: ${key}`);
  }
}

function install(options) {
  checkLock();
  const where = dshTui.paths(options.dataDir);
  if (fs.existsSync(where.root)) {
    dshTui.verifyRuntime(options.dataDir);
    console.log(`already installed and verified: ${where.root}`);
    return;
  }
  const stagingData = fs.mkdtempSync(path.join(options.dataDir, '.dsh-tui-staging-'));
  try {
    build(options, stagingData, where);
  } finally {
    // Only the folder this run created (its exact path), with whatever is left in it.
    fs.rmSync(stagingData, { recursive: true, force: true });
  }
}

function build(options, stagingData, where) {
  const staging = dshTui.paths(stagingData);
  fs.mkdirSync(staging.root, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(SOURCE, 'package.json'), path.join(staging.root, 'package.json'));
  fs.copyFileSync(path.join(SOURCE, 'package-lock.json'), path.join(staging.root, 'package-lock.json'));
  // Empty user and global npm settings (npm refuses one file for both).
  const userconfig = path.join(stagingData, 'user.npmrc');
  const globalconfig = path.join(stagingData, 'global.npmrc');
  fs.writeFileSync(userconfig, '', { mode: 0o600 });
  fs.writeFileSync(globalconfig, '', { mode: 0o600 });
  const cache = options.cache || path.join(stagingData, 'npm-cache');
  const args = [
    'ci',
    '--prefix', staging.root,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '--registry', 'https://registry.npmjs.org/',
    '--userconfig', userconfig,
    '--cache', cache,
  ];
  if (options.offline) args.push('--offline');
  const environment = {
    PATH: process.env.PATH,
    HOME: stagingData,
    TMPDIR: stagingData,
    npm_config_globalconfig: globalconfig,
  };
  execFileSync('npm', args, { stdio: 'inherit', env: environment });
  dshTui.verifyRuntime(stagingData);
  fs.mkdirSync(where.base, { recursive: true, mode: 0o700 });
  fs.renameSync(staging.root, where.root);
  dshTui.verifyRuntime(options.dataDir);
  console.log(`installed and verified: ${where.root}`);
}

if (require.main === module) {
  try {
    install(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`install-dsh-tui: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { parseArguments, checkLock, install, SOURCE };
