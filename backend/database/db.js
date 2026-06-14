'use strict';

const { Pool } = require('pg');
console.log('[DB] Loading database module...');

// Database connection - using explicit parameters
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || null,
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'dev123',
  database: process.env.DB_NAME     || 'province_games',
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

console.log('[DB] Pool created with config:', {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '***',
  database: 'province_games'
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err);
});

async function initDb() {
  console.log('[DB] initDb called, testing connection...');
  let client;
  try {
    client = await pool.connect();
    console.log('[DB] Got client, running test query...');
    const result = await client.query('SELECT NOW() as current_time');
    console.log('[DB] Query successful, current time:', result.rows[0].current_time);
    client.release();
    console.log('[DB] ✅ Connected to PostgreSQL successfully');
    return pool;
  } catch (err) {
    console.error('[DB] ❌ Connection failed - Full error:', err);
    console.error('[DB] Error code:', err.code);
    console.error('[DB] Error message:', err.message);
    if (client) client.release();
    throw err;
  }
}

async function query(text, params) {
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

async function getClient() {
  return pool.connect();
}

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
