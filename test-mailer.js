const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mailer = require(path.join(__dirname, 'mailer'));

test('sendMailgunEmail posts to the configured Mailgun endpoint', async () => {
  process.env.MAILGUN_API_KEY = 'test-key';
  process.env.MAILGUN_DOMAIN = 'mg.example.com';
  process.env.MAILGUN_BASE_URL = 'https://api.mailgun.net';

  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'msg-123' }),
    };
  };

  const result = await mailer.sendMailgunEmail({
    from: 'Neon Horizon <tickets@mg.example.com>',
    to: 'fan@example.com',
    subject: 'Hello',
    text: 'Body',
    html: '<p>Body</p>',
  });

  assert.equal(result.mode, 'mailgun');
  assert.equal(result.messageId, 'msg-123');
  assert.equal(captured.url, 'https://api.mailgun.net/v3/mg.example.com/messages');
  assert.match(captured.options.headers.Authorization, /^Basic /);
  assert.equal(captured.options.method, 'POST');
});
