/* ─────────────────────────────────────────────────────────────────────────
   Ticket Store — Frontend App
   Handles: idempotency key, ticket purchase flow, SSE status updates
   ───────────────────────────────────────────────────────────────────────── */

'use strict';

// ─── Checkout Logic ────────────────────────────────────────────────────────────
const accountOverlay = document.getElementById('account-overlay');
const accountForm    = document.getElementById('account-form');
const accountSubmitBtn = document.getElementById('account-submit-btn');
const accountCloseBtn = document.getElementById('account-close-btn');

accountCloseBtn.addEventListener('click', () => {
  accountOverlay.hidden = true;
  accountOverlay.setAttribute('hidden', '');
});

accountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('customerName').value.trim();
  const email = document.getElementById('customerEmail').value.trim();

  if (!name || !email) return;

  accountOverlay.hidden = true;
  accountOverlay.setAttribute('hidden', '');
  
  state.customerName = name;
  state.customerEmail = email;

  await startPaymentFlow();
});

// ─── State ────────────────────────────────────────────────────────────────────
const PRICE_PER_TICKET = 45.00;
const MAX_TICKETS = 10;
const MIN_TICKETS = 1;

let state = {
  qty: 1,
  idempotencyKey: generateUUID(), // fresh key per page load
  sseSource: null,
  isProcessing: false,
  customerName: '',
  customerEmail: '',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const qtyDisplay     = document.getElementById('qty-display');
const priceDisplay   = document.getElementById('price-display');
const totalDisplay   = document.getElementById('total-display');
const qtyDecrease    = document.getElementById('qty-decrease');
const qtyIncrease    = document.getElementById('qty-increase');
const buyBtn         = document.getElementById('buy-btn');
const overlay        = document.getElementById('payment-overlay');

const stateProcessing = document.getElementById('state-processing');
const stateSuccess    = document.getElementById('state-success');
const stateError      = document.getElementById('state-error');

const overlayIdemKey  = document.getElementById('overlay-idem-key');
const confQty         = document.getElementById('conf-qty');
const confTotal       = document.getElementById('conf-total');
const errorMessage    = document.getElementById('error-message');
const closeSuccessBtn = document.getElementById('close-success-btn');
const retryBtn        = document.getElementById('retry-btn');

// ─── Quantity Controls ────────────────────────────────────────────────────────
qtyDecrease.addEventListener('click', () => {
  if (state.qty > MIN_TICKETS) {
    state.qty--;
    updateQtyUI();
  }
});

qtyIncrease.addEventListener('click', () => {
  if (state.qty < MAX_TICKETS) {
    state.qty++;
    updateQtyUI();
  }
});

function updateQtyUI() {
  qtyDisplay.textContent = state.qty;
  const total = (state.qty * PRICE_PER_TICKET).toFixed(2);
  totalDisplay.textContent = `$${total}`;
  qtyDecrease.disabled = state.qty <= MIN_TICKETS;
  qtyIncrease.disabled = state.qty >= MAX_TICKETS;
}

updateQtyUI(); // initialise

// ─── Buy Button ───────────────────────────────────────────────────────────────
buyBtn.addEventListener('click', () => {
  if (state.isProcessing) return;
  // Show checkout info overlay
  accountOverlay.hidden = false;
  accountOverlay.removeAttribute('hidden');
});

async function startPaymentFlow() {
  state.isProcessing = true;
  buyBtn.disabled = true;

  showOverlay('processing');

  try {
    await initiatePayment();
  } catch (err) {
    console.error('[app] payment initiation failed:', err);
    showOverlay('error', err.message || 'Could not reach payment server.');
  }
}

// ─── Payment Flow ─────────────────────────────────────────────────────────────

/**
 * Step 1 — POST to our server with idempotency_key.
 * Server writes to DB and kicks off the payment processor.
 */
async function initiatePayment() {
  const body = {
    idempotency_key: state.idempotencyKey,
    ticket_qty: state.qty,
    customerName: state.customerName,
    customerEmail: state.customerEmail
  };

  console.log('[app] POST /api/payments', body);

  const res = await fetch('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Server error ${res.status}`);
  }

  console.log('[app] payment created:', data);

  if (data.status === 'complete') {
    showSuccess(data.ticket_qty, data.amount_cents || (data.ticket_qty * PRICE_PER_TICKET * 100));
    return;
  }

  // Step 2 — Open SSE connection to receive webhook-triggered update.
  openSSEConnection(state.idempotencyKey);
}

/**
 * Step 2 — Subscribe to Server-Sent Events for real-time payment status.
 * The server fires the event once the payment processor webhook arrives.
 */
function openSSEConnection(idempotencyKey) {
  const url = `/api/payments/${encodeURIComponent(idempotencyKey)}/status`;
  console.log('[app] opening SSE connection to', url);

  // Close any existing connection
  if (state.sseSource) {
    state.sseSource.close();
  }

  const evtSource = new EventSource(url);
  state.sseSource = evtSource;

  evtSource.addEventListener('payment_complete', (e) => {
    console.log('[app] SSE payment_complete received:', e.data);
    evtSource.close();
    state.sseSource = null;
    const total_cents = state.qty * PRICE_PER_TICKET * 100;
    showSuccess(state.qty, total_cents);
  });

  evtSource.addEventListener('payment_failed', (e) => {
    console.log('[app] SSE payment_failed received:', e.data);
    evtSource.close();
    state.sseSource = null;
    showOverlay('error', 'Your payment was declined. No charge has been made.');
  });

  evtSource.onerror = (e) => {
    // Only treat as error if we haven't received success yet
    if (overlay.hidden || stateSuccess.hidden === false) return;
    console.error('[app] SSE error:', e);
    evtSource.close();
    state.sseSource = null;
    showOverlay('error', 'Lost connection to payment server. Please check your order status.');
  };
}

// ─── Overlay States ───────────────────────────────────────────────────────────

/**
 * @param {'processing'|'success'|'error'} stateName
 * @param {string} [errMsg]
 */
function showOverlay(stateName, errMsg) {
  overlay.hidden = false;
  overlay.removeAttribute('hidden');

  stateProcessing.hidden = true;
  stateSuccess.hidden    = true;
  stateError.hidden      = true;

  if (stateName === 'processing') {
    stateProcessing.hidden = false;
    overlayIdemKey.textContent = state.idempotencyKey;
  } else if (stateName === 'success') {
    stateSuccess.hidden = false;
  } else if (stateName === 'error') {
    stateError.hidden = false;
    if (errMsg) errorMessage.textContent = errMsg;
  }
}

function showSuccess(qty, amount_cents) {
  confQty.textContent   = `${qty} × GA Ticket${qty > 1 ? 's' : ''}`;
  confTotal.textContent = `$${(amount_cents / 100).toFixed(2)}`;
  showOverlay('success');

  // 🎉 Celebratory confetti!
  const duration = 2.5 * 1000;
  const end = Date.now() + duration;
  const colors = ['#a855f7', '#ec4899', '#06b6d4']; // Match site's neon palette

  (function frame() {
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.7 },
      colors: colors,
      zIndex: 1000
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.7 },
      colors: colors,
      zIndex: 1000
    });

    if (Date.now() < end) {
      requestAnimationFrame(frame);
    }
  }());
}

