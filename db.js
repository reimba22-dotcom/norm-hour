// db.js - Высокопроизводительное хранилище на базе IndexedDB для M-Telemetry
// Снимает ограничение 5 МБ в localStorage, позволяя сохранять неограниченно много фото и заказ-нарядов.

(function (window) {
  'use strict';

  const DB_NAME = 'MTelemetry_DB';
  const DB_VERSION = 1;
  const LS_LEGACY_KEY = 'normo_hours_m_telemetry_v2';

  let dbInstance = null;

  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Хранилище заказ-нарядов
        if (!db.objectStoreNames.contains('orders')) {
          const orderStore = db.createObjectStore('orders', { keyPath: 'id' });
          orderStore.createIndex('date', 'date', { unique: false });
        }

        // Хранилище фотографий высокого разрешения (без лимита памяти)
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id' });
        }

        // Хранилище дней графика (смен)
        if (!db.objectStoreNames.contains('days')) {
          db.createObjectStore('days', { keyPath: 'date' });
        }

        // Хранилище настроек
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  function tx(storeName, mode, callback) {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = (e) => reject(e.target.error);

        result = callback(store);
      });
    });
  }

  const MDB = {
    // Получение всех заказов
    getAllOrders: async function () {
      return tx('orders', 'readonly', (store) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      });
    },

    // Сохранение заказа
    saveOrder: async function (order) {
      return tx('orders', 'readwrite', (store) => {
        store.put(order);
      });
    },

    // Удаление заказа
    deleteOrder: async function (id) {
      return tx('orders', 'readwrite', (store) => {
        store.delete(id);
      });
    },

    // Сохранение фото
    savePhoto: async function (id, dataUrl) {
      if (!id || !dataUrl) return;
      return tx('photos', 'readwrite', (store) => {
        store.put({ id: id, data: dataUrl, updatedAt: Date.now() });
      });
    },

    // Получение фото
    getPhoto: async function (id) {
      if (!id) return null;
      return tx('photos', 'readonly', (store) => {
        return new Promise((resolve) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result ? req.result.data : null);
          req.onerror = () => resolve(null);
        });
      });
    },

    // Удаление фото
    deletePhoto: async function (id) {
      if (!id) return;
      return tx('photos', 'readwrite', (store) => {
        store.delete(id);
      });
    },

    // Дни графика (все)
    getDays: async function () {
      return tx('days', 'readonly', (store) => {
        return new Promise((resolve) => {
          const req = store.getAll();
          req.onsuccess = () => {
            const map = {};
            (req.result || []).forEach((row) => {
              map[row.date] = row.status;
            });
            resolve(map);
          };
          req.onerror = () => resolve({});
        });
      });
    },

    // Сохранение дня графика
    setDayStatus: async function (date, status) {
      return tx('days', 'readwrite', (store) => {
        if (!status || status === 'off') {
          store.put({ date: date, status: 'off' });
        } else {
          store.put({ date: date, status: status });
        }
      });
    },

    // Сохранение всех дней пакетом
    saveAllDays: async function (daysMap) {
      return tx('days', 'readwrite', (store) => {
        store.clear();
        Object.entries(daysMap || {}).forEach(([date, status]) => {
          store.put({ date: date, status: status });
        });
      });
    },

    // Настройки
    getSettings: async function () {
      return tx('settings', 'readonly', (store) => {
        return new Promise((resolve) => {
          const req = store.get('app_settings');
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => resolve(null);
        });
      });
    },

    saveSettings: async function (settings) {
      return tx('settings', 'readwrite', (store) => {
        store.put({ key: 'app_settings', value: settings });
      });
    },

    // Автоматическая миграция из старого localStorage (v16) без потери данных
    migrateLegacyData: async function () {
      try {
        const raw = localStorage.getItem(LS_LEGACY_KEY);
        if (!raw) return false;

        const legacy = JSON.parse(raw);
        if (!legacy || !Array.isArray(legacy.orders)) return false;

        const existingOrders = await MDB.getAllOrders();
        // Если база еще пуста, переносим
        if (existingOrders.length === 0 && legacy.orders.length > 0) {
          console.log(`[M-Telemetry DB] Переносим ${legacy.orders.length} заказов из localStorage в IndexedDB...`);

          // Сохраняем заказы
          for (const order of legacy.orders) {
            await MDB.saveOrder(order);
          }

          // Сохраняем фото (выносим их из localStorage)
          if (legacy.photos) {
            for (const [photoId, photoData] of Object.entries(legacy.photos)) {
              if (photoData) await MDB.savePhoto(photoId, photoData);
            }
          }

          // Сохраняем дни
          if (legacy.days) {
            await MDB.saveAllDays(legacy.days);
          }

          // Сохраняем настройки
          if (legacy.settings) {
            await MDB.saveSettings(legacy.settings);
          }

          // Очищаем тяжелые фото из localStorage, чтобы освободить место браузеру
          legacy.photos = {};
          localStorage.setItem(LS_LEGACY_KEY, JSON.stringify(legacy));
          console.log('[M-Telemetry DB] Миграция успешно завершена!');
          return true;
        }
      } catch (err) {
        console.warn('[M-Telemetry DB] Ошибка миграции:', err);
      }
      return false;
    },

    // Полный экспорт базы данных в JSON
    exportBackup: async function () {
      const orders = await MDB.getAllOrders();
      const days = await MDB.getDays();
      const settings = (await MDB.getSettings()) || {};

      // Собираем фото для бэкапа
      const photos = {};
      for (const order of orders) {
        if (order.photoId) {
          const ph = await MDB.getPhoto(order.photoId);
          if (ph) photos[order.photoId] = ph;
        }
      }

      const cleanSettings = Object.assign({}, settings);
      // Очищаем приватные ключи перед экспортом
      cleanSettings.geminiKey = '';
      cleanSettings.ocrSpaceKey = '';

      return {
        app: 'normo-hours-m-telemetry',
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        snapshot: {
          orders: orders,
          days: days,
          settings: cleanSettings,
          photos: photos
        }
      };
    },

    // Импорт базы из файла
    importBackup: async function (snapshot) {
      if (!snapshot || !Array.isArray(snapshot.orders)) {
        throw new Error('Некорректный формат файла резервной копии');
      }

      // Очищаем и заполняем
      await tx('orders', 'readwrite', (s) => s.clear());
      for (const order of snapshot.orders) {
        await MDB.saveOrder(order);
      }

      if (snapshot.photos) {
        await tx('photos', 'readwrite', (s) => s.clear());
        for (const [id, data] of Object.entries(snapshot.photos)) {
          if (data) await MDB.savePhoto(id, data);
        }
      }

      if (snapshot.days) {
        await MDB.saveAllDays(snapshot.days);
      }

      if (snapshot.settings) {
        const curSettings = (await MDB.getSettings()) || {};
        const merged = Object.assign({}, snapshot.settings, {
          geminiKey: curSettings.geminiKey || '',
          ocrSpaceKey: curSettings.ocrSpaceKey || ''
        });
        await MDB.saveSettings(merged);
      }
      return true;
    }
  };

  window.MDB = MDB;
})(window);
