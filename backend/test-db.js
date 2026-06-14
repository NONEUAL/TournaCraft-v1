require('dotenv').config();
const { Pool } = require('pg');
console.log('Testing connection to:', process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.connect((err, client, release) => {
  if (err) {
    console.error('Connection error:', err.message);
  } else {
    console.log('✓ Database connected successfully!');
    release();
  }
  process.exit();
});
