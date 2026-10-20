// Never display an upstream Error.message: Electron load errors contain the
// entire URL, including the private DSH access token.
function startupMessage(error) {
  const messages = {
    NAW_NODE_MISSING: '未找到兼容的 Node.js，无法启动 DSH 界面服务。',
    NAW_UI_BUSY: '上一个界面服务仍在退出；未启动重复服务，请稍后重新打开。',
    NAW_UI_RECORD: '界面进程记录无法读取；未启动重复服务。',
    NAW_VIEW_RECORD: '界面记录无法读取，原文件已保留。请检查本机数据或从备份恢复后重试；未用空白记录覆盖草稿。',
  };
  return (Object.hasOwn(messages, error?.code) ? messages[error.code] : '本地界面未能完成启动，请点击重试或重新打开应用。') + '\n原生会话由独立运行服务保留，不会自动重建或重发消息。';
}
module.exports = { startupMessage };
