const express    = require('express');
const crypto     = require('crypto');
const router     = express.Router();
const db         = require('../db');
const sseClients = require('../sseClients');
const inventory  = require('../inventory');
const redis      = require('../redisClient');
const emailOutbox = require('../emailOutbox');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-secret';

/** Constant-time secret comparison — avoids leaking the secret via response timing. */
function secretMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  const { idempotency_key, payment_id, processor_status, webhook_secret } = req.body;

  // Prefer the header; fall back to the body field for older processor builds.
  const providedSecret = req.get('x-webhook-secret') || webhook_secret;
  if (!secretMatches(providedSecret)) {
    console.warn('[webhook] rejected — invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!idempotency_key || !processor_status) {
    return res.status(400).json({ error: 'idempotency_key and processor_status are required' });
  }

  const newStatus = processor_status === 'success' ? 'complete' : 'failed';

  const updated = await db.updateStatus(idempotency_key, newStatus, payment_id);
  if (!updated) {
    console.warn(`[webhook] payment_not_found key=${idempotency_key} status=${processor_status}`);
    return res.status(404).json({ error: 'Payment not found' });
  }

  const record = await db.findByKey(idempotency_key);
  console.log(`[webhook] processed key=${idempotency_key} status=${newStatus} payment_id=${payment_id || 'n/a'}`);
  
  if (newStatus === 'complete' && record && record.email_or_phone) {
    try {
      const job = await emailOutbox.enqueueTicketConfirmation(record);
      if (job) await emailOutbox.processEmailJobById(job.id);
    } catch (err) {
      console.error('[webhook] confirmation queue error:', err.message || err);
    }
  }
  
  if (newStatus === 'failed' && record) {
    await inventory.release(record.ticket_qty);
    console.log(`[webhook] released qty=${record.ticket_qty} key=${idempotency_key}`);
  }

  // ── Notify SSE clients ────────────────────────────────────────────────────
  const event   = newStatus === 'complete' ? 'payment_complete' : 'payment_failed';
  const payload = JSON.stringify({ status: newStatus, idempotency_key });

  // 1. Notify local clients in this worker
  const clients = sseClients.get(idempotency_key) || [];
  clients.forEach(clientRes => {
    try {
      clientRes.write(`event: ${event}\ndata: ${payload}\n\n`);
    } catch (e) {
      console.error('[webhook] SSE write error:', e.message);
    }
  });

  // 2. Notify other workers (across ALL servers) via Redis Pub/Sub
  redis.publish('sse_updates', JSON.stringify({
    idempotency_key,
    event,
    payload
  }));

  sseClients.delete(idempotency_key);

  return res.status(200).json({ received: true, status: newStatus });
});

module.exports = router;
