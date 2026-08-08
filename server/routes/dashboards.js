const express = require('express');
const db = require('../db');
const { canSee, roleNameMap } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
// NOTE: intentionally no router.use(requireAuth) here — most of these routes are
// reachable anonymously. Every query filters by visibility using req.user, which
// resolveUser sets to null (not blocked) for anonymous requests. Favorites and
// "last used" are personal, so those specific bits require a real user.

function fullDashboard(dashboard, user) {
  const sections = db.prepare(
    'SELECT * FROM sections WHERE dashboard_id = ? ORDER BY sort_order, name'
  ).all(dashboard.id);

  const categories = db.prepare(
    'SELECT * FROM categories WHERE dashboard_id = ? ORDER BY sort_order, name'
  ).all(dashboard.id);

  let items = db.prepare(
    'SELECT * FROM items WHERE dashboard_id = ? ORDER BY sort_order, name'
  ).all(dashboard.id);

  const itemRoleNames = roleNameMap('item_roles', 'item_id', items.map(i => i.id));
  items = items.filter(it => canSee(it.visibility, user, itemRoleNames[it.id]));

  if (user) {
    const favSet = new Set(
      db.prepare('SELECT item_id FROM item_favorites WHERE user_id = ?').all(user.id).map(r => r.item_id)
    );
    const usageMap = {};
    for (const r of db.prepare('SELECT item_id, last_used_at FROM item_usage WHERE user_id = ?').all(user.id)) {
      usageMap[r.item_id] = r.last_used_at;
    }
    items = items.map(it => ({ ...it, is_favorite: favSet.has(it.id), last_used_at: usageMap[it.id] || null }));
  } else {
    items = items.map(it => ({ ...it, is_favorite: false, last_used_at: null }));
  }

  const byCategory = {};
  for (const cat of categories) byCategory[cat.id] = { ...cat, items: [] };
  const uncategorized = [];
  for (const item of items) {
    if (item.category_id && byCategory[item.category_id]) {
      byCategory[item.category_id].items.push(item);
    } else {
      uncategorized.push(item);
    }
  }

  // Group categories under their section, in section sort order. A category with
  // no section_id (shouldn't normally happen) is dropped rather than crashing —
  // it just won't render until an admin assigns it a section.
  const bySection = sections.map(s => ({ ...s, categories: [] }));
  const sectionIndex = {};
  bySection.forEach((s, i) => { sectionIndex[s.id] = i; });
  for (const cat of Object.values(byCategory)) {
    if (cat.section_id != null && sectionIndex[cat.section_id] !== undefined) {
      bySection[sectionIndex[cat.section_id]].categories.push(cat);
    }
  }

  return { ...dashboard, sections: bySection, uncategorized };
}

// GET /api/dashboards -> dashboards visible to the current viewer (anonymous or logged in)
router.get('/', (req, res) => {
  const all = db.prepare('SELECT id, slug, name, sort_order, visibility FROM dashboards ORDER BY sort_order, name').all();
  const roleNames = roleNameMap('dashboard_roles', 'dashboard_id', all.map(d => d.id));
  const dashboards = all
    .filter(d => canSee(d.visibility, req.user, roleNames[d.id]))
    .map(({ visibility, ...d }) => d);
  res.json({ dashboards });
});

// GET /api/dashboards/:slug -> full card data for one dashboard (grouped by section),
// items filtered by visibility, annotated with this viewer's own favorites/last-used.
router.get('/:slug', (req, res) => {
  const dashboard = db.prepare('SELECT * FROM dashboards WHERE slug = ?').get(req.params.slug);
  if (!dashboard) return res.status(404).json({ error: 'not_found' });
  const roleNames = roleNameMap('dashboard_roles', 'dashboard_id', [dashboard.id])[dashboard.id];
  if (!canSee(dashboard.visibility, req.user, roleNames)) return res.status(404).json({ error: 'not_found' });
  res.json(fullDashboard(dashboard, req.user));
});

