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
const useInMemoryFallback = !redisUrl && !requiresDurableRedis;

let redis;

try {
  if (redisUrl) {
    redis = new IORedis(redisUrl, redisOptions);
    redis.on('connect', () => console.log('[redis] connected to durable Redis'));
    redis.on('error', err => console.error('[redis] connection error:', err.message));
  } else if (requiresDurableRedis) {
    throw new Error('REDIS_URL is required in production so inventory and SSE pub/sub are durable.');
  } else if (useInMemoryFallback) {
    redis = new RedisMock();
    console.log('[redis] using in-memory Redis mock for local development');
  }
} catch (err) {
  console.error('[redis] startup failed:', err.message);
  process.exit(1);
}

module.exports = redis;
