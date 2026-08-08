require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

require('./db'); // ensures schema + bootstrap admin/dashboard run before anything else
const { resolveUser } = require('./middleware/auth');
const { startStatusChecker } = require('./services/statusChecker');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboards');
const adminRoutes = require('./routes/admin');
const statusRoutes = require('./routes/status');
const settingsRoutes = require('./routes/settings');

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

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[ops-dashboard] listening on :${PORT}`);
  startStatusChecker();
});
