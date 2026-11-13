/* =====================================================================
   SamSignatures — تذييل التوقيع (the signature footer) of every print
   =====================================================================
   The customer complained that the signature footer of the printed
   documents was wrong: an exit permit must be signed by the warehouse
   keeper, the driver and the gate guard — but a production receipt
   must NOT carry the driver (the driver only ever signs an exit
   permit), and every printed document must have a footer that fits
   what is being printed.

   So the footer stops being a hardcoded array in every print call and
   becomes ONE system:

     · SIGN_PRESETS — the default set of names for every kind of
       document (the truth of the customer's rules);
     · the user's own choice per kind — saved in localStorage, so it
       survives a restart and every later print of that kind uses it;
     · signaturesFor(kind) — the set a print must use: the user's
       choice if there is one, the preset otherwise.

   Other screens call it like this:

     SamUI.printPreview({ kind: 'exit_permit', title: '…' });        // the footer comes from the system
     SamUI.printPreview({ kind: 'exit_permit', signatures: ['…'] });  // an explicit set is the STARTING set

     SamSignatures.signaturesFor('exit_permit');       // → ['أمين المخازن','السائق','حارس البوابة']
     SamSignatures.setSignatureChoice('exit_permit', ['أمين المخازن']);
     SamSignatures.resetSignatureChoice('exit_permit');
   ===================================================================== */

