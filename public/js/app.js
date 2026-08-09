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

    // branding — site-wide, admin-configured (Admin → Branding), applies before login
    appTitle: 'Ops Dashboard',
    logoUrl: null,
    watermarkUrl: null,
    watermarkOpacity: 0.08,
    quicklinksEnabled: true,
    runbooksEnabled: true,
    rememberLastTabEnabled: true,
    async loadBranding() {
      try {
        const b = await fetch('/api/settings').then(r => r.json());
        this.applyBranding(b);
      } catch (e) { /* branding is cosmetic — a failed fetch just keeps defaults */ }
    },
    applyBranding(b) {
      this.appTitle = b.app_title || 'Ops Dashboard';
      document.title = this.appTitle;
      const root = document.documentElement.style;
      if (b.accent_color) {
        root.setProperty('--accent', b.accent_color);
        root.setProperty('--accent-soft', hexToRgba(b.accent_color, 0.12));
      } else {
        root.removeProperty('--accent');
        root.removeProperty('--accent-soft');
      }
      if (b.background_data) root.setProperty('--bg-image', `url(${b.background_data})`);
      else root.removeProperty('--bg-image');
      this.logoUrl = b.logo_data || null;
      this.watermarkUrl = b.watermark_data || null;
      this.watermarkOpacity = b.watermark_opacity ?? 0.08;
      this.quicklinksEnabled = b.quicklinks_enabled === undefined ? true : !!b.quicklinks_enabled;
      this.runbooksEnabled = b.runbooks_enabled === undefined ? true : !!b.runbooks_enabled;
      this.rememberLastTabEnabled = b.remember_last_tab_enabled === undefined ? true : !!b.remember_last_tab_enabled;
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

    // on-demand item notes
    notesModalOpen: false,
    notesModalName: '',
    notesModalText: '',
    notesLoading: false,
    async openNotes(item) {
      this.notesModalName = item.name;
      this.notesModalText = '';
      this.notesLoading = true;
      this.notesModalOpen = true;
      try {
        const res = await fetch(`/api/dashboards/items/${item.id}/notes`, { credentials: 'include' });
        this.notesModalText = res.ok ? (await res.json()).notes : 'You do not have access to view this.';
      } catch (e) {
        this.notesModalText = 'Could not load notes.';
      } finally {
        this.notesLoading = false;
      }
    },
    async copyNotes() {
      try {
        await navigator.clipboard.writeText(this.notesModalText);
        this.pushToast('Copied to clipboard', 'success');
      } catch (e) {
        this.pushToast('Could not copy — select and copy manually.', 'error');
      }
    },

    // feedback on an item
    feedbackModalOpen: false,
    feedbackModalItem: null,
    feedbackForm: { rating: 0, message: '' },
    feedbackError: null,
    feedbackLoading: false,
    openFeedback(item) {
      this.feedbackModalItem = item;
      this.feedbackForm = { rating: 0, message: '' };
      this.feedbackError = null;
      this.feedbackModalOpen = true;
    },
    async submitFeedback() {
      if (!this.feedbackForm.message.trim()) {
        this.feedbackError = 'Please enter a message.';
        return;
      }
      this.feedbackLoading = true;
      this.feedbackError = null;
      try {
        const res = await fetch(`/api/dashboards/items/${this.feedbackModalItem.id}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ message: this.feedbackForm.message.trim(), rating: this.feedbackForm.rating || null }),
        });
        if (!res.ok) throw new Error();
        this.feedbackModalOpen = false;
        this.pushToast('Thanks for the feedback!', 'success');
      } catch (e) {
        this.feedbackError = 'Could not submit feedback.';
      } finally {
        this.feedbackLoading = false;
      }
    },

    // QuickLinks — personal sidebar bookmarks (distinct from admin-managed items)
    quickLinks: { own: [], shared: [] },
    qlModalOpen: false,
    qlForm: { name: '', url: '', description: '' },
    qlEditingId: null,
    qlError: null,
    qlSaving: false,
    qlShareModalOpen: false,
    qlShareLinkId: null,
    qlShareUserIds: [],
    qlAllUsers: [],
    qlPublishModalOpen: false,
    qlPublishLinkId: null,
    qlPublishRemarks: '',

    // Once published, a QuickLink is now a normal dashboard item too — keep it out of
    // the sidebar so it isn't shown twice; it stays in quickLinks.own for the record.
    activeOwnQuickLinks() {
      return this.quickLinks.own.filter(l => l.status !== 'published');
    },
    async loadQuickLinks() {
      if (!this.user || !this.quicklinksEnabled) { this.quickLinks = { own: [], shared: [] }; return; }
      try {
        const res = await fetch('/api/quicklinks', { credentials: 'include' });
        if (res.ok) this.quickLinks = await res.json();
      } catch (e) { /* sidebar is supplementary — a failed fetch just leaves it empty */ }
    },
    openQlModal(link = null) {
      this.qlForm = link ? { name: link.name, url: link.url, description: link.description || '' } : { name: '', url: '', description: '' };
      this.qlEditingId = link ? link.id : null;
      this.qlError = null;
      this.qlModalOpen = true;
    },
    async saveQuickLink() {
      if (!this.qlForm.name.trim() || !this.qlForm.url.trim()) {
        this.qlError = 'Name and URL are required.';
        return;
      }
      this.qlSaving = true;
      this.qlError = null;
      try {
        const path = this.qlEditingId ? `/api/quicklinks/${this.qlEditingId}` : '/api/quicklinks';
        const method = this.qlEditingId ? 'PUT' : 'POST';
        const res = await fetch(path, {
          method, headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(this.qlForm),
        });
        if (!res.ok) throw new Error();
        this.qlModalOpen = false;
        await this.loadQuickLinks();
        this.pushToast(this.qlEditingId ? 'QuickLink updated' : 'QuickLink added', 'success');
      } catch (e) {
        this.qlError = 'Could not save — try again.';
      } finally {
        this.qlSaving = false;
      }
    },
    async deleteQuickLink(link) {
      if (!confirm(`Delete "${link.name}"?`)) return;
      await fetch(`/api/quicklinks/${link.id}`, { method: 'DELETE', credentials: 'include' });
      await this.loadQuickLinks();
      this.pushToast('QuickLink deleted', 'success');
    },
    touchQuickLink(link) {
      // Fire-and-forget, same pattern as markUsed() for dashboard items — don't block navigation.
      fetch(`/api/quicklinks/${link.id}/touch`, { method: 'POST', credentials: 'include' }).catch(() => {});
    },
    async openShareModal(link) {
      this.qlShareLinkId = link.id;
      this.qlShareModalOpen = true;
      const [usersData, sharesData] = await Promise.all([
        fetch('/api/quicklinks/_users', { credentials: 'include' }).then(r => r.json()),
        fetch(`/api/quicklinks/${link.id}/shares`, { credentials: 'include' }).then(r => r.json()),
      ]);
      this.qlAllUsers = usersData.users;
      this.qlShareUserIds = sharesData.user_ids;
    },
    toggleQlShareUser(userId) {
      const idx = this.qlShareUserIds.indexOf(userId);
      if (idx === -1) this.qlShareUserIds.push(userId);
      else this.qlShareUserIds.splice(idx, 1);
    },
    async saveShares() {
      await fetch(`/api/quicklinks/${this.qlShareLinkId}/share`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ user_ids: this.qlShareUserIds }),
      });
      this.qlShareModalOpen = false;
      await this.loadQuickLinks();
      this.pushToast('Sharing updated', 'success');
    },
    openPublishModal(link) {
      this.qlPublishLinkId = link.id;
      this.qlPublishRemarks = '';
      this.qlPublishModalOpen = true;
    },
    async submitPublishRequest() {
      await fetch(`/api/quicklinks/${this.qlPublishLinkId}/publish-request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ remarks: this.qlPublishRemarks }),
      });
      this.qlPublishModalOpen = false;
      await this.loadQuickLinks();
      this.pushToast('Publish request sent to admins', 'success');
    },

    // RunBooks — saved, parameterized HTTP requests (own / shared / published-visible)
    runbooks: { own: [], shared: [], public: [] },
    rbCurlInput: '',
    rbShowCurlBox: false,
    rbModalOpen: false,
    rbForm: { name: '', description: '', method: 'GET', url: '', headers: '', body: '', user_variable_names: '', success_keyword: '', failure_keyword: '', notify_email: '' },
    rbEditingId: null,
    rbError: null,
    rbSaving: false,
    rbRunModalOpen: false,
    rbRunTarget: null,
    rbRunVars: {},
    rbRunning: false,
    rbRunResult: null,
    rbShareModalOpen: false,
    rbShareLinkId: null,
    rbShareUserIds: [],
    rbAllUsers: [],
    rbPublishModalOpen: false,
    rbPublishId: null,
    rbPublishRemarks: '',
    rbLogModalOpen: false,
    rbLogTarget: null,
    rbLogRuns: [],
    rbLogLoading: false,

    async loadRunbooks() {
      if (!this.user || !this.runbooksEnabled) { this.runbooks = { own: [], shared: [], public: [] }; return; }
      try {
        const res = await fetch('/api/runbooks', { credentials: 'include' });
        if (res.ok) this.runbooks = await res.json();
      } catch (e) { /* supplementary panel — a failed fetch just leaves it empty */ }
    },
    rbRequiredVars(rb) {
      return (rb.user_variable_names || '').split(',').map(s => s.trim()).filter(Boolean);
    },
    openRbModal(rb = null, fromCurl = false) {
      this.rbForm = rb
        ? { name: rb.name, description: rb.description || '', method: rb.method || 'GET', url: rb.url, headers: rb.headers || '', body: rb.body || '', user_variable_names: rb.user_variable_names || '', success_keyword: rb.success_keyword || '', failure_keyword: rb.failure_keyword || '', notify_email: rb.notify_email || '' }
        : { name: '', description: '', method: 'GET', url: '', headers: '', body: '', user_variable_names: '', success_keyword: '', failure_keyword: '', notify_email: '' };
      this.rbEditingId = rb ? rb.id : null;
      this.rbCurlInput = '';
      this.rbShowCurlBox = fromCurl;
      this.rbError = null;
      this.rbModalOpen = true;
      if (fromCurl) this.$nextTick(() => this.$refs.rbCurlTextarea && this.$refs.rbCurlTextarea.focus());
    },
    // Tokenizes a curl command respecting quotes, then reads the flags this app's
    // RunBook model actually has fields for (-X/-H/-d and their long forms).
    // Everything else (-k, -b, --compressed, --form, ...) is silently ignored rather
    // than rejected — the point is a fast starting point the user reviews and edits.
    parseCurlCommand(input) {
      const str = input.replace(/\\\r?\n/g, ' ').trim();
      if (!str) return null;
      const tokens = [];
      let i = 0;
      while (i < str.length) {
        while (i < str.length && /\s/.test(str[i])) i++;
        if (i >= str.length) break;
        let quote = null;
        if (str[i] === '"' || str[i] === "'") { quote = str[i]; i++; }
        let tok = '';
        while (i < str.length) {
          if (quote) {
            if (str[i] === quote) { i++; break; }
            if (str[i] === '\\' && quote === '"' && (str[i + 1] === '"' || str[i + 1] === '\\')) { tok += str[i + 1]; i += 2; continue; }
            tok += str[i]; i++;
          } else {
            if (/\s/.test(str[i])) break;
            tok += str[i]; i++;
          }
        }
        tokens.push(tok);
      }

      let method = null, url = null, body = null;
      const headers = [];
      for (let idx = 0; idx < tokens.length; idx++) {
        const t = tokens[idx];
        if (t === 'curl') continue;
        if (t === '-X' || t === '--request') { method = tokens[++idx]; continue; }
        if (t === '-H' || t === '--header') { headers.push(tokens[++idx]); continue; }
        if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') {
          body = tokens[++idx];
          if (!method) method = 'POST';
          continue;
        }
        if (t.startsWith('-')) continue; // unmodeled flag (-k, -b, --compressed, --form...) — skipped, not an error
        if (!url) url = t;
      }
      if (!url) return null;
      return { method: (method || 'GET').toUpperCase(), url, headers: headers.join('\n'), body: body || '' };
    },
    applyCurlParse() {
      const parsed = this.parseCurlCommand(this.rbCurlInput);
      if (!parsed) {
        this.rbError = 'Could not find a URL in that curl command.';
        return;
      }
      this.rbForm.method = parsed.method;
      this.rbForm.url = parsed.url;
      if (parsed.headers) this.rbForm.headers = parsed.headers;
      if (parsed.body) this.rbForm.body = parsed.body;
      this.rbError = null;
      this.pushToast('Parsed — review the fields below and save.', 'success');
    },
    async saveRunbook() {
      if (!this.rbForm.name.trim() || !this.rbForm.url.trim()) {
        this.rbError = 'Name and URL are required.';
        return;
      }
      this.rbSaving = true;
      this.rbError = null;
      try {
        const path = this.rbEditingId ? `/api/runbooks/${this.rbEditingId}` : '/api/runbooks';
        const method = this.rbEditingId ? 'PUT' : 'POST';
        const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(this.rbForm) });
        if (!res.ok) throw new Error();
        this.rbModalOpen = false;
        await this.loadRunbooks();
        this.pushToast(this.rbEditingId ? 'RunBook updated' : 'RunBook created', 'success');
      } catch (e) {
        this.rbError = 'Could not save — try again.';
      } finally {
        this.rbSaving = false;
      }
    },
    async deleteRunbook(rb) {
      if (!confirm(`Delete "${rb.name}"?`)) return;
      const res = await fetch(`/api/runbooks/${rb.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        this.pushToast(data.error === 'published_delete_admin_only' ? 'Published RunBooks can only be deleted by an admin.' : 'Could not delete.', 'error');
        await this.loadRunbooks(); // refresh — its status may have changed since this button rendered
        return;
      }
      await this.loadRunbooks();
      this.pushToast('RunBook deleted', 'success');
    },
    openRunModal(rb) {
      this.rbRunTarget = rb;
      this.rbRunVars = {};
      for (const name of this.rbRequiredVars(rb)) this.rbRunVars[name] = '';
      this.rbRunResult = null;
      this.rbRunModalOpen = true;
    },
    async executeRun() {
      this.rbRunning = true;
      this.rbRunResult = null;
      try {
        const res = await fetch(`/api/runbooks/${this.rbRunTarget.id}/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ variables: this.rbRunVars }),
        });
        const data = await res.json();
        if (!res.ok) {
          this.pushToast(data.error === 'missing_variables' ? `Missing: ${data.missing.join(', ')}` : 'Could not run.', 'error');
          return;
        }
        this.rbRunResult = data.run;
        await this.loadRunbooks(); // refresh the last-run badge
      } catch (e) {
        this.pushToast('Could not reach the server.', 'error');
      } finally {
        this.rbRunning = false;
      }
    },
    async openRbShareModal(rb) {
      this.rbShareLinkId = rb.id;
      this.rbShareModalOpen = true;
      const [usersData, sharesData] = await Promise.all([
        fetch('/api/runbooks/_users', { credentials: 'include' }).then(r => r.json()),
        fetch(`/api/runbooks/${rb.id}/shares`, { credentials: 'include' }).then(r => r.json()),
      ]);
      this.rbAllUsers = usersData.users;
      this.rbShareUserIds = sharesData.user_ids;
    },
    toggleRbShareUser(userId) {
      const idx = this.rbShareUserIds.indexOf(userId);
      if (idx === -1) this.rbShareUserIds.push(userId);
      else this.rbShareUserIds.splice(idx, 1);
    },
    async saveRbShares() {
      await fetch(`/api/runbooks/${this.rbShareLinkId}/share`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ user_ids: this.rbShareUserIds }),
      });
      this.rbShareModalOpen = false;
      await this.loadRunbooks();
      this.pushToast('Sharing updated', 'success');
    },
    openRbPublishModal(rb) {
      this.rbPublishId = rb.id;
      this.rbPublishRemarks = '';
      this.rbPublishModalOpen = true;
    },
    async submitRbPublishRequest() {
      await fetch(`/api/runbooks/${this.rbPublishId}/publish-request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ remarks: this.rbPublishRemarks }),
      });
      this.rbPublishModalOpen = false;
      await this.loadRunbooks();
      this.pushToast('Publish request sent to admins', 'success');
    },
    async openRunLog(rb) {
      this.rbLogTarget = rb;
      this.rbLogRuns = [];
      this.rbLogLoading = true;
      this.rbLogModalOpen = true;
      try {
        const res = await fetch(`/api/runbooks/${rb.id}/runs`, { credentials: 'include' });
        if (res.ok) this.rbLogRuns = (await res.json()).runs;
      } finally {
        this.rbLogLoading = false;
      }
    },

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
      await this.loadBranding();
      this.registerServiceWorker();
      await this.checkAuth();
      // Dashboards load regardless of login — the API filters by visibility itself,
      // so anonymous visitors see whatever's public and nothing more.
      await this.loadDashboardList();
      await this.loadQuickLinks();
      await this.loadRunbooks();
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
        await this.loadQuickLinks();
        await this.loadRunbooks();
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
      this.quickLinks = { own: [], shared: [] };
      this.runbooks = { own: [], shared: [], public: [] };
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
        // On a fresh load activeSlug isn't set yet — fall back to the last tab this
        // browser was on (if the admin allows it, and that dashboard is still visible),
        // otherwise the first dashboard, same as before.
        const rememberedSlug = this.rememberLastTabEnabled ? localStorage.getItem('ops-dash-last-tab') : null;
        const wanted = this.activeSlug || rememberedSlug;
        const keepSlug = this.dashboards.find(d => d.slug === wanted) ? wanted : this.dashboards[0].slug;
        await this.loadDashboard(keepSlug);
      } else {
        this.activeData = null;
      }
    },

    async loadDashboard(slug) {
      this.loadingDashboard = true;
      this.activeSlug = slug;
      if (this.rememberLastTabEnabled) localStorage.setItem('ops-dash-last-tab', slug);
      else localStorage.removeItem('ops-dash-last-tab');
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

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map(x => parseInt(x, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
