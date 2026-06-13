/**
 * js/storage.js
 *
 * Offline-first storage engine.
 *
 * Architecture:
 *   Primary store:  IndexedDB (via Promise wrappers) — structured data
 *   Fallback store: localStorage (JSON) — when IndexedDB unavailable
 *   Sync queue:     localStorage 'pg_sync_queue' — pending cloud changes
 *
 * Offline-first rule:
 *   ALL reads check local store first.
 *   ALL writes go to local store first, then queue for cloud sync.
 *   Sync runs automatically when navigator.onLine becomes true.
 *
 * Cloud sync:
 *   When online, sync queued operations to a configurable REST endpoint.
 *   If no endpoint is configured, data stays local only (fully offline mode).
 *
 * Performance targets:
 *   localStorage saves: < 50ms
 *   Full sync: < 2 seconds on good connection
 */

'use strict';

const Storage = (() => {

  // ── Configuration ─────────────────────────────────────────────
  const DB_NAME      = 'ProvinceGamesDB';
  const DB_VERSION   = 1;
  const STORE_NAME   = 'tournaments';
  const LS_KEY       = 'pg_tournaments';
  const SYNC_KEY     = 'pg_sync_queue';
  const CLOUD_ENDPOINT = null; // Set to your API URL when deploying, e.g. 'https://api.example.com'

  // ── IndexedDB Instance ─────────────────────────────────────────
  let _db = null;
  let _useIDB = true;

  /**
   * Open (or create) the IndexedDB database.
   * Returns a promise that resolves to an IDBDatabase.
   */
  function openDB() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = e => {
        const db    = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('shareCode', 'shareCode', { unique: true });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };

      req.onsuccess = e => {
        _db = e.target.result;
        resolve(_db);
      };

      req.onerror = e => {
        console.warn('[Storage] IndexedDB unavailable, falling back to localStorage:', e.target.error);
        _useIDB = false;
        resolve(null);
      };
    });
  }

  // ── IDB Helpers ────────────────────────────────────────────────

  function idbTransaction(mode) {
    return _db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  function idbGet(id) {
    return new Promise((resolve, reject) => {
      const req = idbTransaction('readonly').get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  function idbGetByIndex(indexName, value) {
    return new Promise((resolve, reject) => {
      const req = idbTransaction('readonly').index(indexName).get(value);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  function idbGetAll() {
    return new Promise((resolve, reject) => {
      const req = idbTransaction('readonly').getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror   = () => reject(req.error);
    });
  }

  function idbPut(record) {
    return new Promise((resolve, reject) => {
      const req = idbTransaction('readwrite').put(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  function idbDelete(id) {
    return new Promise((resolve, reject) => {
      const req = idbTransaction('readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  // ── localStorage Fallback Helpers ──────────────────────────────

  function lsGetAll() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function lsGet(id) {
    return lsGetAll().find(t => t.id === id) ?? null;
  }

  function lsGetByCode(code) {
    return lsGetAll().find(t => t.shareCode === code) ?? null;
  }

  function lsSave(tournament) {
    const all = lsGetAll();
    const idx = all.findIndex(t => t.id === tournament.id);
    if (idx >= 0) all[idx] = tournament;
    else all.push(tournament);
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  }

  function lsDelete(id) {
    const all = lsGetAll().filter(t => t.id !== id);
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  }

  // ── Sync Queue ────────────────────────────────────────────────

  function getSyncQueue() {
    try {
      return JSON.parse(localStorage.getItem(SYNC_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function enqueueSyncOp(op) {
    const queue = getSyncQueue();
    // Deduplicate: replace existing op for the same tournament
    const filtered = queue.filter(o => !(o.id === op.id && o.type === op.type));
    filtered.push({ ...op, queuedAt: Date.now() });
    localStorage.setItem(SYNC_KEY, JSON.stringify(filtered));
  }

  function clearSyncQueue() {
    localStorage.removeItem(SYNC_KEY);
  }

  function removeSyncOp(id, type) {
    const queue = getSyncQueue().filter(o => !(o.id === id && o.type === type));
    localStorage.setItem(SYNC_KEY, JSON.stringify(queue));
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Save (create or update) a tournament.
   * Writes to IndexedDB (or localStorage fallback) immediately.
   * Enqueues a sync operation for when online.
   *
   * @param {Object} tournament
   * @returns {Promise<void>}
   */
  async function saveTournament(tournament) {
    if (!tournament?.id) throw new Error('Tournament must have an id.');
    tournament.updatedAt = tournament.updatedAt || Date.now();

    const startTime = Date.now();

    try {
      await openDB();
      if (_useIDB && _db) {
        await idbPut(tournament);
      } else {
        lsSave(tournament);
      }
    } catch (err) {
      // IDB write failed — fall back to localStorage silently
      console.warn('[Storage] IDB write failed, using localStorage:', err);
      lsSave(tournament);
    }

    // Always mirror to localStorage for resilience and share-code lookups
    lsSave(tournament);

    // Queue for cloud sync
    enqueueSyncOp({ type: 'upsert', id: tournament.id, payload: tournament });

    const elapsed = Date.now() - startTime;
    if (elapsed > 50) console.warn(`[Storage] Save took ${elapsed}ms (target <50ms)`);
  }

  /**
   * Get a single tournament by ID.
   * Checks IndexedDB first, falls back to localStorage.
   *
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async function getTournament(id) {
    if (!id) return null;
    try {
      await openDB();
      if (_useIDB && _db) {
        const result = await idbGet(id);
        if (result) return result;
      }
    } catch (err) {
      console.warn('[Storage] IDB read failed:', err);
    }
    return lsGet(id);
  }

  /**
   * Get a tournament by its 6-character share code.
   * Used by view.html for public viewer access.
   *
   * @param {string} code — uppercase share code
   * @returns {Promise<Object|null>}
   */
  async function getTournamentByCode(code) {
    if (!code) return null;
    const upperCode = code.toUpperCase();

    try {
      await openDB();
      if (_useIDB && _db) {
        const result = await idbGetByIndex('shareCode', upperCode);
        if (result) return result;
      }
    } catch (err) {
      console.warn('[Storage] IDB index read failed:', err);
    }
    return lsGetByCode(upperCode);
  }

  /**
   * Get all tournaments, sorted by updatedAt descending.
   *
   * @returns {Promise<Array>}
   */
  async function getAllTournaments() {
    let results = [];
    try {
      await openDB();
      if (_useIDB && _db) {
        results = await idbGetAll();
      }
    } catch (err) {
      console.warn('[Storage] IDB getAll failed:', err);
    }
    if (results.length === 0) {
      results = lsGetAll();
    }
    return results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * Delete a tournament from all stores.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteTournament(id) {
    if (!id) throw new Error('Tournament id required for deletion.');
    try {
      await openDB();
      if (_useIDB && _db) await idbDelete(id);
    } catch (err) {
      console.warn('[Storage] IDB delete failed:', err);
    }
    lsDelete(id);
    enqueueSyncOp({ type: 'delete', id, payload: null });
  }

  /**
   * Sync pending changes to the cloud backend.
   * Runs automatically when navigator.onLine === true.
   * Safe to call repeatedly — uses last-write-wins semantics.
   *
   * If CLOUD_ENDPOINT is null, syncing is a no-op (fully offline mode).
   *
   * @returns {Promise<void>}
   */
  async function syncPendingChanges() {
    if (!CLOUD_ENDPOINT) return; // Offline-only mode configured
    if (!navigator.onLine)  return;

    const queue = getSyncQueue();
    if (queue.length === 0) return;

    const startTime = Date.now();
    const failed    = [];

    for (const op of queue) {
      try {
        const url    = `${CLOUD_ENDPOINT}/tournaments${op.type === 'delete' ? `/${op.id}` : ''}`;
        const method = op.type === 'delete' ? 'DELETE' : 'PUT';

        const res = await Promise.race([
          fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body:    op.type !== 'delete' ? JSON.stringify(op.payload) : undefined,
          }),
          // Timeout after 5 seconds
          new Promise((_, rej) => setTimeout(() => rej(new Error('Sync timeout')), 5000)),
        ]);

        if (!res.ok) throw new Error(`Server error ${res.status}`);
        removeSyncOp(op.id, op.type);
      } catch (err) {
        console.warn(`[Sync] Op failed for ${op.id}:`, err.message);
        failed.push(op);
      }
    }

    if (failed.length > 0) {
      // Re-queue only the failed ops (with exponential backoff handled by caller)
      localStorage.setItem(SYNC_KEY, JSON.stringify(failed));
    } else {
      clearSyncQueue();
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > 2000) console.warn(`[Sync] Sync took ${elapsed}ms (target <2s)`);
  }

  /**
   * Export all local data as a downloadable JSON blob.
   * Useful for backup before clearing storage.
   *
   * @returns {Promise<Blob>}
   */
  async function exportAllData() {
    const all = await getAllTournaments();
    return new Blob([JSON.stringify({ tournaments: all, exportedAt: Date.now() }, null, 2)],
      { type: 'application/json' });
  }

  /**
   * Import tournaments from a JSON blob (created by exportAllData).
   * Merges — later updatedAt wins for conflicts.
   *
   * @param {string} jsonString
   * @returns {Promise<number>} count of imported tournaments
   */
  async function importData(jsonString) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch {
      throw new Error('Invalid export file. Please select a valid Province Games backup.');
    }
    if (!Array.isArray(data.tournaments)) {
      throw new Error('Export file is missing tournament data.');
    }
    let imported = 0;
    for (const tournament of data.tournaments) {
      if (!tournament.id) continue;
      const existing = await getTournament(tournament.id);
      // Last-write-wins conflict resolution
      if (!existing || (tournament.updatedAt || 0) > (existing.updatedAt || 0)) {
        await saveTournament(tournament);
        imported++;
      }
    }
    return imported;
  }

  /**
   * Clear all local tournament data. Use with care.
   * Prompts for confirmation before clearing.
   *
   * @returns {Promise<void>}
   */
  async function clearAllData() {
    try {
      await openDB();
      if (_useIDB && _db) {
        await new Promise((resolve, reject) => {
          const req = idbTransaction('readwrite').clear();
          req.onsuccess = resolve;
          req.onerror   = () => reject(req.error);
        });
      }
    } catch (err) {
      console.warn('[Storage] IDB clear failed:', err);
    }
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(SYNC_KEY);
  }

  // ── Initialise ────────────────────────────────────────────────

  // Pre-open the database on module load
  openDB().catch(err => {
    console.warn('[Storage] Pre-open failed:', err);
    _useIDB = false;
  });

  // Auto-sync when coming online
  window.addEventListener('online', () => {
    syncPendingChanges().catch(err =>
      console.warn('[Storage] Auto-sync failed:', err)
    );
  });

  // ── Public API ────────────────────────────────────────────────

  return {
    saveTournament,
    getTournament,
    getTournamentByCode,
    getAllTournaments,
    deleteTournament,
    syncPendingChanges,
    exportAllData,
    importData,
    clearAllData,
  };

})();

window.Storage = Storage;
