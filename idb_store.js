// idb_store.js
const DB_NAME = 'AutoEmailLabelerDB';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('store')) {
        db.createObjectStore('store');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const idb = {
  get: async (key, defaultValue = null) => {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readonly');
        const store = tx.objectStore('store');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result !== undefined ? req.result : defaultValue);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error("IDB Get Error:", e);
      return defaultValue;
    }
  },
  set: async (key, value) => {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        const store = tx.objectStore('store');
        const req = store.put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error("IDB Set Error:", e);
    }
  },
  delete: async (key) => {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        const store = tx.objectStore('store');
        const req = store.delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error("IDB Delete Error:", e);
    }
  },
  getAllState: async () => {
    return {
      trainingDataset: await idb.get('trainingDataset', []),
      senderMemory: await idb.get('senderMemory', {}),
      emailLabelMap: await idb.get('emailLabelMap', []),
      centroids: await idb.get('centroids', {}),
      vocabulary: await idb.get('vocabulary', []),
      idf: await idb.get('idf', {}),
      currentHistoryId: await idb.get('currentHistoryId', null),
      lastMessageId: await idb.get('lastMessageId', null),
      offlineQueue: await idb.get('offlineQueue', [])
    };
  },
  clearStaleData: async () => {
    // Disabled: Auto-purging was causing data loss for read emails that hadn't graduated yet.
    // We now rely on background.js smartTrimDataset logic which uses a much larger safety buffer (25,000).
    console.log("IDB: clearStaleData bypass engaged (Safety Mode).");
  }
};
