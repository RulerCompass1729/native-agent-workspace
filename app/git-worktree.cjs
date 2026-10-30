const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const CAPABILITY = 'gitWorktreeV1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controls = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null',
  'core.sparseCheckout=false', 'core.sparseCheckoutCone=false', 'submodule.recurse=false',
  'protocol.allow=never', 'gc.auto=0', 'maintenance.auto=false'];
function failure(message) { return Object.assign(new Error(message), { code: 'NAW_GIT_WORKTREE' }); }
function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key)));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1' };
}
function available() {
  // Git has no provider-location setting; never read the person's native config.
  const candidates = [...(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(folder => path.join(folder, 'git')),
    '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
  return [...new Set(candidates)].find(file => {
    if (/(?:^|\/)Library\/(?:Group )?Containers(?:\/|$)/i.test(file)) return false;
    if (process.platform === 'darwin' && file === '/usr/bin/git' && !fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/git') && !fs.existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/git')) return false;
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
}
function exists(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function plainMetadata(file) {
  const resolved = path.resolve(file);
  if (/(?:^|\/)Library\/(?:Group )?Containers(?:\/|$)/i.test(resolved)) throw failure('Git 元数据指向应用容器，未读取或创建工作副本。');
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = exists(current);
    if (!stat || stat.isSymbolicLink()) throw failure('Git 元数据路径不可用或含链接，未创建工作副本。');
  }
  return resolved;
}
function smallFile(file, optional = false) {
  if (optional && !exists(file)) return '';
  plainMetadata(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 65536) throw failure('Git 元数据格式或大小不支持，未创建工作副本。');
  return fs.readFileSync(file, 'utf8');
}
function repository(selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.length > 4096 || /[\x00-\x1f\x7f]/.test(selected)) throw failure('请选择已有 Git 仓库。');
  if (/(?:^|\/)Library\/(?:Group )?Containers(?:\/|$)/i.test(path.resolve(selected))) throw failure('不自动访问应用容器。');
  let directory;
  try { directory = plainMetadata(selected); if (!fs.statSync(directory).isDirectory()) throw Error(); }
  catch { throw failure('所选路径含链接或不可用，未创建自动副本；请选择实际目录，或使用已有目录模式。'); }
  let root = directory, marker;
  while (!(marker = exists(path.join(root, '.git')))) {
    const parent = path.dirname(root);
    if (parent === root) throw failure('所选目录不在 Git 工作区内；可以直接使用已有目录。');
    root = parent;
  }
  if (root === path.parse(root).root || marker.isSymbolicLink()) throw failure('这个 Git 工作区路径暂不支持自动副本。');
  let gitDir = path.join(root, '.git');
  if (marker.isFile()) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(smallFile(gitDir));
    if (!match) throw failure('Git 工作区登记格式不支持。');
    gitDir = path.resolve(root, match[1]);
  } else if (!marker.isDirectory()) throw failure('Git 元数据不可用。');
  plainMetadata(gitDir);
  const commonFile = path.join(gitDir, 'commondir');
  const common = exists(commonFile) ? path.resolve(gitDir, smallFile(commonFile).trim()) : gitDir;
  plainMetadata(common);
  for (const file of [path.join(common, 'config'), path.join(gitDir, 'config.worktree')]) {
    const text = smallFile(file, true);
    if (/^\s*\[\s*include(?:if)?(?:\s|\])/im.test(text)) throw failure('仓库含外部 Git 配置引用，暂不自动创建副本；未读取引用文件。');
  }
  if (smallFile(path.join(common, 'objects/info/alternates'), true).trim()) throw failure('仓库借用了外部对象目录，暂不自动创建副本。');
  const attributes = path.join(common, 'info/attributes');
  if (exists(attributes)) smallFile(attributes);
  const packs = path.join(common, 'objects/pack');
  if (exists(packs)) {
    plainMetadata(packs);
    if (fs.readdirSync(packs).some(name => name.endsWith('.promisor'))) throw failure('部分克隆仓库暂不自动创建工作副本，不会联网补取内容。');
  }
  return { root, directory, gitDir, common, filters: [] };
}
function run(repo, args, { missing = false, timeout = 10000, environment = {}, workTree = true } = {}) {
  const binary = available();
  if (!binary) return Promise.reject(failure('没有可用 Git；请安装 Git 后再选择工作副本。'));
  const overrides = [...controls];
  for (const driver of repo.filters) for (const field of ['process', 'smudge', 'clean', 'required']) overrides.push(`filter.${driver}.${field}=${field === 'required' ? 'false' : ''}`);
  const argv = ['--no-pager', '--no-optional-locks', `--git-dir=${repo.gitDir}`, ...(workTree ? [`--work-tree=${repo.root}`] : []),
    ...overrides.flatMap(value => ['-c', value]), ...args];
  return new Promise((resolve, reject) => {
    execFile(binary, argv, { cwd: repo.root, env: { ...gitEnvironment(), ...environment }, encoding: 'utf8', timeout,
      maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve(stdout.trimEnd());
      if (missing && error.code === 1) return resolve('');
      reject(failure(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git 准备输出超出限制，未重试；已登记的分支和路径保留。'
        : error.killed ? 'Git 准备超时，未重试；已登记的分支和路径保留。' : 'Git 未能完成准备；请检查仓库、磁盘空间或路径占用，未自动重试。'));
    });
  });
}
async function inspect(selected) {
  const repo = repository(selected);
  const partial = await run(repo, ['config', '--get', 'extensions.partialClone'], { missing: true });
  const promisors = await run(repo, ['config', '--type=bool', '--get-regexp', '^remote\..*\.promisor$'], { missing: true });
  if (partial || promisors.split('\n').some(line => /\s+true$/i.test(line))) throw failure('部分克隆仓库暂不自动创建工作副本，不会联网补取内容。');
  const keys = await run(repo, ['config', '--null', '--name-only', '--get-regexp', '^filter\..*\.(process|smudge|clean|required)$'], { missing: true });
  for (const key of keys.split('\0').filter(Boolean)) {
    const driver = key.slice(7, key.lastIndexOf('.'));
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(driver)) throw failure('仓库过滤器名称暂不支持安全准备，未创建工作副本。');
    if (!repo.filters.includes(driver)) repo.filters.push(driver);
  }
  repo.revision = await run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { missing: true });
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(repo.revision)) throw failure('仓库需要先有一个本机提交；未创建工作副本。');
  return repo;
}
function relativePath(value = '') {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f\\]/.test(value) || path.isAbsolute(value)) throw failure('子目录请从新副本根目录填写相对路径。');
  if (!value || value === '.') return '';
  const normalized = value.replace(/\/+$/, '');
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw failure('子目录不能离开新副本根目录。');
  return normalized;
}
function destination(repo, nonce, relative) {
  if (typeof nonce !== 'string' || !UUID.test(nonce)) throw failure('工作副本预览已变化，请重新选择。');
  const parent = `${repo.root}-lanes`, stat = exists(parent);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw failure('副本存放位置不是普通目录，未创建工作副本。');
  const target = path.join(parent, nonce);
  if (exists(target)) throw failure('工作副本路径已存在，未覆盖或重复创建。');
  return { source: repo.directory, repository: repo.root, revision: repo.revision,
    nonce, branch: `naw/session-${nonce}`, target, relativeDirectory: relative, cwd: path.join(target, relative) };
}
async function preview(selected, nonce, relative = '') {
  const repo = await inspect(selected), child = relativePath(relative), plan = destination(repo, nonce, child);
  if (child && await run(repo, ['cat-file', '-t', `${repo.revision}:${child}`]) !== 'tree') throw failure('子目录不在这个已提交快照中，请从新副本根目录重新选择。');
  if (await run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`], { missing: true })) throw failure('工作副本分支已存在，未覆盖或重复创建。');
  return plan;
}
function planShape(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      Object.keys(plan).sort().join(',') !== 'branch,cwd,nonce,relativeDirectory,repository,revision,source,target' ||
      Object.values(plan).some(value => typeof value !== 'string' || value.length > 4096)) throw failure('工作副本计划无效，请重新预览。');
}
async function validate(plan) {
  planShape(plan);
  const fresh = await preview(plan.source, plan.nonce, plan.relativeDirectory);
  if (Object.keys(fresh).some(key => fresh[key] !== plan[key])) throw failure('仓库或工作副本计划已变化，请重新预览；未创建副本。');
  return fresh;
}
async function checkout(copy, plan) {
  // Checkout reads objects, but never the original repository's mutable config.
  // A late filter/include added there must not become an executable here.
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-git-checkout-')));
  const identity = fs.lstatSync(temporary), isolated = { root: plan.target, gitDir: temporary, filters: [] };
  try {
    await run(isolated, ['init', '--bare', '--template=', `--object-format=${plan.revision.length === 64 ? 'sha256' : 'sha1'}`, temporary], { workTree: false });
    const environment = { GIT_OBJECT_DIRECTORY: plainMetadata(path.join(copy.common, 'objects')) };
    await run(isolated, ['read-tree', plan.revision], { environment });
    // No force: preserve files written by a person during the awaited work.
    await run(isolated, ['checkout-index', '--all'], { environment, timeout: 60000 });
    fs.copyFileSync(path.join(temporary, 'index'), path.join(copy.gitDir, 'index'), fs.constants.COPYFILE_EXCL);
  } finally {
    const current = exists(temporary);
    if (current && (current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev)) throw failure('临时 Git 元数据身份已变化，未清理或启动原生会话。');
    if (current) fs.rmSync(temporary, { recursive: true }); // Only our exclusive temporary metadata, never worktree files.
  }
}
async function prepare(plan) {
  await validate(plan);
  const repo = await inspect(plan.source);
  if (repo.revision !== plan.revision || repo.root !== plan.repository) throw failure('仓库已变化，未创建副本。');
  const parent = path.dirname(plan.target);
  if (!exists(parent)) { try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw failure('副本存放位置已变化，未创建副本。');
  // Exclusive creation reserves only this path. Never remove or reuse work.
  try { fs.mkdirSync(plan.target, { mode: 0o700 }); }
  catch { throw failure('工作副本路径已存在或不可写，未覆盖、删除或重试。'); }
  await run(repo, ['worktree', 'add', '--no-checkout', '--no-guess-remote', '--no-track', '-b', plan.branch, plan.target, plan.revision], { timeout: 30000 });
  // The common config can change while worktree registration is awaited.
  // Re-read the copy's actual config before checkout, not the earlier list.
  const copy = await inspect(plan.target);
  if (copy.revision !== plan.revision) throw failure('副本提交已变化，未开始检出；登记的分支和路径保留。');
  await checkout(copy, plan);
  let cwd;
  try { cwd = fs.realpathSync(plan.cwd); }
  catch { throw failure('副本内子目录不可用；分支和完整路径保留，未启动原生会话。'); }
  if ((cwd !== plan.target && !cwd.startsWith(plan.target + path.sep)) || !fs.statSync(cwd).isDirectory()) throw failure('子目录离开了新副本，未启动原生会话；分支和路径保留。');
  return cwd;
}
module.exports = { CAPABILITY, available, preview, validate, prepare };
