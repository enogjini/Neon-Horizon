const express = require('express');
const router  = express.Router();
const inventory = require('../inventory');

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
 * SSE endpoint that pushes the current ticket count.
 */
router.get('/status', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendUpdate = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial state
  sendUpdate({ available: await inventory.getAvailable(), total: inventory.getTotal() });

  // Listen for changes
  const listener = (data) => sendUpdate(data);
  inventory.events.on('change', listener);

  // Clean up
  req.on('close', () => {
    inventory.events.removeListener('change', listener);
  });
});

module.exports = router;
