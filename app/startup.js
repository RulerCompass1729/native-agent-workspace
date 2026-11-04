const title = document.getElementById('title'), detail = document.getElementById('detail'), retry = document.getElementById('retry'), data = document.getElementById('data');
const locale = window.nativeWorkspaceLocale;
let languageSnapshot = window.__DSH_LOCALE__?.bootstrap || { languages: [], preference: null };
let status = { kind: 'opening', retry: false, data: false };
function renderStartup() {
  const language = languageSnapshot.startupLanguage || locale.language(languageSnapshot);
  const text = key => locale.format(language, key);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  title.textContent = text(status.kind === 'failed' ? 'startup.failed' : 'startup.opening');
  detail.textContent = status.kind === 'failed' ? locale.startupMessage(language, status.code) : text('startup.connecting');
  retry.textContent = text('common.retry'); data.textContent = text('startup.data');
  retry.hidden = !status.retry; data.hidden = !status.data;
}
window.workspace.onLocale(value => { if (locale.validSnapshot(value)) { languageSnapshot = { ...locale.snapshot(value, languageSnapshot), startupLanguage: value.preference === null && ['zh', 'en'].includes(value.startupLanguage) ? value.startupLanguage : undefined }; renderStartup(); } });
window.workspace.onStartup(value => { status = value; retry.disabled = false; renderStartup(); });
renderStartup();
retry.onclick = () => { retry.disabled = true; window.workspace.retryStartup(); };
data.onclick = () => window.workspace.startupData();
