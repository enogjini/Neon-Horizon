const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const attendees = await db.listAttendees();
  return res.json({ attendees });
});

router.post('/', async (req, res) => {
  const { name, email } = req.body || {};
  const trimmedName = String(name || '').trim();
  const trimmedEmail = String(email || '').trim().toLowerCase();

  if (!trimmedName || !trimmedEmail) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  const record = await db.addAttendee({ name: trimmedName, email: trimmedEmail });
  if (!record) {
    return res.status(500).json({ error: 'Could not save attendee' });
  }

  return res.status(201).json({ ok: true, attendee: record });
});

module.exports = router;
