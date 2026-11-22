const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const profile = process.argv[2], daemon = path.resolve(__dirname, '../../daemon.cjs');
const localRequire = Module.createRequire(daemon), { Workspace } = localRequire('./workspace.cjs');
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...args) => mkdtemp(prefix === '/tmp/naw-service-' ? path.join(profile, 'socket-') : prefix, ...args);
class NoProvider {
  constructor() { this.binaries = {}; }
  async start() {}
  resolvePrograms() {}
  close() {}
  create() { throw Error('A snapshot test cannot launch a provider'); }
}
class SyntheticWorkspace extends Workspace {
  snapshot() { return { ...super.snapshot(), fixtureRevision: this.revision = (this.revision || 0) + 1 }; }
  constructor(...args) {
    super(...args);
    this.sessions.set('synthetic', { id: 'synthetic', provider: 'codex', cwd: profile, state: 'ended', name: 'Before',
      nativeId: 'synthetic-native', messages: Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: 'synthetic '.repeat(1000) })) });
  }
}
const worker = new Module(daemon);
worker.filename = daemon; worker.paths = Module._nodeModulePaths(path.dirname(daemon));
worker.require = name => name === './adapters.cjs' ? { NativeHost: NoProvider } : name === './workspace.cjs' ? { Workspace: SyntheticWorkspace } : localRequire(name);
const source = fs.readFileSync(daemon, 'utf8').replace("if (typeof module === 'undefined' || require.main === module)", 'if (true)');
worker._compile(source, daemon);
