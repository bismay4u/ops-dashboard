function dashboardApp() {
  return {
    // theme — default to the visitor's OS preference the first time, then remember their choice
    theme: localStorage.getItem('ops-dash-theme') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    themeMenuOpen: false,
    accountMenuOpen: false,
    get themeIcon() {
      return { light: 'bi-sun', dark: 'bi-moon-stars', glass: 'bi-droplet-half' }[this.theme] || 'bi-sun';
    },
    setTheme(t) {
      this.theme = t;
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('ops-dash-theme', t);
      this.themeMenuOpen = false;
    },

    // auth — user can legitimately be null; anonymous visitors see public content.
    authChecked: false,
    user: null,
    clientIp: null,
    loginModalOpen: false,
    loginForm: { username: '', password: '', mapIp: true },
    loginError: null,
    loginLoading: false,

    // self-service password change
    accountModalOpen: false,
    accountForm: { currentPassword: '', newPassword: '' },
    accountError: null,
    accountLoading: false,

    // dashboards
    dashboards: [],
    activeSlug: null,
    activeData: null,
    loadingDashboard: false,
    statusMap: {},
    statusPollHandle: null,

    // sorting
    sortMode: 'name', // 'name' | 'recent'

    // collapsible categories, remembered per browser
    collapsedCategories: JSON.parse(localStorage.getItem('ops-dash-collapsed') || '{}'),

    // first-visit search hint
    showSearchHint: !localStorage.getItem('ops-dash-seen-search-hint'),

    // toasts
    toasts: [],
    toastSeq: 0,

    // omnisearch
    paletteOpen: false,
    searchQuery: '',
    searchResults: [],
    activeIdx: 0,

    today: new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase(),

    get greeting() {
      const h = new Date().getHours();
      const name = this.user ? this.user.username : '';
      const time = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
      return `${time}${name ? ', ' + name : ''}!`;
    },

    async init() {
      document.documentElement.setAttribute('data-theme', this.theme);
      this.registerServiceWorker();
      await this.checkAuth();
      // Dashboards load regardless of login — the API filters by visibility itself,
      // so anonymous visitors see whatever's public and nothing more.
      await this.loadDashboardList();
    },

    registerServiceWorker() {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {}); // best-effort; install prompt just won't show if it fails
      }
    },

    // ---------- toasts ----------
    pushToast(message, type = 'info') {
      const id = ++this.toastSeq;
      this.toasts.push({ id, message, type });
      setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 3500);
    },

    async checkAuth() {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          this.user = data.user;
          this.clientIp = data.ip;
        } else {
          const data = await res.json().catch(() => ({}));
          this.clientIp = data.ip || null;
          this.user = null;
        }
      } finally {
        this.authChecked = true;
      }
    },

    async login() {
      this.loginLoading = true;
      this.loginError = null;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(this.loginForm),
        });
        const data = await res.json();
        if (!res.ok) {
          this.loginError = data.error === 'invalid_credentials' ? 'Incorrect username or password.' : 'Sign-in failed.';
          return;
        }
        this.user = data.user;
        this.loginModalOpen = false;
        this.loginForm = { username: '', password: '', mapIp: true };
        this.pushToast(`Signed in as ${data.user.username}`, 'success');
        await this.loadDashboardList(); // reload — more may now be visible
      } catch (e) {
        this.loginError = 'Could not reach the server.';
      } finally {
        this.loginLoading = false;
      }
    },

    async logout(forgetDevice = false) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forgetDevice }),
      });
      this.user = null;
      this.accountMenuOpen = false;
      if (this.sortMode === 'recent') this.sortMode = 'name';
      if (this.statusPollHandle) clearInterval(this.statusPollHandle);
      if (forgetDevice) this.pushToast('Signed out and forgot this device.', 'success');
      await this.loadDashboardList(); // reload — drop back to public-only view
    },

    async changePassword() {
      this.accountLoading = true;
      this.accountError = null;
      try {
        const res = await fetch('/api/auth/me/password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(this.accountForm),
        });
        const data = await res.json();
        if (!res.ok) {
          this.accountError = data.error === 'current_password_incorrect' ? 'Current password is incorrect.'
            : data.error === 'new_password_too_short' ? 'New password must be at least 8 characters.'
            : 'Could not change password.';
          return;
        }
        this.accountModalOpen = false;
        this.accountForm = { currentPassword: '', newPassword: '' };
        this.pushToast('Password updated', 'success');
      } catch (e) {
        this.accountError = 'Could not reach the server.';
      } finally {
        this.accountLoading = false;
      }
    },

    async loadDashboardList() {
      const res = await fetch('/api/dashboards', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      this.dashboards = data.dashboards;
      if (this.dashboards.length) {
        const keepSlug = this.dashboards.find(d => d.slug === this.activeSlug) ? this.activeSlug : this.dashboards[0].slug;
        await this.loadDashboard(keepSlug);
      } else {
        this.activeData = null;
      }
    },

    async loadDashboard(slug) {
      this.loadingDashboard = true;
      this.activeSlug = slug;
      try {
        const res = await fetch(`/api/dashboards/${slug}`, { credentials: 'include' });
        if (res.ok) {
          this.activeData = await res.json();
        }
      } finally {
        this.loadingDashboard = false;
      }
      this.restartStatusPolling();
    },

    nonEmptySections() {
      if (!this.activeData) return [];
      return this.activeData.sections.filter(s => s.categories.some(c => c.items.length));
    },

    hasCardItems() {
      return this.nonEmptySections().some(s => s.display_style === 'cards');
    },

    pinnedItems() {
      if (!this.activeData) return [];
      const all = this.activeData.sections.flatMap(s => s.categories.flatMap(c => c.items)).concat(this.activeData.uncategorized || []);
      return all.filter(it => it.is_favorite);
    },

    sortedItems(items) {
      const copy = [...items];
      if (this.sortMode === 'recent') {
        copy.sort((a, b) => {
          if (!a.last_used_at && !b.last_used_at) return a.name.localeCompare(b.name);
          if (!a.last_used_at) return 1;
          if (!b.last_used_at) return -1;
          return new Date(b.last_used_at) - new Date(a.last_used_at);
        });
      } else {
        copy.sort((a, b) => a.name.localeCompare(b.name));
      }
      return copy;
    },

    hasAnyItems() {
      if (!this.activeData) return false;
      const catItems = this.activeData.sections.reduce((n, s) => n + s.categories.reduce((m, c) => m + c.items.length, 0), 0);
      return catItems + (this.activeData.uncategorized ? this.activeData.uncategorized.length : 0) > 0;
    },

    relativeTime(iso) {
      // iso comes from SQLite datetime('now'), which is UTC without a timezone
      // suffix — append 'Z' so Date parses it as UTC instead of local time.
      const then = new Date(iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
      const diffMs = Date.now() - then.getTime();
      const mins = Math.round(diffMs / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.round(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.round(hours / 24);
      if (days < 30) return `${days}d ago`;
      return then.toLocaleDateString();
    },

    markUsed(item) {
      // Fire-and-forget: don't block or delay the actual navigation (the <a> tag's
      // own href already opens the link in a new tab regardless of this call).
      // Only meaningful when signed in — the server silently no-ops for anonymous.
      if (!this.user) return;
      fetch(`/api/dashboards/items/${item.id}/touch`, { method: 'POST', credentials: 'include' }).catch(() => {});
      item.last_used_at = new Date().toISOString(); // optimistic, so "Last used" sort/label feels instant
    },

    async toggleFavorite(item) {
      if (!this.user) return;
      const wasFavorite = item.is_favorite;
      item.is_favorite = !wasFavorite; // optimistic
      try {
        const res = await fetch(`/api/dashboards/items/${item.id}/favorite`, { method: 'POST', credentials: 'include' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        item.is_favorite = data.favorited;
      } catch (e) {
        item.is_favorite = wasFavorite; // revert on failure
        this.pushToast('Could not update favorite', 'error');
      }
    },

    // ---------- collapsible categories ----------
    isCollapsed(categoryId) {
      return !!this.collapsedCategories[categoryId];
    },
    toggleCategory(categoryId) {
      this.collapsedCategories = { ...this.collapsedCategories, [categoryId]: !this.collapsedCategories[categoryId] };
      localStorage.setItem('ops-dash-collapsed', JSON.stringify(this.collapsedCategories));
    },

    dismissSearchHint() {
      this.showSearchHint = false;
      localStorage.setItem('ops-dash-seen-search-hint', '1');
    },

    statusFor(itemId) {
      return this.statusMap[itemId] || 'unknown';
    },

    async pollStatus() {
      if (!this.activeSlug) return;
      const res = await fetch(`/api/status/${this.activeSlug}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const map = {};
      for (const s of data.statuses) map[s.id] = s.last_status;
      this.statusMap = map;
    },

    restartStatusPolling() {
      if (this.statusPollHandle) clearInterval(this.statusPollHandle);
      this.pollStatus();
      this.statusPollHandle = setInterval(() => this.pollStatus(), 20000);
    },

    // ---------- omnisearch ----------
    onGlobalKeydown(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        this.openPalette();
        this.dismissSearchHint();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openPalette();
        this.dismissSearchHint();
      }
      if (e.key === 'Escape') this.closePalette();
    },

    openPalette() {
      this.paletteOpen = true;
      this.searchQuery = '';
      this.searchResults = [];
      this.activeIdx = 0;
      this.dismissSearchHint();
      this.$nextTick(() => this.$refs.paletteInput && this.$refs.paletteInput.focus());
    },

    closePalette() {
      this.paletteOpen = false;
    },

    async runSearch() {
      const q = this.searchQuery.trim();
      if (!q) { this.searchResults = []; return; }
      const res = await fetch(`/api/dashboards/search/query?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      this.searchResults = data.results;
      this.activeIdx = 0;
    },

    moveActive(delta) {
      if (!this.searchResults.length) return;
      this.activeIdx = (this.activeIdx + delta + this.searchResults.length) % this.searchResults.length;
    },

    openActive() {
      const r = this.searchResults[this.activeIdx];
      if (r) {
        this.markUsed(r);
        window.open(r.url, '_blank', 'noopener');
      }
    },
  };
}
