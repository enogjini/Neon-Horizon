'use strict';
require('dotenv').config();
const { sendTicketConfirmation } = require('./mailer');

const fakeRecord = {
  id: 'TEST-001',
  email_or_phone: 'ksenogjini@gmail.com',
  customer_name: 'Eno',
  ticket_qty: 2,
  amount_cents: 9000,
};

console.log('[test] MAILGUN_API_KEY =', process.env.MAILGUN_API_KEY ? '✓ set' : '✗ missing');
console.log('[test] MAILGUN_DOMAIN  =', process.env.MAILGUN_DOMAIN || '✗ missing');
console.log('[test] Sending to:', fakeRecord.email_or_phone);
console.log('---');

sendTicketConfirmation(fakeRecord)
  .then(result => {
    console.log('[test] Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('[test] FAILED:', err.message);
    if (err.response) console.error('[test] API response:', err.response);
    process.exit(1);
  });
