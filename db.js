'use strict';

const { pool } = require('./pgClient');

let fallbackMode = false;

function nowIso() {
  return new Date().toISOString();
}

function createMemoryStore() {
  const paymentsByKey = new Map();
  const paymentsById = new Map();
  const accounts = new Map();
  const emailJobs = new Map();
  const attendees = new Map();
  let paymentSeq = 1;
  let emailJobSeq = 1;
  let attendeeSeq = 1;

  return {
    async upsertPayment(record) {
      if (!record || !record.idempotency_key) return null;
      const existing = paymentsByKey.get(record.idempotency_key);
      const normalized = {
        ...existing,
        ...record,
        id: record.id || existing?.id || paymentSeq,
        idempotency_key: record.idempotency_key,
        ticket_qty: record.ticket_qty,
        amount_cents: record.amount_cents,
        customer_name: record.customer_name ?? record.customerName ?? null,
        email_or_phone: record.email_or_phone ?? record.emailOrPhone ?? null,
        status: record.status || 'pending',
        processor_id: record.processor_id ?? null,
        email_sent_at: record.email_sent_at ?? null,
        created_at: record.created_at || nowIso(),
        updated_at: record.updated_at || nowIso(),
      };
      if (!normalized.id || normalized.id >= paymentSeq) {
        paymentSeq = normalized.id + 1;
      }
      paymentsByKey.set(normalized.idempotency_key, normalized);
      paymentsById.set(normalized.id, normalized);
      return normalized;
    },
    async findByKey(idempotency_key) {
      return paymentsByKey.get(idempotency_key) || null;
    },
    async findPaymentById(id) {
      return paymentsById.get(id) || null;
    },
    async insert({ idempotency_key, ticket_qty, amount_cents, customerName, emailOrPhone, accountId }) {
      const record = {
        id: paymentSeq++,
        idempotency_key,
        ticket_qty,
        amount_cents,
        customer_name: customerName || null,
        email_or_phone: emailOrPhone || null,
        account_id: accountId || null,
        status: 'pending',
        processor_id: null,
        email_sent_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      paymentsByKey.set(idempotency_key, record);
      paymentsById.set(record.id, record);
      return record;
    },
    async updateStatus(idempotency_key, status, processor_id) {
      const existing = paymentsByKey.get(idempotency_key);
      if (!existing) return false;
      existing.status = status;
      if (processor_id) existing.processor_id = processor_id;
      existing.updated_at = nowIso();
      paymentsByKey.set(idempotency_key, existing);
      paymentsById.set(existing.id, existing);
      return true;
    },
    async markPaymentEmailSent(payment_id) {
      const payment = await this.findPaymentById(payment_id);
      if (!payment) return null;
      payment.email_sent_at = nowIso();
      payment.updated_at = nowIso();
      paymentsByKey.set(payment.idempotency_key, payment);
      paymentsById.set(payment.id, payment);
      return payment;
    },
    async enqueueEmailJob({ idempotency_key, type, payment_id, payload = {} }) {
      const existing = Array.from(emailJobs.values()).find(job => job.idempotency_key === idempotency_key);
      if (existing) {
        existing.updated_at = nowIso();
        return existing;
      }
      const job = {
        id: emailJobSeq++,
        idempotency_key,
        type,
        payment_id,
        payload,
        status: 'queued',
        attempts: 0,
        max_attempts: 5,
        locked_at: null,
        next_attempt_at: nowIso(),
        sent_at: null,
        provider_message_id: null,
        last_error: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      emailJobs.set(job.id, job);
      return job;
    },
    async claimNextEmailJob() {
      const readyJobs = Array.from(emailJobs.values())
        .filter(job => job.attempts < job.max_attempts && job.status !== 'sent')
        .sort((a, b) => a.id - b.id);
      const job = readyJobs[0] || null;
      if (!job) return null;
      job.status = 'sending';
      job.attempts += 1;
      job.locked_at = nowIso();
      job.updated_at = nowIso();
      return job;
    },
    async claimEmailJobById(id) {
      const job = emailJobs.get(id);
      if (!job) return null;
      if (job.attempts >= job.max_attempts || job.status === 'sent') return null;
      job.status = 'sending';
      job.attempts += 1;
      job.locked_at = nowIso();
      job.updated_at = nowIso();
      return job;
    },
    async completeEmailJob(id, provider_message_id) {
      const job = emailJobs.get(id);
      if (!job) return null;
      job.status = 'sent';
      job.provider_message_id = provider_message_id || null;
      job.sent_at = nowIso();
      job.locked_at = null;
      job.last_error = null;
      job.updated_at = nowIso();
      return job;
    },
    async failEmailJob(id, error, next_attempt_at) {
      const job = emailJobs.get(id);
      if (!job) return null;
      job.status = job.attempts >= job.max_attempts ? 'dead' : 'failed';
      job.locked_at = null;
      job.next_attempt_at = next_attempt_at ? next_attempt_at.toISOString() : nowIso();
      job.last_error = error && error.message ? error.message : String(error || 'Unknown error');
      job.updated_at = nowIso();
      return job;
    },
    async findAccount(emailOrPhone) {
      return accounts.get(emailOrPhone) || null;
    },
    async createAccount({ emailOrPhone, passwordHash }) {
      const account = {
        id: accounts.size + 1,
        email_or_phone: emailOrPhone,
        password_hash: passwordHash,
        created_at: nowIso(),
      };
      accounts.set(emailOrPhone, account);
      return account;
    },
    async addAttendee({ name, email }) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const normalizedName = String(name || '').trim();
      if (!normalizedName || !normalizedEmail) return null;
      const id = attendeeSeq++;
      const record = {
        id,
        name: normalizedName,
        email: normalizedEmail,
        created_at: nowIso(),
      };
      attendees.set(id, record);
      return record;
    },
    async listAttendees() {
      return Array.from(attendees.values()).sort((a, b) => b.id - a.id);
    },
  };
}

const memoryStore = createMemoryStore();

function handleFallback(err, fallbackImpl) {
  if (!fallbackMode) {
    fallbackMode = true;
    console.warn(`[db] PostgreSQL unavailable, using in-memory fallback (${err.message || err})`);
  }
  return fallbackImpl();
}

// ── Public API (PostgreSQL with in-memory fallback) ───────────────────────

async function findByKey(idempotency_key) {
  if (fallbackMode) return memoryStore.findByKey(idempotency_key);
  try {
    const res = await pool.query('SELECT * FROM payments WHERE idempotency_key = $1', [idempotency_key]);
    const record = res.rows[0] || null;
    if (record) {
      await memoryStore.upsertPayment(record);
    }
    return record;
  } catch (err) {
    return handleFallback(err, () => memoryStore.findByKey(idempotency_key));
  }
}

async function findPaymentById(id) {
  if (fallbackMode) return memoryStore.findPaymentById(id);
  try {
    const res = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    const record = res.rows[0] || null;
    if (record) {
      await memoryStore.upsertPayment(record);
    }
    return record;
  } catch (err) {
    return handleFallback(err, () => memoryStore.findPaymentById(id));
  }
}

async function insert({ idempotency_key, ticket_qty, amount_cents, customerName, emailOrPhone, accountId }) {
  const args = { idempotency_key, ticket_qty, amount_cents, customerName, emailOrPhone, accountId };
  if (fallbackMode) return memoryStore.insert(args);
  try {
    const res = await pool.query(
      `
        INSERT INTO payments (
          idempotency_key,
          ticket_qty,
          amount_cents,
          customer_name,
          email_or_phone,
          account_id,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [idempotency_key, ticket_qty, amount_cents, customerName, emailOrPhone, accountId || null, 'pending']
    );
    const record = res.rows[0];
    if (record) {
      await memoryStore.upsertPayment(record);
    }
    return record;
  } catch (err) {
    return handleFallback(err, () => memoryStore.insert(args));
  }
}

async function updateStatus(idempotency_key, status, processor_id) {
  if (fallbackMode) return memoryStore.updateStatus(idempotency_key, status, processor_id);
  try {
    const res = await pool.query(
      `
        UPDATE payments
        SET status = $1,
            processor_id = COALESCE($3, processor_id),
            updated_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = $2
        RETURNING *
      `,
      [status, idempotency_key, processor_id || null]
    );
    const record = res.rows[0] || null;
    if (record) {
      await memoryStore.upsertPayment(record);
    }
    return res.rowCount > 0;
  } catch (err) {
    return handleFallback(err, () => memoryStore.updateStatus(idempotency_key, status, processor_id));
  }
}

async function markPaymentEmailSent(payment_id) {
  if (fallbackMode) return memoryStore.markPaymentEmailSent(payment_id);
  try {
    const res = await pool.query(
      `
        UPDATE payments
        SET email_sent_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `,
      [payment_id]
    );
    const record = res.rows[0] || null;
    if (record) {
      await memoryStore.upsertPayment(record);
    }
    return record;
  } catch (err) {
    return handleFallback(err, () => memoryStore.markPaymentEmailSent(payment_id));
  }
}

async function enqueueEmailJob({ idempotency_key, type, payment_id, payload = {} }) {
  if (fallbackMode) return memoryStore.enqueueEmailJob({ idempotency_key, type, payment_id, payload });
  try {
    const res = await pool.query(
      `
        INSERT INTO email_jobs (idempotency_key, type, payment_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (idempotency_key) DO UPDATE
        SET updated_at = email_jobs.updated_at
        RETURNING *
      `,
      [idempotency_key, type, payment_id, JSON.stringify(payload)]
    );
    return res.rows[0];
  } catch (err) {
    return handleFallback(err, () => memoryStore.enqueueEmailJob({ idempotency_key, type, payment_id, payload }));
  }
}

async function claimNextEmailJob() {
  if (fallbackMode) return memoryStore.claimNextEmailJob();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`
        SELECT *
        FROM email_jobs
        WHERE attempts < max_attempts
          AND next_attempt_at <= CURRENT_TIMESTAMP
          AND (
            status IN ('queued', 'failed')
            OR (status = 'sending' AND locked_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
          )
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);

      if (selected.rowCount === 0) {
        await client.query('COMMIT');
        return null;
      }

      const job = selected.rows[0];
      const updated = await client.query(
        `
          UPDATE email_jobs
          SET status = 'sending',
              attempts = attempts + 1,
              locked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
        `,
        [job.id]
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return handleFallback(err, () => memoryStore.claimNextEmailJob());
  }
}

async function claimEmailJobById(id) {
  if (fallbackMode) return memoryStore.claimEmailJobById(id);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `
          SELECT *
          FROM email_jobs
          WHERE id = $1
            AND attempts < max_attempts
            AND (
              status IN ('queued', 'failed')
              OR (status = 'sending' AND locked_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
            )
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [id]
      );

      if (selected.rowCount === 0) {
        await client.query('COMMIT');
        return null;
      }

      const updated = await client.query(
        `
          UPDATE email_jobs
          SET status = 'sending',
              attempts = attempts + 1,
              locked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
        `,
        [id]
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return handleFallback(err, () => memoryStore.claimEmailJobById(id));
  }
}

async function completeEmailJob(id, provider_message_id) {
  if (fallbackMode) return memoryStore.completeEmailJob(id, provider_message_id);
  try {
    const res = await pool.query(
      `
        UPDATE email_jobs
        SET status = 'sent',
            provider_message_id = $2,
            sent_at = CURRENT_TIMESTAMP,
            locked_at = NULL,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `,
      [id, provider_message_id || null]
    );
    return res.rows[0] || null;
  } catch (err) {
    return handleFallback(err, () => memoryStore.completeEmailJob(id, provider_message_id));
  }
}

async function failEmailJob(id, error, next_attempt_at) {
  if (fallbackMode) return memoryStore.failEmailJob(id, error, next_attempt_at);
  try {
    const errorMessage = error && error.message ? error.message : String(error || 'Unknown error');
    const res = await pool.query(
      `
        UPDATE email_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'failed' END,
            locked_at = NULL,
            next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE $3 END,
            last_error = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `,
      [id, errorMessage.slice(0, 2000), next_attempt_at]
    );
    return res.rows[0] || null;
  } catch (err) {
    return handleFallback(err, () => memoryStore.failEmailJob(id, error, next_attempt_at));
  }
}

async function findAccount(emailOrPhone) {
  if (fallbackMode) return memoryStore.findAccount(emailOrPhone);
  try {
    const res = await pool.query('SELECT * FROM accounts WHERE email_or_phone = $1', [emailOrPhone]);
    return res.rows[0] || null;
  } catch (err) {
    return handleFallback(err, () => memoryStore.findAccount(emailOrPhone));
  }
}

async function createAccount({ emailOrPhone, passwordHash }) {
  if (fallbackMode) return memoryStore.createAccount({ emailOrPhone, passwordHash });
  try {
    const res = await pool.query(
      'INSERT INTO accounts (email_or_phone, password_hash) VALUES ($1, $2) RETURNING id, email_or_phone, created_at',
      [emailOrPhone, passwordHash]
    );
    return res.rows[0];
  } catch (err) {
    return handleFallback(err, () => memoryStore.createAccount({ emailOrPhone, passwordHash }));
  }
}

async function addAttendee({ name, email }) {
  if (fallbackMode) return memoryStore.addAttendee({ name, email });
  try {
    const res = await pool.query(
      'INSERT INTO attendees (name, email) VALUES ($1, $2) RETURNING id, name, email, created_at',
      [String(name || '').trim(), String(email || '').trim().toLowerCase()]
    );
    return res.rows[0];
  } catch (err) {
    return handleFallback(err, () => memoryStore.addAttendee({ name, email }));
  }
}

async function listAttendees() {
  if (fallbackMode) return memoryStore.listAttendees();
  try {
    const res = await pool.query('SELECT id, name, email, created_at FROM attendees ORDER BY id DESC');
    return res.rows;
  } catch (err) {
    return handleFallback(err, () => memoryStore.listAttendees());
  }
}

module.exports = {
  findByKey,
  findPaymentById,
  insert,
  updateStatus,
  markPaymentEmailSent,
  enqueueEmailJob,
  claimNextEmailJob,
  claimEmailJobById,
  completeEmailJob,
  failEmailJob,
  findAccount,
  createAccount,
  addAttendee,
  listAttendees
};
