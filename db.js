'use strict';

const { pool } = require('./pgClient');

// ── Public API (PostgreSQL) ────────────────────────────────────────────

async function findByKey(idempotency_key) {
  const res = await pool.query('SELECT * FROM payments WHERE idempotency_key = $1', [idempotency_key]);
  return res.rows[0] || null;
}

async function insert({ idempotency_key, ticket_qty, amount_cents, emailOrPhone }) {
  const res = await pool.query(
    'INSERT INTO payments (idempotency_key, ticket_qty, email_or_phone, status) VALUES ($1, $2, $3, $4) RETURNING *',
    [idempotency_key, ticket_qty, emailOrPhone, 'pending']
  );
  return res.rows[0];
}

async function updateStatus(idempotency_key, status) {
  const res = await pool.query(
    'UPDATE payments SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE idempotency_key = $2 RETURNING *',
    [status, idempotency_key]
  );
  return res.rowCount > 0;
}

async function findAccount(emailOrPhone) {
  const res = await pool.query('SELECT * FROM accounts WHERE email_or_phone = $1', [emailOrPhone]);
  return res.rows[0] || null;
}

async function createAccount({ emailOrPhone, password }) {
  const res = await pool.query(
    'INSERT INTO accounts (email_or_phone, password_hash) VALUES ($1, $2) RETURNING *',
    [emailOrPhone, password]
  );
  return res.rows[0];
}

module.exports = { 
  findByKey, 
  insert, 
  updateStatus, 
  findAccount,
  createAccount
};
