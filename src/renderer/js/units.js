/* =====================================================================
   SamUnits — وحدات الصنف: الكرتون والكيس والوحدة الخاصة
   =====================================================================
   The customer counts in PIECES — the piece is the only truth. The
   carton, the bag and the unit of its own are a way to READ the same
   quantity, never another quantity:

     · the quantity is the truth, the packs are its shape;
     · typing the quantity fills the packs (12 bags of 24 + 12 pieces);
     · typing the packs fills the quantity;
     · a pack that is not whole is written in PIECES («12 حبة من كيس»),
       never as a fraction that cannot be counted.

   So every screen works with the same two helpers:

     SamUnits.unitsOf(item)      → the units this item really uses
     SamUnits.split(item, key, pieces) → { count, part }
     SamUnits.join(item, key, count, part) → pieces
   ===================================================================== */

(function (global) {
  'use strict';
  if (global.SamUnits) return;

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  /** the units of an item — only the ones the item really uses */
  function unitsOf(item) {
    const it = item || {};
    const out = [];
    if (num(it.pieces_per_carton) > 0) {
      out.push({ key: 'cartons', label: 'كرتون', short: 'كرتون', pieces: num(it.pieces_per_carton) });
    }
    if (num(it.pieces_per_bag) > 0) {
      out.push({ key: 'bags', label: 'كيس', short: 'كيس', pieces: num(it.pieces_per_bag) });
    }
    const label = (it.unit_label || '').trim();
    if (label && num(it.unit_pieces) > 0) {
      out.push({ key: 'unit', label, short: label, pieces: num(it.unit_pieces) });
    }
    return out;
  }

  /** how many pieces one unit of this kind holds */
  function piecesOf(item, key) {
    const it = item || {};
    if (key === 'cartons') return num(it.pieces_per_carton);
    if (key === 'bags') return num(it.pieces_per_bag);
    if (key === 'unit') return num(it.unit_pieces);
    return 0;
  }

  /**
   * The quantity split into the units of one kind:
   * 300 pieces of a bag of 24 → 12 bags and 12 pieces of an incomplete bag.
   */
  function split(item, key, pieces) {
    const per = piecesOf(item, key);
    const q = Math.max(0, Math.round(num(pieces)));
    if (!per) return { count: 0, part: 0 };
    const count = Math.floor(q / per);
    const part = q - count * per;
    return { count, part };
  }

  /** the units back into the quantity: 12 bags of 24 and 12 pieces → 300 */
  function join(item, key, count, part) {
    const per = piecesOf(item, key);
    return Math.max(0, num(count) * per + num(part));
  }

  /** the text of one unit of a line: «12 كيس + 12 حبة» (nothing if it is whole) */
  function describe(item, key, count, part) {
    const u = unitsOf(item).find((x) => x.key === key);
    if (!u) return '';
    const c = num(count);
    const p = num(part);
    if (!c && !p) return '';
    if (!p) return `${c} ${u.short}`;
    return `${c ? c + ' ' + u.short + ' + ' : ''}${p} حبة`;
  }

  /** the whole line in one line of text: «12 كيس + 12 حبة» for every unit */
  function describeAll(item, line) {
    const l = line || {};
    const parts = unitsOf(item).map((u) => describe(item, u.key, l[u.key], l[u.key + '_part'])).filter(Boolean);
    return parts.join(' · ');
  }

  /** the fields of a line, ready for a form */
  function fieldsFor(item) {
    return unitsOf(item).map((u) => ({
      key: u.key,
      label: u.label,
      short: u.short,
      pieces: u.pieces,
      countKey: u.key,
      partKey: u.key + '_part'
    }));
  }

  global.SamUnits = { unitsOf, piecesOf, split, join, describe, describeAll, fieldsFor };
})(window);
