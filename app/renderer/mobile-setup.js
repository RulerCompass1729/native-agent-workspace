/* Explicit local setup, inside the existing setup dialog. Opening is read-only. */
(function (global) {
  'use strict';
  function bind({ container, document, api, getSessions, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
    const section = node('details'), summary = node('summary', '手机访问'); section.append(summary);
    const status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    section.append(node('p', '仅向明确配对的手机开放所选会话。请先准备只用于 NAW 的私有 HTTPS 入口，不要代理整个桌面。'));
    const field = (label, id, type = 'text') => { const box = node('label', label), input = node('input'); input.id = id; input.type = type; box.append(input); section.append(box); return input; };
    const origin = field('私有 HTTPS 地址', 'mobile-origin', 'url'); origin.placeholder = 'https://device.example.ts.net'; origin.autocomplete = 'off'; origin.maxLength = 2048;
    const actor = field('允许的具体 Tailscale 用户', 'mobile-actor'); actor.autocomplete = 'off'; actor.maxLength = 320;
    const port = field('本机端口（0 为自动分配，仅监听本机）', 'mobile-port', 'number'); port.min = '0'; port.max = '65535'; port.value = '0';
    const carrier = field('已核对：此 HTTPS 主机只用于该入口，私有转发配置及允许用户正确', 'mobile-carrier', 'checkbox');
    const choices = node('fieldset'); choices.append(node('legend', '允许访问的现有会话')); section.append(choices);
    const replace = field('明确替换原来的手机配对', 'mobile-replace', 'checkbox');
    section.append(node('p', '手机发送按真人输入处理，可能停止自动接力。撤销或重配对会使待确认的交接需要重新确认；已写入的原生工作可能继续。'));
    const prepare = node('button', '准备手机配对'), revoke = node('button', '撤销手机访问'); prepare.type = revoke.type = 'button'; prepare.id = 'mobile-prepare'; revoke.id = 'mobile-revoke';
    const linkBox = node('label', '在手机 Safari 打开此链接（最多 120 秒有效）'), link = node('input'); link.id = 'mobile-pair-link'; link.readOnly = true; link.autocomplete = 'off'; linkBox.append(link); linkBox.hidden = true;
    section.append(prepare, revoke, linkBox, status); container.append(section);
    let revision = 0, timer, opened = false, busy = false, selections = [];
    const clearLink = () => { clearTimer(timer); timer = undefined; link.value = ''; linkBox.hidden = true; };
    function open() {
      revision++; opened = true; busy = false; prepare.disabled = false; clearLink(); selections = [];
      choices.replaceChildren(node('legend', '允许访问的现有会话'));
      for (const record of getSessions()) {
        if (record.archived || record.nativeContextPending || !record.nativeId) continue;
        const box = node('div'), label = node('label'), read = node('input'); read.type = 'checkbox'; label.append(read, node('span', `${record.name || record.id} · ${record.id.slice(0, 6)}`));
        const sendLabel = node('label', '允许发送消息'), send = node('input'); send.type = 'checkbox'; sendLabel.append(send);
        const answerLabel = node('label', '允许回答原生问题（不含权限批准）'), answer = node('input'); answer.type = 'checkbox'; answerLabel.append(answer);
        box.append(label, sendLabel, answerLabel); choices.append(box); selections.push({ id: record.id, nativeId: record.nativeId, read, send, answer });
      }
      status.textContent = '本窗口尚未生成配对链接。关闭界面不会撤销此前开始的配对或手机访问；不确定时请先撤销访问。';
    }
    async function pair() {
      if (!opened || busy) return;
      clearLink();
      const current = getSessions(), selected = selections.filter(s => s.read.checked);
      let site, listenPort;
      try {
        site = new URL(origin.value.trim()); listenPort = Number(port.value);
        if (site.protocol !== 'https:' || site.origin !== origin.value.trim() || site.username || site.password || !actor.value.trim() || !carrier.checked || !selected.length ||
            !/^\d+$/.test(port.value) || !Number.isInteger(listenPort) || listenPort > 65535 || listenPort !== 0 && listenPort < 1024 ||
            selected.some(s => !current.some(row => row.id === s.id && row.nativeId === s.nativeId && !row.archived && !row.nativeContextPending))) throw Error('invalid');
      } catch { status.textContent = '请核对私有 HTTPS 地址、具体用户、端口和现有会话范围；没有创建配对。'; return; }
      const ticket = ++revision; busy = true; prepare.disabled = true; status.textContent = '正在准备本机配对…';
      try {
        const result = await api.mobilePairing({ actor: actor.value.trim(), origin: site.origin, port: listenPort, carrierConfirmed: true, replace: replace.checked,
          selection: selected.map(s => ({ sessionId: s.id, actions: ['read', ...(s.send.checked ? ['send'] : []), ...(s.answer.checked ? ['answer'] : [])] })) });
        if (!opened || revision !== ticket) return;
        if (typeof result.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.secret) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) throw Error('unconfirmed');
        link.value = site.origin + '/mobile/#pair=' + result.secret; linkBox.hidden = false;
        status.textContent = result.localAddress ? `本机入口：${result.localAddress}。私有转发就绪后，在手机打开配对链接。` : '配对已准备。网络入口仍须核对，不能据此认定手机已连接。';
        timer = setTimer(() => { if (revision !== ticket) return; clearLink(); status.textContent = '配对链接已过期；已有手机会话是否有效，请在手机或 Mac 核对。'; }, Math.min(120000, result.expiresAt - now()));
      } catch { if (opened && revision === ticket) status.textContent = '配对未确认。旧手机可能仍有效；需要替换时请明确勾选，或先撤销访问。'; }
      finally { if (opened && revision === ticket) { busy = false; prepare.disabled = false; } }
    }
    async function stop() {
      if (!opened) return;
      const ticket = ++revision; clearLink(); busy = false; prepare.disabled = false; status.textContent = '正在撤销手机访问…';
      try {
        const result = await api.mobileRevoke();
        if (opened && revision === ticket) status.textContent = result.authorizationRevoked ? '手机访问授权已撤销；已写入的原生工作可能继续。待确认的交接需要重新确认。' : '撤销未确认，请核对原会话；已写入的工作可能继续。';
      } catch { if (opened && revision === ticket) status.textContent = '撤销未确认，请在 Mac 核对原会话。'; }
    }
    function close() {
      revision++; opened = false; busy = false; clearLink(); origin.value = actor.value = ''; port.value = '0'; carrier.checked = replace.checked = false;
      selections = []; choices.replaceChildren(); status.textContent = ''; prepare.disabled = false; section.open = false;
    }
    prepare.addEventListener('click', pair); revoke.addEventListener('click', stop);
    return { open, close, dispose() { close(); section.remove(); } };
  }
  const value = { bind };
  if (typeof module === 'object' && module.exports) module.exports = value;
  else global.nativeWorkspaceMobileSetup = value;
})(globalThis);
