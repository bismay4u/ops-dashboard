# Ops Dashboard

Self-hosted, multi-dashboard app launcher — a cards-and-bookmarks home page with
IP-based auto-login, live status badges, an admin console, and omnisearch.

It replaces several separately-maintained static dashboard pages with one
deployment that serves multiple "dashboards" (tabs) from a single admin console.

## Quick start

```bash
npm install
cp .env.example .env      # edit JWT_SECRET and DEFAULT_ADMIN_PASSWORD at minimum
npm start                 # http://localhost:4000
```

On first run it creates `data/dashboard.sqlite`, an admin user (from `.env`), and a
sample "Main Dashboard".

1. Open `http://localhost:4000` and sign in with the admin username/password from
   your `.env`.
2. Go to **Admin console** (top-right menu) to add your real dashboards, sections,
   categories, apps, and bookmarks, and to create accounts for everyone else.
3. Delete or edit the sample "Main Dashboard" once you've set up your own.

## Using it day to day

- **Browsing** — the home page shows cards/bookmarks for whatever dashboard tab is
  selected. Anything marked "Public" is visible without signing in.
- **Search** — press `/` or `Ctrl/Cmd+K` anywhere to search every app and bookmark
  across every dashboard.
- **Signing in** — click **Sign in** (top-right). Once you're in, you can star
  favorites (shown in a "Pinned" strip), and the app remembers what you last used.
  Signing in from a device once can also remember that device, so you won't need to
  log in there again.
- **Admin console** — visible only to accounts with the `admin` role, under the
  profile menu (top-right) once signed in. From there you manage dashboards,
  sections, categories, items, users, roles, and IP mappings, and can import users
  in bulk from a CSV.
- **Live status** — any item with "Live status: On" shows a green/red dot reflecting
  whether it's currently reachable.

## Learn more

For deploying behind a reverse proxy, production hardening, the project's internal
file layout, the API, and the full version history, see
[how_to_run.md](how_to_run.md).
