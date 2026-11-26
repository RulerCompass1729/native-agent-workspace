#!/usr/bin/env node
'use strict';
// Installs NAW's pinned pi runtime, shared by every backend of one NAW data folder.
//   node scripts/install-pi-tui.cjs --data-dir <NAW data directory> [--cache <dir>] [--offline]
// - Exactly the committed lockfile (npm ci): every package is checked against
//   its recorded integrity, pi itself against the pinned sha512.
// - No install scripts, no audit/fund/update-notifier requests, and none of
//   the person's npm settings (an empty userconfig, the public registry).
// - Built in a staging folder and checked before it moves into place. An
//   existing runtime is never replaced or deleted; remove it yourself first.
// It touches neither a global `pi` nor ~/.pi.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const piTui = require('../app/pi-tui.cjs');

const SOURCE = path.join(__dirname, 'pi-tui-runtime');
const PI_LOCK_KEY = `node_modules/${piTui.PI_PACKAGE}`;

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

// The committed manifest and lock must name exactly the pinned version.
function checkLock() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package-lock.json'), 'utf8'));
  const wanted = { [piTui.PI_PACKAGE]: piTui.PI_VERSION };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(manifest.dependencies, wanted)) throw Error('runtime package.json does not name the pinned version');
  if (!same(lock.packages[''].dependencies, wanted)) throw Error('lockfile root does not name the pinned version');
  const pi = lock.packages[PI_LOCK_KEY];
  if (pi.version !== piTui.PI_VERSION || pi.integrity !== piTui.PI_INTEGRITY) throw Error('lockfile pi entry is not the pinned tarball');
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.inBundle) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) throw Error(`lockfile entry outside the public registry: ${key}`);
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw Error(`lockfile entry without sha512 integrity: ${key}`);
  }
}

async function install(options) {
  checkLock();
  const where = piTui.paths(options.dataDir);
  if (fs.existsSync(where.root)) {
    await piTui.verifyRuntime(options.dataDir);
    console.log(`already installed and verified: ${where.root}`);
    return;
  }
  fs.mkdirSync(where.runtimeBase, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(where.runtimeBase, '.staging-'));
  try {
    await build(options, staging, where);
  } finally {
    // Only the folder this run created (its exact path), with whatever is left in it.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function build(options, staging, where) {
  const root = path.join(staging, 'runtime');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.copyFileSync(path.join(SOURCE, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(SOURCE, 'package-lock.json'), path.join(root, 'package-lock.json'));
  // Empty user and global npm settings (npm refuses one file for both).
  const userconfig = path.join(staging, 'user.npmrc');
  const globalconfig = path.join(staging, 'global.npmrc');
  fs.writeFileSync(userconfig, '', { mode: 0o600 });
  fs.writeFileSync(globalconfig, '', { mode: 0o600 });
  const cache = options.cache || path.join(staging, 'npm-cache');
  const args = [
    'ci',
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
    HOME: staging,
    TMPDIR: staging,
    npm_config_globalconfig: globalconfig,
  };
  // From inside the folder: npm 11.20 with --prefix reads the folder's name as a missing dependency.
  execFileSync('npm', args, { cwd: root, stdio: 'inherit', env: environment });
  await piTui.verifyTree(root);
  fs.renameSync(root, where.root);
  await piTui.verifyRuntime(options.dataDir);
  console.log(`installed and verified: ${where.root}`);
}

if (require.main === module) {
  Promise.resolve()
    .then(() => install(parseArguments(process.argv.slice(2))))
    .catch(error => {
      console.error(`install-pi-tui: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { parseArguments, checkLock, install, SOURCE };
