/* =====================================================================
   SamCompany — اسم الشركة وشعارها
   =====================================================================
   The customer wants his own company on the papers — its name and, when
   he has one, its logo. The program keeps its own name and its footer in
   every paper whatever the customer writes, so a paper always says which
   program printed it.

   The settings live in the database (the settings table), and the logo is
   a file inside the data folder — never inside the installation, which
   the installer would replace.
   ===================================================================== */

(function (global) {
  'use strict';
  if (global.SamCompany) return;

  const state = { name: '', logo: '', logoFile: '' };

  /** the logo as a link the page can show */
  function logoUrl() {
    if (!state.logoFile) return '';
    if (global.sam && global.sam.app && global.sam.app.imagesDir) {
      /* the dir is known only after the first call — it is kept here */
    }
    return state.logoUrl || '';
  }

  async function load() {
    try {
      const all = await SamDB.call('allSettings') || {};
      state.name = String(all.company_name || '').trim();
      state.logoFile = String(all.company_logo || '').trim();
      state.logoUrl = '';
      if (state.logoFile && global.sam && global.sam.app) {
        const r = await global.sam.app.imagesDir();
        if (r && r.ok && r.dir) {
          state.logoUrl = global.sam.app.fileUrl(r.dir + '/' + state.logoFile);
        }
      }
    } catch (e) {
      state.name = ''; state.logoFile = ''; state.logoUrl = '';
    }
    global.SamCompany.data = { name: state.name, logo: state.logoUrl };
    return global.SamCompany.data;
  }

  global.SamCompany = {
    data: { name: '', logo: '' },
    load,
    get name() { return state.name; },
    get logoFile() { return state.logoFile; },
    get logo() { return state.logoUrl; }
  };
})(window);
