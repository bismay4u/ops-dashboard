function adminApp() {
  return {
    // theme
    theme: localStorage.getItem('ops-dash-theme') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    themeMenuOpen: false,
    get themeIcon() {
      return { light: 'bi-sun', dark: 'bi-moon-stars', glass: 'bi-droplet-half' }[this.theme] || 'bi-sun';
    },
    setTheme(t) {
      this.theme = t;
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('ops-dash-theme', t);
      this.themeMenuOpen = false;
    },

    authChecked: false,
    user: null,
    tab: 'dashboards',

    // generic modal + form used by all "create/edit" flows
    modalOpen: null, // 'dashboard' | 'section' | 'category' | 'item' | 'user' | 'mapping' | null
    form: {},
    editingId: null, // set when the modal is editing an existing record instead of creating one

    // icon picker
    iconPickerOpen: false,
    iconSearch: '',
    iconList: [],

    roles: [],
    newRoleName: '',

    dashboards: [],
    sectionEditorDashboard: null,
    sections: [],
    categories: [],

    itemsDashboardId: null,
    items: [],
    categoriesForItems: [],

    users: [],
    mappings: [],
    importUsersModalOpen: false,
    importUsersText: '',
    importUsersResults: null,
    deletedUsersModalOpen: false,
    deletedUsers: [],

    backupDashboardId: null,
    importText: '',

    feedback: [],
    feedbackStatusFilter: 'open_pending', // 'open_pending' | 'all' | 'open' | 'pending' | 'closed'

    // branding — form state for the Branding tab, plus what's currently applied
    appTitle: 'Ops Dashboard',
    logoUrl: null,
    watermarkUrl: null,
    watermarkOpacity: 0.08,
    branding: { app_title: '', logo_data: null, background_data: null, watermark_data: null, watermark_opacity: 0.08, accent_color: null },

    updateRunning: false,
    updateResult: null,

    statusIntervalLabel: '60 seconds', // display copy; actual value is server-configured

    toasts: [],
    toastSeq: 0,
    pushToast(message, type = 'info') {
      const id = ++this.toastSeq;
      this.toasts.push({ id, message, type });
      setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 3500);
    },

    get monitoredItems() {
      return this.items.filter(it => it.status_check);
    },

    async init() {
      document.documentElement.setAttribute('data-theme', this.theme);
      await this.loadBranding();
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        this.user = data.user;
      }
      this.authChecked = true;
      if (this.user && this.user.roles.includes('admin')) {
        await this.loadRoles();
        await this.loadDashboards();
        await this.loadUsers();
        await this.loadMappings();
        await this.loadIconList();
      }
    },

    // ---------- branding ----------
    async loadBranding() {
      try {
        const b = await fetch('/api/settings').then(r => r.json());
        this.branding = {
          app_title: b.app_title || '',
          logo_data: b.logo_data || null,
          background_data: b.background_data || null,
          watermark_data: b.watermark_data || null,
          watermark_opacity: b.watermark_opacity ?? 0.08,
          accent_color: b.accent_color || null,
        };
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
    },
    handleBrandingImage(field, event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) {
        this.pushToast('Image must be under 3MB.', 'error');
        event.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { this.branding[field] = reader.result; };
      reader.readAsDataURL(file);
      event.target.value = '';
    },
    async saveBranding() {
      await this.api('/settings', { method: 'PUT', body: JSON.stringify(this.branding) });
      this.applyBranding(this.branding);
      this.pushToast('Branding saved', 'success');
    },

    // ---------- update ----------
    async runUpdate() {
      if (!confirm('Pull the latest code and restart the app now?')) return;
      this.updateRunning = true;
      this.updateResult = null;
      try {
        const res = await fetch('/api/admin/update', { method: 'POST', credentials: 'include' });
        this.updateResult = await res.json();
        if (this.updateResult.ok) this.pushToast('Updated — restarting now.', 'success');
        else this.pushToast('Update failed — see output below.', 'error');
      } catch (e) {
        // The connection can legitimately drop mid-response if the process restarts
        // faster than the browser finishes reading it — that's a plausible success,
        // not necessarily a failure.
        this.updateResult = { ok: false, error: 'Lost connection — the app may already be restarting. Refresh in a few seconds.' };
      } finally {
        this.updateRunning = false;
      }
    },

    async loadIconList() {
      try {
        const res = await fetch('/js/icon-list.json');
        this.iconList = await res.json();
      } catch (e) {
        this.iconList = [];
      }
    },
    filteredIcons() {
      const q = this.iconSearch.trim().toLowerCase();
      const list = q ? this.iconList.filter(n => n.includes(q)) : this.iconList;
      return list.slice(0, 240);
    },
    selectIcon(name) {
      this.form.icon = 'bi-' + name;
      this.iconPickerOpen = false;
    },

    visibilitySummary(visibility, roleIds) {
      if (visibility === 'public') return 'Public';
      if (visibility === 'authenticated') return 'Any user';
      if (visibility === 'roles') {
        const names = (roleIds || []).map(id => { const r = this.roles.find(r => r.id === id); return r ? r.name : null; }).filter(Boolean);
        return names.length ? 'Roles: ' + names.join(', ') : 'Roles: (none set)';
      }
      return visibility;
    },

    toggleFormRole(roleId) {
      const idx = this.form.role_ids.indexOf(roleId);
      if (idx === -1) this.form.role_ids.push(roleId);
      else this.form.role_ids.splice(idx, 1);
    },
    toggleFormNoteUser(userId) {
      const idx = this.form.note_user_ids.indexOf(userId);
      if (idx === -1) this.form.note_user_ids.push(userId);
      else this.form.note_user_ids.splice(idx, 1);
    },

    // ---------- modal helpers ----------
    openModal(type, entity = null) {
      const defaults = {
        dashboard: { slug: '', name: '', visibility: 'authenticated', role_ids: [] },
        section: { name: '', display_style: 'cards' },
        category: { name: '', section_id: this.sections[0] ? this.sections[0].id : null },
        item: { name: '', url: '', category_id: null, icon: 'bi-link-45deg', description: '', status_check: 0, visibility: 'authenticated', role_ids: [], notes: '', notes_visibility: 'all', note_user_ids: [] },
        user: { username: '', password: '', role_ids: [] },
        mapping: { ip: '', user_id: this.users[0] ? this.users[0].id : null, note: '' },
      };
      if (entity) {
        this.form = { ...defaults[type], ...entity };
        this.editingId = entity.id;
      } else {
        this.form = { ...defaults[type] };
        this.editingId = null;
      }
      this.modalOpen = type;
    },
    closeModal() {
      this.modalOpen = null;
      this.form = {};
      this.editingId = null;
    },

    async api(path, options = {}) {
      const res = await fetch('/api/admin' + path, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.pushToast('Error: ' + (err.error || res.status), 'error');
        throw new Error(err.error || String(res.status));
      }
      return res.status === 204 ? null : res.json();
    },

    // ---------- roles ----------
    async loadRoles() {
      const data = await this.api('/roles');
      this.roles = data.roles;
    },
    async createRole() {
      if (!this.newRoleName.trim()) return;
      await this.api('/roles', { method: 'POST', body: JSON.stringify({ name: this.newRoleName.trim() }) });
      this.newRoleName = '';
      this.pushToast('Role created', 'success');
      await this.loadRoles();
    },
    async deleteRole(r) {
      if (r.name === 'admin') return;
      if (!confirm(`Delete role "${r.name}"? Anything restricted to only this role becomes invisible to everyone but admins.`)) return;
      await this.api(`/roles/${r.id}`, { method: 'DELETE' });
      this.pushToast('Role deleted', 'success');
      await this.loadRoles();
    },

    // ---------- dashboards ----------
    async loadDashboards() {
      const data = await this.api('/dashboards');
      this.dashboards = data.dashboards;
      if (!this.itemsDashboardId && this.dashboards.length) {
        this.itemsDashboardId = this.dashboards[0].id;
        this.backupDashboardId = this.dashboards[0].id;
        await this.loadItemsFor(this.itemsDashboardId);
      }
    },
    async saveDashboard() {
      if (!this.form.slug || !this.form.name) return;
      if (this.editingId) {
        await this.api(`/dashboards/${this.editingId}`, { method: 'PUT', body: JSON.stringify(this.form) });
        this.pushToast('Dashboard updated', 'success');
      } else {
        await this.api('/dashboards', { method: 'POST', body: JSON.stringify(this.form) });
        this.pushToast('Dashboard created', 'success');
      }
      this.closeModal();
      await this.loadDashboards();
    },
    async updateDashboard(id, fields) {
      await this.api(`/dashboards/${id}`, { method: 'PUT', body: JSON.stringify(fields) });
      await this.loadDashboards();
    },
    async deleteDashboard(d) {
      if (!confirm(`Delete dashboard "${d.name}" and everything on it?`)) return;
      await this.api(`/dashboards/${d.id}`, { method: 'DELETE' });
      this.pushToast('Dashboard deleted', 'success');
      if (this.sectionEditorDashboard && this.sectionEditorDashboard.id === d.id) this.sectionEditorDashboard = null;
      await this.loadDashboards();
    },

    // ---------- sections + categories ----------
    async manageSections(d) {
      this.sectionEditorDashboard = d;
      await this.loadSections(d.id);
      await this.loadCategoriesFor(d.id);
    },
    async loadSections(dashboardId) {
      const data = await this.api(`/dashboards/${dashboardId}/sections`);
      this.sections = data.sections;
    },
    async loadCategoriesFor(dashboardId) {
      const slug = this.dashboards.find(x => x.id === dashboardId).slug;
      const dash = await fetch(`/api/dashboards/${slug}`, { credentials: 'include' }).then(r => r.json());
      this.categories = dash.sections.flatMap(s => s.categories.map(({ items, ...c }) => c));
    },
    async createSection() {
      if (!this.form.name || !this.sectionEditorDashboard) return;
      await this.api('/sections', { method: 'POST', body: JSON.stringify({ dashboard_id: this.sectionEditorDashboard.id, ...this.form }) });
      this.closeModal();
      this.pushToast('Section created', 'success');
      await this.loadSections(this.sectionEditorDashboard.id);
    },
    async updateSection(id, fields) {
      await this.api(`/sections/${id}`, { method: 'PUT', body: JSON.stringify(fields) });
      await this.loadSections(this.sectionEditorDashboard.id);
    },
    async deleteSection(s) {
      if (!confirm(`Delete section "${s.name}"? Its categories become unassigned until you move them to another section.`)) return;
      await this.api(`/sections/${s.id}`, { method: 'DELETE' });
      this.pushToast('Section deleted', 'success');
      await this.loadSections(this.sectionEditorDashboard.id);
      await this.loadCategoriesFor(this.sectionEditorDashboard.id);
    },
    async createCategory() {
      if (!this.form.name || !this.form.section_id || !this.sectionEditorDashboard) return;
      await this.api('/categories', { method: 'POST', body: JSON.stringify({ dashboard_id: this.sectionEditorDashboard.id, ...this.form }) });
      this.closeModal();
      this.pushToast('Category created', 'success');
      await this.loadCategoriesFor(this.sectionEditorDashboard.id);
    },
    async updateCategory(id, fields) {
      await this.api(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(fields) });
      await this.loadCategoriesFor(this.sectionEditorDashboard.id);
    },
    async deleteCategory(c) {
      if (!confirm(`Delete category "${c.name}"? Items in it become uncategorized.`)) return;
      await this.api(`/categories/${c.id}`, { method: 'DELETE' });
      this.pushToast('Category deleted', 'success');
      await this.loadCategoriesFor(this.sectionEditorDashboard.id);
    },

    // ---------- items ----------
    async loadItemsFor(dashboardId) {
      if (!dashboardId) return;
      const slug = this.dashboards.find(x => x.id === Number(dashboardId)).slug;
      const dash = await fetch(`/api/dashboards/${slug}`, { credentials: 'include' }).then(r => r.json());
      this.categoriesForItems = dash.sections.flatMap(s => s.categories.map(({ items, ...c }) => c));
      this.items = [...dash.sections.flatMap(s => s.categories.flatMap(c => c.items)), ...dash.uncategorized];
      // role_ids aren't part of the public dashboard payload; fetch lazily per-item here,
      // stored as _role_ids for the visibility pill summary.
      for (const it of this.items) {
        if (it.visibility === 'roles' && it._role_ids === undefined) {
          this.api(`/items/${it.id}/roles`).then(data => { it._role_ids = data.role_ids; });
        }
      }
    },
    categoryName(id) {
      const c = this.categoriesForItems.find(c => c.id === id);
      return c ? c.name : '—';
    },
    async saveItem() {
      if (!this.form.name || !this.form.url) return;
      if (this.editingId) {
        await this.api(`/items/${this.editingId}`, { method: 'PUT', body: JSON.stringify(this.form) });
        this.pushToast('Item updated', 'success');
      } else {
        await this.api('/items', { method: 'POST', body: JSON.stringify({ dashboard_id: this.itemsDashboardId, ...this.form }) });
        this.pushToast('Item created', 'success');
      }
      this.closeModal();
      await this.loadItemsFor(this.itemsDashboardId);
    },
    async updateItem(id, fields) {
      await this.api(`/items/${id}`, { method: 'PUT', body: JSON.stringify(fields) });
      await this.loadItemsFor(this.itemsDashboardId);
    },
    async editItem(it) {
      const roleData = it.visibility === 'roles' ? await this.api(`/items/${it.id}/roles`) : { role_ids: [] };
      const noteUserData = await this.api(`/items/${it.id}/notes-users`);
      // Notes text is never in the dashboard payload (public/js/app.js fetches it
      // on demand too) — reuse that same public endpoint here; admins are always
      // authorized by canSeeNotes so this just works.
      let notes = '';
      if (it.has_notes) {
        const res = await fetch(`/api/dashboards/items/${it.id}/notes`, { credentials: 'include' });
        if (res.ok) notes = (await res.json()).notes || '';
      }
      this.openModal('item', { ...it, role_ids: roleData.role_ids, note_user_ids: noteUserData.note_user_ids, notes });
    },
    async deleteItem(it) {
      if (!confirm(`Delete "${it.name}"?`)) return;
      await this.api(`/items/${it.id}`, { method: 'DELETE' });
      this.pushToast('Item deleted', 'success');
      await this.loadItemsFor(this.itemsDashboardId);
    },

    // ---------- live status ----------
    async recheckNow() {
      const res = await fetch('/api/status/recheck', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.pushToast('Error: ' + (err.error || res.status), 'error');
        return;
      }
      this.pushToast('Status re-check complete', 'success');
      await this.loadItemsFor(this.itemsDashboardId);
    },

    // ---------- users ----------
    async loadUsers() {
      const data = await this.api('/users');
      this.users = data.users;
    },
    async saveUser() {
      if (this.editingId) {
        await this.api(`/users/${this.editingId}`, { method: 'PUT', body: JSON.stringify({ role_ids: this.form.role_ids }) });
        this.pushToast('Roles updated', 'success');
      } else {
        if (!this.form.username || !this.form.password) return;
        await this.api('/users', { method: 'POST', body: JSON.stringify(this.form) });
        this.pushToast('User created', 'success');
      }
      this.closeModal();
      await this.loadUsers();
    },
    editUserRoles(u) {
      this.openModal('user', { id: u.id, username: u.username, role_ids: [...u.role_ids] });
    },
    async updateUser(id, fields) {
      await this.api(`/users/${id}`, { method: 'PUT', body: JSON.stringify(fields) });
      await this.loadUsers();
    },
    async deleteUser(u) {
      if (!confirm(`Delete user "${u.username}"? Their roles and IP mappings are kept, and this can be undone from Deleted users.`)) return;
      await this.api(`/users/${u.id}`, { method: 'DELETE' });
      this.pushToast('User deleted', 'success');
      await this.loadUsers();
    },

    // ---------- users: deleted / restore ----------
    async loadDeletedUsers() {
      const data = await this.api('/users/deleted');
      this.deletedUsers = data.users;
    },
    async openDeletedUsersModal() {
      await this.loadDeletedUsers();
      this.deletedUsersModalOpen = true;
    },
    async restoreUser(u) {
      await this.api(`/users/${u.id}/restore`, { method: 'POST' });
      this.pushToast(`Restored "${u.username}"`, 'success');
      await this.loadDeletedUsers();
      await this.loadUsers();
    },

    // ---------- users: CSV import ----------
    openImportUsersModal() {
      this.importUsersText = '';
      this.importUsersResults = null;
      this.importUsersModalOpen = true;
    },
    handleUsersCsvFile(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { this.importUsersText = reader.result; };
      reader.readAsText(file);
      event.target.value = '';
    },
    parseUsersCsv(text) {
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) return [];
      const header = lines[0].split(',').map(h => h.trim().toLowerCase());
      const uIdx = header.indexOf('username');
      const pIdx = header.indexOf('password');
      const rIdx = header.indexOf('roles');
      return lines.slice(1).map(line => {
        const cols = line.split(',');
        return {
          username: (cols[uIdx] || '').trim(),
          password: (cols[pIdx] || '').trim(),
          roles: rIdx >= 0 ? (cols[rIdx] || '').split(';').map(r => r.trim()).filter(Boolean) : [],
        };
      });
    },
    async importUsers() {
      const rows = this.parseUsersCsv(this.importUsersText);
      if (!rows.length) { this.pushToast('Nothing to import — paste or upload a CSV first.', 'error'); return; }
      const data = await this.api('/users/import', { method: 'POST', body: JSON.stringify({ rows }) });
      this.importUsersResults = data.results;
      const created = data.results.filter(r => r.status === 'created').length;
      const skipped = data.results.filter(r => r.status === 'skipped').length;
      const errored = data.results.filter(r => r.status === 'error').length;
      this.pushToast(`${created} created, ${skipped} skipped, ${errored} errors`, errored ? 'error' : 'success');
      await this.loadUsers();
      await this.loadRoles();
    },

    // ---------- ip mappings ----------
    async loadMappings() {
      const data = await this.api('/ip-mappings');
      this.mappings = data.mappings;
    },
    async createMapping() {
      if (!this.form.ip || !this.form.user_id) return;
      await this.api('/ip-mappings', { method: 'POST', body: JSON.stringify(this.form) });
      this.closeModal();
      this.pushToast('IP mapped', 'success');
      await this.loadMappings();
    },
    async deleteMapping(m) {
      if (!confirm(`Remove mapping for ${m.ip}?`)) return;
      await this.api(`/ip-mappings/${m.id}`, { method: 'DELETE' });
      this.pushToast('Mapping removed', 'success');
      await this.loadMappings();
    },

    // ---------- feedback ----------
    async loadFeedback() {
      const data = await this.api('/feedback');
      this.feedback = data.feedback;
    },
    visibleFeedback() {
      if (this.feedbackStatusFilter === 'all') return this.feedback;
      if (this.feedbackStatusFilter === 'open_pending') return this.feedback.filter(f => f.status !== 'closed');
      return this.feedback.filter(f => f.status === this.feedbackStatusFilter);
    },
    async setFeedbackStatus(f, status) {
      await this.api(`/feedback/${f.id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
      await this.loadFeedback();
    },
    async deleteFeedback(f) {
      if (!confirm(`Delete this feedback from "${f.username}" on "${f.item_name}"?`)) return;
      await this.api(`/feedback/${f.id}`, { method: 'DELETE' });
      this.pushToast('Feedback deleted', 'success');
      await this.loadFeedback();
    },

    // ---------- backup / json ----------
    exportDashboard() {
      if (!this.backupDashboardId) return;
      window.open(`/api/admin/dashboards/${this.backupDashboardId}/export`, '_blank');
    },
    async importDashboard() {
      if (!this.backupDashboardId || !this.importText.trim()) return;
      let parsed;
      try {
        parsed = JSON.parse(this.importText);
      } catch (e) {
        this.pushToast('Invalid JSON: ' + e.message, 'error');
        return;
      }
      if (!confirm('This replaces all sections, categories, and items on the selected dashboard. Continue?')) return;
      await this.api(`/dashboards/${this.backupDashboardId}/import`, { method: 'POST', body: JSON.stringify(parsed) });
      this.pushToast('Import complete', 'success');
      await this.loadDashboards();
    },
  };
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map(x => parseInt(x, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
