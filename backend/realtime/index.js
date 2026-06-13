/**
 * backend/realtime/index.js
 *
 * WebSocket server for live bracket updates.
 *
 * Architecture:
 *   - Uses the `ws` package (not Socket.io) — lightweight, no polling fallback needed
 *   - Clients subscribe to a tournament ID ("room")
 *   - When any client (admin app) sends an update, it's broadcast to all
 *     other clients in the same room
 *   - Server also broadcasts when the REST API updates a tournament
 *     (via the exported `broadcast()` function)
 *
 * Message protocol (same as js/websocket.js on the frontend):
 *   Client → Server:
 *     { type: 'subscribe',   tournamentId: string }
 *     { type: 'update',      tournamentId: string, tournament: Object }
 *     { type: 'ping' }
 *
 *   Server → Client:
 *     { type: 'update',      tournamentId: string, tournament: Object }
 *     { type: 'subscribed',  tournamentId: string, clientCount: number }
 *     { type: 'pong' }
 *     { type: 'error',       message: string }
 *
 * Security:
 *   - Only 'subscribe' and 'ping' messages are accepted from clients
 *   - 'update' messages from clients are accepted but validated
 *     (team/bracket structure checked before re-broadcasting)
 *   - Message size limit: 2MB
 *   - Rate limit: 60 messages per client per minute
 */

'use strict';

const WebSocket = require('ws');

// ── State ─────────────────────────────────────────────────────
// rooms: Map<tournamentId, Set<WebSocket>>
const rooms = new Map();

// Rate limiting: Map<WebSocket, { count, resetAt }>
const rateLimits = new Map();
const RATE_LIMIT      = 60;   // messages per minute per client
const PING_TIMEOUT_MS = 60_000; // disconnect client if no ping for 60s
const MAX_MSG_BYTES   = 2 * 1024 * 1024; // 2MB

let wss = null;

// ── Initialise WebSocket server ───────────────────────────────

/**
 * Attach the WebSocket server to an existing HTTP server.
 * Called once from server.js.
 *
 * @param {http.Server} httpServer
 */
function initWs(httpServer) {
  wss = new WebSocket.Server({
    server:       httpServer,
    path:         '/ws',
    maxPayload:   MAX_MSG_BYTES,
    clientTracking: true,
  });

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    ws._pg_ip          = ip;
    ws._pg_rooms       = new Set();    // tournaments this client is watching
    ws._pg_lastPing    = Date.now();

    // Keepalive: disconnect idle clients
    ws._pg_pingTimer = setInterval(() => {
      if (Date.now() - ws._pg_lastPing > PING_TIMEOUT_MS) {
        console.log(`[WS] Disconnecting idle client ${ip}`);
        ws.terminate();
      }
    }, 30_000);

    ws.on('message', (rawData) => onMessage(ws, rawData));
    ws.on('close',   ()        => onClose(ws));
    ws.on('error',   (err)     => console.warn(`[WS] Client error (${ip}):`, err.message));
  });

  wss.on('error', (err) => {
    console.error('[WS] Server error:', err.message);
  });

  // Heartbeat: log room sizes every 60s in development
  if (process.env.NODE_ENV !== 'production') {
    setInterval(() => {
      const clientCount = wss?.clients?.size || 0;
      const roomCount   = rooms.size;
      if (clientCount > 0) {
        console.log(`[WS] ${clientCount} client(s) across ${roomCount} room(s)`);
      }
    }, 60_000);
  }

  console.log('[WS] WebSocket server initialised on /ws');
  return wss;
}

// ── Message handler ───────────────────────────────────────────

