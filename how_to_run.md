# How to run — advanced / deployment guide

This covers everything beyond the basic `npm start` in [README.md](README.md):
production deployment, the API, the internal project layout, and the version
history of how this app got here.

## Deploying behind Nginx Proxy Manager

This app expects to sit behind NPM like your other services. Two things matter for
IP-based login to work correctly:

1. In `.env`, set `TRUST_PROXY_HOPS` to the number of reverse proxies between the
   browser and this app (normally `1` for a single NPM hop). This makes Express read
   the real client IP from `X-Forwarded-For` instead of NPM's own IP.
2. In the NPM proxy host's **Advanced** tab, make sure `X-Forwarded-For` and
   `X-Real-IP` are being forwarded (NPM does this by default) — don't strip them.

Add a proxy host pointing at this app's port (default `4000`), same as your other
subdomains, e.g. `home.smartinfologiks.net → http://<this-host>:4000`.

For production, also:
- Set a real `JWT_SECRET` and change `DEFAULT_ADMIN_PASSWORD` before first boot.
- Enable HTTPS on the NPM host and uncomment `secure: true` on the cookie in
  `server/routes/auth.js` once everything is served over TLS.
- Run under a process manager (`pm2`, systemd unit, or a container) so it restarts
  on crash/reboot; `data/` is the only directory that needs to persist/be backed up.

## How the pieces work

- **One dashboard tool instead of several** — each of your dashboards becomes a
  "dashboard" row (`slug` + `name`) in this one app. The tab bar at the top of the
  main page lets people switch between them; the admin console manages all of them
  from one place instead of several separate codebases.
- **JSON rules file, no auto-discovery** — categories/items live in SQLite (so the
  admin UI and live-status checker can update them), but Admin → Backup/JSON can
  export any dashboard to a JSON file and import it back. Commit those exports to
  git as your source-controlled "rules file" and treat SQLite as the runtime cache.
  Nothing auto-discovers services from a reverse proxy or Docker — every tile is
  explicit.
- **Live status on tiles** — any item with "Live status: On" gets checked on an
  interval (`STATUS_CHECK_INTERVAL_SECONDS` in `.env`, default 60s) via HTTP
  HEAD/GET with a timeout, and the card shows a green/red/grey dot. The frontend
  polls `/api/status/:slug` every 20s so badges update without a page reload.
- **Omnisearch** — press `/` or `Cmd/Ctrl+K` anywhere on the main dashboard to open
  a command-palette style search across every app and bookmark on every dashboard,
  not just the one you're currently viewing.
