const express = require('express');
const router  = express.Router();
const inventory = require('../inventory');

// Long-lived SSE connections are killed by serverless platforms at the function
// timeout and cannot span multiple workers, so the stream is treated as a
// best-effort optimisation. Clients must also poll GET /api/availability.
const SSE_MAX_LIFETIME_MS = parseInt(process.env.SSE_MAX_LIFETIME_MS || '270000', 10); // 4.5 min
const SSE_HEARTBEAT_MS = parseInt(process.env.SSE_HEARTBEAT_MS || '25000', 10);

/**
 * GET /api/availability
 * Returns the current ticket count immediately.
 */
router.get('/', async (req, res) => {
  const available = await inventory.getAvailable();
  const total = inventory.getTotal();
  res.json({ available, total });
});

/**
 * GET /api/availability/status
 * SSE endpoint that pushes the current ticket count. Best-effort only.
 */
router.get('/status', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  res.flushHeaders();

  // Tell EventSource how long to wait before reconnecting after we close.
  res.write('retry: 10000\n\n');

  const sendUpdate = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    sendUpdate({ available: await inventory.getAvailable(), total: inventory.getTotal() });
  } catch (err) {
    // If inventory is unreachable, close the stream and let the client poll.
    return res.end();
  }

  const listener = (data) => sendUpdate(data);
  inventory.events.on('change', listener);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);

  // Proactively recycle the connection so a frozen serverless instance does not
  // leave the client believing it still has a live stream.
  const lifetime = setTimeout(() => res.end(), SSE_MAX_LIFETIME_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    inventory.events.removeListener('change', listener);
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
});

module.exports = router;