// GET /api/search?q=... -> omnisearch across every visible item on every visible dashboard
router.get('/search/query', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  const like = `%${q.toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT items.*, categories.name AS category_name,
           dashboards.slug AS dashboard_slug, dashboards.name AS dashboard_name, dashboards.visibility AS dashboard_visibility
    FROM items
    LEFT JOIN categories ON categories.id = items.category_id
    JOIN dashboards ON dashboards.id = items.dashboard_id
    WHERE (LOWER(items.name) LIKE ? OR LOWER(items.description) LIKE ? OR LOWER(categories.name) LIKE ?)
    ORDER BY items.name
    LIMIT 200
  `).all(like, like, like);

  const dashboardIds = [...new Set(rows.map(r => r.dashboard_id))];
  const dashboardRoleNames = roleNameMap('dashboard_roles', 'dashboard_id', dashboardIds);
  const itemRoleNamesMap = roleNameMap('item_roles', 'item_id', rows.map(r => r.id));

  const results = rows
    .filter(r => canSee(r.dashboard_visibility, req.user, dashboardRoleNames[r.dashboard_id])
              && canSee(r.visibility, req.user, itemRoleNamesMap[r.id]))
    .slice(0, 50)
    .map(({ dashboard_visibility, ...r }) => r);

  res.json({ results });
});

// POST /api/dashboards/items/:id/touch -> record that THIS viewer just opened this item
// ("last used" is personal, not office-wide). Anonymous visitors can still click the
// link fine — this just silently doesn't record anything for them.
router.post('/items/:id/touch', (req, res) => {
  const item = db.prepare('SELECT items.*, dashboards.visibility AS dashboard_visibility, dashboards.id AS dashboard_id FROM items JOIN dashboards ON dashboards.id = items.dashboard_id WHERE items.id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const dashboardRoleNames = roleNameMap('dashboard_roles', 'dashboard_id', [item.dashboard_id])[item.dashboard_id];
  const itemRoleNames = roleNameMap('item_roles', 'item_id', [item.id])[item.id];
  if (!canSee(item.dashboard_visibility, req.user, dashboardRoleNames) || !canSee(item.visibility, req.user, itemRoleNames)) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (req.user) {
    db.prepare(`
      INSERT INTO item_usage (user_id, item_id, last_used_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id, item_id) DO UPDATE SET last_used_at = datetime('now')
    `).run(req.user.id, item.id);
  }
  res.json({ ok: true, tracked: !!req.user });
});

// POST /api/dashboards/items/:id/favorite -> toggle this item as a personal favorite.
// Requires login — favorites are meaningless without an account to attach them to.
router.post('/items/:id/favorite', requireAuth, (req, res) => {
  const item = db.prepare('SELECT items.*, dashboards.visibility AS dashboard_visibility, dashboards.id AS dashboard_id FROM items JOIN dashboards ON dashboards.id = items.dashboard_id WHERE items.id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const dashboardRoleNames = roleNameMap('dashboard_roles', 'dashboard_id', [item.dashboard_id])[item.dashboard_id];
  const itemRoleNames = roleNameMap('item_roles', 'item_id', [item.id])[item.id];
  if (!canSee(item.dashboard_visibility, req.user, dashboardRoleNames) || !canSee(item.visibility, req.user, itemRoleNames)) {
    return res.status(404).json({ error: 'not_found' });
  }
  const existing = db.prepare('SELECT id FROM item_favorites WHERE user_id = ? AND item_id = ?').get(req.user.id, item.id);
  if (existing) {
    db.prepare('DELETE FROM item_favorites WHERE id = ?').run(existing.id);
    return res.json({ favorited: false });
  }
  db.prepare('INSERT INTO item_favorites (user_id, item_id) VALUES (?, ?)').run(req.user.id, item.id);
  res.json({ favorited: true });
});

module.exports = router;
