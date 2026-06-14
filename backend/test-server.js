require("dotenv").config({ path: __dirname + "/.env" });
console.log("DATABASE_URL from .env:", process.env.DATABASE_URL);

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function test() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as time');
    console.log("✅ Database connected! Current time:", result.rows[0].time);
    client.release();
    process.exit(0);
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1);
  }
}

test();
