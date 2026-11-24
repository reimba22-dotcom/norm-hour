// sw.js - Service Worker для полной автономной работы приложения «Нормо-часы M-Telemetry»
const CACHE_NAME = 'm-telemetry-offline-v2';
const APP_SHELL = [
  './',
  './index.html',
  './db.js',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Кэшируем оболочку приложения для офлайн-режима');
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn('[Service Worker] Ошибка предкэширования некоторых ресурсов:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Удаляем старый кэш:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Внешние API (Gemini, OCR.space) не кэшируем, отправляем сразу в сеть
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Для локальных файлов приложения: стратегия Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Офлайн - если запрос не удался, кэш уже вернется ниже
      });

      return cachedResponse || fetchPromise;
    })
  );
});
