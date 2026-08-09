const db = require('../db');
const { executeRunbook } = require('./runbookExecutor');

// One tick checks every enabled automator rather than one JS timer per automator —
// same reasoning as feedbackAutoCloser: correct across add/remove/interval-change and
// server restarts with no timer bookkeeping. 60s granularity is fine since the
// smallest configurable interval is 1 minute.
const TICK_MS = 60 * 1000;

async function runDueAutomators() {
  const branding = db.prepare('SELECT runbooks_enabled FROM branding WHERE id = 1').get();
  if (branding && !branding.runbooks_enabled) return; // feature switched off — don't fire scheduled runs either

  const due = db.prepare(`
    SELECT id AS automator_id, runbook_id FROM automators
    WHERE enabled = 1 AND (last_run_at IS NULL OR last_run_at <= datetime('now', '-' || interval_minutes || ' minutes'))
  `).all();

  for (const row of due) {
    const runbook = db.prepare('SELECT * FROM runbooks WHERE id = ? AND deleted_at IS NULL').get(row.runbook_id);
    if (!runbook) continue; // soft-deleted (or orphaned) — pauses automatically; resumes on restore since last_run_at isn't touched here
    try {
      await executeRunbook(runbook, { userVars: {}, runByUserId: null, triggeredBy: 'automator' });
    } catch (e) {
      console.error(`[automator] run failed for runbook ${runbook.id}:`, e.message);
    } finally {
      db.prepare("UPDATE automators SET last_run_at = datetime('now') WHERE id = ?").run(row.automator_id);
    }
  }
}

let intervalHandle = null;

function startAutomatorRunner() {
  if (intervalHandle) return;
  setTimeout(() => runDueAutomators().catch(err => console.error('[automator] initial tick failed:', err)), 5000);
  intervalHandle = setInterval(() => {
    runDueAutomators().catch(err => console.error('[automator] tick failed:', err));
  }, TICK_MS);
  console.log('[automator] scheduler running (checks every 60s for due RunBook automations)');
}

module.exports = { startAutomatorRunner, runDueAutomators };
