const express = require('express');
const router  = express.Router();
const db      = require('../db');
const sseClients = require('../sseClients');
const inventory = require('../inventory');
const { sendTicketConfirmation } = require('../mailer');

// Price per ticket in cents ($45.00)
const PRICE_PER_TICKET_CENTS = 4500;

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

  const qty = parseInt(ticket_qty, 10);
  if (isNaN(qty) || qty < 1 || qty > 10) {
    return res.status(400).json({ error: 'ticket_qty must be between 1 and 10' });
  }

  // ── Idempotency check ─────────────────────────────────────────────────────

  const existing = await db.findByKey(idempotency_key);
  if (existing) {
    console.log(`[payments] replayed key: ${idempotency_key} (status: ${existing.status})`);
    return res.status(200).json({ ...existing, replayed: true });
  }
  // ── Real-time Inventory Check ─────────────────────────────────────────────
  const reserved = await inventory.reserve(qty);
  if (!reserved) {
    console.warn(`[payments] sold out (requested: ${qty}, available: ${await inventory.getAvailable()})`);
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


  console.log(`[payments] created payment #${record.id} for key: ${idempotency_key}`);

  // ── Call payment processor (simulated, non-blocking) ──────────────────────
  // In production: POST to Stripe / Adyen / etc. with the idempotency_key header.
  if (process.env.VERCEL) {
    // 1. Mark payment as complete synchronously to prevent background timer freeze on Vercel
    await db.updateStatus(idempotency_key, 'complete');
    
    // 2. Fetch the fully completed record
    const completedRecord = await db.findByKey(idempotency_key);
    
    // 3. Order confirmation — must await on Vercel: the invocation freezes after the
    //    response is sent, so a fire-and-forget SMTP call often never completes.
    if (completedRecord && completedRecord.email_or_phone) {
      try {
        await sendTicketConfirmation({
          ...completedRecord,
          customer_name: customerName || completedRecord.customer_name,
        });
      } catch (err) {
        console.error('[payments] confirmation email failed:', err && err.message, err);
      }
    }

    return res.status(200).json({ ...completedRecord, replayed: false });
  } else {
    callMockProcessor(idempotency_key, amount_cents);
    return res.status(202).json({ ...record, replayed: false });
  }
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
    res.write(`event: payment_complete\ndata: ${JSON.stringify({ status: 'complete' })}\n\n`);
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
function callMockProcessor(idempotency_key, amount_cents) {
  const http = require('http');
  const port = process.env.PORT || 3000;
  const webhook_url = `http://localhost:${port}/api/webhook`;

  const body = JSON.stringify({
    idempotency_key,
    amount_cents,
    currency: 'usd',
    webhook_url
  });

  const req = http.request({
    hostname: 'localhost',
    port: process.env.PROCESSOR_PORT || 3001,
    path: '/charge',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  });

  req.on('error', err =>
    console.error('[payments] call to mock processor failed:', err.message)
  );
  req.write(body);
  req.end();
}

module.exports = router;
