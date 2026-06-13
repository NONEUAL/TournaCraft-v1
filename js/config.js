/**
 * js/config.js
 *
 * Runtime configuration — edit this file when deploying to set
 * your backend URL. This is the ONLY file you need to change
 * when moving between local dev, staging, and production.
 *
 * How to configure:
 *   1. Local dev (no backend):      leave both null — fully offline mode
 *   2. Local dev (with backend):    set to localhost URLs below
 *   3. Production on Railway:       set to your Railway backend URL
 *
 * Do NOT hardcode these in app.js or view.html — keep them here.
 */

(function () {
  'use strict';

  // ── Backend REST API base URL ──────────────────────────────
  // Used by storage.js to sync tournaments to the cloud.
  // Set to null to run in fully-offline mode (no cloud sync).
  //
  // Examples:
  //   null                                    — offline only
  //   'http://localhost:3000'                 — local backend
  //   'https://province-games.railway.app'   — production
  window.CLOUD_ENDPOINT = null;

  // ── WebSocket URL ──────────────────────────────────────────
  // Used by websocket.js for real-time bracket updates.
  // Set to null to fall back to 30-second polling in view.html.
  //
  // Examples:
  //   null                                      — polling only
  //   'ws://localhost:3000/ws'                  — local backend
  //   'wss://province-games.railway.app/ws'    — production
  window.WS_ENDPOINT = null;

})();
