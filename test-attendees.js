const assert = require('assert');
const db = require('./db');

(async () => {
  const name = 'Test Attendee';
  const email = `test+${Date.now()}@example.com`;

  const record = await db.addAttendee({ name, email });

  assert.ok(record, 'expected attendee record to be created');
  assert.strictEqual(record.name, name);
  assert.strictEqual(record.email, email);

  console.log('attendee-record test passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
