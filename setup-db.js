'use strict';

const { initDB } = require('./pgClient');

console.log('⏳ Connecting to cloud database and running table schema creation...');

initDB()
  .then(() => {
    console.log('🎉 Database successfully initialized on Neon!');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Database initialization failed:', err);
    process.exit(1);
  });