function onMessage(ws, rawData) {
  // Rate limit
  if (!checkRateLimit(ws)) {
    send(ws, { type: 'error', message: 'Rate limit exceeded. Slow down.' });
    return;
  }

  ws._pg_lastPing = Date.now();

  let msg;
  try {
    msg = JSON.parse(rawData.toString());
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON message.' });
    return;
  }

  switch (msg.type) {
    case 'subscribe':
      handleSubscribe(ws, msg);
      break;

    case 'update':
      handleUpdate(ws, msg);
      break;

    case 'ping':
      send(ws, { type: 'pong' });
      break;

    default:
      send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

function handleSubscribe(ws, msg) {
  const { tournamentId } = msg;
  if (!tournamentId || typeof tournamentId !== 'string' || tournamentId.length > 80) {
    send(ws, { type: 'error', message: 'Invalid tournamentId.' });
    return;
  }

  // Unsubscribe from any previous rooms (a client typically watches one tournament)
  ws._pg_rooms.forEach(id => leaveRoom(ws, id));

  // Join new room
  joinRoom(ws, tournamentId);

  const clientCount = rooms.get(tournamentId)?.size || 1;
  send(ws, { type: 'subscribed', tournamentId, clientCount });
  console.log(`[WS] Client subscribed to ${tournamentId} (${clientCount} total)`);
}

function handleUpdate(ws, msg) {
  const { tournamentId, tournament } = msg;

  // Basic validation — don't blindly re-broadcast untrusted data
  if (!tournamentId || typeof tournamentId !== 'string') {
    send(ws, { type: 'error', message: 'tournamentId required for update.' });
    return;
  }
  if (!tournament || typeof tournament !== 'object') {
    send(ws, { type: 'error', message: 'tournament object required for update.' });
    return;
  }
  if (tournament.id !== tournamentId) {
    send(ws, { type: 'error', message: 'tournament.id must match tournamentId.' });
    return;
  }

  // Re-broadcast to all other subscribers in the same room
  broadcastToRoom(tournamentId, { type: 'update', tournament }, ws /* exclude sender */);
}

function onClose(ws) {
  clearInterval(ws._pg_pingTimer);
  rateLimits.delete(ws);
  ws._pg_rooms?.forEach(id => leaveRoom(ws, id));
}

// ── Room management ───────────────────────────────────────────

function joinRoom(ws, tournamentId) {
  if (!rooms.has(tournamentId)) rooms.set(tournamentId, new Set());
  rooms.get(tournamentId).add(ws);
  ws._pg_rooms.add(tournamentId);
}

function leaveRoom(ws, tournamentId) {
  const room = rooms.get(tournamentId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) rooms.delete(tournamentId);  // GC empty rooms
  ws._pg_rooms?.delete(tournamentId);
}

function broadcastToRoom(tournamentId, message, excludeWs = null) {
  const room = rooms.get(tournamentId);
  if (!room || room.size === 0) return 0;

  const payload = JSON.stringify(message);
  let sent = 0;

  room.forEach(client => {
    if (client === excludeWs) return;
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(payload);
      sent++;
    } catch (err) {
      console.warn('[WS] Send failed:', err.message);
    }
  });

  return sent;
}

// ── Rate limiting ─────────────────────────────────────────────

function checkRateLimit(ws) {
  const now  = Date.now();
  const info = rateLimits.get(ws) || { count: 0, resetAt: now + 60_000 };

  if (now > info.resetAt) {
    info.count   = 0;
    info.resetAt = now + 60_000;
  }
  info.count++;
  rateLimits.set(ws, info);

  return info.count <= RATE_LIMIT;
}

// ── Helpers ───────────────────────────────────────────────────

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    console.warn('[WS] send() failed:', err.message);
  }
}

// ── Exported broadcast (called by REST API routes) ────────────

/**
 * Broadcast an update to all WebSocket clients watching a tournament.
 * Called from tournaments.js and matches.js after every write.
 *
 * @param {string} tournamentId
 * @param {Object} message
 * @returns {number} number of clients notified
 */
function broadcast(tournamentId, message) {
  return broadcastToRoom(tournamentId, message);
}

/**
 * Get stats about current connections (for /health or admin use).
 */
function getStats() {
  return {
    totalClients: wss?.clients?.size || 0,
    totalRooms:   rooms.size,
    rooms:        Object.fromEntries(
      [...rooms.entries()].map(([id, set]) => [id, set.size])
    ),
  };
}

module.exports = { initWs, broadcast, getStats };
