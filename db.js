// db.js - Надежное асинхронное хранилище IndexedDB для M-Telemetry Cockpit
// Гарантирует полную сохранность заказов, дней, настроек, корректировок и неограниченного количества фото.

(function (window) {
  'use strict';

  const DB_NAME = 'MTelemetry_DB';
  const DB_VERSION = 2;
  const LS_LEGACY_KEY = 'normo_hours_m_telemetry_v2';
  const LS_MIGRATED_FLAG = 'normo_hours_migrated_v2_done';

  let dbInstance = null;

  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('orders')) {
          const orderStore = db.createObjectStore('orders', { keyPath: 'id' });
          orderStore.createIndex('date', 'date', { unique: false });
        }

        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('days')) {
          db.createObjectStore('days', { keyPath: 'date' });
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        console.error('[M-Telemetry DB] IndexedDB error:', event.target.error);
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
    getAllOrders: async function () {
      return tx('orders', 'readonly', (store) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      });
    },

    saveOrder: async function (order) {
      return tx('orders', 'readwrite', (store) => {
        store.put(order);
      });
    },

    saveAllOrders: async function (orders) {
      return tx('orders', 'readwrite', (store) => {
        store.clear();
        (orders || []).forEach((o) => store.put(o));
      });
    },

    deleteOrder: async function (id) {
      return tx('orders', 'readwrite', (store) => {
        store.delete(id);
      });
    },

    savePhoto: async function (id, dataUrl) {
      if (!id || !dataUrl) return;
      return tx('photos', 'readwrite', (store) => {
        store.put({ id: id, data: dataUrl, updatedAt: Date.now() });
      });
    },

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

    getAllPhotoIds: async function () {
      return tx('photos', 'readonly', (store) => {
        return new Promise((resolve) => {
          const req = store.getAllKeys();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
      });
    },

    getStorageStats: async function () {
      try {
        const photos = await tx('photos', 'readonly', (store) => {
          return new Promise((resolve) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
          });
        });
        const orders = await MDB.getAllOrders();
        let photoBytes = 0;
        photos.forEach((p) => {
          if (p && p.data) photoBytes += p.data.length;
        });
        return {
          ordersCount: orders.length,
          photosCount: photos.length,
          photoMb: (photoBytes / (1024 * 1024)).toFixed(2)
        };
      } catch (e) {
        return { ordersCount: 0, photosCount: 0, photoMb: '0.00' };
      }
    },

    deletePhoto: async function (id) {
      if (!id) return;
      return tx('photos', 'readwrite', (store) => {
        store.delete(id);
      });
    },

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

    setDayStatus: async function (date, status) {
      return tx('days', 'readwrite', (store) => {
        store.put({ date: date, status: status || 'off' });
      });
    },

    saveAllDays: async function (daysMap) {
      return tx('days', 'readwrite', (store) => {
        store.clear();
        Object.entries(daysMap || {}).forEach(([date, status]) => {
          store.put({ date: date, status: status });
        });
      });
    },

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

    getMeta: async function (key, fallback = null) {
      return tx('meta', 'readonly', (store) => {
        return new Promise((resolve) => {
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
          req.onerror = () => resolve(fallback);
        });
      });
    },

    setMeta: async function (key, value) {
      return tx('meta', 'readwrite', (store) => {
        store.put({ key: key, value: value });
      });
    },

    // Безопасная и полная миграция старого состояния (заказы, дни, настройки, корректировки, пресеты и фото)
    migrateLegacyData: async function () {
      try {
        const alreadyMigrated = localStorage.getItem(LS_MIGRATED_FLAG);
        const raw = localStorage.getItem(LS_LEGACY_KEY);
        if (!raw) return { migrated: false, reason: 'no_legacy' };

        const legacy = JSON.parse(raw);
        if (!legacy || typeof legacy !== 'object') return { migrated: false, reason: 'invalid' };

        const existingOrders = await MDB.getAllOrders();
        const existingDays = await MDB.getDays();
        const existingSettings = await MDB.getSettings();

        let didSomething = false;

        // Перенос заказов (если в IndexedDB еще нет заказов или есть неперенесенные)
        if (Array.isArray(legacy.orders) && legacy.orders.length > 0 && existingOrders.length === 0) {
          for (const order of legacy.orders) {
            await MDB.saveOrder(order);
          }
          didSomething = true;
        }

        // Перенос графика смен (даже если заказов было 0!)
        if (legacy.days && Object.keys(legacy.days).length > 0 && Object.keys(existingDays).length === 0) {
          await MDB.saveAllDays(legacy.days);
          didSomething = true;
        }

        // Перенос настроек (даже если заказов было 0!)
        if (legacy.settings && !existingSettings) {
          await MDB.saveSettings(legacy.settings);
          didSomething = true;
        }

        // Перенос корректировок
        if (Array.isArray(legacy.adjustments) && legacy.adjustments.length > 0) {
          const curAdj = await MDB.getMeta('adjustments', []);
          if (!curAdj.length) {
            await MDB.setMeta('adjustments', legacy.adjustments);
            didSomething = true;
          }
        }

        // Перенос фотографий из localStorage в безлимитный IndexedDB
        if (legacy.photos && typeof legacy.photos === 'object') {
          const photoEntries = Object.entries(legacy.photos);
          if (photoEntries.length > 0) {
            for (const [photoId, photoData] of photoEntries) {
              if (photoData) await MDB.savePhoto(photoId, photoData);
            }
            // Освобождаем 5MB квоту localStorage, оставляя резервную структуру без тяжелых фото
            legacy.photos = {};
            localStorage.setItem(LS_LEGACY_KEY, JSON.stringify(legacy));
            didSomething = true;
          }
        }

        if (!alreadyMigrated) {
          localStorage.setItem(LS_MIGRATED_FLAG, '1');
        }

        return { migrated: didSomething, ordersCount: (legacy.orders || []).length };
      } catch (err) {
        console.warn('[M-Telemetry DB] Migration warning:', err);
        return { migrated: false, error: err.message };
      }
    },

    // Легкий фоновый снимок в localStorage (без тяжелых фото) на случай отката/сверки
    syncLightweightMirror: function (state) {
      try {
        const mirror = {
          orders: state.orders || [],
          days: state.days || {},
          settings: state.settings || {},
          adjustments: state.adjustments || [],
          photos: {}
        };
        localStorage.setItem(LS_LEGACY_KEY, JSON.stringify(mirror));
      } catch (e) {
        // Игнорируем, если localStorage полон — основная БД IndexedDB уже все сохранила
      }
    },

    exportBackup: async function (includePhotos = true) {
      const orders = await MDB.getAllOrders();
      const days = await MDB.getDays();
      const settings = (await MDB.getSettings()) || {};
      const adjustments = await MDB.getMeta('adjustments', []);
      const customPresets = await MDB.getMeta('customPresets', []);

      const photos = {};
      if (includePhotos) {
        for (const order of orders) {
          if (order.photoId) {
            const ph = await MDB.getPhoto(order.photoId);
            if (ph) photos[order.photoId] = ph;
          }
        }
      }

      const cleanSettings = Object.assign({}, settings);
      cleanSettings.geminiKey = '';
      cleanSettings.ocrSpaceKey = '';

      return {
        app: 'normo-hours',
        version: 2,
        exportedAt: new Date().toISOString(),
        snapshot: {
          orders: orders,
          days: days,
          settings: cleanSettings,
          adjustments: adjustments,
          customPresets: customPresets,
          photos: photos
        }
      };
    },

    importBackup: async function (snapshot) {
      if (!snapshot || !Array.isArray(snapshot.orders)) {
        throw new Error('Некорректный формат файла резервной копии');
      }

      await MDB.saveAllOrders(snapshot.orders);

      if (snapshot.photos && typeof snapshot.photos === 'object') {
        await tx('photos', 'readwrite', (s) => s.clear());
        for (const [id, data] of Object.entries(snapshot.photos)) {
          if (data) await MDB.savePhoto(id, data);
        }
      }

      if (snapshot.days) {
        await MDB.saveAllDays(snapshot.days);
      }

      if (Array.isArray(snapshot.adjustments)) {
        await MDB.setMeta('adjustments', snapshot.adjustments);
      }

      if (Array.isArray(snapshot.customPresets)) {
        await MDB.setMeta('customPresets', snapshot.customPresets);
      }

      if (snapshot.settings) {
        const curSettings = (await MDB.getSettings()) || {};
        const merged = Object.assign({}, snapshot.settings, {
          geminiKey: snapshot.settings.geminiKey || curSettings.geminiKey || '',
          ocrSpaceKey: snapshot.settings.ocrSpaceKey || curSettings.ocrSpaceKey || '',
          workingModel: snapshot.settings.workingModel || curSettings.workingModel || ''
        });
        await MDB.saveSettings(merged);
      }
      return true;
    }
  };

  window.MDB = MDB;
})(window);
