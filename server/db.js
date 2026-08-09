const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'dashboard.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS dashboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- A section is a named, styleable band on a dashboard (e.g. "Applications",
-- "Bookmarks", or anything an admin invents — "Runbooks", "Vendor logins"...).
-- display_style controls how its categories render: big cards, or a compact list.
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_style TEXT NOT NULL DEFAULT 'cards', -- 'cards' | 'list'
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT DEFAULT 'bi-link-45deg',
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  status_check INTEGER DEFAULT 0,
  status_url TEXT,
  last_status TEXT DEFAULT 'unknown', -- unknown | up | down
  last_checked TEXT,
  last_response_ms INTEGER,
  visibility TEXT NOT NULL DEFAULT 'authenticated' -- 'public' | 'authenticated' | 'roles'
);

CREATE TABLE IF NOT EXISTS status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  response_ms INTEGER,
  checked_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Roles are the single mechanism for both admin-console access and content
-- visibility: a user can hold any number of roles. Holding the reserved role
-- "admin" grants the admin console and sees everything regardless of other rules.
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS dashboard_roles (
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (dashboard_id, role_id)
);

CREATE TABLE IF NOT EXISTS item_roles (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, role_id)
);

-- Grants for items.notes when notes_visibility = 'users' — separate from item_roles
-- since notes are an on-demand reveal to hand-picked people, not a role-based
-- visibility rule.
CREATE TABLE IF NOT EXISTS item_note_users (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, user_id)
);

CREATE TABLE IF NOT EXISTS ip_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS item_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, item_id)
);

CREATE TABLE IF NOT EXISTS item_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  last_used_at TEXT,
  UNIQUE(user_id, item_id)
);

-- Site-wide branding, a single row (id is pinned to 1). Images are stored as data
-- URLs so the whole app stays backed up by data/dashboard.sqlite alone — no separate
-- uploads directory to remember to persist.
CREATE TABLE IF NOT EXISTS branding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_title TEXT DEFAULT 'Ops Dashboard',
  logo_data TEXT,
  background_data TEXT,
  watermark_data TEXT,
  watermark_opacity REAL DEFAULT 0.08,
  accent_color TEXT
);

-- Free-text feedback a signed-in user leaves on a specific item, for admin review.
-- Not a support ticket system — no status/reply thread, just a log kept for as long
-- as an admin wants it (delete from the admin console when reviewed/stale).
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Generic event log backing the Admin > Analytics tab. Every trackable action in the
-- app (page views, link clicks, favorites, logins) writes one row here as
-- category/action, e.g. ('link','follow_link'), ('auth','login_failure'). Analytics
-- queries group/filter this one table instead of each feature keeping its own
-- counters — a new event type is just a new (category, action) pair, no schema change.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  label TEXT,
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- QuickLinks: a user's own private bookmarks (distinct from admin-managed items).
-- status moves private -> pending_publish (a publish request is open) -> published
-- (an admin approved it and it now also exists as a normal items row) or back to
-- private (rejected). Published links are kept, not deleted, as the audit trail for
-- "this quicklink became that dashboard item".
CREATE TABLE IF NOT EXISTS quick_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'private', -- 'private' | 'pending_publish' | 'published'
  created_at TEXT DEFAULT (datetime('now'))
);

-- Who a QuickLink's owner has personally shared it with (distinct from the roles
-- system — this is direct user-to-user sharing of a private link, not a visibility rule).
CREATE TABLE IF NOT EXISTS quick_link_shares (
  quick_link_id INTEGER NOT NULL REFERENCES quick_links(id) ON DELETE CASCADE,
  shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (quick_link_id, shared_with_user_id)
);

