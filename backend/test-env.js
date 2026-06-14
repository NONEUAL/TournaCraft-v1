console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Current directory:', process.cwd());
console.log('__dirname:', __dirname);

const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'dev123',
  database: 'province_games',
});

pool.connect()
  .then(() => console.log('✅ Connected!'))
  .catch(err => console.error('❌ Error:', err.message))
  .finally(() => process.exit());
