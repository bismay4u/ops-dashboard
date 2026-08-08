const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signUser } = require('../utils/jwt');
const { COOKIE_NAME, requireAuth } = require('../middleware/auth');

const router = express.Router();

function publicUser(user) {
  return { id: user.id, username: user.username, roles: user.roles };
}

// POST /api/auth/login  { username, password, mapIp: true|false }
// On success: sets a session cookie AND, by default, maps the caller's current
// IP to this user so future requests from this IP auto-login (no cookie needed).
router.post('/login', (req, res) => {
  const { username, password, mapIp = true } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username_and_password_required' });
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const user = { ...row, roles: db.rolesForUser(row.id) };

  const token = signUser(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    // secure: true, // enable once served over HTTPS (recommended in production)
  });

  let ipMapped = false;
  if (mapIp && req.clientIp) {
    try {
      db.prepare(
        `INSERT INTO ip_mappings (ip, user_id, note) VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET user_id = excluded.user_id`
      ).run(req.clientIp, user.id, 'auto-mapped at login');
      ipMapped = true;
    } catch (e) {
      // ip already mapped to someone else via a race, or similar — non-fatal
      console.warn('[auth] ip mapping failed:', e.message);
    }
  }

  res.json({ user: publicUser(user), ipMapped, ip: req.clientIp });
});

router.post('/logout', (req, res) => {
  const { forgetDevice } = req.body || {};
  if (forgetDevice && req.user && req.clientIp) {
    db.prepare('DELETE FROM ip_mappings WHERE ip = ? AND user_id = ?').run(req.clientIp, req.user.id);
  }
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'login_required', ip: req.clientIp });
  res.json({ user: publicUser(req.user), authMethod: req.authMethod, ip: req.clientIp });
});

// PUT /api/auth/me/password  { currentPassword, newPassword } — self-service password
// change for the signed-in user. Doesn't touch IP mappings or require re-login.
router.put('/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'current_and_new_password_required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'new_password_too_short' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'current_password_incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ ok: true });
});

module.exports = router;
