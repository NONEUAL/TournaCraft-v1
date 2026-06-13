/**
 * js/websocket.js
 *
 * Real-time sync via WebSocket.
 *
 * Architecture:
 *   - Connects to a configurable WS endpoint when online
 *   - Broadcasts match updates to all connected viewers immediately
 *   - Shows a "Live" indicator on the bracket topbar when connected
 *   - Reconnects automatically with exponential backoff (max 30s)
 *   - Falls back gracefully to polling (storage.js auto-sync) when WS unavailable
 *   - All outgoing messages are queued if disconnected and flushed on reconnect
 *
 * Message protocol:
 *   Client → Server:
 *     { type: 'subscribe',   tournamentId: string }
 *     { type: 'update',      tournamentId: string, tournament: Object }
 *     { type: 'ping' }
 *
 *   Server → Client:
 *     { type: 'update',      tournamentId: string, tournament: Object }
 *     { type: 'subscribed',  tournamentId: string }
 *     { type: 'pong' }
 *     { type: 'error',       message: string }
 *
 * Usage:
 *   RealtimeSync.connect('wss://your-server/ws');
 *   RealtimeSync.subscribe('TOURNAMENT-ID-123');
 *   RealtimeSync.broadcast(tournament);          // call after every update
 *   RealtimeSync.disconnect();
 *
 *   RealtimeSync.onUpdate = (tournament) => { ... };   // set your handler
 */

'use strict';

