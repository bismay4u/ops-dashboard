const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/settings -> site-wide branding (title, logo, background, watermark, accent
// color). No login required — this drives the page chrome for anonymous visitors too,
// same tier as the theme system, which already applies before any auth check.
router.get('/', (req, res) => {
  const branding = db.prepare('SELECT * FROM branding WHERE id = 1').get();
  res.json(branding);
});

module.exports = router;
