/**
 * backend/database/db.js
 *
 * PostgreSQL connection pool using the `pg` package.
 * All queries go through the pool — never create ad-hoc clients.
 *
 * Usage:
 *   const { query, getClient } = require('./database/db');
 *   const { rows } = await query('SELECT * FROM tournaments WHERE id = $1', [id]);
 */

'use strict';

const { Pool } = require('pg');

let pool = null;

/**
 * Initialise the connection pool and verify connectivity.
 * Call once at startup from server.js.
 */
async function initDb() {
  if (pool) return pool;

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set.');
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // SSL required for Railway/Render/Heroku in production
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
    max:             10,    // max pool size
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Test the connection
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
  });

  return pool;
}

/**
 * Run a parameterised query.
 * @param {string} text    — SQL with $1, $2… placeholders
 * @param {Array}  params  — parameter values
 * @returns {Promise<pg.QueryResult>}
 */
async function query(text, params) {
  if (!pool) throw new Error('Database not initialised. Call initDb() first.');
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const elapsed = Date.now() - start;
    if (elapsed > 500) {
      console.warn(`[DB] Slow query (${elapsed}ms): ${text.slice(0, 80)}`);
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nSQL:', text);
    throw err;
  }
}

/**
 * Get a raw client for multi-statement transactions.
 * Caller must call client.release() when done.
 * @returns {Promise<pg.PoolClient>}
 */
async function getClient() {
  if (!pool) throw new Error('Database not initialised.');
  return pool.connect();
}

/**
 * Run multiple queries in a transaction.
 * Automatically rolls back on error.
 * @param {Function} fn — async (client) => result
 */
async function transaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initDb, query, getClient, transaction };
