require("dotenv").config({ path: __dirname + "/.env" });

/**
 * backend/server.js
 *
 * Province Games — Express + WebSocket server
 */

'use strict';

const http    = require('http');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

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
app.use(express.json({ limit: '2mb' }));
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
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
}

// ── Boot ──────────────────────────────────────────────────────
async function start() {
  try {
    await initDb();
    console.log('[DB] Connected');
    
    const server = http.createServer(app);
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
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    console.error('     Set DATABASE_URL in your .env file');
    process.exit(1);
  }
}

start();
