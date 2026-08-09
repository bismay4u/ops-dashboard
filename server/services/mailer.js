const nodemailer = require('nodemailer');

let transporter;
let warnedOnce = false;

// Off by default — no SMTP_HOST means "not configured", same posture as
// DISABLE_STATIC_CACHE/FEEDBACK_AUTO_CLOSE_DAYS: functional once .env is filled in,
// a harmless no-op (with one console warning) until then.
function getTransporter() {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) {
    transporter = null;
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    if (!warnedOnce) {
      console.warn('[mailer] SMTP_HOST not set in .env — RunBook email notifications are disabled.');
      warnedOnce = true;
    }
    return false;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return true;
  } catch (e) {
    console.warn('[mailer] send failed:', e.message);
    return false;
  }
}

module.exports = { sendMail };
