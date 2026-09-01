'use strict';

const EventEmitter = require('events');
const redis = require('./redisClient');
const inventoryEvents = new EventEmitter();

function positiveIntEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TOTAL_CAPACITY = positiveIntEnv('INVENTORY_CAPACITY', 100);
const INVENTORY_KEY = 'tickets:available';
const WEEK_KEY = 'tickets:week';

// 'weekly' refills the pool to full capacity at the start of each ISO week
// (Monday 00:00 UTC). 'never' keeps the pool fixed until it is changed by hand.
const RESET_MODE = (process.env.INVENTORY_RESET || 'weekly').trim().toLowerCase();

// The rollover check runs on every read/reserve; this throttles the Redis round
// trip to at most once per interval per process while the week is unchanged.
const WEEK_CHECK_TTL_MS = positiveIntEnv('INVENTORY_WEEK_CHECK_MS', 60 * 1000);

let confirmedWeek = null;
let confirmedWeekAt = 0;

/**
 * ISO-8601 week identifier for a date, e.g. "2026-W36".
 * Weeks start on Monday and everything is computed in UTC.
 */
function isoWeekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;         // Mon = 0 … Sun = 6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);      // move to this week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Refills the pool to full capacity when the ISO week rolls over, and seeds it
 * on first run. The first worker to observe a new week wins an atomic GETSET on
 * WEEK_KEY and performs the refill; every other worker sees the already-updated
 * stamp and skips it, so the reset happens exactly once per week across the
 * whole cluster. Safe to call on every read/reserve.
 *
 * Boundary note: a `reserve` that lands in the sub-millisecond gap between the
 * GETSET and the capacity SET can be overwritten by the refill. With a 100-seat
 * pool this is immaterial; it only ever grants a seat or two extra at the exact
 * turn of the week.
 */
async function rolloverIfNeeded(now = new Date()) {
  if (RESET_MODE !== 'weekly') {
    const exists = await redis.exists(INVENTORY_KEY);
    if (!exists) await redis.set(INVENTORY_KEY, TOTAL_CAPACITY);
    return;
  }

  const currentWeek = isoWeekId(now);
  if (confirmedWeek === currentWeek && Date.now() - confirmedWeekAt < WEEK_CHECK_TTL_MS) {
    return;
  }

  const storedWeek = await redis.get(WEEK_KEY);
  confirmedWeek = currentWeek;
  confirmedWeekAt = Date.now();
  if (storedWeek === currentWeek) return;

  const previousWeek = await redis.getset(WEEK_KEY, currentWeek);
  if (previousWeek === currentWeek) return; // another worker already claimed this rollover

  if (previousWeek === null) {
    // First run under weekly reset — seed without clobbering an existing pool
    // (e.g. a restart part-way through the current week).
    const exists = await redis.exists(INVENTORY_KEY);
    if (!exists) await redis.set(INVENTORY_KEY, TOTAL_CAPACITY);
    return;
  }

  await redis.set(INVENTORY_KEY, TOTAL_CAPACITY);
  inventoryEvents.emit('change', { available: TOTAL_CAPACITY, total: TOTAL_CAPACITY });
  console.log(`[inventory] weekly rollover ${previousWeek} → ${currentWeek}; tickets reset to ${TOTAL_CAPACITY}`);
}

/**
 * Initialize inventory: seed the pool and apply any pending weekly rollover.
 */
async function init() {
  await rolloverIfNeeded();
}

async function reserve(qty) {
  try {
    await rolloverIfNeeded();
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
    await rolloverIfNeeded();
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
  isoWeekId,
  rolloverIfNeeded,
  events: inventoryEvents
};
