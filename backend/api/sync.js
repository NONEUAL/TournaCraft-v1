/**
 * backend/api/sync.js
 *
 * Bulk offline sync endpoint.
 * When the frontend comes back online it may have a queue of operations
 * accumulated while offline. This endpoint accepts them all in one request
 * and applies them in order, returning the results so the frontend can
 * clear its queue and update any conflicted items.
 *
 * POST /api/sync
 *   Body: { operations: [ { type, id, payload, queuedAt }, ... ] }
 *   Response: { results: [ { id, type, status, data?, conflict? }, ... ] }
 *
 * Operation types:
 *   upsert  — create or update a tournament (last-write-wins)
 *   delete  — soft-delete a tournament
 */

'use strict';

const router   = require('express').Router();
const { query, transaction } = require('../database/db');
const { broadcast } = require('../realtime/index');
const { validateTournamentId, validateShareCode } = require('./validate');

// Max operations per sync request (prevent abuse)
const MAX_OPS = 100;

// ── POST /api/sync ────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { operations } = req.body;

    if (!Array.isArray(operations)) {
      return res.status(400).json({ error: 'Body must contain an operations array.' });
    }
    if (operations.length === 0) {
      return res.json({ results: [], message: 'Nothing to sync.' });
    }
    if (operations.length > MAX_OPS) {
      return res.status(400).json({
        error: `Maximum ${MAX_OPS} operations per sync request. Split into smaller batches.`,
      });
    }

    const results = [];

    for (const op of operations) {
      const result = await processOperation(op, req.headers['x-client-id'] || null);
      results.push(result);

      // Broadcast successful upserts to live viewers
      if (result.status === 'ok' && op.type === 'upsert' && result.data) {
        broadcast(op.id, { type: 'update', tournament: result.data });
      }
    }

    const failed    = results.filter(r => r.status === 'error').length;
    const conflicts = results.filter(r => r.status === 'conflict').length;

    res.json({
      results,
      summary: {
        total:     operations.length,
        ok:        results.filter(r => r.status === 'ok').length,
        conflicts,
        failed,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/sync/delta — fetch changes since a timestamp ─────
// Allows a re-joining viewer to catch up on everything missed.
router.get('/delta', async (req, res, next) => {
  try {
    const since = parseInt(req.query.since || '0', 10);
    if (isNaN(since) || since < 0) {
      return res.status(400).json({ error: 'since must be a non-negative epoch millisecond timestamp.' });
    }

    const { rows } = await query(
      `SELECT data FROM tournaments
       WHERE updated_at > $1 AND deleted = FALSE
       ORDER BY updated_at DESC
       LIMIT 50`,
      [since]
    );

    res.json({
      data:      rows.map(r => r.data),
      serverTime: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

// ── Operation processor ───────────────────────────────────────

async function processOperation(op, clientId) {
  // Basic validation
  if (!op || typeof op !== 'object') {
    return { id: null, type: null, status: 'error', message: 'Invalid operation object.' };
  }
  if (!['upsert', 'delete'].includes(op.type)) {
    return { id: op.id, type: op.type, status: 'error', message: `Unknown operation type: ${op.type}` };
  }
  if (!validateTournamentId(op.id)) {
    return { id: op.id, type: op.type, status: 'error', message: 'Invalid tournament ID.' };
  }

  try {
    if (op.type === 'upsert') return await processUpsert(op, clientId);
    if (op.type === 'delete') return await processDelete(op, clientId);
  } catch (err) {
    console.error(`[Sync] Operation failed for ${op.id}:`, err.message);
    return { id: op.id, type: op.type, status: 'error', message: 'Server error processing operation.' };
  }
}

async function processUpsert(op, clientId) {
  const t = op.payload;
  if (!t || !t.id || !t.shareCode || !t.name) {
    return { id: op.id, type: 'upsert', status: 'error', message: 'Invalid tournament payload.' };
  }

  const now = Date.now();
  const incomingUpdatedAt = t.updatedAt || op.queuedAt || now;

  return await transaction(async (client) => {
    // Fetch existing with row lock
    const { rows } = await client.query(
      'SELECT updated_at FROM tournaments WHERE id = $1 FOR UPDATE',
      [op.id]
    );

    // Conflict detection: server is newer
    if (rows.length && rows[0].updated_at > incomingUpdatedAt) {
      const { rows: cur } = await client.query(
        'SELECT data FROM tournaments WHERE id = $1',
        [op.id]
      );
      return {
        id:       op.id,
        type:     'upsert',
        status:   'conflict',
        message:  'Server has a newer version. Merge manually or discard your local changes.',
        data:     cur[0]?.data,
      };
    }

    // Apply upsert
    const updatedAt = Math.max(incomingUpdatedAt, now);
    await client.query(
      `INSERT INTO tournaments
         (id, share_code, name, game, format, status, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         share_code = EXCLUDED.share_code,
         name       = EXCLUDED.name,
         game       = EXCLUDED.game,
         format     = EXCLUDED.format,
         status     = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         data       = EXCLUDED.data,
         deleted    = FALSE`,
      [
        t.id, t.shareCode, t.name.slice(0, 120),
        t.game || 'mobile_legends',
        t.format || 'single_elimination',
        t.status || 'active',
        t.createdAt || now, updatedAt,
        JSON.stringify({ ...t, updatedAt }),
      ]
    );

    await client.query(
      'INSERT INTO sync_log (tournament_id, operation, client_id) VALUES ($1, $2, $3)',
      [op.id, 'update', clientId]
    );

    return { id: op.id, type: 'upsert', status: 'ok', data: { ...t, updatedAt } };
  });
}

async function processDelete(op, clientId) {
  const now = Date.now();
  const { rowCount } = await query(
    `UPDATE tournaments
     SET deleted = TRUE, deleted_at = $2, updated_at = $2
     WHERE id = $1 AND deleted = FALSE`,
    [op.id, now]
  );

  if (rowCount) {
    await query(
      'INSERT INTO sync_log (tournament_id, operation, client_id) VALUES ($1, $2, $3)',
      [op.id, 'delete', clientId]
    );
  }

  return { id: op.id, type: 'delete', status: 'ok' };
}

module.exports = router;
