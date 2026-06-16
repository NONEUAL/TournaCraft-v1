/**
 * backend/server.js
 *
 * Province Games — Express + WebSocket server
 *
 * Provides:
 *   REST API:   /api/tournaments  (CRUD + sync endpoint)
 *   WebSocket:  /ws               (real-time bracket updates)
 *   Static:     serves the frontend in production
 *
 * Stack: Node.js, Express 4, ws (WebSocket), pg (PostgreSQL)
 *
 * Environment variables (set in .env or Railway/Vercel dashboard):
 *   DATABASE_URL    PostgreSQL connection string
 *   PORT            HTTP port (default 3000)
 *   FRONTEND_URL    Allowed CORS origin (default *)
 *   NODE_ENV        'production' | 'development'
 *   JWT_SECRET      Optional: for future auth (not used yet)
 *
 * Setup:
 *   cd backend
 *   npm install
 *   npm start
 */

'use strict';

const http    = require('http');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

// Load .env in development
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch {}
}

const { initDb }       = require('./database/db');
const tournamentsRoute = require('./api/tournaments');
const matchesRoute     = require('./api/matches');
const syncRoute        = require('./api/sync');
const { initWs }       = require('./realtime/index');

// ── Constants ─────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || '3000', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const IS_PROD      = process.env.NODE_ENV === 'production';

// ── App setup ─────────────────────────────────────────────────
const app = express();

// Security headers (relaxed for development)
app.use(helmet({
  contentSecurityPolicy: IS_PROD ? undefined : false,
  crossOriginEmbedderPolicy: false,
}));

// CORS — allow the frontend origin
app.use(cors({
  origin:      FRONTEND_URL === '*' ? true : FRONTEND_URL.split(',').map(s => s.trim()),
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id'],
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '2mb' }));      // tournament data can be up to ~200KB
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(morgan(IS_PROD ? 'combined' : 'dev'));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: Date.now(),
    version:   process.env.npm_package_version || '1.0.0',
    env:       process.env.NODE_ENV || 'development',
  });
});

// ── API routes ────────────────────────────────────────────────
app.use('/api/tournaments', tournamentsRoute);
app.use('/api/matches',     matchesRoute);
app.use('/api/sync',        syncRoute);

// ── Static frontend (production only) ─────────────────────────
if (IS_PROD) {
  const frontendDir = path.join(__dirname, '..');
  app.use(express.static(frontendDir, {
    maxAge: '1d',
    etag:   true,
  }));
  // SPA fallback — everything not matched goes to index.html
  app.get('*', (req, res) => {
    // Don't catch API routes that 404
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
}

// ── Global error handler ──────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.message);

  // Don't leak stack traces in production
  const message = IS_PROD
    ? 'An unexpected error occurred. Please try again.'
    : err.message;

  res.status(err.status || 500).json({
    error:   message,
    ...(IS_PROD ? {} : { stack: err.stack }),
  });
});

// ── Boot ──────────────────────────────────────────────────────
async function start() {
  // Connect to database first
  try {
    await initDb();
    console.log('[DB] Connected');
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    console.error('     Set DATABASE_URL in your .env file');
    process.exit(1);
  }

  // Create HTTP server (needed to attach WebSocket server to same port)
  const server = http.createServer(app);

  // Attach WebSocket server at /ws
  initWs(server);

  server.listen(PORT, () => {
    console.log(`[Server] Province Games running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[Server] CORS origin:  ${FRONTEND_URL}`);
    console.log(`[Server] WebSocket:    ws://localhost:${PORT}/ws`);
    if (!IS_PROD) {
      console.log(`[Server] API docs:     http://localhost:${PORT}/api/tournaments`);
    }
  });

  // ── Graceful shutdown ────────────────────────────────────────
  function shutdown(signal) {
    console.log(`\n[Server] ${signal} received — shutting down gracefully`);
    server.close(() => {
      console.log('[Server] HTTP server closed');
      process.exit(0);
    });
    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => {
      console.error('[Server] Forced exit after timeout');
      process.exit(1);
    }, 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start();