-- A user's ask to make their private QuickLink a normal, generally-available item.
-- On approval the admin picks a dashboard/category and a real items row is created
-- (resolved_item_id); on rejection the QuickLink just reverts to 'private'.
CREATE TABLE IF NOT EXISTS quick_link_publish_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quick_link_id INTEGER NOT NULL REFERENCES quick_links(id) ON DELETE CASCADE,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remarks TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  admin_remarks TEXT,
  resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- RunBooks: a saved, parameterized HTTP request a user can re-run on demand (or on a
-- schedule via an Automator). Status/visibility mirror QuickLinks + items: private ->
-- pending_publish -> published, with visibility/roles only meaningful once published
-- (before that, access is owner + runbook_shares only, same as a QuickLink).
-- url/headers/body may contain {{env:NAME}} (admin-managed environment_variables) and
-- {{user:NAME}} (prompted from whoever runs it) placeholders — user_variable_names is
-- the comma-separated declaration of which {{user:*}} names a run must supply.
CREATE TABLE IF NOT EXISTS runbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  method TEXT NOT NULL DEFAULT 'GET',
  url TEXT NOT NULL,
  headers TEXT DEFAULT '',
  body TEXT DEFAULT '',
  user_variable_names TEXT DEFAULT '',
  success_keyword TEXT,
  failure_keyword TEXT,
  notify_email TEXT,
  visibility TEXT NOT NULL DEFAULT 'authenticated', -- only applied once status = 'published'
  status TEXT NOT NULL DEFAULT 'private', -- 'private' | 'pending_publish' | 'published'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runbook_shares (
  runbook_id INTEGER NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (runbook_id, shared_with_user_id)
);

-- Same shape as item_roles/dashboard_roles — which roles can see a published,
-- visibility='roles' RunBook.
CREATE TABLE IF NOT EXISTS runbook_roles (
  runbook_id INTEGER NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (runbook_id, role_id)
);

-- A user's ask to make their private RunBook generally available. Unlike a QuickLink
-- publish request, approval doesn't create a new row elsewhere — it just sets the
-- RunBook's own visibility/roles and flips status to 'published' in place, since a
-- RunBook stays the same executable thing either way.
CREATE TABLE IF NOT EXISTS runbook_publish_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runbook_id INTEGER NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remarks TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  admin_remarks TEXT,
  resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Admin-managed key/value store referenced by {{env:NAME}} in RunBook templates —
-- values are never returned to non-admin API responses, only substituted server-side.
CREATE TABLE IF NOT EXISTS environment_variables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Run log. Deliberately does NOT persist resolved request headers/body (which may
-- contain secret env var values) — only the resolved URL, what came back, and the
-- pass/fail verdict. Visible to the runbook's owner/shared users/admin, same as who
-- can run it.
CREATE TABLE IF NOT EXISTS runbook_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runbook_id INTEGER NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  run_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  triggered_by TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'automator'
  request_method TEXT,
  request_url TEXT,
  http_status INTEGER,
  response_snippet TEXT,
  result TEXT NOT NULL, -- 'success' | 'failed' | 'error'
  error_message TEXT,
  duration_ms INTEGER,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Admin-only schedule: run a RunBook every interval_minutes. A single background tick
