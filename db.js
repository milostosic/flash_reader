// IndexedDB wrapper for book storage.
// Schema:
//   books: { id, title, words[], wordCount, position, wpm, createdAt, updatedAt }
// Large word arrays are stored here because localStorage would be too small/slow.

(function () {
  const DB_NAME = 'flash-reader';
  const DB_VERSION = 1;
  const STORE = 'books';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const DB = {
    async put(book) {
      const store = await tx('readwrite');
      book.updatedAt = Date.now();
      return promisify(store.put(book));
    },

    async get(id) {
      const store = await tx('readonly');
      return promisify(store.get(id));
    },

    async delete(id) {
      const store = await tx('readwrite');
      return promisify(store.delete(id));
    },

    async getAllMeta() {
      // Returns all books but strips the words[] array to keep memory low.
      const store = await tx('readonly');
      const all = await promisify(store.getAll());
      return all
        .map((b) => ({
          id: b.id,
          title: b.title,
          author: b.author || '',
          cover: b.cover || null,
          wordCount: b.wordCount,
          position: b.position || 0,
          wpm: b.wpm || 500,
          readingMs: b.readingMs || 0,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    async updateProgress(id, position, wpm, readingMs) {
      const store = await tx('readwrite');
      const book = await promisify(store.get(id));
      if (!book) return;
      if (position != null) book.position = position;
      if (wpm != null) book.wpm = wpm;
      if (readingMs != null) book.readingMs = readingMs;
      book.updatedAt = Date.now();
      return promisify(store.put(book));
    },
  };

  window.FlashReaderDB = DB;
})();