function hideOverlay() {
  overlay.hidden = true;
  state.isProcessing = false;
  buyBtn.disabled = false;
  // Generate a fresh idempotency key for the next purchase
  state.idempotencyKey = generateUUID();
  console.log('[app] new idempotency key ready:', state.idempotencyKey);
}

// ─── Overlay Button Handlers ──────────────────────────────────────────────────
closeSuccessBtn.addEventListener('click', hideOverlay);

retryBtn.addEventListener('click', () => {
  hideOverlay();
  // Slight delay so the user sees the card reset before they retry
  setTimeout(() => buyBtn.focus(), 100);
});

// Close overlay on backdrop click
overlay.addEventListener('click', (e) => {
  if (e.target === overlay && stateProcessing.hidden) {
    hideOverlay();
  }
});

// ─── Particle Canvas (aesthetic background) ───────────────────────────────────
(function initParticles() {
  const canvas = document.getElementById('particle-canvas');
  const ctx = canvas.getContext('2d');
  let particles = [];
  let animId;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function createParticle() {
    return {
      x:       Math.random() * canvas.width,
      y:       Math.random() * canvas.height,
      vx:      (Math.random() - 0.5) * 0.3,
      vy:      -Math.random() * 0.5 - 0.2,
      radius:  Math.random() * 1.5 + 0.5,
      alpha:   Math.random() * 0.4 + 0.05,
      color:   Math.random() > 0.5 ? '#a855f7' : '#ec4899',
      life:    0,
      maxLife: 200 + Math.random() * 300,
    };
  }

  for (let i = 0; i < 60; i++) particles.push(createParticle());

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach((p, i) => {
      p.x += p.vx;
      p.y += p.vy;
      p.life++;

      const progress = p.life / p.maxLife;
      const fade = progress < 0.1
        ? progress / 0.1
        : progress > 0.8
          ? 1 - (progress - 0.8) / 0.2
          : 1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha * fade;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (p.life >= p.maxLife || p.y < -10) {
        particles[i] = createParticle();
        particles[i].y = canvas.height + 10;
      }
    });

    animId = requestAnimationFrame(tick);
  }

  tick();
})();

// ─── Real-time Availability (SSE) ─────────────────────────────────────────────
(function initAvailabilityStream() {
  const availabilityText = document.getElementById('availability-text');
  const availabilityBadge = document.getElementById('availability-badge');
  
  const evtSource = new EventSource('/api/availability/status');

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const { available, total } = data;
    
    availabilityText.textContent = `${available} Tickets Remaining`;
    
    // Add some visual urgency
    if (available === 0) {
      availabilityText.textContent = 'Sold Out';
      availabilityBadge.classList.add('sold-out');
      buyBtn.disabled = true;
      buyBtn.textContent = 'Sold Out';
    } else if (available < 10) {
      availabilityBadge.classList.add('low-stock');
    } else {
      availabilityBadge.classList.remove('low-stock', 'sold-out');
    }
  };

  evtSource.onerror = () => {
    availabilityText.textContent = 'Limited Tickets Available';
  };
})();

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * RFC 4122 v4 UUID generator (crypto.randomUUID with fallback).
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
