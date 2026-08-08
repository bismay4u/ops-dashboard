const db = require('../db');
const { verifyToken } = require('../utils/jwt');
const { rolesForUser } = require('../db');

const COOKIE_NAME = process.env.JWT_COOKIE_NAME || 'ops_dash_session';

function getClientIp(req) {
  // req.ip already honors 'trust proxy' setting configured in index.js,
  // which is what makes this correct behind Nginx Proxy Manager.
  let ip = req.ip || req.connection.remoteAddress || '';
  // Normalize IPv4-mapped IPv6 addresses like ::ffff:192.168.1.10
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function attachRoles(user) {
  if (!user) return user;
  return { ...user, roles: rolesForUser(user.id) };
}

// Attaches req.user (or null) and req.clientIp. Does NOT block the request —
// use requireAuth / requireAdmin below for that. req.user, when present, always
// carries a `.roles` array (e.g. ['admin'] or ['finance', 'ops']).
function resolveUser(req, res, next) {
  const ip = getClientIp(req);
  req.clientIp = ip;
  req.authMethod = null;
  req.user = null;

  const mapping = db.prepare(
    `SELECT u.* FROM ip_mappings m JOIN users u ON u.id = m.user_id WHERE m.ip = ?`
  ).get(ip);

  if (mapping) {
    req.user = attachRoles(mapping);
    req.authMethod = 'ip';
    return next();
  }

  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
      if (user) {
        req.user = attachRoles(user);
        req.authMethod = 'session';
      }
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'login_required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'login_required' });
  if (!req.user.roles.includes('admin')) return res.status(403).json({ error: 'admin_required' });
  next();
}

module.exports = { resolveUser, requireAuth, requireAdmin, getClientIp, COOKIE_NAME };
