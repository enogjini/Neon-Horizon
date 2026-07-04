// test.js — end-to-end API smoke test
const http = require('http');
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:1';
const inventory = require('./inventory');

const KEY = `test-${Date.now()}`;
const BASE = 'http://localhost:3000';
const CUSTOMER = {
  customerName: 'Smoke Test',
  customerEmail: `smoke+${Date.now()}@example.com`,
};

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postMalformedJson(path, rawBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = null; }
        resolve({ status: res.statusCode, raw, body });
      });
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

(async () => {
  console.log('\n── Test 1: POST /api/payments (new key) ──');
  const r1 = await post('/api/payments', { idempotency_key: KEY, ticket_qty: 2, ...CUSTOMER });
  console.log('Status:', r1.status, '(expected 202)');
  console.log('Body:', JSON.stringify(r1.body, null, 2));
  const ok1 = r1.status === 202 && r1.body.status === 'pending' && !r1.body.replayed;
  console.log(ok1 ? '✅ PASS' : '❌ FAIL');

  console.log('\n── Test 2: POST /api/payments again (same key — idempotent) ──');
  const r2 = await post('/api/payments', { idempotency_key: KEY, ticket_qty: 2, ...CUSTOMER });
  console.log('Status:', r2.status, '(expected 200)');
  console.log('Body:', JSON.stringify(r2.body, null, 2));
  const ok2 = r2.status === 200 && r2.body.replayed === true;
  console.log(ok2 ? '✅ PASS' : '❌ FAIL');

  console.log('\n── Test 3: Waiting 5s for mock webhook to fire and update DB ──');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n── Test 4: POST same key again — should now return status: complete ──');
  const r3 = await post('/api/payments', { idempotency_key: KEY, ticket_qty: 2, ...CUSTOMER });
  console.log('Status:', r3.status);
  console.log('Body:', JSON.stringify(r3.body, null, 2));
  const ok3 = r3.body.status === 'complete' && r3.body.confirmation && r3.body.confirmation.status === 'sent';
  console.log(ok3 ? '✅ PASS' : '❌ FAIL');

  console.log('\n── Test 5: Missing idempotency_key → 400 ──');
  const r4 = await post('/api/payments', { ticket_qty: 1 });
  const ok4 = r4.status === 400;
  console.log('Status:', r4.status, ok4 ? '✅ PASS' : '❌ FAIL');

  console.log('\n── Test 6: Malformed JSON → JSON error response ──');
  const r5 = await postMalformedJson('/api/payments', '{bad json');
  const ok5 = r5.status === 400 && r5.body && r5.body.error === 'Invalid JSON body';
  console.log('Status:', r5.status, ok5 ? '✅ PASS' : '❌ FAIL');

  const passed = [ok1, ok2, ok3, ok4, ok5].filter(Boolean).length;
  console.log(`\n${'─'.repeat(44)}`);
  console.log(`Results: ${passed}/5 tests passed ${passed === 5 ? '🎉' : '⚠️'}`);
})();
