const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const keys = ['claude', 'codex', 'python3'];
function readLocations(file = process.env.NAW_RUNTIME_CONFIG) {
  if (!file) return {};
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw Error('unsafe');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.entries(data).some(([key, value]) => !keys.includes(key) || typeof value !== 'string' || !path.isAbsolute(value))) throw Error('invalid');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw Error('自定义程序位置无法读取，请在设置中检查本机数据文件。'); }
}
function isExecutable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) return false;
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}
function setLocation(file, key, value) {
  if (!keys.includes(key) || (value !== null && !isExecutable(value))) throw Error('请选择可运行的原生程序文件，不是安装包、文件夹或应用图标。');
  const data = readLocations(file);
  if (value === null) delete data[key]; else data[key] = value;
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
module.exports = { readLocations, setLocation, isExecutable };
