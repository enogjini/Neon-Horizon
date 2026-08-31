require('dotenv').config();
const express = require('express');
const path = require('path');
const inventory = require('./inventory');
const { startEmailWorker } = require('./emailOutbox');
const { initDB } = require('./pgClient');
const { attachUser, assertSessionSecretConfigured } = require('./auth');

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

function validateProductionEnv() {
  if (!IS_PRODUCTION) return;

  // Hard requirement: a production deployment must not sign sessions with the
  // shared development key. Fail fast instead of 500-ing on first login.
  assertSessionSecretConfigured();

  const required = ['DATABASE_URL', 'REDIS_URL'];
  const missing = required.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');

  if (missing.length > 0) {
    console.warn(`[startup] production env missing: ${missing.join(', ')}; continuing with in-memory fallback`);
  }
}

validateProductionEnv();

// ── App Setup (Single Process for Mock Compatibility) ───────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

console.log('\nNeon Horizon server booting');

let runtimeInitialized = false;

async function initializeRuntime() {
  if (runtimeInitialized) return;

  try {
    await initDB().catch((err) => {
      console.warn('[startup] database initialization failed, continuing in fallback mode:', err.message || err);
    });

    await inventory.init().catch((err) => {
      console.warn('[startup] inventory initialization failed, continuing in fallback mode:', err.message || err);
    });

    runtimeInitialized = true;
    console.log('[startup] runtime ready (database and inventory fallback mode enabled if needed)');
  } catch (err) {
    console.error('[startup] initialization failed:', err.message || err);
  }
}

void initializeRuntime();

// Performance Tweaks
app.disable('x-powered-by');

// Middleware
//
// CORS: browsers only enforce this for cross-origin requests. Same-origin calls
// (the bundled frontend) always work. Configure ALLOWED_ORIGINS as a
// comma-separated allowlist to permit specific external origins with credentials.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

app.use(require('cors')({
  credentials: true,
  origin(origin, callback) {
    // No Origin header: same-origin navigation, curl, server-to-server, health checks.
    if (!origin) return callback(null, true);
    if (allowedOrigins.length > 0) return callback(null, allowedOrigins.includes(origin));
    // No allowlist configured: permit any origin in development, none in production.
    return callback(null, !IS_PRODUCTION);
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(attachUser);

const requestCounts = new Map();
app.use((req, res, next) => {
  const key = req.ip || 'global';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = process.env.NODE_ENV === 'production' ? 120 : 1000;

  const entries = requestCounts.get(key) || [];
  const recent = entries.filter((ts) => now - ts < windowMs);
  recent.push(now);
  requestCounts.set(key, recent);

  if (recent.length > maxRequests) {
    return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  }

  next();
});

// Routes
app.use('/api/payments', require('./routes/payments'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/availability', require('./routes/availability'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/attendees', require('./routes/attendees'));

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const inventoryState = await inventory.getAvailable();
    res.json({
      status: 'ok',
      worker: process.pid,
      timestamp: new Date().toISOString(),
      inventory: inventoryState,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/ready', async (req, res) => {
  try {
    await inventory.getAvailable();
    res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'not-ready', error: err.message });
  }
});

// Unknown API routes return JSON 404 instead of falling through to the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400 && 'body' in err))) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  console.error('[server] unhandled error:', err && err.stack ? err.stack : err);
  const status = err && (err.status || err.statusCode) ? err.status || err.statusCode : 500;
  return res.status(status).json({ error: err && err.message ? err.message : 'Internal server error' });
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
  initializeRuntime().then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Worker ${process.pid} started on port ${PORT}`);
    });

    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully');
      server.close(() => process.exit(0));
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down gracefully');
      server.close(() => process.exit(0));
    });

    if (!process.env.VERCEL) {
      startEmailWorker();
    }
  }).catch((err) => {
    console.error('[startup] server startup aborted:', err.message || err);
    process.exit(1);
  });
}