(function (global) {
  'use strict';

  /* already loaded (the page may include the file twice) */
  if (global.SamSignatures) return;

  /* ---------------- the presets — the customer's rules ---------------- */
  const SIGN_PRESETS = {
    /* تصريح خروج — warehouse keeper + driver + gate guard */
    exit_permit: ['أمين المخازن', 'السائق', 'حارس البوابة'],
    /* إذن إدخال — the gate guard + the warehouse keeper */
    gate_in: ['حارس البوابة', 'أمين المخازن'],
    /* سند استلام الإنتاج — keeper + production manager + the manager (NO driver) */
    production_receipt: ['أمين المخازن', 'مسؤول الإنتاج', 'المدير'],
    /* سند توريد الإنتاج — the same three */
    production_issue: ['أمين المخازن', 'مسؤول الإنتاج', 'المدير'],
    /* فاتورة (بيع / شراء) */
    invoice: ['أمين المخزن', 'المراجع', 'المدير'],
    /* تحويل بين المخازن */
    transfer: ['أمين المخزن', 'السائق', 'المدير'],
    /* بطاقة رصيد صنف */
    item_card: ['أمين المخزن', 'المراجع', 'المدير'],
    /* استلام خامة عميل (نفخ للغير) */
    tolling_in: ['حارس البوابة', 'أمين المخازن'],
    /* التقارير — a report carries no signature footer */
    report: []
  };

  /* the fallback when nothing can be inferred */
  const DEFAULT_SIGNATURES = ['أمين المخزن', 'المدير'];
  const DEFAULT_KIND = 'default';

  /* the document kinds of the program → the signature kind */
  const DOC_KIND_MAP = {
    purchase: 'invoice',
    sale: 'invoice',
    sale_return: 'invoice',
    purchase_return: 'invoice',
    adjustment: 'invoice',
    transfer: 'transfer',
    prod_receipt: 'production_receipt',
    prod_issue: 'production_issue',
    gate_in: 'gate_in',
    gate_out: 'exit_permit'
  };

  /* the order matters: the first match wins */
  const KIND_RULES = [
    ['exit_permit', /تصريح\s*خروج|إذن\s*خروج|تصريح\s*الخروج|خروج\s*من\s*المصنع/],
    ['gate_in', /تصريح\s*دخول|إذن\s*إدخال|إدخال\s*البوابة|دخول\s*البوابة/],
    ['production_receipt', /استلام\s*الإنتاج|استلام\s*انتاج/],
    ['production_issue', /توريد\s*الإنتاج|توريد\s*انتاج/],
    ['tolling_in', /نفخ|للغير|توليد\s+للغير/],
    ['item_card', /بطاقة|رصيد\s*صنف/],
    ['invoice', /فاتورة|مشتريات|مبيعات|مرتجع|تسوية\s*جرد|إذن\s*خروج/],
    ['transfer', /تحويل|نقل\s*بين\s*المخازن|انتقال/],
    ['report', /تقرير|أرشيف|كشف|ملخص|أرصدة|حركة|ناقصة|التالف|عجز|دليل/]
  ];

  const STORAGE_KEY = 'sam.signatures.v1';
  const KINDS = Object.keys(SIGN_PRESETS);

  /* ---------------- the storage (it never throws) ---------------- */
  function readAll() {
    try {
      const ls = global.localStorage;
      if (!ls) return {};
      const raw = ls.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch (e) {
      return {};
    }
  }

  function writeAll(map) {
    try {
      const ls = global.localStorage;
      if (!ls) return false;
      ls.setItem(STORAGE_KEY, JSON.stringify(map || {}));
      return true;
    } catch (e) {
      /* a full disk or a blocked storage must never break the print */
      return false;
    }
  }

  /* ---------------- helpers ---------------- */
  function labelOf(sig) {
    if (sig == null) return '';
    if (typeof sig === 'string') return sig.trim();
    if (typeof sig === 'object' && sig.label != null) return String(sig.label).trim();
    return '';
  }

  function cleanNames(names) {
    if (!Array.isArray(names)) return [];
    const out = [];
    names.forEach((n) => {
      const s = labelOf(n);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  /** the kind of a document — an alias is folded into the real kind */
  function normalizeKind(kind) {
    const k = String(kind == null ? '' : kind).trim();
    if (!k) return '';
    if (Object.prototype.hasOwnProperty.call(SIGN_PRESETS, k)) return k;
    if (Object.prototype.hasOwnProperty.call(DOC_KIND_MAP, k)) return DOC_KIND_MAP[k];
    return k;
  }

  /** the default set of a kind — a report has none, an unknown kind has the generic one */
  function presetFor(kind) {
    const k = normalizeKind(kind);
    if (k && Object.prototype.hasOwnProperty.call(SIGN_PRESETS, k)) return SIGN_PRESETS[k].slice();
    return DEFAULT_SIGNATURES.slice();
  }

  /** the kind of a print — from `kind`, or guessed from the words of the document */
  function resolveKind(o) {
    if (!o || typeof o !== 'object') return DEFAULT_KIND;
    if (o.kind) {
      const k = normalizeKind(o.kind);
      if (k) return k;
    }
    const text = [o.docType, o.title, o.subtitle, o.footer, o.docRefLabel]
      .filter((t) => t != null && String(t).trim())
      .join(' ');
    if (!text.trim()) return DEFAULT_KIND;
    for (let i = 0; i < KIND_RULES.length; i++) {
      if (KIND_RULES[i][1].test(text)) return KIND_RULES[i][0];
    }
    return DEFAULT_KIND;
  }

  /* the same thing under a second name — the call sites read better with it */
  const inferKind = resolveKind;

  /* ---------------- the user's own choice ---------------- */
  function hasSignatureChoice(kind) {
    const k = normalizeKind(kind);
    if (!k) return false;
    const map = readAll();
    return Object.prototype.hasOwnProperty.call(map, k) && Array.isArray(map[k]);
  }

  /** the set a print must use — the user's choice, else the preset */
  function signaturesFor(kind) {
    const k = normalizeKind(kind);
    if (!k) return presetFor(DEFAULT_KIND);
    const map = readAll();
    if (Object.prototype.hasOwnProperty.call(map, k) && Array.isArray(map[k])) {
      return map[k].slice();
    }
    return presetFor(k);
  }

  /** the user's choice is saved — it survives a restart */
  function setSignatureChoice(kind, names) {
    const k = normalizeKind(kind);
    if (!k) return false;
    const list = cleanNames(names);
    const map = readAll();
    map[k] = list;
    return writeAll(map);
  }

  /** forget the choice — the preset comes back */
  function resetSignatureChoice(kind) {
    const k = normalizeKind(kind);
    if (!k) return false;
    const map = readAll();
    if (!Object.prototype.hasOwnProperty.call(map, k)) return true;
    delete map[k];
    return writeAll(map);
  }

  /** forget every choice */
  function clearAll() {
    return writeAll({});
  }

  /** the whole map — for the diagnostics */
  function choices() {
    const map = readAll();
    const out = {};
    Object.keys(map).forEach((k) => { out[k] = cleanNames(map[k]); });
    return out;
  }

  /**
   * the names a print must show.
   *   1. the user's own choice for the kind (if there is one)
   *   2. the array the caller passed (the STARTING set)
   *   3. the preset of the kind
   */
  function namesFor(o) {
    const kind = resolveKind(o);
    if (hasSignatureChoice(kind)) return signaturesFor(kind);
    if (o && Array.isArray(o.signatures)) {
      const list = cleanNames(o.signatures);
      if (list.length) return list;
      return list;               /* an explicit empty set stays empty */
    }
    return signaturesFor(kind);
  }

  global.SamSignatures = {
    SIGN_PRESETS,
    PRESETS: SIGN_PRESETS,
    KINDS,
    DEFAULT_SIGNATURES,
    DEFAULT_KIND,
    STORAGE_KEY,
    DOC_KIND_MAP,
    normalizeKind,
    presetFor,
    resolveKind,
    inferKind,
    signaturesFor,
    setSignatureChoice,
    resetSignatureChoice,
    hasSignatureChoice,
    clearAll,
    choices,
    namesFor
  };
})(window);
