'use strict';

/* =====================================================================
   Renderer helpers: SamDB (db IPC bridge) and SamSession (permissions)
   Every call flips the loading pill, so no screen has to remember to.
   ===================================================================== */

window.SamDB = {
  async call(name, ...args) {
    const quiet = ['summary', 'listRecentMoves', 'getDistinctValues', 'prodRouting'].includes(name);
    if (!quiet && window.SamUI) SamUI.busy(true);
    try {
      const r = await window.sam.db.invoke(name, ...args);
      if (!r || !r.ok) {
        const err = new Error(r && r.error ? r.error : 'قاعدة البيانات غير متاحة');
        err.denied = !!(r && r.denied);
        throw err;
      }
      return r.data;
    } finally {
      if (!quiet && window.SamUI) SamUI.busy(false);
    }
  },
  /** tolerant parser: commas, Arabic digits, stray text -> a real number */
  n(v) {
    if (window.SamUI) return SamUI.parseNum(v);
    const x = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(x) ? x : 0;
  },
  /** 1234567 -> "1,234,567" */
  fmt(v) {
    const n = this.n(v);
    return n.toLocaleString('en-US');
  },
  money(v) {
    const n = this.n(v);
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  },
  /** money with the currency spelled out, for print and totals */
  withCurrency(v) {
    return `${this.money(v)} ${window.SamUI ? SamUI.CURRENCY : 'ريال'}`;
  }
};

window.SamSession = {
  user: null,
  meta: { screens: [], perms: [] },
  /** screens that borrow another screen's permission (daily ⊂ reports) */
  ALIAS: { daily: 'reports' },

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
    const s = this.ALIAS[screen] || screen;
    if (!this.user.screens.includes(s)) return false;
    if (action === 'manage') return false;
    return !!(this.user.perms || {})[action];
  }
};
