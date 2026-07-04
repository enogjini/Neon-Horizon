'use strict';

const IORedis = require('ioredis');
const RedisMock = require('ioredis-mock');

const restUrl = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const restToken = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
let derivedRedisUrl = '';

if (restUrl && restToken) {
  try {
    const { hostname } = new URL(restUrl);
    derivedRedisUrl = `rediss://:${restToken}@${hostname}:6379`;
  } catch (err) {
    console.error('[redis] invalid UPSTASH_REDIS_REST_URL:', err.message);
  }
}

const redisUrl = (
  process.env.REDIS_URL ||
  process.env.UPSTASH_REDIS_URL ||
  derivedRedisUrl ||
  ''
).trim();

const redisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
};

if (redisUrl.startsWith('rediss://')) {
  redisOptions.tls = {};
}

const requiresDurableRedis = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const useInMemoryFallback = !redisUrl;

let redis;

try {
  if (redisUrl) {
    redis = new IORedis(redisUrl, redisOptions);
    redis.on('connect', () => console.log('[redis] connected to durable Redis'));
    redis.on('error', err => console.error('[redis] connection error:', err.message));
  } else if (useInMemoryFallback) {
    redis = new RedisMock();
    console.log(requiresDurableRedis
      ? '[redis] REDIS_URL not configured; using in-memory Redis fallback for this deployment'
      : '[redis] using in-memory Redis mock for local development');
  }
} catch (err) {
  console.error('[redis] startup failed:', err.message);
  redis = new RedisMock();
  console.warn('[redis] falling back to in-memory Redis mock after startup failure');
}

module.exports = redis;
