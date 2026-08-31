'use strict';

const http    = require('http');
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PROCESSOR_PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'processor-public')));

// ── In-memory transaction store ───────────────────────────────────────────────
const transactions = new Map(); // processor_payment_id → record

// ── Config (tweak via query params on /config) ────────────────────────────────
let config = {
  delay_ms:     3000,   // default processing delay
  failure_rate: 0,      // 0–1 probability of random failure
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /charge
// Body: { idempotency_key, amount_cents, currency?, webhook_url }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/charge', (req, res) => {
  const { idempotency_key, amount_cents, currency = 'usd', webhook_url } = req.body;

  if (!idempotency_key || !amount_cents || !webhook_url) {
    return res.status(400).json({ error: 'idempotency_key, amount_cents, and webhook_url are required' });
  }

  // Idempotency: same key → return existing record
  for (const [, t] of transactions) {
    if (t.idempotency_key === idempotency_key) {
      console.log(`[processor] replayed charge for key: ${idempotency_key}`);
      return res.status(200).json({ processor_payment_id: t.processor_payment_id, status: t.status, replayed: true });
    }
  }

  const processor_payment_id = `proc_${crypto.randomBytes(8).toString('hex')}`;
  const record = {
    processor_payment_id,
    idempotency_key,
    amount_cents,
    currency,
    webhook_url,
    status:       'processing',
    created_at:   new Date().toISOString(),
    completed_at: null,
    delay_ms:     config.delay_ms,
    forced:       null,
  };

  transactions.set(processor_payment_id, record);
  console.log(`[processor] new charge ${processor_payment_id} — $${(amount_cents / 100).toFixed(2)}`);

  // Schedule webhook callback
  scheduleWebhook(processor_payment_id);

  return res.status(202).json({ processor_payment_id, status: 'processing', replayed: false });
});

// ── GET /transactions — list all ──────────────────────────────────────────────
app.get('/transactions', (req, res) => {
  res.json([...transactions.values()].reverse());
});

// ── POST /transactions/:id/force-complete ─────────────────────────────────────
app.post('/transactions/:id/force-complete', (req, res) => {
  const t = transactions.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status !== 'processing') return res.status(400).json({ error: 'Already settled' });
  t.forced = 'complete';
  fireWebhook(t, 'success');
  res.json({ ok: true });
});

// ── POST /transactions/:id/force-fail ─────────────────────────────────────────
app.post('/transactions/:id/force-fail', (req, res) => {
  const t = transactions.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status !== 'processing') return res.status(400).json({ error: 'Already settled' });
  t.forced = 'fail';
  fireWebhook(t, 'failed');
  res.json({ ok: true });
});

// ── POST /config ───────────────────────────────────────────────────────────────
app.post('/config', (req, res) => {
  const { delay_ms, failure_rate } = req.body;
  if (delay_ms    !== undefined) config.delay_ms     = Number(delay_ms);
  if (failure_rate !== undefined) config.failure_rate = Math.min(1, Math.max(0, Number(failure_rate)));
  console.log('[processor] config updated:', config);
  res.json(config);
});

app.get('/config', (req, res) => res.json(config));

// ─────────────────────────────────────────────────────────────────────────────

function scheduleWebhook(processor_payment_id) {
  setTimeout(() => {
    const t = transactions.get(processor_payment_id);
    if (!t || t.status !== 'processing') return; // already forced
    const outcome = Math.random() < config.failure_rate ? 'failed' : 'success';
    fireWebhook(t, outcome);
  }, config.delay_ms);
}

function fireWebhook(t, outcome) {
  t.status       = outcome === 'success' ? 'complete' : 'failed';
  t.completed_at = new Date().toISOString();

  console.log(`[processor] webhook → ${t.webhook_url} (${t.processor_payment_id}: ${t.status})`);

  const body = JSON.stringify({
    idempotency_key:  t.idempotency_key,
    payment_id:       t.processor_payment_id,
    processor_status: outcome,
    webhook_secret:   process.env.WEBHOOK_SECRET || 'dev-secret',
  });

  const url  = new URL(t.webhook_url);
  const opts = {
    hostname: url.hostname,
    port:     url.port || 80,
    path:     url.pathname,
    method:   'POST',
    headers:  {
      'Content-Type':    'application/json',
      'Content-Length':  Buffer.byteLength(body),
      'X-Webhook-Secret': process.env.WEBHOOK_SECRET || 'dev-secret',
    },
  };

  const req = http.request(opts, res => {
    console.log(`[processor] webhook response: ${res.statusCode}`);
  });
  req.on('error', err => console.error('[processor] webhook error:', err.message));
  req.write(body);
  req.end();
}

app.listen(PORT, () => {
  console.log(`\n💳  Mock Payment Processor running at http://localhost:${PORT}`);
  console.log(`    Dashboard: http://localhost:${PORT}`);
  console.log(`    Charge:    POST http://localhost:${PORT}/charge\n`);
});
