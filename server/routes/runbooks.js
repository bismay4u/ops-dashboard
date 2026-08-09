const express = require('express');
const db = require('../db');
const { canSee, roleNameMap, logEvent } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { executeRunbook, requiredUserVarNames } = require('../services/runbookExecutor');

const router = express.Router();
// RunBooks are personal-first (like QuickLinks) — no anonymous access.
router.use(requireAuth);

// Admin kill switch (Admin > Branding > Features). Checked server-side, not just
// hidden in the UI, so the API is actually off when disabled, not just unlisted.
router.use((req, res, next) => {
  const row = db.prepare('SELECT runbooks_enabled FROM branding WHERE id = 1').get();
  if (row && !row.runbooks_enabled) return res.status(403).json({ error: 'feature_disabled' });
  next();
});

// Most recent run per runbook, batched — powers the status badge on each card
// without a separate round-trip per runbook.
function lastRunMap(ids) {
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT runbook_id, result, created_at FROM runbook_runs
    WHERE id IN (SELECT MAX(id) FROM runbook_runs WHERE runbook_id IN (${placeholders}) GROUP BY runbook_id)
  `).all(...ids);
  const map = {};
  for (const r of rows) map[r.runbook_id] = { result: r.result, at: r.created_at };
  return map;
}

function sharedUsernames(runbookId) {
  return db.prepare(`
    SELECT u.username FROM runbook_shares s JOIN users u ON u.id = s.shared_with_user_id
    WHERE s.runbook_id = ? ORDER BY u.username
  `).all(runbookId).map(r => r.username);
}

// Owner or shared-with always has access. Once published, access follows the same
// visibility/roles rule as items (canSee), regardless of sharing.
function canAccess(runbook, user) {
  if (!runbook || !user) return false;
  if (runbook.owner_user_id === user.id) return true;
  if (db.prepare('SELECT 1 FROM runbook_shares WHERE runbook_id = ? AND shared_with_user_id = ?').get(runbook.id, user.id)) return true;
  if (runbook.status === 'published') {
    const roleNames = roleNameMap('runbook_roles', 'runbook_id', [runbook.id])[runbook.id];
    return canSee(runbook.visibility, user, roleNames);
  }
  return false;
}

router.get('/_users', (req, res) => {
  const users = db.prepare('SELECT id, username FROM users WHERE deleted_at IS NULL AND id != ? ORDER BY username').all(req.user.id);
  res.json({ users });
});

// GET /api/runbooks -> { own, shared, public } for the current user. 'shared'
// excludes already-published ones (those surface via 'public' instead, filtered by
// visibility/roles) so a runbook never appears twice.
router.get('/', (req, res) => {
  const own = db.prepare('SELECT * FROM runbooks WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(req.user.id);
  for (const rb of own) {
    rb.shared_with = sharedUsernames(rb.id);
    if (rb.status === 'pending_publish') {
      const request = db.prepare(`
        SELECT remarks FROM runbook_publish_requests WHERE runbook_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1
      `).get(rb.id);
      rb.pending_remarks = request ? request.remarks : null;
    }
  }

  const shared = db.prepare(`
    SELECT rb.*, u.username AS owner_username
    FROM runbook_shares s
    JOIN runbooks rb ON rb.id = s.runbook_id
    JOIN users u ON u.id = rb.owner_user_id
    WHERE s.shared_with_user_id = ? AND rb.status != 'published' AND rb.deleted_at IS NULL
    ORDER BY s.created_at DESC
  `).all(req.user.id);

  const publishedRows = db.prepare(`
    SELECT rb.*, u.username AS owner_username
    FROM runbooks rb JOIN users u ON u.id = rb.owner_user_id
    WHERE rb.status = 'published' AND rb.owner_user_id != ? AND rb.deleted_at IS NULL
  `).all(req.user.id);
  const roleNames = roleNameMap('runbook_roles', 'runbook_id', publishedRows.map(r => r.id));
  const publicList = publishedRows.filter(r => canSee(r.visibility, req.user, roleNames[r.id]));

  const lastRuns = lastRunMap([...own, ...shared, ...publicList].map(r => r.id));
  for (const rb of [...own, ...shared, ...publicList]) rb.last_run = lastRuns[rb.id] || null;

  res.json({ own, shared, public: publicList });
});

router.post('/', (req, res) => {
  const {
    name, description = '', method = 'GET', url, headers = '', body = '',
    user_variable_names = '', success_keyword, failure_keyword, notify_email,
  } = req.body || {};
  if (!name || !name.trim() || !url || !url.trim()) return res.status(400).json({ error: 'name_and_url_required' });
  const info = db.prepare(`
    INSERT INTO runbooks (owner_user_id, name, description, method, url, headers, body, user_variable_names, success_keyword, failure_keyword, notify_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, name.trim(), description.trim(), (method || 'GET').toUpperCase(), url.trim(),
    headers, body, user_variable_names, success_keyword || null, failure_keyword || null, notify_email || null
  );
  res.json({ id: info.lastInsertRowid });
});

