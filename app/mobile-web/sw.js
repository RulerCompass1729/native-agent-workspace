/* No private reads, cache, tokens, approvals or destination URLs in a push. */
self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 ||
      !Object.hasOwn(data, 'count') || !Number.isSafeInteger(data.count) || data.count < 0) return;
  const zh = self.navigator.language.startsWith('zh');
  event.waitUntil(self.registration.showNotification('NAW', {
    body: zh ? `NAW 有 ${data.count} 条提醒` : `NAW has ${data.count} reminders`, tag: 'naw-count',
  }));
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
