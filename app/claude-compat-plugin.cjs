// NAW's Claude compatibility plugin for a retained session's folder. Claude
// loads it from <cwd>/.claude/skills, so the daemon also refreshes NAW's own
// byte-exact old copy before it starts Claude there (T-100).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// existingOnly: refresh a copy that is already there, as when NAW starts Claude
// in a folder that once hosted a retained session; never create one.
function installPlugin(cwd, { existingOnly = false } = {}) {
  let directory = cwd;
  for (const part of ['.claude', 'skills', 'native-workspace-compat']) {
    directory = path.join(directory, part);
    if (existingOnly && !fs.existsSync(directory)) return false;
    if (!existingOnly) try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('本地插件目录不可安全写入，原会话未改动。');
  }
  const files = new Map();
  for (const name of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js']) {
    let content = fs.readFileSync(path.join(__dirname, 'claude-bridge', name), 'utf8');
    if (name.endsWith('plugin.json')) content = JSON.stringify({ ...JSON.parse(content), name: 'native-workspace-compat' }, null, 2) + '\n';
    if (name.endsWith('register.js')) content = content.replace('const legacyOnly = false;', 'const legacyOnly = true;');
    files.set(name, content);
  }
  for (const part of ['.claude-plugin', 'hooks']) {
    const parent = path.join(directory, part);
    if (existingOnly && !fs.existsSync(parent)) return false;
    if (!existingOnly) try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('本地插件路径不安全，未写入插件文件。');
  }
  // Upgrade only our byte-exact previous hook. Edited copies remain untouched.
  const previousHooks = new Set(['c01128b905d1d2270fe511e6e0774737667ba2ff07c745f6887aaf3cf6912ec8','f4edcbf3e0dc27aface203fc3ce13888ec986562f58bce9e591cf71be6538aec','6fd9a5650c74e5ee1cbde98efdb6ba33bc83dae1eeacbef3e86c614aabca785a','ea38c6320e515aea2150db84e39bc2a817d57d68974661422e419617cdc14887','add32628c2d9b306efc391e28801aa3b339520451a659101d6a6689c6e688fb3','959ab599a77d3a69a06c388eafe77cdfb57666defacb568cba28be957dba40e0','ba3228157c0b6c0288c6df9f389c9624efde43535f1a6c2fb3600846064c7de8',
    'd86c8546f734b75620eea9fe1fbc80aa49092650da494d2d2cf73ba41a6f2453',
    '48b912ba8dd5df5e5609a32d4dbfb1a9f7894b51b50aa1f518a3a3da951f1190',
    '623b1ae035b00d8a0366d563945b98e6edf6486c9ca4a1977792506183fe7482',
    '0c04a03d3a7cb3c191405bd9637c218f7603aa6dfad6345741b5e39177ca8017',
    '4bc48cb24744f5f4795d16ad95f13ccfa0583baaf35941ba11f43fb8cbed6ee3',
    'dcbff5190245c72761ef3e0d110b8976f5f49740b0ef3a839654cdcb933764ba',
    '069c66cb4889031f0cc460dcbb75d0892cf41835c9bac02e9dbf796cd52c7a40',
    '6e72f7d5eade95e90e4667ed22888e7923d535b5e9620d26074bc01c2a8303d1',
    '0833cbf4165cc439bfdd04ff7e7676886f5e40d518c47cfda25ba62e3292009a',
    '79a701e38fa7ab32e0551c2aa6c364bf34cd4ccd5942ab5ae899463f7b355cc6',
    'dc1140fd7d19d57cafd7f8545be466efd177012960763a43c769b79a92229687',
    'a3462c9cb8bb11cdd6fdfb26baebf780bb9af9f7ef72535dd08bfa3f0ae7b359',
    '39a213b15740f1723dfb9886d709a1a4dd92a71e651a261d42ceac188e29f388',
    '22935561d72d25326d16fb150ac00210e9d6a3e05a9daec0dd3a5c209c075e72',
    '6924d98e28c3b7280d787f497806899f606a36ae5f07ce680471db74ff830650',
    'a882f1f1a9051e9789cc1d4e7fa18e4ae77e485ea4b42135d1c40e7bc5b90339',
    '797306a5985d1704bbb4621012af6147610b8bfb73e29be913daa786ca5a5569',
    '90e3355e6cce028caf9d62eb5c2039652067f041153ee3a935e09819b0b1a0f5',
    '2e8d7a39b4990be6e3a9e3f219d232c6e8a7d3531d66cb9adac5093565f612a1',
    '179b3fc6a479f10ab07e02a39cbbcbbcce0205ee99ad6c7f010b845c669e8f77',
    '07765664e4bf6aab7b41e034fa142e5988452cadbd6fe0e3c46b14fabe17066b',
    '276dbd818671f5c5a867a0a0e2a7bc7bddd1a153ef9ddc5f00d47b69030d1f9b',
    // Committed outputs missed when two hook changes shipped together; ccea1a6's
    // copy was still in the daily shared folder on 11-02 (T-100).
    '21747af95a28473c4e4427679368b71a5ad502a60af8057814994fdf157ce2c3',
    'f187117c765b290c78f8cf1e5d60e6bfdd7b51b1e43a4e06b1de567070ddc0d6',
    'ac4bb9518434cc4b278ce1eeee71a7e6c246b255b4fcada02a8fc0af116dfc56',
    '5de54527becca19aa455af4a8fcd1723c27c57242396d360af88eb654e271fa9',
    '0def028a251c2666ddca955669b7fbd19663892cea2a97b79290f259de14829f',
    'ca4b12df70df8c8de74a61e0ee2551cf7f9bdda6110ea95445140f502cbde399',
    '04c2ef659b098206e57ca1c5f47d98f277719ec3f7fdd0c4c2a4b517c313d979',
    'acbbe61d27693926e66d04579b8bf6c79114fdff6b68830aefde3b4f920fc3f8']);
  const upgrades = new Set();
  for (const [name, content] of files) {
    const filename = path.join(directory, name);
    if (!fs.existsSync(filename)) continue;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('已有同名插件内容不同，未覆盖；原会话继续保留。');
    const prior = fs.readFileSync(filename, 'utf8');
    if (prior === content) continue;
    if (name === 'hooks/register.js' && previousHooks.has(crypto.createHash('sha256').update(prior).digest('hex'))) upgrades.add(name);
    else throw Error('已有同名插件内容不同，未覆盖；原会话继续保留。');
  }
  for (const [name, content] of files) {
    const filename = path.join(directory, name);
    if (existingOnly && !fs.existsSync(filename)) continue;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, content, { mode: 0o600, flag: 'wx' });
    else if (upgrades.has(name)) {
      const temp = filename + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try { fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, filename); }
      finally { fs.rmSync(temp, { force: true }); }
    }
  }
  return true;
}
module.exports = { installPlugin };