router.get('/:id', (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!canAccess(rb, req.user)) return res.status(404).json({ error: 'not_found' });
  res.json(rb);
});

router.put('/:id', (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!rb || rb.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (rb.status === 'published') return res.status(400).json({ error: 'already_published' });
  const f = req.body || {};
  db.prepare(`
    UPDATE runbooks SET
      name = COALESCE(?, name), description = COALESCE(?, description), method = COALESCE(?, method),
      url = COALESCE(?, url), headers = COALESCE(?, headers), body = COALESCE(?, body),
      user_variable_names = COALESCE(?, user_variable_names),
      success_keyword = ?, failure_keyword = ?, notify_email = ?
    WHERE id = ?
  `).run(
    f.name, f.description, f.method ? f.method.toUpperCase() : undefined, f.url, f.headers, f.body, f.user_variable_names,
    f.success_keyword !== undefined ? (f.success_keyword || null) : rb.success_keyword,
    f.failure_keyword !== undefined ? (f.failure_keyword || null) : rb.failure_keyword,
    f.notify_email !== undefined ? (f.notify_email || null) : rb.notify_email,
    rb.id
  );
  res.json({ ok: true });
});

// Owner can delete private/pending_publish RunBooks; once published, only an admin
// can delete it (from the admin console) — see admin.js DELETE /admin/runbooks/:id.
// Always a soft delete: shares/roles/run log are kept untouched so a restore (admin
// console) brings everything back exactly as it was, same precedent as users.deleted_at.
router.delete('/:id', (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!rb || rb.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (rb.status === 'published') return res.status(403).json({ error: 'published_delete_admin_only' });
  db.prepare("UPDATE runbooks SET deleted_at = datetime('now') WHERE id = ?").run(rb.id);
  res.json({ ok: true });
});

router.get('/:id/shares', (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!rb || rb.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  const userIds = db.prepare('SELECT shared_with_user_id FROM runbook_shares WHERE runbook_id = ?').all(rb.id).map(r => r.shared_with_user_id);
  res.json({ user_ids: userIds });
});

router.put('/:id/share', (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!rb || rb.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  const { user_ids = [] } = req.body || {};
  db.transaction(() => {
    db.prepare('DELETE FROM runbook_shares WHERE runbook_id = ?').run(rb.id);
    const insert = db.prepare('INSERT INTO runbook_shares (runbook_id, shared_with_user_id) VALUES (?, ?)');
    for (const userId of user_ids) {
      if (userId !== rb.owner_user_id) insert.run(rb.id, userId);
    }
  })();
  res.json({ ok: true });
});

router.post('/:id/publish-request', (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!rb || rb.owner_user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (rb.status !== 'private') return res.status(400).json({ error: 'request_already_open_or_published' });
  const { remarks = '' } = req.body || {};
  db.transaction(() => {
    db.prepare('INSERT INTO runbook_publish_requests (runbook_id, requested_by_user_id, remarks) VALUES (?, ?, ?)')
      .run(rb.id, req.user.id, remarks.trim());
    db.prepare("UPDATE runbooks SET status = 'pending_publish' WHERE id = ?").run(rb.id);
  })();
  res.json({ ok: true });
});

router.get('/:id/runs', (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!canAccess(rb, req.user)) return res.status(404).json({ error: 'not_found' });
  const runs = db.prepare(`
    SELECT r.*, u.username AS run_by_username
    FROM runbook_runs r LEFT JOIN users u ON u.id = r.run_by_user_id
    WHERE r.runbook_id = ? ORDER BY r.created_at DESC LIMIT 50
  `).all(rb.id);
  res.json({ runs });
});

// POST /api/runbooks/:id/run { variables: { name: value, ... } } -> executes now.
router.post('/:id/run', async (req, res) => {
  const rb = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!canAccess(rb, req.user)) return res.status(404).json({ error: 'not_found' });
  const required = requiredUserVarNames(rb);
  const provided = (req.body && req.body.variables) || {};
  const missing = required.filter(name => !provided[name] || !String(provided[name]).trim());
  if (missing.length) return res.status(400).json({ error: 'missing_variables', missing });

  const record = await executeRunbook(rb, { userVars: provided, runByUserId: req.user.id, triggeredBy: 'manual' });
  logEvent({ userId: req.user.id, category: 'runbook', action: 'run_runbook', label: `${rb.name}:${record.result}`, ip: req.clientIp });
  res.json({ run: record });
});

module.exports = router;
