'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/frappe',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        email_or_phone VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        idempotency_key VARCHAR(255) UNIQUE NOT NULL,
        ticket_qty INTEGER NOT NULL,
        email_or_phone VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        processor_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        total_capacity INTEGER NOT NULL,
        available INTEGER NOT NULL
      );
    `);

    // Initialize inventory if empty
    const res = await client.query('SELECT COUNT(*) FROM inventory');
    if (parseInt(res.rows[0].count, 10) === 0) {
      await client.query('INSERT INTO inventory (total_capacity, available) VALUES ($1, $2)', [100, 100]);
    }
    console.log('✅ PostgreSQL Database initialized');
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDB
};
