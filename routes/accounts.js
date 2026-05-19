const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * POST /api/accounts/signup
 */
router.post('/signup', async (req, res) => {
  const { emailOrPhone, password } = req.body;

  if (!emailOrPhone || !password) {
    return res.status(400).json({ error: 'Email/Phone and password are required' });
  }

  const existing = await db.findAccount(emailOrPhone);
  if (existing) {
    return res.status(400).json({ error: 'Account already exists' });
  }

  const account = await db.createAccount({ emailOrPhone, password });
  res.status(201).json({ message: 'Account created successfully', emailOrPhone: account.emailOrPhone });
});

/**
 * POST /api/accounts/login
 */
router.post('/login', async (req, res) => {
  const { emailOrPhone, password } = req.body;

  if (!emailOrPhone || !password) {
    return res.status(400).json({ error: 'Email/Phone and password are required' });
  }

  const account = await db.findAccount(emailOrPhone);
  if (!account || account.password !== password) {
    return res.status(401).json({ error: 'Invalid email/phone or password' });
  }

  res.json({ message: 'Login successful', emailOrPhone: account.emailOrPhone });
});


module.exports = router;
