const express = require('express');
const db = require('../db');
const { logEvent } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
// QuickLinks are inherently personal — no anonymous access, unlike dashboards.js.
router.use(requireAuth);

// Admin kill switch (Admin > Branding > Features). Checked server-side, not just
// hidden in the UI, so the API is actually off when disabled, not just unlisted.
router.use((req, res, next) => {
  const row = db.prepare('SELECT quicklinks_enabled FROM branding WHERE id = 1').get();
  if (row && !row.quicklinks_enabled) return res.status(403).json({ error: 'feature_disabled' });
  next();
});

function sharedUsernames(quickLinkId) {
  return db.prepare(`
    SELECT u.username FROM quick_link_shares s JOIN users u ON u.id = s.shared_with_user_id
    WHERE s.quick_link_id = ? ORDER BY u.username
  `).all(quickLinkId).map(r => r.username);
}

// A quicklink is visible to its owner or anyone it's been shared with — used to gate
// touch (usage tracking) the same way dashboards.js gates favorite/touch on items.
function canAccess(link, userId) {
  if (!link) return false;
  if (link.owner_user_id === userId) return true;
  return !!db.prepare('SELECT 1 FROM quick_link_shares WHERE quick_link_id = ? AND shared_with_user_id = ?').get(link.id, userId);
}

// GET /api/quicklinks/_users -> minimal username list for the share picker. Any
// signed-in user needs this (not just admins) since sharing is a peer-to-peer action.
router.get('/_users', (req, res) => {
  const users = db.prepare('SELECT id, username FROM users WHERE deleted_at IS NULL AND id != ? ORDER BY username').all(req.user.id);
  res.json({ users });
});

// GET /api/quicklinks -> { own: [...], shared: [...] } for the current user.
router.get('/', (req, res) => {
  const own = db.prepare('SELECT * FROM quick_links WHERE owner_user_id = ? ORDER BY created_at DESC').all(req.user.id);
  for (const link of own) {
    link.shared_with = sharedUsernames(link.id);
    if (link.status === 'pending_publish') {
      const request = db.prepare(`
        SELECT remarks FROM quick_link_publish_requests
        WHERE quick_link_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1
      `).get(link.id);
      link.pending_remarks = request ? request.remarks : null;
    }
  }

  const shared = db.prepare(`
    SELECT ql.*, u.username AS owner_username
    FROM quick_link_shares s
    JOIN quick_links ql ON ql.id = s.quick_link_id
    JOIN users u ON u.id = ql.owner_user_id
    WHERE s.shared_with_user_id = ?
    ORDER BY s.created_at DESC
  `).all(req.user.id);

  res.json({ own, shared });
});

// POST /api/quicklinks -> create a new private QuickLink.
router.post('/', (req, res) => {
  const { name, url, description = '' } = req.body || {};
  if (!name || !name.trim() || !url || !url.trim()) return res.status(400).json({ error: 'name_and_url_required' });
  const info = db.prepare('INSERT INTO quick_links (owner_user_id, name, url, description) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name.trim(), url.trim(), description.trim());
  res.json({ id: info.lastInsertRowid });
});

// PUT /api/quicklinks/:id -> edit (owner only, not once published — it's a real item by then).
router.put('/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM quick_links WHERE id = ?').get(req.params.id);
  if (!link || link.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (link.status === 'published') return res.status(400).json({ error: 'already_published' });
  const { name, url, description } = req.body || {};
  db.prepare('UPDATE quick_links SET name = COALESCE(?, name), url = COALESCE(?, url), description = COALESCE(?, description) WHERE id = ?')
    .run(name && name.trim(), url && url.trim(), description !== undefined ? description.trim() : undefined, link.id);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM quick_links WHERE id = ?').get(req.params.id);
  if (!link || link.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM quick_links WHERE id = ?').run(link.id);
  res.json({ ok: true });
});

// GET /api/quicklinks/:id/shares -> current share list, for populating the share modal.
router.get('/:id/shares', (req, res) => {
  const link = db.prepare('SELECT * FROM quick_links WHERE id = ?').get(req.params.id);
  if (!link || link.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  const userIds = db.prepare('SELECT shared_with_user_id FROM quick_link_shares WHERE quick_link_id = ?').all(link.id).map(r => r.shared_with_user_id);
  res.json({ user_ids: userIds });
});

// PUT /api/quicklinks/:id/share -> replace the full share list (owner only).
router.put('/:id/share', (req, res) => {
  const link = db.prepare('SELECT * FROM quick_links WHERE id = ?').get(req.params.id);
  if (!link || link.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  const { user_ids = [] } = req.body || {};
  db.transaction(() => {
    db.prepare('DELETE FROM quick_link_shares WHERE quick_link_id = ?').run(link.id);
    const insert = db.prepare('INSERT INTO quick_link_shares (quick_link_id, shared_with_user_id) VALUES (?, ?)');
    for (const userId of user_ids) {
      if (userId !== link.owner_user_id) insert.run(link.id, userId);
    }
  })();
  res.json({ ok: true });
});

// POST /api/quicklinks/:id/touch -> log usage; owner or anyone it's shared with.
router.post('/:id/touch', (req, res) => {
  const link = db.prepare('SELECT * FROM quick_links WHERE id = ?').get(req.params.id);
  if (!canAccess(link, req.user.id)) return res.status(404).json({ error: 'not_found' });
  logEvent({ userId: req.user.id, category: 'quicklink', action: 'follow_quicklink', quicklinkId: link.id, ip: req.clientIp });
  res.json({ ok: true });
});

// POST /api/quicklinks/:id/publish-request -> ask an admin to make this generally available.
router.post('/:id/publish-request', (req, res) => {
  const link = db.prepare('SELECT * FROM quick_links WHERE id = ?').get(req.params.id);
  if (!link || link.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (link.status !== 'private') return res.status(400).json({ error: 'request_already_open_or_published' });
  const { remarks = '' } = req.body || {};
  db.transaction(() => {
    db.prepare('INSERT INTO quick_link_publish_requests (quick_link_id, requested_by_user_id, remarks) VALUES (?, ?, ?)')
      .run(link.id, req.user.id, remarks.trim());
    db.prepare("UPDATE quick_links SET status = 'pending_publish' WHERE id = ?").run(link.id);
  })();
  res.json({ ok: true });
});

module.exports = router;
