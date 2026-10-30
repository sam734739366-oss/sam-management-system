'use strict';

/* =====================================================================
   Renderer helpers: SamDB (db IPC bridge) and SamSession (permissions)
   ===================================================================== */

window.SamDB = {
  async call(name, ...args) {
    const r = await window.sam.db.invoke(name, ...args);
    if (!r || !r.ok) {
      const err = new Error(r && r.error ? r.error : 'قاعدة البيانات غير متاحة');
      err.denied = !!(r && r.denied);
      throw err;
    }
    return r.data;
  },
  n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  },
  fmt(v) {
    return this.n(v).toLocaleString('en-US');
  },
  money(v) {
    return this.n(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
};

window.SamSession = {
  user: null,
  meta: { screens: [], perms: [] },

  async init() {
    const [cur, meta] = await Promise.all([sam.auth.current(), sam.auth.meta()]);
    this.user = cur && cur.ok ? cur.data : null;
    this.meta = meta && meta.ok ? meta.data : { screens: [], perms: [] };
    return this.user;
  },

  isAdmin() { return !!this.user && this.user.role === 'admin'; },

  can(screen, action = 'view') {
    if (!this.user) return false;
    if (this.user.role === 'admin') return true;
    if (!this.user.screens.includes(screen)) return false;
    if (action === 'manage') return false;
    return !!(this.user.perms || {})[action];
  }
};