- **Users managed by IP, falling back to login** — every request is checked against
  the `ip_mappings` table first. If the caller's IP is mapped, they're signed in
  automatically with no login screen. If not, they see the login form; on a
  successful login the current IP is mapped to that user automatically (so that
  desk/workstation won't need to log in again) unless "Remember this device" is
  unchecked. Admins can also add, fix, or remove IP↔user mappings by hand under
  Admin → IP Mappings — useful for shared kiosks or static desk IPs, or if
  someone's IP changes via DHCP.
- **Login API** — `POST /api/auth/login` (`{ username, password, mapIp }`) issues an
  httpOnly session cookie and, unless `mapIp: false` is sent, maps the caller's IP
  to that user. `GET /api/auth/me` and `POST /api/auth/logout` round out the API.
  Logging out with `{ forgetDevice: true }` also clears that IP's mapping.

## Project layout

```
server/
  index.js            Express app, middleware wiring, boot
  db.js               SQLite schema + first-run bootstrap (admin user, sample data)
  middleware/auth.js   IP-mapping + session-cookie resolution
  routes/auth.js       login / logout / me
  routes/dashboards.js read-only dashboard data + omnisearch (any logged-in user)
  routes/admin.js      CRUD for dashboards/categories/items/users/IP mappings + JSON export/import
  routes/status.js     status polling + manual recheck trigger
  services/statusChecker.js   background interval + on-demand HTTP checks
public/
  index.html / js/app.js      main dashboard (login gate, cards, omnisearch, status dots)
  admin.html / js/admin.js    admin console
  css/style.css                shared design tokens + components
```

## Operational notes

- Icons use Bootstrap Icons class names (e.g. `bi-diagram-3`) — browse the full set
  at https://icons.getbootstrap.com and paste the class name into the item's icon
  field in admin, or use the built-in icon picker.
- Status checks treat any HTTP response under 500 (including 401/403 from an app's
  own login wall) as "up" — it's a reachability check, not an auth check.
- There's no rate limiting on `/api/auth/login` yet; add one (e.g. `express-rate-limit`)
  before exposing this outside a trusted network.
- `better-sqlite3` is a native module — if you deploy on a different OS/arch than
  where you ran `npm install`, run `npm rebuild` on the target machine (or install
  fresh there) rather than copying `node_modules` across architectures.
- Deleting a user is a soft delete — the account is hidden and can no longer log in,
  but its roles and IP mappings are preserved and can be restored from
  Admin → Users → Deleted users.

## Version history

### Multi-role users, role-controlled dashboards/items, and custom sections (v4)

This was a bigger shift than earlier updates: visibility moved from a single
"team" string per user to a real **roles** system, and sections (the
Applications/Bookmarks split) are now admin-managed instead of hardcoded.

- **Users can hold multiple roles** — a user is no longer just "admin" or
  "user" with one optional team. They hold any number of roles from Admin →
  Roles (e.g. `admin`, `finance`, `oncall`). The `admin` role is reserved:
  holding it opens the admin console and grants visibility into everything,
  everywhere; it can't be deleted or renamed away. Any other role is yours to
  invent and is purely a visibility label — create it once, assign it to
  whoever needs it.
- **Dashboards and items are role-controlled** — Visibility is now: `public`
  (no login), `authenticated` (any signed-in user), or `roles` (only users
  holding at least one of the roles you pick, via checkboxes, when creating or
  editing). This replaces the old free-text "team name" field with a real
  many-to-many relationship — no more typos silently creating a new, empty
  team.
- **Section Manager, for more than two sections** — Applications/Bookmarks
  used to be hardcoded rendering modes. Now every dashboard has its own
  **sections** (Admin → Dashboards → Sections), each with a name and a
  **display style**: `cards` (big tiles with live-status dots and favorite
  stars — what "Applications" used to be) or `list` (compact link columns —
  what "Bookmarks" used to be). Add as many as you want — "Runbooks",
  "Vendor logins", "Docs" — each rendered in its chosen style, in the order
  you set. Categories now belong to a section (picked from a dropdown) instead
  of a fixed `applications`/`bookmarks` tag.
- **Migration is automatic** — booting this version against an older
  `data/dashboard.sqlite` converts everything in place on first start: old
  `users.role`/`users.team` become role assignments, old free-text
  `visibility` team-name strings become a real role, and old
  `categories.section` text values become two sections ("Applications"/cards,
  "Bookmarks"/list) with categories repointed at them. Nothing manual needed —
  check the server log on first boot after upgrading for a `[migrate]` line
  per change made.
- **Backup/JSON export-import updated accordingly** — exports now include
  `sections` and, for role-restricted dashboards/items, `role_names` (by name,
  not id, so a backup restores cleanly on a different instance — missing role
  names are created automatically on import).

### Favorites, personal history, account, and polish (v3)

- **Favorites/pinning, per person** — a star on each card/bookmark (visible when
  signed in) toggles a personal favorite. Anything favorited shows in a "Pinned"
  strip above everything else on that dashboard. Favorites are per-user, stored in
  `item_favorites`, and require login (there's no meaningful anonymous favorite).
- **"Last used" is now personal, not office-wide** — swapped the earlier shared
  `items.last_used_at` column for a per-user `item_usage` table. Signing in and
  opening things builds up *your* recency data, not everyone's combined. The "Last
  used" sort toggle is disabled for anonymous visitors (nothing to sort by yet).
- **Self-service password change** — click your name in the top-right → Change
  password. `PUT /api/auth/me/password` verifies the current password before
  setting a new one; doesn't touch IP mappings or force a re-login.
- **Toasts instead of `alert()`** — admin console actions (create/update/delete,
  import, re-check) now show a small dismissing toast in the corner rather than a
  blocking browser alert. Destructive deletes still use a native `confirm()`, which
  is fine since those are rare, deliberate actions.
- **Accessibility pass** — icon-only buttons (theme, sign out, favorite star,
  collapse chevrons) now have `aria-label`s, modals are marked `role="dialog"
  aria-modal`, and there's a visible `:focus-visible` outline everywhere for
  keyboard navigation.
- **System-default theme** — first-time visitors get Dark automatically if their OS
  is set to dark mode, Light otherwise; their explicit choice (once made) always
  wins after that.
- **First-visit search hint** — a small one-time callout points at the search bar
  ("Press / anytime to search") for new visitors, dismissed automatically the first
  time they use search and never shown again after that (tracked in
  `localStorage`).
- **Collapsible categories** — a chevron next to each category heading collapses/
  expands it; remembered per browser via `localStorage`, useful once a dashboard
  has enough categories that scrolling gets old.
- **Mobile-friendly + installable** — the nav wraps sensibly on narrow screens, the
  admin sidebar becomes a top bar on mobile, and a `manifest.json` + `sw.js` +
  `icon.svg` make "Add to Home Screen" available on phones/tablets. The service
  worker deliberately caches nothing — it exists only to satisfy Chrome's
  installability checklist, not to serve stale content (this dashboard's whole
  point is showing *current* status/visibility, so offline caching would be wrong).

### Public access, roles, and "last used" sorting (v2)

- **Public browsing, login optional** — the home page no longer forces a login. Every
  dashboard and every item has a **Visibility** setting: `public` (anyone, no login),
  `authenticated` (any signed-in user), or a **team name** (e.g. `finance`) — only
  admins and users whose Team field matches can see it. Anonymous visitors land on
  the home page and see whatever's `public`; signing in (via the "Sign in" button in
  the nav, no full-page gate anymore) adds whatever their team unlocks, on top of
  what's already public. Set a user's team from Admin → Users; set an item or
  dashboard's visibility from their respective admin tabs — both fields autocomplete
  against team names already in use.
- **Sorting + "last used"** — the Applications section has a Name / Last used toggle
  next to the greeting. Cards also show a small "Used Xm/h/d ago" line once they've
  been opened. Every click on a card (main dashboard or the omnisearch palette) pings
  `POST /api/dashboards/items/:id/touch` in the background — it doesn't block or
  delay the actual navigation. This is tracked per item, not per user, so "last used"
  reflects the whole office's activity, matching the shared/kiosk-style nature of
  these dashboards.
- **Theme switcher fix** — the nav theme toggle previously used an invalid Alpine
  modifier (`click.outside` isn't real; the correct one is `click.away`) and mounted
  its dropdown in a way that could race with the same click that opened it. It's now
  `x-show` + `click.away` + `click.stop` on the trigger, which is the robust pattern
  for this kind of popover.
