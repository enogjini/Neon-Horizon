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
  // Atomic decrement
  const remaining = await redis.decrby(INVENTORY_KEY, qty);
  
  if (remaining < 0) {
    // Rollback if we went below zero
    await redis.incrby(INVENTORY_KEY, qty);
    return false;
  }
  
  inventoryEvents.emit('change', { available: remaining, total: TOTAL_CAPACITY });
  return true;
}

async function release(qty) {
  const current = await redis.incrby(INVENTORY_KEY, qty);
  inventoryEvents.emit('change', { available: current, total: TOTAL_CAPACITY });
}

async function getAvailable() {
  const val = await redis.get(INVENTORY_KEY);
  return parseInt(val || 0, 10);
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


