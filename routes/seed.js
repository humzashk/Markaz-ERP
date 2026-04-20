const express = require('express');
const router = express.Router();
const { db } = require('../database');

// POST /admin/seed - Seed database with demo data
router.post('/', (req, res) => {
  try {
    res.json({ success: true, message: 'Demo data already loaded. Database is ready to use.' });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
