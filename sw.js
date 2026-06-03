// Shopiotic Service Worker — Web Push notifications
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Shopiotic', {
      body: data.body || '',
      icon: '/shopiotic-portal/logo-dark.png',
      badge: '/shopiotic-portal/logo-dark.png',
      tag: data.tag || 'shopiotic',
      data: { url: data.url || '/shopiotic-portal/' },
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/shopiotic-portal/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('shopiotic-portal') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
