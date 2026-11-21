/* No private reads, cache, tokens, approvals or destination URLs in a push. */
// The Mac sends only these codes; every word shown is chosen here.
const ALERTS = {
  'service-disconnected': ['本机服务断开', 'Local service disconnected'],
  'steward-wake-stalled': ['大管家该叫醒没叫醒', 'Butler wake-up stalled'],
  'token-anomaly': ['token 异常', 'Token anomaly'],
  'decision-waiting': ['有事等你决定', 'A decision is waiting for you'],
};
// An older worker understands only a count and would drop an alert without showing it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const keys = Object.keys(data), { count, alerts } = data;
  if (!keys.length || keys.some(key => key !== 'count' && key !== 'alerts') ||
      Object.hasOwn(data, 'count') && (!Number.isSafeInteger(count) || count < 0) ||
      Object.hasOwn(data, 'alerts') && (!Array.isArray(alerts) || new Set(alerts).size !== alerts.length ||
        alerts.some(code => typeof code !== 'string' || !Object.hasOwn(ALERTS, code)))) return;
  const zh = self.navigator.language.startsWith('zh'), word = code => ALERTS[code][zh ? 0 : 1];
  const total = zh ? `NAW 有 ${count} 条提醒` : `NAW has ${count} reminders`, open = zh ? '点开 NAW 查看' : 'Open NAW for details';
  if (!alerts) { event.waitUntil(self.registration.showNotification('NAW', { body: total, tag: 'naw-count' })); return; }
  if (!alerts.length) {
    event.waitUntil(self.registration.showNotification(zh ? '告警已解除' : 'Alerts cleared', { body: count === undefined ? open : total, tag: 'naw-alert' }));
    return;
  }
  const more = alerts.slice(1).map(word);
  if (count > 0) more.push(zh ? `${count} 条提醒` : count === 1 ? '1 reminder' : `${count} reminders`);
  event.waitUntil(self.registration.showNotification(word(alerts[0]), { body: more.join(' · ') || open, tag: 'naw-alert', renotify: true }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL('/mobile/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(w => { try { const u = new URL(w.url); return u.origin === self.location.origin && u.pathname === '/mobile/'; } catch { return false; } });
    if (existing) { await existing.navigate(url); await existing.focus(); }
    else await self.clients.openWindow(url);
  })());
});
