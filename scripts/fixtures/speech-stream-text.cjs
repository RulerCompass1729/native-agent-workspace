// Shared by the speech-stream fixture and its test: a reply long enough to fold.
const LONG = ['输入框修复已完成，改动如下：', ...Array.from({ length: 14 }, (_, n) => `${n + 1}. 第 ${n + 1} 处改动：保留原生会话，不新开进程。`), '测试 1480/1480 通过。'].join('\n');
module.exports = { LONG };
