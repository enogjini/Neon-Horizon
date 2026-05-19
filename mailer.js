'use strict';

const nodemailer = require('nodemailer');

const PRICE_PER_TICKET_USD = 45;

function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hasSendGrid() {
  const key = process.env.SENDGRID_API_KEY;
  return key && key.length > 12 && !/your_api_key|placeholder/i.test(key);
}

function brevoSmtpLogin() {
  return (
    process.env.BREVO_SMTP_LOGIN ||
    process.env.BREVO_LOGIN ||
    ''
  ).trim();
}

/** Brevo “SMTP key” (password). Not the REST API v3 key. */
function brevoSmtpPassword() {
  return (
    process.env.BREVO_SMTP_KEY ||
    process.env.BREVO_SMTP_PASSWORD ||
    ''
  ).trim();
}

function hasBrevo() {
  const key = brevoSmtpPassword();
  const login = brevoSmtpLogin();
  return Boolean(key && login && looksLikeEmail(login));
}

function warnPartialBrevoConfig() {
  const key = brevoSmtpPassword();
  const login = brevoSmtpLogin();
  if (!key) return;
  if (!login || !looksLikeEmail(login)) {
    console.warn(
      '[mailer] BREVO_SMTP_KEY is set but BREVO_SMTP_LOGIN must be the SMTP login email from Brevo (looks like an email). Email will not use Brevo until fixed.'
    );
  }
}

async function createTransport() {
  if (hasBrevo()) {
    const port = parseInt(process.env.BREVO_SMTP_PORT || '587', 10);
    return {
      transporter: nodemailer.createTransport({
        host: 'smtp-relay.brevo.com',
        port,
        secure: port === 465,
        auth: {
          user: brevoSmtpLogin(),
          pass: brevoSmtpPassword(),
        },
      }),
      mode: 'brevo',
    };
  }

  if (hasSendGrid()) {
    return {
      transporter: nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
      }),
      mode: 'sendgrid',
    };
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      transporter: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      }),
      mode: 'smtp',
    };
  }

  warnPartialBrevoConfig();

  const testAccount = await nodemailer.createTestAccount();
  return {
    transporter: nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    }),
    mode: 'ethereal',
  };
}

function buildBodies(record) {
  const name = record.customer_name ? record.customer_name.trim() : 'there';
  const safeName = escapeHtml(name);
  const qty = record.ticket_qty;
  const total = (qty * PRICE_PER_TICKET_USD).toFixed(2);

  const text = `Hello ${name},

Your Neon Horizon ticket purchase is confirmed.

Order ID:  #${record.id}
Tickets:   ${qty} x General Admission
Total:     $${total}

Event:     July 12, 2026 — doors 7:00 PM
Venue:     The Warehouse, NYC

Bring this email (printed or on your phone) for entry.

— Neon Horizon Tickets`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111;background:#fafafa;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:12px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
      <tr><td>
        <h1 style="margin:0 0 8px;font-size:22px;color:#6d28d9;">You're in</h1>
        <p style="margin:0 0 16px;">Hi ${safeName},</p>
        <p style="margin:0 0 20px;">Your purchase for <strong>Neon Horizon</strong> is confirmed.</p>
        <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:15px;">
          <tr><td style="padding:6px 0;color:#555;">Order ID</td><td style="padding:6px 0;text-align:right;">#${record.id}</td></tr>
          <tr><td style="padding:6px 0;color:#555;">Tickets</td><td style="padding:6px 0;text-align:right;">${qty} × GA</td></tr>
          <tr><td style="padding:6px 0;color:#555;">Total</td><td style="padding:6px 0;text-align:right;font-weight:700;">$${total}</td></tr>
        </table>
        <p style="margin:0 0 8px;font-size:14px;color:#555;">July 12, 2026 · Doors 7:00 PM<br />The Warehouse, NYC</p>
        <p style="margin:20px 0 0;font-size:14px;color:#333;">Bring this email for entry. See you at the show.</p>
        <p style="margin:24px 0 0;font-size:13px;color:#888;">— Neon Horizon Tickets</p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;

  return { text, html };
}

/**
 * Sends order confirmation when payment completes.
 * Uses Brevo (BREVO_SMTP_*), or SENDGRID_API_KEY, or SMTP_* env vars, or Ethereal (dev — check logs for preview URL).
 * Skips if `email_or_phone` is not a valid email (e.g. phone-only).
 */
async function sendTicketConfirmation(record) {
  if (!record || !record.email_or_phone) return;

  const to = String(record.email_or_phone).trim();
  if (!looksLikeEmail(to)) {
    console.log(`[mailer] skip confirmation — need a valid email, got: ${to}`);
    return;
  }

  const { text, html } = buildBodies(record);
  const { transporter, mode } = await createTransport();
  const from = (process.env.FROM_EMAIL || 'tickets@neonhorizon.example.com').trim();

  console.log(`[mailer] sending confirmation transport=${mode} to=${to}`);

  try {
    const info = await transporter.sendMail({
      from: `"Neon Horizon" <${from}>`,
      to,
      subject: 'Your Neon Horizon tickets — confirmed',
      text,
      html,
    });

    if (mode === 'ethereal') {
      const url = nodemailer.getTestMessageUrl(info);
      console.log(`[mailer] dev inbox — preview: ${url}`);
    } else {
      console.log(`[mailer] confirmation sent (${mode}) messageId=${info.messageId || 'n/a'}`);
    }
  } catch (err) {
    const extra = err.response ? ` smtp=${String(err.response).slice(0, 500)}` : '';
    console.error(`[mailer] sendMail failed (${mode}):`, err.message || err, extra);
    throw err;
  }
}

module.exports = { sendTicketConfirmation, looksLikeEmail };