-- (see services/automatorRunner.js) checks all enabled rows rather than one JS timer
-- per automator, so add/remove/interval-change need no timer bookkeeping and it's
-- correct across server restarts.
CREATE TABLE IF NOT EXISTS automators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runbook_id INTEGER NOT NULL UNIQUE REFERENCES runbooks(id) ON DELETE CASCADE,
  interval_minutes INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_dashboard ON items(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_feedback_item ON feedback(item_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_category_action ON events(category, action);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
CREATE INDEX IF NOT EXISTS idx_quicklinks_owner ON quick_links(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_quicklink_shares_user ON quick_link_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_quicklink_requests_status ON quick_link_publish_requests(status);
CREATE INDEX IF NOT EXISTS idx_runbooks_owner ON runbooks(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_runbook_shares_user ON runbook_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_runbook_requests_status ON runbook_publish_requests(status);
CREATE INDEX IF NOT EXISTS idx_runbook_runs_runbook ON runbook_runs(runbook_id, created_at);
CREATE INDEX IF NOT EXISTS idx_categories_dashboard ON categories(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_sections_dashboard ON sections(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_status_log_item ON status_log(item_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON item_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON item_usage(user_id);
`);

// ---------- safe migrations: add/backfill columns and tables for DBs from earlier versions ----------
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migrate] added ${table}.${column}`);
  }
  return cols.includes(column);
}
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// Pre-v4 DBs had dashboards.visibility as free text ('public' | 'authenticated' | a
// team name) and no roles system at all. Bring those forward into real roles.
ensureColumn('dashboards', 'visibility', `visibility TEXT NOT NULL DEFAULT 'authenticated'`);
ensureColumn('users', 'deleted_at', 'deleted_at TEXT DEFAULT NULL');
ensureColumn('items', 'notes', 'notes TEXT');
ensureColumn('items', 'notes_visibility', `notes_visibility TEXT NOT NULL DEFAULT 'all'`);
// 'open' (just submitted) -> 'pending' (admin is looking into it) -> 'closed' (resolved,
// either by an admin or by the 45-day auto-closer — see services/feedbackAutoCloser.js).
ensureColumn('feedback', 'status', `status TEXT NOT NULL DEFAULT 'open'`);
ensureColumn('feedback', 'closed_at', 'closed_at TEXT');
ensureColumn('events', 'quicklink_id', 'quicklink_id INTEGER REFERENCES quick_links(id) ON DELETE SET NULL');
ensureColumn('branding', 'quicklinks_enabled', 'quicklinks_enabled INTEGER NOT NULL DEFAULT 1');
ensureColumn('branding', 'runbooks_enabled', 'runbooks_enabled INTEGER NOT NULL DEFAULT 1');
ensureColumn('branding', 'remember_last_tab_enabled', 'remember_last_tab_enabled INTEGER NOT NULL DEFAULT 1');
// Soft delete only, same precedent as users.deleted_at — shares/roles are left
// untouched so restoring a RunBook brings its sharing/visibility config back as-is.
ensureColumn('runbooks', 'deleted_at', 'deleted_at TEXT DEFAULT NULL');
const hadOldTeamColumn = hasColumn('users', 'team');
const hadOldRoleColumn = hasColumn('users', 'role');
const hadOldSectionColumn = hasColumn('categories', 'section');

function getOrCreateRole(name) {
  const existing = db.prepare('SELECT id FROM roles WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO roles (name) VALUES (?)').run(name).lastInsertRowid;
}

const migrate = db.transaction(() => {
  // Always make sure the "admin" role exists — it's load-bearing (grants console + sees all).
  getOrCreateRole('admin');

  // Migrate old single role/team columns on users, if this DB predates the roles system.
  if (hadOldRoleColumn || hadOldTeamColumn) {
    const oldUsers = db.prepare(`SELECT id${hadOldRoleColumn ? ', role' : ''}${hadOldTeamColumn ? ', team' : ''} FROM users`).all();
    for (const u of oldUsers) {
      const alreadyHasRoles = db.prepare('SELECT 1 FROM user_roles WHERE user_id = ?').get(u.id);
      if (alreadyHasRoles) continue;
      if (hadOldRoleColumn && u.role === 'admin') {
        db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(u.id, getOrCreateRole('admin'));
      }
      if (hadOldTeamColumn && u.team) {
        db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(u.id, getOrCreateRole(u.team));
      }
    }
    if (hadOldRoleColumn) console.log('[migrate] users.role → roles/user_roles');
    if (hadOldTeamColumn) console.log('[migrate] users.team → roles/user_roles');
  }

  // Migrate old free-text visibility values (a team name string) on dashboards/items
  // into visibility='roles' + a linking row, now that visibility is a fixed enum.
  for (const table of ['dashboards', 'items']) {
    const linkTable = table === 'dashboards' ? 'dashboard_roles' : 'item_roles';
    const fk = table === 'dashboards' ? 'dashboard_id' : 'item_id';
    const rows = db.prepare(`SELECT id, visibility FROM ${table} WHERE visibility NOT IN ('public','authenticated','roles')`).all();
    for (const row of rows) {
      const roleId = getOrCreateRole(row.visibility);
      db.prepare(`UPDATE ${table} SET visibility = 'roles' WHERE id = ?`).run(row.id);
      db.prepare(`INSERT OR IGNORE INTO ${linkTable} (${fk}, role_id) VALUES (?, ?)`).run(row.id, roleId);
    }
    if (rows.length) console.log(`[migrate] ${table}.visibility free-text team names → roles (${rows.length} rows)`);
  }

  // Sections: pre-v4 DBs tagged categories with a free-text section ('applications' |
  // 'bookmarks') instead of a real sections table. Create the two equivalent sections
  // per dashboard and repoint categories at them.
  if (hadOldSectionColumn) {
    ensureColumn('categories', 'section_id', 'section_id INTEGER REFERENCES sections(id)');
    const dashboardIds = db.prepare('SELECT DISTINCT dashboard_id FROM categories').all().map(r => r.dashboard_id);
    for (const dashboardId of dashboardIds) {
      const cardsSection = db.prepare(`INSERT INTO sections (dashboard_id, name, display_style, sort_order) VALUES (?, 'Applications', 'cards', 0)`).run(dashboardId).lastInsertRowid;
      const listSection = db.prepare(`INSERT INTO sections (dashboard_id, name, display_style, sort_order) VALUES (?, 'Bookmarks', 'list', 1)`).run(dashboardId).lastInsertRowid;
      db.prepare(`UPDATE categories SET section_id = ? WHERE dashboard_id = ? AND section = 'applications' AND section_id IS NULL`).run(cardsSection, dashboardId);
      db.prepare(`UPDATE categories SET section_id = ? WHERE dashboard_id = ? AND section_id IS NULL`).run(listSection, dashboardId);
    }
    console.log(`[migrate] categories.section (text) → sections table (${dashboardIds.length} dashboards)`);
  } else {
    ensureColumn('categories', 'section_id', 'section_id INTEGER REFERENCES sections(id)');
  }
});
migrate();

db.prepare('INSERT OR IGNORE INTO branding (id) VALUES (1)').run();

// Bootstrap: create a default admin user + one sample dashboard on first run
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'change-me-immediately';
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(info.lastInsertRowid, getOrCreateRole('admin'));
  console.log(`[bootstrap] Created default admin user "${username}". Change the password immediately.`);
}

const dashboardCount = db.prepare('SELECT COUNT(*) AS c FROM dashboards').get().c;
if (dashboardCount === 0) {
  const info = db.prepare('INSERT INTO dashboards (slug, name, sort_order, visibility) VALUES (?, ?, ?, ?)')
    .run('main', 'Main Dashboard', 0, 'public');
  const dashboardId = info.lastInsertRowid;
  const cardsSection = db.prepare(`INSERT INTO sections (dashboard_id, name, display_style, sort_order) VALUES (?, 'Applications', 'cards', 0)`).run(dashboardId).lastInsertRowid;
  const listSection = db.prepare(`INSERT INTO sections (dashboard_id, name, display_style, sort_order) VALUES (?, 'Bookmarks', 'list', 1)`).run(dashboardId).lastInsertRowid;
  const catApps = db.prepare('INSERT INTO categories (dashboard_id, section_id, name, sort_order) VALUES (?, ?, ?, ?)')
    .run(dashboardId, cardsSection, 'Applications', 0).lastInsertRowid;
  const catTools = db.prepare('INSERT INTO categories (dashboard_id, section_id, name, sort_order) VALUES (?, ?, ?, ?)')
    .run(dashboardId, listSection, 'Tools', 0).lastInsertRowid;
  db.prepare(`INSERT INTO items (dashboard_id, category_id, name, url, icon, description, sort_order, status_check, status_url, visibility)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(dashboardId, catApps, 'Example App', 'https://example.com', 'bi-star', 'Replace me via the admin console', 0, 1, 'https://example.com', 'public');
  db.prepare(`INSERT INTO items (dashboard_id, category_id, name, url, icon, description, sort_order, status_check, status_url, visibility)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(dashboardId, catTools, 'Admin Console', '/admin.html', 'bi-gear', 'Manage dashboards, users, and IP mappings', 0, 0, null, 'authenticated');
  console.log('[bootstrap] Created sample "Main Dashboard" — edit or delete it from /admin.html');
}

// ---------- shared helpers ----------

// Role names held by a user, e.g. ['admin', 'finance']. Call once per request and
// attach to req.user (see middleware/auth.js) rather than re-querying repeatedly.
function rolesForUser(userId) {
  return db.prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`)
    .all(userId).map(r => r.name);
}

// visibility: 'public' (anyone, no login) | 'authenticated' (any signed-in user) |
// 'roles' (only users holding at least one of entityRoleNames). `user` is req.user
// (may be null/undefined) and must already have a `.roles` array attached.
function canSee(visibility, user, entityRoleNames) {
  if (visibility === 'public') return true;
  if (!user) return false;
  const userRoles = user.roles || [];
  if (userRoles.includes('admin')) return true; // admins always see everything
  if (visibility === 'authenticated') return true;
  if (visibility === 'roles') {
    if (!entityRoleNames || !entityRoleNames.length) return false;
    return entityRoleNames.some(r => userRoles.includes(r));
  }
  return false;
}

// Batch-fetch role names for every dashboard, keyed by dashboard id — avoids N+1
// queries when filtering a full list.
function roleNameMap(linkTable, fkColumn, ids) {
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT lt.${fkColumn} AS entity_id, r.name AS role_name
    FROM ${linkTable} lt JOIN roles r ON r.id = lt.role_id
    WHERE lt.${fkColumn} IN (${placeholders})
  `).all(...ids);
  const map = {};
  for (const row of rows) {
    (map[row.entity_id] = map[row.entity_id] || []).push(row.role_name);
  }
  return map;
}

// Notes are a separate, always-login-required reveal — no 'public' option like
// canSee's visibility, since this exists specifically for controlled info (demo
// credentials etc.), not general content gating.
function canSeeNotes(item, user, noteUserIds) {
  if (!item.notes) return false;
  if (!user) return false;
  if ((user.roles || []).includes('admin')) return true;
  if (item.notes_visibility === 'all') return true;
  if (item.notes_visibility === 'users') return (noteUserIds || []).includes(user.id);
  return false;
}

// Batch-fetch which user ids are granted an item's notes, keyed by item id — same
// shape as roleNameMap, for the 'users' notes_visibility case.
function noteUserIdMap(itemIds) {
  if (!itemIds.length) return {};
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT item_id, user_id FROM item_note_users WHERE item_id IN (${placeholders})`).all(...itemIds);
  const map = {};
  for (const row of rows) {
    (map[row.item_id] = map[row.item_id] || []).push(row.user_id);
  }
  return map;
}

// Fire-and-forget analytics write — callers never await this or let it block/fail
// the request it's attached to; a missed event is not worth a 500.
function logEvent({ userId = null, category, action, itemId = null, quicklinkId = null, label = null, ip = null }) {
  try {
    db.prepare('INSERT INTO events (user_id, category, action, item_id, quicklink_id, label, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, category, action, itemId, quicklinkId, label, ip);
  } catch (e) {
    console.warn('[events] log failed:', e.message);
  }
}

module.exports = db;
module.exports.canSee = canSee;
module.exports.rolesForUser = rolesForUser;
module.exports.roleNameMap = roleNameMap;
module.exports.canSeeNotes = canSeeNotes;
module.exports.noteUserIdMap = noteUserIdMap;
module.exports.logEvent = logEvent;
