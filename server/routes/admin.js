const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const { exec } = require('child_process');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

function getOrCreateRoleId(name) {
  const existing = db.prepare('SELECT id FROM roles WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO roles (name) VALUES (?)').run(name).lastInsertRowid;
}
function setRoleLinks(linkTable, fkColumn, entityId, roleIds) {
  db.prepare(`DELETE FROM ${linkTable} WHERE ${fkColumn} = ?`).run(entityId);
  const insert = db.prepare(`INSERT INTO ${linkTable} (${fkColumn}, role_id) VALUES (?, ?)`);
  for (const roleId of roleIds || []) insert.run(entityId, roleId);
}
function rolesFor(linkTable, fkColumn, entityId) {
  return db.prepare(`SELECT r.id, r.name FROM ${linkTable} lt JOIN roles r ON r.id = lt.role_id WHERE lt.${fkColumn} = ?`).all(entityId);
}
function setNoteUserLinks(itemId, userIds) {
  db.prepare('DELETE FROM item_note_users WHERE item_id = ?').run(itemId);
  const insert = db.prepare('INSERT INTO item_note_users (item_id, user_id) VALUES (?, ?)');
  for (const userId of userIds || []) insert.run(itemId, userId);
}

// ---------- Roles ----------
router.get('/roles', (req, res) => {
  res.json({ roles: db.prepare('SELECT * FROM roles ORDER BY name').all() });
});

router.post('/roles', (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  try {
    const info = db.prepare('INSERT INTO roles (name) VALUES (?)').run(name.trim());
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'name_taken', detail: e.message });
  }
});

router.delete('/roles/:id', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (role && role.name === 'admin') return res.status(400).json({ error: 'cannot_delete_admin_role' });
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Dashboards ----------
router.get('/dashboards', (req, res) => {
  const dashboards = db.prepare('SELECT * FROM dashboards ORDER BY sort_order, name').all();
  for (const d of dashboards) d.role_ids = rolesFor('dashboard_roles', 'dashboard_id', d.id).map(r => r.id);
  res.json({ dashboards });
});

router.post('/dashboards', (req, res) => {
  const { slug, name, sort_order = 0, visibility = 'authenticated', role_ids = [] } = req.body || {};
  if (!slug || !name) return res.status(400).json({ error: 'slug_and_name_required' });
  try {
    const info = db.prepare('INSERT INTO dashboards (slug, name, sort_order, visibility) VALUES (?, ?, ?, ?)').run(slug, name, sort_order, visibility);
    if (visibility === 'roles') setRoleLinks('dashboard_roles', 'dashboard_id', info.lastInsertRowid, role_ids);
    // A brand-new dashboard needs at least one section to hold anything.
    db.prepare(`INSERT INTO sections (dashboard_id, name, display_style, sort_order) VALUES (?, 'Applications', 'cards', 0)`).run(info.lastInsertRowid);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'slug_taken_or_invalid', detail: e.message });
  }
});

router.put('/dashboards/:id', (req, res) => {
  const { slug, name, sort_order, visibility, role_ids } = req.body || {};
  db.prepare(`UPDATE dashboards SET slug = COALESCE(?, slug), name = COALESCE(?, name),
              sort_order = COALESCE(?, sort_order), visibility = COALESCE(?, visibility) WHERE id = ?`)
    .run(slug, name, sort_order, visibility, req.params.id);
  if (role_ids !== undefined) setRoleLinks('dashboard_roles', 'dashboard_id', req.params.id, role_ids);
  res.json({ ok: true });
});

