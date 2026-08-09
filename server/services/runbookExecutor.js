const db = require('../db');
const { sendMail } = require('./mailer');

const TIMEOUT_MS = Number(process.env.RUNBOOK_TIMEOUT_MS || 15000);
const SNIPPET_MAX = 4000;

function buildVarMap(userVars = {}) {
  const map = {};
  for (const row of db.prepare('SELECT name, value FROM environment_variables').all()) {
    map[`env:${row.name}`] = row.value;
  }
  for (const [name, value] of Object.entries(userVars)) map[`user:${name}`] = value;
  return map;
}

// {{env:NAME}} / {{user:NAME}} — a placeholder for a source that has no matching
// entry is left as-is (better to see the literal token in a failed request than to
// silently substitute an empty string).
function substitute(text, varMap) {
  if (!text) return text;
  return text.replace(/\{\{\s*(env|user):([\w.-]+)\s*\}\}/g, (match, source, name) => {
    const key = `${source}:${name}`;
    return Object.prototype.hasOwnProperty.call(varMap, key) ? varMap[key] : match;
  });
}

function parseHeaders(text) {
  const headers = {};
  if (!text) return headers;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    headers[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return headers;
}

function requiredUserVarNames(runbook) {
  return (runbook.user_variable_names || '').split(',').map(s => s.trim()).filter(Boolean);
}

// failure_keyword wins if both are set — an explicit "this means it broke" signal
// should override a coincidental success_keyword match elsewhere in the body.
function determineResult(status, bodyText, runbook) {
  if (runbook.failure_keyword && bodyText.includes(runbook.failure_keyword)) return 'failed';
  if (runbook.success_keyword) return bodyText.includes(runbook.success_keyword) ? 'success' : 'failed';
  return status >= 200 && status < 400 ? 'success' : 'failed';
}

// Shared by both a manual "Run" click and the Automator tick. Never throws — a
// request failure (timeout, DNS, connection refused) is recorded as result:'error',
// not an exception the caller has to handle.
async function executeRunbook(runbook, { userVars = {}, runByUserId = null, triggeredBy = 'manual' } = {}) {
  const varMap = buildVarMap(userVars);
  const url = substitute(runbook.url, varMap);
  const headers = parseHeaders(substitute(runbook.headers, varMap));
  const method = (runbook.method || 'GET').toUpperCase();
  const body = runbook.body ? substitute(runbook.body, varMap) : undefined;

  const startedAt = Date.now();
  const record = {
    runbook_id: runbook.id, run_by_user_id: runByUserId, triggered_by: triggeredBy,
    request_method: method, request_url: url,
    http_status: null, response_snippet: null, result: 'error', error_message: null,
    duration_ms: 0, notified: 0,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    record.http_status = resp.status;
    record.response_snippet = text.slice(0, SNIPPET_MAX);
    record.result = determineResult(resp.status, text, runbook);
  } catch (e) {
    record.result = 'error';
    record.error_message = e.message;
  }
  record.duration_ms = Date.now() - startedAt;

  if (runbook.notify_email) {
    const subject = `[RunBook] ${runbook.name} — ${record.result.toUpperCase()}`;
    const text = [
      `RunBook: ${runbook.name}`,
      `Result: ${record.result}`,
      `HTTP status: ${record.http_status ?? 'n/a'}`,
      record.error_message ? `Error: ${record.error_message}` : null,
      '',
      'Response:',
      record.response_snippet || '(empty)',
    ].filter(Boolean).join('\n');
    record.notified = (await sendMail({ to: runbook.notify_email, subject, text })) ? 1 : 0;
  }

  const info = db.prepare(`
    INSERT INTO runbook_runs
      (runbook_id, run_by_user_id, triggered_by, request_method, request_url, http_status, response_snippet, result, error_message, duration_ms, notified)
    VALUES
      (@runbook_id, @run_by_user_id, @triggered_by, @request_method, @request_url, @http_status, @response_snippet, @result, @error_message, @duration_ms, @notified)
  `).run(record);
  record.id = info.lastInsertRowid;
  return record;
}

module.exports = { executeRunbook, requiredUserVarNames, substitute, parseHeaders };
