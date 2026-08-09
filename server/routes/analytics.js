const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { roleNameMap } = require('../db');

const router = express.Router();
router.use(requireAdmin);

// Every endpoint here reads the shared `events` log (see db.js) over a caller-picked
// trailing window, clamped to [1, 365] days so a bad query string can't force a
// full-table scan.
function windowDays(req) {
  const n = Number(req.query.days);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, Math.round(n)));
}

// GET /api/admin/analytics/daily-usage?days=30 -> per-day total events + unique
// signed-in users, so "how much is this thing actually used" has one chart.
router.get('/daily-usage', (req, res) => {
  const days = windowDays(req);
  const rows = db.prepare(`
    SELECT date(created_at) AS day,
           COUNT(*) AS total_events,
           COUNT(DISTINCT user_id) AS unique_users
    FROM events
    WHERE created_at >= datetime('now', ?)
    GROUP BY day
    ORDER BY day
  `).all(`-${days} days`);
  res.json({ days, daily: rows });
});

// GET /api/admin/analytics/item-usage?days=30 -> items ranked by link-follow count.
router.get('/item-usage', (req, res) => {
  const days = windowDays(req);
  const rows = db.prepare(`
    SELECT e.item_id, i.name AS item_name, d.name AS dashboard_name, COUNT(*) AS clicks
    FROM events e
    JOIN items i ON i.id = e.item_id
    JOIN dashboards d ON d.id = i.dashboard_id
    WHERE e.category = 'link' AND e.action = 'follow_link' AND e.created_at >= datetime('now', ?)
    GROUP BY e.item_id
    ORDER BY clicks DESC
    LIMIT 50
  `).all(`-${days} days`);
  res.json({ days, items: rows });
});

// GET /api/admin/analytics/logins?days=30 -> success/failure per day, unique
// successful users, and the most recent failures (who/where) for quick review.
router.get('/logins', (req, res) => {
  const days = windowDays(req);
  const daily = db.prepare(`
    SELECT date(created_at) AS day,
           SUM(CASE WHEN action = 'login_success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN action = 'login_failure' THEN 1 ELSE 0 END) AS failure
    FROM events
    WHERE category = 'auth' AND created_at >= datetime('now', ?)
    GROUP BY day
    ORDER BY day
  `).all(`-${days} days`);
  const uniqueUsers = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS c FROM events
    WHERE category = 'auth' AND action = 'login_success' AND created_at >= datetime('now', ?)
  `).get(`-${days} days`).c;
  const recentFailures = db.prepare(`
    SELECT label AS attempted_username, ip, created_at FROM events
    WHERE category = 'auth' AND action = 'login_failure' AND created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT 50
  `).all(`-${days} days`);
  res.json({ days, daily, uniqueUsers, recentFailures });
});

// GET /api/admin/analytics/events?days=30 -> every (category, action) pair ranked by
// count — the generic "what are people doing" breakdown.
router.get('/events', (req, res) => {
  const days = windowDays(req);
  const rows = db.prepare(`
    SELECT category, action, COUNT(*) AS count
    FROM events
    WHERE created_at >= datetime('now', ?)
    GROUP BY category, action
    ORDER BY count DESC
  `).all(`-${days} days`);
  res.json({ days, events: rows });
});

// GET /api/admin/analytics/users?days=30 -> every non-deleted user with their event
// count for the window (0 for users who haven't touched the app) plus their all-time
// last-active timestamp, so "who's using this, who isn't" is one table. user_roles
// happens to share the (fk, role_id) shape roleNameMap already expects, so it's
// reused as-is rather than writing a one-off join here.
router.get('/users', (req, res) => {
  const days = windowDays(req);
  const rows = db.prepare(`
    SELECT u.id, u.username,
           COUNT(CASE WHEN e.created_at >= datetime('now', ?) THEN 1 END) AS events_in_period,
           SUM(CASE WHEN e.category = 'auth' AND e.action = 'login_success' AND e.created_at >= datetime('now', ?) THEN 1 ELSE 0 END) AS logins_in_period,
           MAX(e.created_at) AS last_active_at
    FROM users u
    LEFT JOIN events e ON e.user_id = u.id
    WHERE u.deleted_at IS NULL
    GROUP BY u.id
    ORDER BY events_in_period DESC, last_active_at DESC
  `).all(`-${days} days`, `-${days} days`);
  const roleNames = roleNameMap('user_roles', 'user_id', rows.map(r => r.id));
  const users = rows.map(r => ({ ...r, roles: roleNames[r.id] || [] }));
  res.json({ days, users });
});

module.exports = router;
