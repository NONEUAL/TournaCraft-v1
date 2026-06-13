/**
 * sw.js — Province Games Service Worker
 *
 * Implements offline-first caching strategy:
 *   - Static assets (HTML, CSS, JS, fonts, icons): Cache-first
 *   - API calls: Network-first with offline fallback
 *   - Unknown requests: Network-first, cache on success
 *
 * Cache versioning: bump CACHE_VERSION on each deploy to
 * invalidate old caches and serve updated assets.
 *
 * PWA requirements:
 *   - Offline fallback page (offline.html)
 *   - All static assets cached on install
 *   - Background sync for queued match updates
 */

'use strict';

const CACHE_VERSION   = 'province-games-v1';
const OFFLINE_URL     = '/offline.html';

// ── Assets to pre-cache on install ────────────────────────────
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/view.html',
  '/offline.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/storage.js',
  '/js/bracket/doubleElim.js',
  '/js/bracket/roundRobin.js',
  '/js/games/mobileLegends.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: pre-cache all static assets ──────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async cache => {
      // Pre-cache known assets; log failures individually (don't abort install)
      const results = await Promise.allSettled(
        PRECACHE_ASSETS.map(url => cache.add(url).catch(err => {
          console.warn(`[SW] Failed to cache ${url}:`, err.message);
        }))
      );
      console.log('[SW] Pre-cache complete.');
    }).then(() => self.skipWaiting()) // Activate immediately
  );
});

// ── Activate: clean up old caches ─────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      const staleKeys = cacheNames.filter(name => name !== CACHE_VERSION);
      return Promise.all(staleKeys.map(key => {
        console.log('[SW] Deleting stale cache:', key);
        return caches.delete(key);
      }));
    }).then(() => {
      console.log('[SW] Activated, controlling all clients.');
      return self.clients.claim();
    })
  );
});

// ── Fetch: serve from cache or network ────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin && !isExternalAsset(url)) return;

  // Strategy selection
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  } else if (isApiRequest(url)) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// ── Caching Strategies ─────────────────────────────────────────

/**
 * Cache-first: serve from cache, fall back to network.
 * Best for: CSS, JS, fonts — assets that don't change between deploys.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

/**
 * Network-first: try network, fall back to cache.
 * Best for: API endpoints, data that changes frequently.
 */
async function networkFirst(request) {
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Network timeout')), 4000)
      )
    ]);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback(request);
  }
}

/**
 * Stale-while-revalidate: serve from cache immediately,
 * then update cache in background.
 * Best for: HTML pages — fast load + freshness.
 */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  // Start a background network fetch regardless
  const networkPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await networkPromise || offlineFallback(request);
}

/**
 * Return offline page for navigation requests, or a 503 for others.
 */
async function offlineFallback(request) {
  if (request.mode === 'navigate') {
    const offlinePage = await caches.match(OFFLINE_URL);
    return offlinePage || new Response(
      '<html><body><h1>You are offline</h1><p>Open Province Games while online first to cache it.</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
  return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
}

// ── URL Classification Helpers ────────────────────────────────

function isStaticAsset(url) {
  return /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)(\?.*)?$/.test(url.pathname);
}

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.hostname !== self.location.hostname;
}

function isExternalAsset(url) {
  // Allow CDN fonts, etc.
  const allowedExternalHosts = ['fonts.googleapis.com', 'fonts.gstatic.com'];
  return allowedExternalHosts.includes(url.hostname);
}

// ── Background Sync (when supported) ─────────────────────────
// Fires when the browser regains connectivity and a sync was registered.
self.addEventListener('sync', event => {
  if (event.tag === 'sync-tournaments') {
    event.waitUntil(syncTournaments());
  }
});

async function syncTournaments() {
  // The main app's Storage module handles the actual sync logic.
  // We just notify all open clients to trigger their sync.
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => {
    client.postMessage({ type: 'SW_SYNC_REQUESTED' });
  });
}

// ── Push Notifications (skeleton for future use) ──────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); }
  catch { return; }

  const title   = data.title || 'Province Games';
  const options = {
    body:    data.body || 'Match update available.',
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    tag:     data.matchId || 'update',
    renotify: true,
    data:    { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const existing = windowClients.find(c => c.url.includes(url) && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

console.log('[SW] Province Games service worker loaded. Cache:', CACHE_VERSION);
