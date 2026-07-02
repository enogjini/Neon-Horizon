'use strict';

const db = require('./db');
const { sendTicketConfirmation, looksLikeEmail } = require('./mailer');

const TICKET_CONFIRMATION = 'ticket_confirmation';
const DEFAULT_POLL_MS = parseInt(process.env.EMAIL_WORKER_POLL_MS || '5000', 10);
const DEFAULT_DRAIN_LIMIT = parseInt(process.env.EMAIL_INLINE_DRAIN_LIMIT || '3', 10);

function nextRetryAt(attempts) {
  const exponent = Math.max(0, attempts - 1);
  const backoffMs = Math.min(15 * 60 * 1000, Math.pow(2, exponent) * 1000);
  return new Date(Date.now() + backoffMs);
}

async function enqueueTicketConfirmation(payment) {
  if (!payment || !payment.id) return null;

  if (!looksLikeEmail(payment.email_or_phone)) {
    console.log(`[email-outbox] skip confirmation job for payment #${payment.id}: no valid email`);
    return null;
  }

  return db.enqueueEmailJob({
    idempotency_key: `ticket-confirmation:${payment.id}`,
    type: TICKET_CONFIRMATION,
    payment_id: payment.id,
    payload: {
      payment_id: payment.id,
      payment_key: payment.idempotency_key,
    },
  });
}

async function processClaimedEmailJob(job) {
  try {
    if (job.type !== TICKET_CONFIRMATION) {
      throw new Error(`Unsupported email job type: ${job.type}`);
    }

    const paymentId = job.payment_id || (job.payload && job.payload.payment_id);
    const payment = await db.findPaymentById(paymentId);

    if (!payment) {
      throw new Error(`Payment not found for email job #${job.id}`);
    }

    if (payment.status !== 'complete') {
      throw new Error(`Payment #${payment.id} is ${payment.status}, not complete`);
    }

    if (payment.email_sent_at) {
      await db.completeEmailJob(job.id, 'already-sent');
      return { ok: true, status: 'sent', mode: 'already-sent', previewUrl: null, messageId: null };
    }

    const info = await sendTicketConfirmation(payment);
    await db.markPaymentEmailSent(payment.id);
    await db.completeEmailJob(
      job.id,
      (info && (info.messageId || info.previewUrl)) || null
    );
    return {
      ok: true,
      status: 'sent',
      mode: info && info.mode ? info.mode : 'unknown',
      previewUrl: info && info.previewUrl ? info.previewUrl : null,
      messageId: info && info.messageId ? info.messageId : null,
    };
  } catch (err) {
    const updated = await db.failEmailJob(job.id, err, nextRetryAt(job.attempts));
    console.error(
      `[email-outbox] job #${job.id} failed; status=${updated ? updated.status : 'unknown'}:`,
      err.message || err
    );
    return { ok: false, status: 'failed', error: err.message || String(err) };
  }
}

async function processOneEmailJob() {
  const job = await db.claimNextEmailJob();
  if (!job) return false;
  return processClaimedEmailJob(job);
}

async function processEmailJobById(id) {
  const job = await db.claimEmailJobById(id);
  if (!job) return false;
  return processClaimedEmailJob(job);
}

async function processQueuedEmails({ limit = DEFAULT_DRAIN_LIMIT } = {}) {
  let processed = 0;

  while (processed < limit) {
    const didWork = await processOneEmailJob();
    if (!didWork) break;
    processed += 1;
  }

  return processed;
}

function startEmailWorker({ pollMs = DEFAULT_POLL_MS } = {}) {
  if (process.env.EMAIL_WORKER_DISABLED === 'true') {
    console.log('[email-outbox] worker disabled by EMAIL_WORKER_DISABLED=true');
    return { stop() {} };
  }

  let timer = null;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped) return;

    if (running) {
      timer = setTimeout(tick, pollMs);
      return;
    }

    running = true;
    try {
      await processQueuedEmails({ limit: 25 });
    } catch (err) {
      console.error('[email-outbox] worker tick failed:', err.message || err);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, pollMs);
    }
  };

  timer = setTimeout(tick, 250);
  console.log(`[email-outbox] worker started; pollMs=${pollMs}`);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = {
  enqueueTicketConfirmation,
  processEmailJobById,
  processQueuedEmails,
  processOneEmailJob,
  startEmailWorker,
};
