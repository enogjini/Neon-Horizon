'use strict';

const EventEmitter = require('events');
const redis = require('./redisClient');
const inventoryEvents = new EventEmitter();

const TOTAL_CAPACITY = 100;
const INVENTORY_KEY = 'tickets:available';

/**
 * Initialize inventory if it doesn't exist.
 */
async function init() {
  const exists = await redis.exists(INVENTORY_KEY);
  if (!exists) {
    await redis.set(INVENTORY_KEY, TOTAL_CAPACITY);
  }
}

async function reserve(qty) {
  try {
    const remaining = await redis.decrby(INVENTORY_KEY, qty);

    if (remaining < 0) {
      await redis.incrby(INVENTORY_KEY, qty);
      return false;
    }

    inventoryEvents.emit('change', { available: remaining, total: TOTAL_CAPACITY });
    return true;
  } catch (err) {
    console.error('[inventory] reserve failed:', err.message || err);
    return false;
  }
}

async function release(qty) {
  try {
    const current = await redis.incrby(INVENTORY_KEY, qty);
    inventoryEvents.emit('change', { available: current, total: TOTAL_CAPACITY });
  } catch (err) {
    console.error('[inventory] release failed:', err.message || err);
  }
}

async function getAvailable() {
  try {
    const val = await redis.get(INVENTORY_KEY);
    return parseInt(val || 0, 10);
  } catch (err) {
    console.error('[inventory] getAvailable failed:', err.message || err);
    return TOTAL_CAPACITY;
  }
}

function getTotal() {
  return TOTAL_CAPACITY;
}

module.exports = {
  init,
  reserve,
  release,
  getAvailable,
  getTotal,
  events: inventoryEvents
};


