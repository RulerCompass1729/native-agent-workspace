// The interface language a GUI test starts in (T-170). The scripts' expected text is Chinese, so the default is zh;
// NAW_TEST_UI_LANGUAGE=en or =system overrides it. A profile with no saved language follows the system language.
// test-scratch.cjs seeds fresh scratch profiles by the same rule; app/tests/gui-script-language.test.cjs checks that the
// two write the same row. Production code never imports this module.
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
function testLanguage(env = process.env) {
  const language = env.NAW_TEST_UI_LANGUAGE ?? 'zh';
  if (!['zh', 'en', 'system'].includes(language)) throw Error('Test UI language must be zh, en or system');
  return language;
}
const localeModule = () => require.resolve('@deepseek-ai/dsh-client-locale');
const localePatch = language => '- id: locale\n  name: ' + JSON.stringify(localeModule()) + '\n  config:\n    preference: ' + JSON.stringify(language) + '\n';
// A stable test profile is reused across runs, so test-scratch's "seed only a new profile" never applies to it. Pin it
// on every run instead: write the row when nothing is saved, keep a profile that already says the test language (read
// with the app's own reader), and refuse anything else rather than overwrite settings this helper did not write.
async function pinStableProfileLanguage(profile, env = process.env) {
  const language = testLanguage(env);
  if (language === 'system') return language;
  const dsh = path.join(profile, 'dsh'), file = path.join(dsh, 'cordis.patch.yml');
  let saved;
  try { saved = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved === undefined || saved.trim() === '[]') {
    fs.mkdirSync(dsh, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, localePatch(language), { mode: 0o600 });
    return language;
  }
  const { readLocaleProfile } = await import(pathToFileURL(path.join(__dirname, '../../app/ui-locale-profile.mjs')).href);
  const { preference } = await readLocaleProfile({ dataDir: dsh, localeModule: localeModule() });
  if (preference === language) return language;
  throw Error(`The test profile has its own saved interface settings (${file}, language ${preference ?? 'not set'}); ` +
    `set NAW_TEST_UI_LANGUAGE to match, reset that file, or use a fresh NAW_DOGFOOD_DIR`);
}
module.exports = { testLanguage, localePatch, pinStableProfileLanguage };
