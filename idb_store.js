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
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('store', 'readonly');
      const store = tx.objectStore('store');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result !== undefined ? req.result : defaultValue);
      req.onerror = () => reject(req.error);
    });
  },
  set: async (key, value) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('store', 'readwrite');
      const store = tx.objectStore('store');
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
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
  }
};
