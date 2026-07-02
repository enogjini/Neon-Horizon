const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword } = require('../passwords');

function normalizeIdentifier(value) {
  const identifier = String(value || '').trim();
  return identifier.includes('@') ? identifier.toLowerCase() : identifier;
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

  res.json({ message: 'Login successful', emailOrPhone: account.email_or_phone });
});


module.exports = router;
