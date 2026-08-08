const express = require('express');
const db = require('../db');
const { canSee, roleNameMap } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { checkAllNow } = require('../services/statusChecker');

const router = express.Router();

// GET /api/status/:slug -> lightweight poll target for the frontend (badges only).
// No login required — matches the dashboard/item visibility rules, same as the main
// dashboard data route, so a public dashboard's status badges work for anonymous viewers.
router.get('/:slug', (req, res) => {
  const dashboard = db.prepare('SELECT * FROM dashboards WHERE slug = ?').get(req.params.slug);
  if (!dashboard) return res.status(404).json({ error: 'not_found' });
  const dashboardRoleNames = roleNameMap('dashboard_roles', 'dashboard_id', [dashboard.id])[dashboard.id];
  if (!canSee(dashboard.visibility, req.user, dashboardRoleNames)) return res.status(404).json({ error: 'not_found' });

  const rows = db.prepare(
    'SELECT id, visibility, last_status, last_checked, last_response_ms FROM items WHERE dashboard_id = ? AND status_check = 1'
  ).all(dashboard.id);
  const itemRoleNames = roleNameMap('item_roles', 'item_id', rows.map(r => r.id));
  const statuses = rows
    .filter(it => canSee(it.visibility, req.user, itemRoleNames[it.id]))
    .map(({ visibility, ...it }) => it);
  res.json({ statuses });
});

// POST /api/status/recheck -> admin-triggered immediate re-check of all monitored items
router.post('/recheck', requireAdmin, async (req, res) => {
  const results = await checkAllNow();
  res.json({ ok: true, checked: results.length });
});

module.exports = router;
