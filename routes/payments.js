const express = require('express');
const router  = express.Router();
const db      = require('../db');
const sseClients = require('../sseClients');
const inventory = require('../inventory');
const emailOutbox = require('../emailOutbox');
const redis = require('../redisClient');

// Price per ticket in cents ($45.00)
const PRICE_PER_TICKET_CENTS = 4500;

async function finalizePayment(idempotency_key) {
  const updated = await db.updateStatus(idempotency_key, 'complete');
  const completedRecord = await db.findByKey(idempotency_key);

  let confirmation = null;
  if (completedRecord) {
    try {
      if (!process.env.VERCEL && process.env.NODE_ENV !== 'production') {
        confirmation = await emailOutbox.processTicketConfirmationInline(completedRecord);
      } else {
        const job = await emailOutbox.enqueueTicketConfirmation(completedRecord);
        if (job) {
          confirmation = await emailOutbox.processEmailJobById(job.id);
        }
      }
    } catch (err) {
      console.error('[payments] confirmation queue failed:', err && err.message, err);
    }
  }

  const confirmationInfo = confirmation && confirmation.ok
    ? { status: confirmation.status, mode: confirmation.mode, previewUrl: confirmation.previewUrl, messageId: confirmation.messageId }
    : { status: 'queued', mode: null, previewUrl: null, messageId: null };

  // Notify SSE subscribers in-process and across workers.
  const payload = JSON.stringify({ status: 'complete', idempotency_key, confirmation: confirmationInfo });
  const clients = sseClients.get(idempotency_key) || [];
  clients.forEach(clientRes => {
    try {
      clientRes.write(`event: payment_complete\ndata: ${payload}\n\n`);
    } catch (e) {
      console.error('[payments] SSE write error:', e.message);
    }
  });
  sseClients.delete(idempotency_key);
  redis.publish('sse_updates', JSON.stringify({ idempotency_key, event: 'payment_complete', payload }));

  return {
    updated,
    completedRecord: completedRecord ? { ...completedRecord, confirmation: confirmationInfo } : completedRecord,
    confirmation: confirmationInfo,
  };
}

/**
 * POST /api/payments
 * Body: { idempotency_key: string, ticket_qty: number }
 *
 * Idempotent: if a record with the same key already exists, return it as-is.
 */
router.post('/', async (req, res) => {
  const { idempotency_key, ticket_qty, customerName, customerEmail } = req.body;

  if (!idempotency_key || !ticket_qty) {
    return res.status(400).json({ error: 'idempotency_key and ticket_qty are required' });
  }

  if (typeof idempotency_key !== 'string' || idempotency_key.trim().length < 3) {
    return res.status(400).json({ error: 'idempotency_key must be a non-empty string' });
  }

  const qty = parseInt(ticket_qty, 10);
  if (isNaN(qty) || qty < 1 || qty > 10) {
    return res.status(400).json({ error: 'ticket_qty must be between 1 and 10' });
  }

  if (customerName !== undefined && typeof customerName !== 'string') {
    return res.status(400).json({ error: 'customerName must be a string' });
  }

  if (customerEmail !== undefined && typeof customerEmail !== 'string') {
    return res.status(400).json({ error: 'customerEmail must be a string' });
  }

  // ── Idempotency check ─────────────────────────────────────────────────────

  const existing = await db.findByKey(idempotency_key);
  if (existing) {
    console.log(`[payments] replayed key=${idempotency_key} status=${existing.status} qty=${existing.ticket_qty}`);
    const confirmation = existing.status === 'complete' && existing.email_sent_at
      ? { status: 'sent', mode: 'already-sent', previewUrl: null, messageId: null }
      : null;
    return res.status(200).json({ ...existing, replayed: true, confirmation });
  }
  // ── Real-time Inventory Check ─────────────────────────────────────────────
  const reserved = await inventory.reserve(qty);
  if (!reserved) {
    const remaining = await inventory.getAvailable();
    console.warn(`[payments] sold_out key=${idempotency_key} requested=${qty} remaining=${remaining}`);
    return res.status(403).json({ error: 'Tickets are currently sold out.', code: 'SOLD_OUT' });
  }


  // ── New payment: write to DB as pending ───────────────────────────────────
  const amount_cents = qty * PRICE_PER_TICKET_CENTS;
  const record = await db.insert({ 
    idempotency_key, 
    ticket_qty: qty, 
    amount_cents, 
    customerName, 
    emailOrPhone: customerEmail 
  });

  if (customerName || customerEmail) {
    await db.addAttendee({ name: customerName, email: customerEmail });
  }

  console.log(`[payments] created id=${record.id} key=${idempotency_key} qty=${qty} amount_cents=${amount_cents}`);

  // ── Call payment processor (simulated, non-blocking) ──────────────────────
  // In production: POST to Stripe / Adyen / etc. with the idempotency_key header.
  if (process.env.VERCEL) {
    const { completedRecord } = await finalizePayment(idempotency_key);
    return res.status(200).json({ ...completedRecord, replayed: false });
  }

  callMockProcessor(idempotency_key, amount_cents);
  return res.status(202).json({ ...record, replayed: false });
});

/**
 * GET /api/payments/:idempotency_key/status
 * Server-Sent Events — pushes a status event once the webhook fires.
 */
router.get('/:idempotency_key/status', async (req, res) => {
  const { idempotency_key } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Register this SSE client
  if (!sseClients.has(idempotency_key)) {
    sseClients.set(idempotency_key, []);
  }
  sseClients.get(idempotency_key).push(res);

  // Acknowledge connection
  res.write('event: connected\ndata: {}\n\n');

  // If already complete (e.g. page refresh after success), fire immediately
  const existing = await db.findByKey(idempotency_key);
  if (existing && existing.status === 'complete') {
    res.write(`event: payment_complete\ndata: ${JSON.stringify({ status: 'complete', confirmation: { status: 'sent', mode: null, previewUrl: null, messageId: null } })}\n\n`);
  }

  // Clean up on disconnect
  req.on('close', () => {
    const clients  = sseClients.get(idempotency_key) || [];
    const filtered = clients.filter(c => c !== res);
    filtered.length === 0
      ? sseClients.delete(idempotency_key)
      : sseClients.set(idempotency_key, filtered);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the external mock payment processor running on port 3001.
 */
function callMockProcessor(idempotency_key) {
  const delayMs = parseInt(process.env.MOCK_PROCESSOR_DELAY_MS || '2500', 10);

  setTimeout(async () => {
    try {
      await finalizePayment(idempotency_key);
    } catch (err) {
      console.error('[payments] local mock processor failed:', err.message || err);
    }
  }, delayMs);
}

module.exports = router;
