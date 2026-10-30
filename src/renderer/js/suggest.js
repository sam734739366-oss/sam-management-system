'use strict';

/* =====================================================================
   SamSuggest — free-text inputs with database-backed suggestions.

   The field stays a plain text input (so a brand-new value can always be
   typed), while a <datalist> is filled with SELECT DISTINCT values already
   stored. Values are cached per field and invalidated after a save.
   ===================================================================== */
(function (global) {
  const cache = new Map();
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function ensureList(field) {
    const id = 'dl-' + field;
    let dl = document.getElementById(id);
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = id;
      document.body.appendChild(dl);
    }
    return dl;
  }

  function paint(values, dl) {
    dl.innerHTML = values.map((v) => `<option value="${esc(v)}"></option>`).join('');
  }

  async function fill(field, dl) {
    if (cache.has(field)) { paint(cache.get(field), dl); return; }
    try {
      const values = await SamDB.call('getDistinctValues', field);
      cache.set(field, values);
      paint(values, dl);
    } catch (e) {
      cache.set(field, []);
      paint([], dl);
    }
  }

  /** input, field = 'base_unit' | 'category' | 'wh_location' | ... */
  function attach(input, field) {
    if (!input || !field) return input;
    const dl = ensureList(field);
    input.setAttribute('list', dl.id);
    const refresh = () => fill(field, dl);
    input.addEventListener('focus', refresh);
    input.addEventListener('click', refresh);
    refresh();
    return input;
  }

  function invalidate(field) { cache.delete(field); }

  global.SamSuggest = { attach, invalidate, clear: () => cache.clear() };
})(window);
