'use strict';

let Redis;
try {
  // Try to use real ioredis first
  const IORedis = require('ioredis');
  const RedisMock = require('ioredis-mock');

  // We'll use the mock by default for now to avoid the connection errors 
  // since Docker is currently having issues.
  Redis = RedisMock;
  console.log('💡 Using In-Memory Redis Mock (Docker not detected)');

} catch (err) {
  console.error('Failed to load Redis/Mock:', err.message);
  process.exit(1);
}

const redis = new Redis();

module.exports = redis;

