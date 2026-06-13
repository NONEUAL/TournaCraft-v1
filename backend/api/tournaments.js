/**
 * backend/api/tournaments.js
 *
 * REST API for tournaments.
 *
 * Routes:
 *   GET    /api/tournaments              — list all (admin; paginated)
 *   GET    /api/tournaments/:id          — get one by ID
 *   GET    /api/tournaments/code/:code   — get one by share code (viewer)
 *   POST   /api/tournaments              — create
 *   PUT    /api/tournaments/:id          — full replace (offline sync upsert)
 *   PATCH  /api/tournaments/:id          — partial update
 *   DELETE /api/tournaments/:id          — soft delete
 *
 * All responses: { data: ... } on success, { error: string } on failure.
 * Timestamps are epoch milliseconds throughout to match the frontend.
 */

'use strict';

const router = require('express').Router();
const { query, transaction } = require('../database/db');
const { broadcast } = require('../realtime/index');
const { sanitiseInput, validateShareCode, validateTournamentId } = require('./validate');

// ── GET /api/tournaments — list (paginated, newest first) ─────
router.get('/', async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50',  10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);
    const status = req.query.status || null;  // filter by 'active' | 'done'

    const baseQuery = status
      ? `SELECT id, share_code, name, game, format, status, created_at, updated_at,
               jsonb_array_length(COALESCE(data->'teams','[]'::jsonb)) AS team_count
         FROM tournaments
         WHERE deleted = FALSE AND status = $3
         ORDER BY updated_at DESC LIMIT $1 OFFSET $2`
      : `SELECT id, share_code, name, game, format, status, created_at, updated_at,
               jsonb_array_length(COALESCE(data->'teams','[]'::jsonb)) AS team_count
         FROM tournaments
         WHERE deleted = FALSE
         ORDER BY updated_at DESC LIMIT $1 OFFSET $2`;

    const params = status ? [limit, offset, status] : [limit, offset];
    const { rows } = await query(baseQuery, params);

    res.json({ data: rows, meta: { limit, offset, count: rows.length } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tournaments/code/:code — look up by share code ───
router.get('/code/:code', async (req, res, next) => {
  try {
    const code = req.params.code?.toUpperCase();
    if (!validateShareCode(code)) {
      return res.status(400).json({ error: 'Invalid share code format.' });
    }

    const { rows } = await query(
      'SELECT data FROM tournaments WHERE share_code = $1 AND deleted = FALSE LIMIT 1',
      [code]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: 'Tournament not found. Check the share code and try again.'
      });
    }

    res.json({ data: rows[0].data });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tournaments/:id — get one by ID ──────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validateTournamentId(id)) {
      return res.status(400).json({ error: 'Invalid tournament ID.' });
    }

    const { rows } = await query(
      'SELECT data FROM tournaments WHERE id = $1 AND deleted = FALSE LIMIT 1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Tournament not found.' });
    }

    res.json({ data: rows[0].data });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tournaments — create new tournament ─────────────
router.post('/', async (req, res, next) => {
  try {
    const t = req.body;
    const validation = validateTournamentBody(t);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.message });
    }

    const now = Date.now();
    t.createdAt = t.createdAt || now;
    t.updatedAt = now;

    await query(
      `INSERT INTO tournaments
         (id, share_code, name, game, format, status, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        t.id, t.shareCode, sanitiseInput(t.name),
        t.game, t.format, t.status || 'active',
        t.createdAt, t.updatedAt, JSON.stringify(t),
      ]
    );

    res.status(201).json({ data: t });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/tournaments/:id — upsert (offline sync) ──────────
// This is the primary sync endpoint. The frontend sends the full
// tournament object; we apply last-write-wins conflict resolution.
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validateTournamentId(id)) {
      return res.status(400).json({ error: 'Invalid tournament ID.' });
    }
    if (id !== req.body?.id) {
      return res.status(400).json({ error: 'ID in URL must match ID in body.' });
    }

    const t = req.body;
    const validation = validateTournamentBody(t);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.message });
    }

    const now = Date.now();
    t.updatedAt = Math.max(t.updatedAt || now, now);

    // Last-write-wins: only update if incoming updatedAt is newer than stored
    const result = await transaction(async (client) => {
      const { rows: existing } = await client.query(
        'SELECT updated_at FROM tournaments WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (existing.length && existing[0].updated_at > t.updatedAt) {
        // Server has a newer version — return conflict with server's version
        const { rows: current } = await client.query(
          'SELECT data FROM tournaments WHERE id = $1',
          [id]
        );
        return { conflict: true, data: current[0]?.data };
      }

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
          t.id, t.shareCode, sanitiseInput(t.name),
          t.game, t.format, t.status || 'active',
          t.createdAt || now, t.updatedAt, JSON.stringify(t),
        ]
      );

      // Log the sync operation
      await client.query(
        `INSERT INTO sync_log (tournament_id, operation, client_id)
         VALUES ($1, 'update', $2)`,
        [id, req.headers['x-client-id'] || null]
      );

      return { conflict: false, data: t };
    });

    if (result.conflict) {
      return res.status(409).json({
        error:   'Conflict: server has a newer version.',
        data:    result.data,
        message: 'The server has changes made after your last sync. Your local changes were not saved.',
      });
    }

    // Broadcast to all WebSocket clients watching this tournament
    broadcast(id, { type: 'update', tournament: t });

    res.json({ data: result.data });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/tournaments/:id — partial update ───────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validateTournamentId(id)) {
      return res.status(400).json({ error: 'Invalid tournament ID.' });
    }

    // Merge patch into stored JSONB
    const now = Date.now();
    const { rows } = await query(
      `UPDATE tournaments
       SET data       = data || $2::jsonb,
           updated_at = $3,
           status     = COALESCE(($2::jsonb->>'status')::text, status)
       WHERE id = $1 AND deleted = FALSE
       RETURNING data`,
      [id, JSON.stringify({ ...req.body, updatedAt: now }), now]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Tournament not found.' });
    }

    const updated = rows[0].data;
    broadcast(id, { type: 'update', tournament: updated });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/tournaments/:id — soft delete ─────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validateTournamentId(id)) {
      return res.status(400).json({ error: 'Invalid tournament ID.' });
    }

    const now = Date.now();
    const { rowCount } = await query(
      `UPDATE tournaments
       SET deleted = TRUE, deleted_at = $2, updated_at = $2
       WHERE id = $1 AND deleted = FALSE`,
      [id, now]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'Tournament not found.' });
    }

    // Notify viewers that the tournament was removed
    broadcast(id, { type: 'deleted', tournamentId: id });

    res.json({ data: { id, deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ── Validation helpers ────────────────────────────────────────

function validateTournamentBody(t) {
  if (!t || typeof t !== 'object') {
    return { valid: false, message: 'Request body must be a tournament object.' };
  }
  if (!t.id || typeof t.id !== 'string' || t.id.length > 80) {
    return { valid: false, message: 'Tournament must have a valid id.' };
  }
  if (!t.shareCode || typeof t.shareCode !== 'string') {
    return { valid: false, message: 'Tournament must have a shareCode.' };
  }
  if (!t.name || typeof t.name !== 'string' || t.name.trim().length === 0) {
    return { valid: false, message: 'Tournament must have a name.' };
  }
  if (t.name.length > 120) {
    return { valid: false, message: 'Tournament name must be 120 characters or fewer.' };
  }
  return { valid: true };
}

module.exports = router;
