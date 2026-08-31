const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword } = require('../passwords');
const {
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} = require('../auth');

function normalizeIdentifier(value) {
  const identifier = String(value || '').trim();
  return identifier.includes('@') ? identifier.toLowerCase() : identifier;
}

function startSession(res, account) {
  const token = createSessionToken({ sub: account.id, identifier: account.email_or_phone });
  setSessionCookie(res, token);
}

/**
 * POST /api/accounts/signup
 */
router.post('/signup', async (req, res) => {
  const { password } = req.body;
  const emailOrPhone = normalizeIdentifier(req.body.emailOrPhone);

  if (!emailOrPhone || !password) {
    return res.status(400).json({ error: 'Email/Phone and password are required' });
  }

  let passwordHash;
  try {
    passwordHash = await hashPassword(password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const existing = await db.findAccount(emailOrPhone);
  if (existing) {
    return res.status(409).json({ error: 'Account already exists' });
  }

  const account = await db.createAccount({ emailOrPhone, passwordHash });
  startSession(res, account);
  res.status(201).json({
    message: 'Account created successfully',
    emailOrPhone: account.email_or_phone,
  });
});

/**
 * POST /api/accounts/login
 */
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const emailOrPhone = normalizeIdentifier(req.body.emailOrPhone);

  if (!emailOrPhone || !password) {
    return res.status(400).json({ error: 'Email/Phone and password are required' });
  }

  const account = await db.findAccount(emailOrPhone);
  if (!account || !(await verifyPassword(password, account.password_hash))) {
    return res.status(401).json({ error: 'Invalid email/phone or password' });
  }

  startSession(res, account);
  res.json({ message: 'Login successful', emailOrPhone: account.email_or_phone });
});

/**
 * POST /api/accounts/logout
 */
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ message: 'Logged out' });
});

/**
 * GET /api/accounts/me — returns the current session's account, or 401.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, emailOrPhone: req.user.identifier });
});

module.exports = router;
