const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const sseClients = require('../sseClients');
const inventory  = require('../inventory');
const redis      = require('../redisClient');
const emailOutbox = require('../emailOutbox');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-secret';

router.post('/', async (req, res) => {
  const { idempotency_key, payment_id, processor_status, webhook_secret } = req.body;

  if (webhook_secret !== WEBHOOK_SECRET) {
    console.warn('[webhook] rejected — invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!idempotency_key || !processor_status) {
    return res.status(400).json({ error: 'idempotency_key and processor_status are required' });
  }

  const newStatus = processor_status === 'success' ? 'complete' : 'failed';

  const updated = await db.updateStatus(idempotency_key, newStatus, payment_id);
  if (!updated) {
    console.warn(`[webhook] no payment found for key: ${idempotency_key}`);
    return res.status(404).json({ error: 'Payment not found' });
  }

  const record = await db.findByKey(idempotency_key);
  console.log(`[webhook] payment ${idempotency_key} → ${newStatus}`);
  
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
    console.log(`[webhook] released ${record.ticket_qty} tickets back to pool`);
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