router.delete('/dashboards/:id', (req, res) => {
  db.prepare('DELETE FROM dashboards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Sections ----------
router.get('/dashboards/:id/sections', (req, res) => {
  res.json({ sections: db.prepare('SELECT * FROM sections WHERE dashboard_id = ? ORDER BY sort_order, name').all(req.params.id) });
});

router.post('/sections', (req, res) => {
  const { dashboard_id, name, display_style = 'cards', sort_order = 0 } = req.body || {};
  if (!dashboard_id || !name) return res.status(400).json({ error: 'dashboard_id_and_name_required' });
  if (!['cards', 'list'].includes(display_style)) return res.status(400).json({ error: 'invalid_display_style' });
  const info = db.prepare('INSERT INTO sections (dashboard_id, name, display_style, sort_order) VALUES (?, ?, ?, ?)')
    .run(dashboard_id, name, display_style, sort_order);
  res.json({ id: info.lastInsertRowid });
});

router.put('/sections/:id', (req, res) => {
  const { name, display_style, sort_order } = req.body || {};
  if (display_style !== undefined && !['cards', 'list'].includes(display_style)) return res.status(400).json({ error: 'invalid_display_style' });
  db.prepare('UPDATE sections SET name = COALESCE(?, name), display_style = COALESCE(?, display_style), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(name, display_style, sort_order, req.params.id);
  res.json({ ok: true });
});

router.delete('/sections/:id', (req, res) => {
  // Categories under this section become unassigned (hidden until reassigned) rather
  // than deleted outright — matches how deleting a category orphans its items.
  db.prepare('UPDATE categories SET section_id = NULL WHERE section_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sections WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Categories ----------
router.post('/categories', (req, res) => {
  const { dashboard_id, section_id, name, sort_order = 0 } = req.body || {};
  if (!dashboard_id || !section_id || !name) return res.status(400).json({ error: 'dashboard_id_section_id_and_name_required' });
  const info = db.prepare('INSERT INTO categories (dashboard_id, section_id, name, sort_order) VALUES (?, ?, ?, ?)')
    .run(dashboard_id, section_id, name, sort_order);
  res.json({ id: info.lastInsertRowid });
});

router.put('/categories/:id', (req, res) => {
  const { name, section_id, sort_order } = req.body || {};
  db.prepare('UPDATE categories SET name = COALESCE(?, name), section_id = COALESCE(?, section_id), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(name, section_id, sort_order, req.params.id);
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Items (apps / bookmarks / anything else) ----------
router.post('/items', (req, res) => {
  const { dashboard_id, category_id, name, url, icon, description, sort_order = 0, status_check = 0, status_url, visibility = 'authenticated', role_ids = [] } = req.body || {};
  if (!dashboard_id || !name || !url) return res.status(400).json({ error: 'dashboard_id_name_url_required' });
  const info = db.prepare(`
    INSERT INTO items (dashboard_id, category_id, name, url, icon, description, sort_order, status_check, status_url, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(dashboard_id, category_id || null, name, url, icon || 'bi-link-45deg', description || '', sort_order, status_check ? 1 : 0, status_url || url, visibility);
  if (visibility === 'roles') setRoleLinks('item_roles', 'item_id', info.lastInsertRowid, role_ids);
  res.json({ id: info.lastInsertRowid });
});

router.put('/items/:id', (req, res) => {
  const f = req.body || {};
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  db.prepare(`
    UPDATE items SET
      category_id = ?, name = ?, url = ?, icon = ?, description = ?,
      sort_order = ?, status_check = ?, status_url = ?, visibility = ?,
      notes = ?, notes_visibility = ?
    WHERE id = ?
  `).run(
    f.category_id !== undefined ? f.category_id : existing.category_id,
    f.name !== undefined ? f.name : existing.name,
    f.url !== undefined ? f.url : existing.url,
    f.icon !== undefined ? f.icon : existing.icon,
    f.description !== undefined ? f.description : existing.description,
    f.sort_order !== undefined ? f.sort_order : existing.sort_order,
    f.status_check !== undefined ? (f.status_check ? 1 : 0) : existing.status_check,
    f.status_url !== undefined ? f.status_url : existing.status_url,
    f.visibility !== undefined ? f.visibility : existing.visibility,
    f.notes !== undefined ? f.notes : existing.notes,
    f.notes_visibility !== undefined ? f.notes_visibility : existing.notes_visibility,
    req.params.id
  );
  if (f.role_ids !== undefined) setRoleLinks('item_roles', 'item_id', req.params.id, f.role_ids);
  if (f.note_user_ids !== undefined) setNoteUserLinks(req.params.id, f.note_user_ids);
  res.json({ ok: true });
});

router.delete('/items/:id', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/items/:id/roles', (req, res) => {
  res.json({ role_ids: rolesFor('item_roles', 'item_id', req.params.id).map(r => r.id) });
});

router.get('/items/:id/notes-users', (req, res) => {
  const rows = db.prepare('SELECT user_id FROM item_note_users WHERE item_id = ?').all(req.params.id);
  res.json({ note_user_ids: rows.map(r => r.user_id) });
});

// ---------- Users ----------
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, created_at FROM users WHERE deleted_at IS NULL ORDER BY username').all();
  for (const u of users) {
    const roles = rolesFor('user_roles', 'user_id', u.id);
    u.role_ids = roles.map(r => r.id);
    u.role_names = roles.map(r => r.name);
  }
  res.json({ users });
});

// Soft-deleted users — listed separately so they can be restored. Their user_roles
// and ip_mappings rows are left untouched by DELETE /users/:id below, so restoring
// just clears deleted_at and everything (roles, remembered devices) comes back as-is.
router.get('/users/deleted', (req, res) => {
  const users = db.prepare('SELECT id, username, created_at, deleted_at FROM users WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
  for (const u of users) {
    const roles = rolesFor('user_roles', 'user_id', u.id);
    u.role_names = roles.map(r => r.name);
  }
  res.json({ users });
});

router.post('/users', (req, res) => {
  const { username, password, role_ids = [] } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username_and_password_required' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    setRoleLinks('user_roles', 'user_id', info.lastInsertRowid, role_ids);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'username_taken', detail: e.message });
  }
});

// Bulk-create users from parsed CSV rows: [{ username, password, roles: ['admin', ...] }].
// Role names not yet on this instance are created automatically (same precedent as
// dashboard JSON import above). Returns a per-row result so the admin can see exactly
// which rows were created vs skipped vs rejected, instead of an opaque overall status.
router.post('/users/import', (req, res) => {
  const { rows = [] } = req.body || {};
  const results = [];
  db.transaction(() => {
    for (const row of rows) {
      const username = (row.username || '').trim();
      const password = row.password || '';
      if (!username || !password) {
        results.push({ username: username || '(blank)', status: 'error', error: 'username_and_password_required' });
        continue;
      }
      if (password.length < 8) {
        results.push({ username, status: 'error', error: 'password_too_short' });
        continue;
      }
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        results.push({ username, status: 'skipped', error: 'username_taken' });
        continue;
      }
      const roleIds = (row.roles || []).filter(Boolean).map(getOrCreateRoleId);
      const hash = bcrypt.hashSync(password, 10);
      const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
      setRoleLinks('user_roles', 'user_id', info.lastInsertRowid, roleIds);
      results.push({ username, status: 'created' });
    }
  })();
  res.json({ results });
});

router.put('/users/:id', (req, res) => {
  const { password, role_ids } = req.body || {};
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  }
  if (role_ids !== undefined) {
    setRoleLinks('user_roles', 'user_id', req.params.id, role_ids);
  }
  res.json({ ok: true });
});

// Soft delete: marks the account deleted_at instead of removing the row, so login and
// IP auto-login both stop recognizing them (see middleware/auth.js, routes/auth.js)
// while their roles and IP mappings stay intact for POST /users/:id/restore below.
router.delete('/users/:id', (req, res) => {
  db.prepare("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.post('/users/:id/restore', (req, res) => {
  db.prepare('UPDATE users SET deleted_at = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- IP mappings ----------
router.get('/ip-mappings', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.ip, m.note, m.created_at, u.id AS user_id, u.username
    FROM ip_mappings m JOIN users u ON u.id = m.user_id
    ORDER BY m.ip
  `).all();
  res.json({ mappings: rows });
});

router.post('/ip-mappings', (req, res) => {
  const { ip, user_id, note = '' } = req.body || {};
  if (!ip || !user_id) return res.status(400).json({ error: 'ip_and_user_id_required' });
  try {
    db.prepare(`
      INSERT INTO ip_mappings (ip, user_id, note) VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET user_id = excluded.user_id, note = excluded.note
    `).run(ip, user_id, note);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'invalid', detail: e.message });
  }
});

router.delete('/ip-mappings/:id', (req, res) => {
  db.prepare('DELETE FROM ip_mappings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- JSON export / import (git-friendly backup, per dashboard) ----------
router.get('/dashboards/:id/export', (req, res) => {
  const dashboard = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(req.params.id);
  if (!dashboard) return res.status(404).json({ error: 'not_found' });
  const sections = db.prepare('SELECT id, name, display_style, sort_order FROM sections WHERE dashboard_id = ?').all(dashboard.id);
  const categories = db.prepare('SELECT id, section_id, name, sort_order FROM categories WHERE dashboard_id = ?').all(dashboard.id);
  const items = db.prepare('SELECT id, category_id, name, url, icon, description, sort_order, status_check, status_url, visibility FROM items WHERE dashboard_id = ?').all(dashboard.id);
  for (const it of items) it.role_names = rolesFor('item_roles', 'item_id', it.id).map(r => r.name);
  const dashboardRoleNames = rolesFor('dashboard_roles', 'dashboard_id', dashboard.id).map(r => r.name);

  res.setHeader('Content-Disposition', `attachment; filename="${dashboard.slug}.json"`);
  res.json({
    slug: dashboard.slug,
    name: dashboard.name,
    sort_order: dashboard.sort_order,
    visibility: dashboard.visibility,
    role_names: dashboardRoleNames,
    sections,
    categories,
    items,
  });
});

// Body: the JSON produced by the export endpoint above (or hand-written).
// Replaces this dashboard's sections/categories/items wholesale — meant for
// restoring from a git-committed rules file, not for incremental merges. Role
// names not yet present on this instance are created automatically.
router.post('/dashboards/:id/import', (req, res) => {
  const dashboardId = Number(req.params.id);
  const dashboard = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(dashboardId);
  if (!dashboard) return res.status(404).json({ error: 'not_found' });
  const { sections = [], categories = [], items = [], visibility, role_names } = req.body || {};

  const tx = db.transaction(() => {
    if (visibility) {
      db.prepare('UPDATE dashboards SET visibility = ? WHERE id = ?').run(visibility, dashboardId);
    }
    if (visibility === 'roles' && role_names) {
      setRoleLinks('dashboard_roles', 'dashboard_id', dashboardId, role_names.map(getOrCreateRoleId));
    }

    db.prepare('DELETE FROM items WHERE dashboard_id = ?').run(dashboardId);
    db.prepare('DELETE FROM categories WHERE dashboard_id = ?').run(dashboardId);
    db.prepare('DELETE FROM sections WHERE dashboard_id = ?').run(dashboardId);

    const sectionIdMap = {};
    const insertSection = db.prepare('INSERT INTO sections (dashboard_id, name, display_style, sort_order) VALUES (?, ?, ?, ?)');
    for (const s of sections) {
      const info = insertSection.run(dashboardId, s.name, s.display_style || 'cards', s.sort_order || 0);
      if (s.id !== undefined) sectionIdMap[s.id] = info.lastInsertRowid;
    }

    const catIdMap = {};
    const insertCat = db.prepare('INSERT INTO categories (dashboard_id, section_id, name, sort_order) VALUES (?, ?, ?, ?)');
    for (const c of categories) {
      const newSectionId = c.section_id !== undefined ? (sectionIdMap[c.section_id] ?? null) : null;
      const info = insertCat.run(dashboardId, newSectionId, c.name, c.sort_order || 0);
      if (c.id !== undefined) catIdMap[c.id] = info.lastInsertRowid;
    }

    const insertItem = db.prepare(`
      INSERT INTO items (dashboard_id, category_id, name, url, icon, description, sort_order, status_check, status_url, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of items) {
      const newCatId = it.category_id !== undefined ? (catIdMap[it.category_id] ?? null) : null;
      const info = insertItem.run(
        dashboardId, newCatId, it.name, it.url, it.icon || 'bi-link-45deg',
        it.description || '', it.sort_order || 0, it.status_check ? 1 : 0, it.status_url || it.url,
        it.visibility || 'authenticated'
      );
      if (it.visibility === 'roles' && it.role_names) {
        setRoleLinks('item_roles', 'item_id', info.lastInsertRowid, it.role_names.map(getOrCreateRoleId));
      }
    }
  });

  tx();
  res.json({ ok: true });
});

// ---------- Feedback ----------
router.get('/feedback', (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.rating, f.message, f.status, f.created_at, f.closed_at,
           i.id AS item_id, i.name AS item_name,
           d.id AS dashboard_id, d.name AS dashboard_name,
           u.id AS user_id, u.username
    FROM feedback f
    JOIN items i ON i.id = f.item_id
    JOIN dashboards d ON d.id = i.dashboard_id
    JOIN users u ON u.id = f.user_id
    ORDER BY f.created_at DESC
  `).all();
  res.json({ feedback: rows });
});

// 'open' (just submitted) -> 'pending' (admin looking into it) -> 'closed' (resolved).
// Also auto-closed after FEEDBACK_AUTO_CLOSE_DAYS by services/feedbackAutoCloser.js.
router.put('/feedback/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'pending', 'closed'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  if (status === 'closed') {
    db.prepare("UPDATE feedback SET status = ?, closed_at = datetime('now') WHERE id = ?").run(status, req.params.id);
  } else {
    db.prepare('UPDATE feedback SET status = ?, closed_at = NULL WHERE id = ?').run(status, req.params.id);
  }
  res.json({ ok: true });
});

router.delete('/feedback/:id', (req, res) => {
  db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Quick Links (monitoring + publish requests) ----------
// GET /admin/quicklinks -> every user's QuickLink, who it's shared with, and its
// all-time click count — the "who's sharing what with whom, and is it used" view.
router.get('/quicklinks', (req, res) => {
  const rows = db.prepare(`
    SELECT ql.id, ql.name, ql.url, ql.description, ql.status, ql.created_at, u.username AS owner_username
    FROM quick_links ql JOIN users u ON u.id = ql.owner_user_id
    ORDER BY ql.created_at DESC
  `).all();
  const ids = rows.map(r => r.id);
  const shareMap = {};
  const usageMap = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const shareRows = db.prepare(`
      SELECT s.quick_link_id, u.username FROM quick_link_shares s JOIN users u ON u.id = s.shared_with_user_id
      WHERE s.quick_link_id IN (${placeholders})
    `).all(...ids);
    for (const r of shareRows) (shareMap[r.quick_link_id] = shareMap[r.quick_link_id] || []).push(r.username);
    const usageRows = db.prepare(`
      SELECT quicklink_id, COUNT(*) AS c FROM events
      WHERE category = 'quicklink' AND action = 'follow_quicklink' AND quicklink_id IN (${placeholders})
      GROUP BY quicklink_id
    `).all(...ids);
    for (const r of usageRows) usageMap[r.quicklink_id] = r.c;
  }
  const quicklinks = rows.map(r => ({ ...r, shared_with: shareMap[r.id] || [], usage_count: usageMap[r.id] || 0 }));
  res.json({ quicklinks });
});

router.delete('/quicklinks/:id', (req, res) => {
  db.prepare('DELETE FROM quick_links WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/quicklinks/publish-requests', (req, res) => {
  const status = req.query.status || 'pending';
  const where = status === 'all' ? '' : 'WHERE r.status = ?';
  const rows = db.prepare(`
    SELECT r.id, r.remarks, r.status, r.admin_remarks, r.created_at, r.resolved_at,
           ql.id AS quick_link_id, ql.name AS link_name, ql.url AS link_url, ql.description AS link_description,
           u.username AS requested_by
    FROM quick_link_publish_requests r
    JOIN quick_links ql ON ql.id = r.quick_link_id
    JOIN users u ON u.id = r.requested_by_user_id
    ${where}
    ORDER BY r.created_at DESC
  `).all(...(status === 'all' ? [] : [status]));
  res.json({ requests: rows });
});

// POST /admin/quicklinks/publish-requests/:id/approve { category_id } -> creates a
// real items row under that category (dashboard is derived from the category), marks
// the QuickLink 'published', and closes the request.
router.post('/quicklinks/publish-requests/:id/approve', (req, res) => {
  const request = db.prepare('SELECT * FROM quick_link_publish_requests WHERE id = ?').get(req.params.id);
  if (!request || request.status !== 'pending') return res.status(404).json({ error: 'not_found_or_resolved' });
  const link = db.prepare('SELECT * FROM quick_links WHERE id = ?').get(request.quick_link_id);
  if (!link) return res.status(404).json({ error: 'quicklink_not_found' });
  const { category_id } = req.body || {};
  const category = category_id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(category_id) : null;
  if (!category) return res.status(400).json({ error: 'invalid_category' });

  const itemId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO items (dashboard_id, category_id, name, url, description, visibility)
      VALUES (?, ?, ?, ?, ?, 'authenticated')
    `).run(category.dashboard_id, category.id, link.name, link.url, link.description || '');
    db.prepare("UPDATE quick_links SET status = 'published' WHERE id = ?").run(link.id);
    db.prepare(`
      UPDATE quick_link_publish_requests
      SET status = 'approved', resolved_by_user_id = ?, resolved_item_id = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(req.user.id, info.lastInsertRowid, request.id);
    return info.lastInsertRowid;
  })();
  res.json({ ok: true, item_id: itemId });
});

router.post('/quicklinks/publish-requests/:id/reject', (req, res) => {
  const request = db.prepare('SELECT * FROM quick_link_publish_requests WHERE id = ?').get(req.params.id);
  if (!request || request.status !== 'pending') return res.status(404).json({ error: 'not_found_or_resolved' });
  const { admin_remarks = '' } = req.body || {};
  db.transaction(() => {
    db.prepare(`
      UPDATE quick_link_publish_requests
      SET status = 'rejected', admin_remarks = ?, resolved_by_user_id = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(admin_remarks.trim(), req.user.id, request.id);
    db.prepare("UPDATE quick_links SET status = 'private' WHERE id = ?").run(request.quick_link_id);
  })();
  res.json({ ok: true });
});

// ---------- branding ----------
// Partial update — only touches fields present in the body, same style as PUT
// /users/:id above. Any field may be explicitly null to clear it back to unset.
router.put('/settings', (req, res) => {
  const fields = ['app_title', 'logo_data', 'background_data', 'watermark_data', 'watermark_opacity', 'accent_color'];
  const updates = fields.filter(f => req.body && Object.prototype.hasOwnProperty.call(req.body, f));
  if (updates.length) {
    const setClause = updates.map(f => `${f} = ?`).join(', ');
    db.prepare(`UPDATE branding SET ${setClause} WHERE id = 1`).run(...updates.map(f => req.body[f]));
  }
  res.json({ ok: true });
});

// ---------- update ----------
// Fixed command sequence only — no user-supplied input reaches the shell. Only
// restarts on a successful pull; a conflicted/failed pull leaves the running
// process alone so a bad update doesn't take the site down.
router.post('/update', (req, res) => {
  const repoRoot = path.join(__dirname, '..', '..');
  exec('git pull origin HEAD', { cwd: repoRoot, timeout: 60000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, step: 'git_pull', error: err.message, stdout, stderr });
    res.json({ ok: true, stdout, stderr, restarting: true });
    setTimeout(() => {
      // pm2 sets pm_id on any process it manages, regardless of configured app name —
      // no assumption baked in about how this particular deployment is run.
      if (process.env.pm_id) exec(`pm2 restart ${process.env.pm_id}`);
      else process.exit(0); // no pm2 — rely on systemd/docker/manual restart
    }, 300);
  });
});

module.exports = router;
