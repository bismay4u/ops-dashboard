const db = require('../db');

const TIMEOUT_MS = Number(process.env.STATUS_CHECK_TIMEOUT_MS || 5000);
const INTERVAL_SECONDS = Number(process.env.STATUS_CHECK_INTERVAL_SECONDS || 60);
const MAX_LOG_ROWS_PER_ITEM = 200;

async function checkOne(item) {
  const url = item.status_url || item.url;
  const startedAt = Date.now();
  let status = 'down';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    // HEAD first (cheap); some apps 405 on HEAD, so fall back to GET.
    let resp;
    try {
      resp = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
      if (resp.status === 405 || resp.status === 501) {
        resp = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
      }
    } finally {
      clearTimeout(timer);
    }
    // Treat any response (even 401/403 from an app requiring its own login) as "up" —
    // we only care whether the service is reachable, not whether we're authorized.
    status = resp && resp.status < 500 ? 'up' : 'down';
  } catch (e) {
    status = 'down';
  }
  const responseMs = Date.now() - startedAt;

  db.prepare('UPDATE items SET last_status = ?, last_checked = datetime(\'now\'), last_response_ms = ? WHERE id = ?')
    .run(status, responseMs, item.id);

  db.prepare('INSERT INTO status_log (item_id, status, response_ms) VALUES (?, ?, ?)')
    .run(item.id, status, responseMs);

  // Trim old log rows for this item so status_log doesn't grow unbounded
  db.prepare(`
    DELETE FROM status_log WHERE item_id = ? AND id NOT IN (
      SELECT id FROM status_log WHERE item_id = ? ORDER BY checked_at DESC LIMIT ?
    )
  `).run(item.id, item.id, MAX_LOG_ROWS_PER_ITEM);

  return { id: item.id, status, responseMs };
}

async function checkAllNow() {
  const items = db.prepare('SELECT * FROM items WHERE status_check = 1 AND (status_url IS NOT NULL OR url IS NOT NULL)').all();
  const results = [];
  // Run checks with limited concurrency so we don't hammer the network all at once
  const CONCURRENCY = 5;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(checkOne));
    results.push(...batchResults);
  }
  return results;
}

let intervalHandle = null;

function startStatusChecker() {
  if (intervalHandle) return;
  // Kick off an initial check shortly after boot, then on a fixed interval.
  setTimeout(() => checkAllNow().catch(err => console.error('[status] initial check failed:', err)), 3000);
  intervalHandle = setInterval(() => {
    checkAllNow().catch(err => console.error('[status] periodic check failed:', err));
  }, INTERVAL_SECONDS * 1000);
  console.log(`[status] Live status checker running every ${INTERVAL_SECONDS}s (timeout ${TIMEOUT_MS}ms)`);
}

module.exports = { startStatusChecker, checkAllNow };