const RealtimeSync = (() => {

  // ── Configuration ─────────────────────────────────────────────
  const PING_INTERVAL_MS     = 25_000;   // keepalive ping every 25s
  const RECONNECT_BASE_MS    = 1_000;    // first reconnect after 1s
  const RECONNECT_MAX_MS     = 30_000;   // cap backoff at 30s
  const RECONNECT_MULTIPLIER = 2;        // double each attempt
  const MAX_QUEUE_SIZE       = 50;       // cap outgoing queue

  // ── State ──────────────────────────────────────────────────────
  let _ws               = null;
  let _endpoint         = null;
  let _subscribedId     = null;
  let _pingTimer        = null;
  let _reconnectTimer   = null;
  let _reconnectAttempt = 0;
  let _intentionalClose = false;
  let _outQueue         = [];   // messages queued while disconnected

  // Connection state enum
  const STATE = {
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    RECONNECTING: 'reconnecting',
  };
  let _state = STATE.DISCONNECTED;

  // ── Public callbacks (override these) ─────────────────────────
  /** Called when a tournament update arrives from the server */
  let onUpdate    = null;
  /** Called when connection state changes */
  let onStateChange = null;

  // ================================================================
  // CONNECTION MANAGEMENT
  // ================================================================

  /**
   * Connect to the WebSocket server.
   * @param {string} endpoint — ws:// or wss:// URL
   */
  function connect(endpoint) {
    if (!endpoint) return;
    _endpoint         = endpoint;
    _intentionalClose = false;
    _setState(STATE.CONNECTING);
    _openSocket();
  }

  function _openSocket() {
    if (!_endpoint || !navigator.onLine) {
      _scheduleReconnect();
      return;
    }

    try {
      _ws = new WebSocket(_endpoint);
    } catch (err) {
      console.warn('[WS] Could not open WebSocket:', err.message);
      _setState(STATE.DISCONNECTED);
      _scheduleReconnect();
      return;
    }

    _ws.addEventListener('open', _onOpen);
    _ws.addEventListener('message', _onMessage);
    _ws.addEventListener('close', _onClose);
    _ws.addEventListener('error', _onError);
  }

  function _onOpen() {
    console.log('[WS] Connected to', _endpoint);
    _reconnectAttempt = 0;
    _setState(STATE.CONNECTED);
    updateLiveIndicator(true);

    // Re-subscribe to the active tournament
    if (_subscribedId) {
      _send({ type: 'subscribe', tournamentId: _subscribedId });
    }

    // Flush queued messages
    _flushQueue();

    // Start keepalive pings
    _pingTimer = setInterval(() => {
      _send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  function _onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn('[WS] Received non-JSON message:', event.data);
      return;
    }

    switch (msg.type) {
      case 'update':
        if (msg.tournament && typeof onUpdate === 'function') {
          // Persist to local storage before calling the UI callback
          if (window.Storage) {
            Storage.saveTournament(msg.tournament).catch(err =>
              console.warn('[WS] Could not persist incoming update:', err)
            );
          }
          onUpdate(msg.tournament);
        }
        break;

      case 'subscribed':
        console.log('[WS] Subscribed to tournament:', msg.tournamentId);
        break;

      case 'pong':
        // Keepalive acknowledged — no action needed
        break;

      case 'error':
        console.warn('[WS] Server error:', msg.message);
        break;

      default:
        console.warn('[WS] Unknown message type:', msg.type);
    }
  }

  function _onClose(event) {
    clearInterval(_pingTimer);
    _pingTimer = null;
    updateLiveIndicator(false);

    if (_intentionalClose) {
      _setState(STATE.DISCONNECTED);
      return;
    }

    console.warn(`[WS] Connection closed (code ${event.code}). Reconnecting…`);
    _setState(STATE.RECONNECTING);
    _scheduleReconnect();
  }

  function _onError(event) {
    // WebSocket error events don't carry a message — the close event follows
    console.warn('[WS] Connection error');
  }

  /**
   * Exponential backoff reconnect.
   * Attempts: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …
   */
  function _scheduleReconnect() {
    if (_reconnectTimer) return; // already scheduled
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, _reconnectAttempt),
      RECONNECT_MAX_MS
    );
    _reconnectAttempt++;
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`);
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      if (!_intentionalClose && navigator.onLine) _openSocket();
      else _scheduleReconnect(); // wait until online
    }, delay);
  }

  /**
   * Intentionally close the WebSocket connection.
   */
  function disconnect() {
    _intentionalClose = true;
    clearInterval(_pingTimer);
    clearTimeout(_reconnectTimer);
    _pingTimer      = null;
    _reconnectTimer = null;
    if (_ws) {
      _ws.close(1000, 'Client disconnect');
      _ws = null;
    }
    _setState(STATE.DISCONNECTED);
    updateLiveIndicator(false);
  }

  // ================================================================
  // SUBSCRIPTION & BROADCAST
  // ================================================================

  /**
   * Subscribe to live updates for a tournament.
   * @param {string} tournamentId
   */
  function subscribe(tournamentId) {
    _subscribedId = tournamentId;
    _send({ type: 'subscribe', tournamentId });
  }

  /**
   * Broadcast an updated tournament to all viewers.
   * Called by the admin app after every match update.
   * @param {Object} tournament
   */
  function broadcast(tournament) {
    if (!tournament?.id) return;
    _send({ type: 'update', tournamentId: tournament.id, tournament });
  }

  // ================================================================
  // INTERNAL SEND & QUEUE
  // ================================================================

  function _send(msg) {
    const json = JSON.stringify(msg);
    if (_ws?.readyState === WebSocket.OPEN) {
      _ws.send(json);
    } else {
      // Queue for sending when reconnected (skip pings — stale by then)
      if (msg.type !== 'ping') {
        if (_outQueue.length < MAX_QUEUE_SIZE) {
          _outQueue.push(json);
        } else {
          // Queue full: drop oldest non-subscribe message
          const dropIdx = _outQueue.findIndex(m => !m.includes('"subscribe"'));
          if (dropIdx >= 0) _outQueue.splice(dropIdx, 1);
          _outQueue.push(json);
        }
      }
    }
  }

  function _flushQueue() {
    if (!_outQueue.length || _ws?.readyState !== WebSocket.OPEN) return;
    const toSend = [..._outQueue];
    _outQueue = [];
    toSend.forEach(json => {
      try { _ws.send(json); }
      catch (err) {
        console.warn('[WS] Flush failed for message:', err);
        _outQueue.unshift(json); // put back at front
      }
    });
  }

  // ================================================================
  // STATE & UI HELPERS
  // ================================================================

  function _setState(newState) {
    _state = newState;
    if (typeof onStateChange === 'function') onStateChange(newState, STATE);
  }

  function getState() { return _state; }
  function isConnected() { return _state === STATE.CONNECTED; }

  /**
   * Update the "Live" indicator badge in the bracket topbar.
   * Works in both index.html (admin) and view.html (viewer).
   *
   * @param {boolean} live
   */
  function updateLiveIndicator(live) {
    // Admin topbar
    const badge = document.querySelector('.viewer-badge') ||
                  document.querySelector('#viewer-live-badge');
    if (badge) {
      badge.style.opacity = live ? '1' : '0.4';
      const dot = badge.querySelector('.live-dot');
      if (dot) dot.style.animation = live ? '' : 'none';
      const text = badge.querySelector('span:last-child');
      if (text && !text.classList.contains('live-dot')) {
        text.textContent = live ? 'Live' : 'Offline';
      }
    }

    // Auto-refresh label in viewer
    const refreshInfo = document.getElementById('last-updated-info');
    if (refreshInfo && live) {
      refreshInfo.textContent = '🟢 Connected live — updates stream automatically';
    }
  }

  // ── Reconnect when browser goes online ───────────────────────
  window.addEventListener('online', () => {
    if (!_intentionalClose && _endpoint && _state !== STATE.CONNECTED) {
      console.log('[WS] Network online — reconnecting');
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
      _reconnectAttempt = 0;
      _openSocket();
    }
  });

  window.addEventListener('offline', () => {
    console.log('[WS] Network offline — pausing reconnect');
    updateLiveIndicator(false);
  });

  // ================================================================
  // PUBLIC API
  // ================================================================

  return {
    connect,
    disconnect,
    subscribe,
    broadcast,
    isConnected,
    getState,
    STATE,

    // Settable callbacks
    get onUpdate()      { return onUpdate; },
    set onUpdate(fn)    { onUpdate = fn; },
    get onStateChange() { return onStateChange; },
    set onStateChange(fn) { onStateChange = fn; },
  };

})();

window.RealtimeSync = RealtimeSync;
