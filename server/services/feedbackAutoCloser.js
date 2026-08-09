const db = require('../db');

const AUTO_CLOSE_DAYS = Number(process.env.FEEDBACK_AUTO_CLOSE_DAYS || 45);
// A 45-day window doesn't need minute-level polling — hourly is frequent enough
// that nothing sits stale for more than an hour past its close date.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function autoCloseStale() {
  const info = db.prepare(`
    UPDATE feedback SET status = 'closed', closed_at = datetime('now')
    WHERE status != 'closed' AND created_at <= datetime('now', ?)
  `).run(`-${AUTO_CLOSE_DAYS} days`);
  if (info.changes) {
    console.log(`[feedback] auto-closed ${info.changes} item(s) open ${AUTO_CLOSE_DAYS}+ days`);
  }
  return info.changes;
}

let intervalHandle = null;

function startFeedbackAutoCloser() {
  if (intervalHandle) return;
  autoCloseStale();
  intervalHandle = setInterval(autoCloseStale, CHECK_INTERVAL_MS);
  console.log(`[feedback] auto-closer running hourly (closes items after ${AUTO_CLOSE_DAYS} days)`);
}

module.exports = { startFeedbackAutoCloser, autoCloseStale };
