require('dotenv').config();
const express = require('express');
const path = require('path');
const inventory = require('./inventory');
const { startEmailWorker } = require('./emailOutbox');

// ── App Setup (Single Process for Mock Compatibility) ───────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

console.log('\nNeon Horizon server booting');

// Initialize shared inventory
inventory.init().catch(err => console.error('Inventory init error:', err));

// Performance Tweaks
app.disable('x-powered-by');

// Middleware
app.use(require('cors')());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/payments', require('./routes/payments'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/availability', require('./routes/availability'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/attendees', require('./routes/attendees'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', worker: process.pid, timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Redis Pub/Sub for Cross-Worker Notifications ──────────────────────────
const redisClient = require('./redisClient');
const sub = redisClient.duplicate();

sub.subscribe('sse_updates');
sub.on('message', (channel, message) => {
  if (channel === 'sse_updates') {
    const { idempotency_key, event, payload } = JSON.parse(message);
    const sseClients = require('./sseClients');
    const clients = sseClients.get(idempotency_key) || [];
    clients.forEach(res => {
      try {
        res.write(`event: ${event}\ndata: ${payload}\n\n`);
      } catch (e) {}
    });
  }
});

// Export app instance for Vercel Serverless Function
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Worker ${process.pid} started`);
  });
  startEmailWorker();
}
