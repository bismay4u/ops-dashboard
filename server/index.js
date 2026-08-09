require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

require('./db'); // ensures schema + bootstrap admin/dashboard run before anything else
const { resolveUser } = require('./middleware/auth');
const { startStatusChecker } = require('./services/statusChecker');
const { startFeedbackAutoCloser } = require('./services/feedbackAutoCloser');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboards');
const adminRoutes = require('./routes/admin');
const statusRoutes = require('./routes/status');
const settingsRoutes = require('./routes/settings');
const analyticsRoutes = require('./routes/analytics');

const app = express();

// Trust Nginx Proxy Manager (or however many reverse proxies sit in front of this
// app) so req.ip is the real client IP, not the proxy's — this is what makes
// IP-based auto-login work correctly. See .env.example TRUST_PROXY_HOPS.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

app.use(cors({ origin: true, credentials: true }));
// Raised from the 100kb default to fit branding images, which travel as base64 data
// URLs in the JSON body (client caps each upload at 3MB before it's even read).
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use(resolveUser);

app.use('/api/auth', authRoutes);
app.use('/api/dashboards', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin/analytics', analyticsRoutes);

// Off by default (normal browser caching applies). Set DISABLE_STATIC_CACHE=true
// in .env to force no-cache on .css/.js while iterating on the frontend, so
// browsers always revalidate instead of serving a stale asset after deploy.
const disableStaticCache = process.env.DISABLE_STATIC_CACHE === 'true';
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: disableStaticCache
    ? (res, filePath) => {
        if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    : undefined,
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[ops-dashboard] listening on :${PORT}`);
  startStatusChecker();
  startFeedbackAutoCloser();
});
