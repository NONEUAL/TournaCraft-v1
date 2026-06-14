// Add this before the pool creation in server.js
// Replace the existing pool initialization with:
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'dev123',
  database: process.env.DB_NAME || 'province_games',
});
