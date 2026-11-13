/* =====================================================================
   SamUI.combo — searchable dropdown (autocomplete) used instead of <select>
   everywhere an Item or a Party has to be picked, and in long filter lists.

   - type a few letters (Arabic-insensitive: تخطيط/همزة/تاء مربوطة/ياء)
   - instant filtering, keyboard driven: ↑ ↓ Enter Esc, plus mouse
   - optional [+] button to create a record without leaving the form

   V4 — the customer found the old control confusing:
     · the caret was a decorative shape, so clicking it did nothing,
     · the "+" and the caret overlapped the text on narrow columns,
     · the list only opened while typing, so an empty field looked dead,
     · after picking an item the list could not be reopened without typing.
   Now the caret is a real BUTTON, the "+" is an icon button, the list opens
   on click / focus / typing and right after a pick, and the chosen item gets
   a visible state so changing it is obvious.

   V7 — two more faults the customer wrote about:
     · the list only showed up while he typed: a field that already held a
       value took the WRITTEN LABEL («code — name») as the needle, so it
       answered «لا يوجد صنف مطابق» instead of the list of the options,
     · the list flashed for a moment and vanished again: it was opened by
       the focus (which comes with the press) and closed by the click that
       came with the release.
   So the rule of the control is now clear:
     · the PRESS opens the list and the RELEASE keeps it open — nothing that
       happens between the two may close it,
     · a press or a click shows EVERY option with the current one marked,
     · the filter only takes what the user really typed, never the label.
   ===================================================================== */
(function (global) {
  'use strict';

  const el = SamUI.el;
  const esc = SamUI.esc;

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[ً-ْـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ئ/g, 'ي')
      .replace(/ؤ/g, 'و')
      .replace(/ة/g, 'ه')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function score(hay, needle) {
    if (!needle) return 1;
    const h = norm(hay);
    const n = norm(needle);
    if (!n) return 1;
    if (h === n) return 100;
    if (h.startsWith(n)) return 60;
    if (h.includes(n)) return 30;
    // loose subsequence match (letters typed out of order / abbreviations)
    let i = 0;
    for (const ch of h) if (ch === n[i]) i++;
    return i === n.length ? 12 : 0;
  }

  let openCombo = null;
  function closeAll() {
    if (openCombo) openCombo.closeList();
  }
  document.addEventListener('mousedown', (e) => {
    if (openCombo && !openCombo.root.contains(e.target) && !(openCombo.pop && openCombo.pop.contains(e.target))) {
      openCombo.closeList();
    }
  }, true);
  window.addEventListener('blur', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openCombo) openCombo.closeList(); }, true);

  class Combo {
    constructor(root, opts = {}) {
      this.root = root;
      this.opts = opts;
      this.items = [];
      this.value = opts.value == null ? null : opts.value;
      this.active = -1;
      this._typing = false;   /* the user is typing — the list is filtered */
      this._needle = '';       /* what he really typed — the filter */
      this._label = '';        /* what the field shows for the picked item */
      this.build();
      if (opts.items) this.setItems(opts.items);
      if (opts.value != null) this.setValue(opts.value, false);
    }

    build() {
      this.root.classList.add('combo');
      /* the caret is placed inside the text box (it is an absolute arrow over
         the padding of the field) and the "+" stays a brother of it — in an
         RTL field the two used to sit on top of each other, and the click
         on the "+" fell on the caret, which only opens the list */
      this.root.innerHTML = `
        <div class="combo-field">
          <div class="combo-text" style="position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0">
            <input class="input combo-input" type="text" autocomplete="off" spellcheck="false"
                   placeholder="${esc(this.opts.placeholder || 'ابحث…')}" />
            <button type="button" class="combo-caret" title="إظهار القائمة" aria-label="إظهار القائمة">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6L8 10.5 12.5 6" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          ${this.opts.onAdd ? `<button type="button" class="combo-plus" title="إضافة سجل جديد" aria-label="إضافة جديد">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round"/></svg>
          </button>` : ''}
        </div>
        <input type="hidden" class="combo-value" />`;
      this.input = this.root.querySelector('.combo-input');
      this.hidden = this.root.querySelector('.combo-value');
      this.caret = this.root.querySelector('.combo-caret');
      this.input.addEventListener('input', () => this.onQuery());
      /* the PRESS opens the list and the RELEASE (the click) keeps it open —
         nothing that happens between the two may close it again */
      this.input.addEventListener('mousedown', () => this.openAll());
      this.input.addEventListener('focus', () => this.openAll());
      this.input.addEventListener('click', () => this.openAll());
      this.input.addEventListener('keydown', (e) => this.onKey(e));
      this.input.addEventListener('blur', () => setTimeout(() => this.renderLabel(), 60));

      /* the caret is a real toggle — clicking it opens the list without typing.
         It must NOT steal the focus from the field: the focus would move away
         and the list would flicker while the mouse is down. */
      this.caret.addEventListener('mousedown', (e) => e.preventDefault());
      this.caret.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleList();
      });

      if (this.opts.onAdd) {
        const plus = this.root.querySelector('.combo-plus');
        plus.addEventListener('mousedown', (e) => e.preventDefault());
        plus.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.opts.onAdd();
        });
      }
    }

    setItems(items) {
      this.items = items || [];
      if (this.value != null) this.renderLabel();
      if (this.pop && this.pop.style.display !== 'none') this.renderList();
      return this;
    }

    /** the item the user picked */
    current() {
      return this.items.find((x) => x.id === this.value) || null;
    }

    filtered() {
      // an empty field shows the WHOLE list — the dropdown must appear even
      // before the first letter is typed
      const search = this._typing ? this._needle : '';
      const list = !search ? this.items : this.items
        .map((it) => ({ it, s: Math.max(score(it.label, search), score(it.code, search) * 0.95, score(it.sub, search) * 0.7) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s || norm(a.it.label).localeCompare(norm(b.it.label)))
        .map((r) => r.it);
      return list.slice(0, this.opts.limit || 50);
    }

    /**
     * A press, a click or a focus on the field shows EVERY option — the
     * customer must not have to type to know what is inside. The filter is
     * only alive while he is really typing.
     */
    openAll() {
      if (!this._typing) {
        this._needle = '';
        this.renderLabel();
      }
      this.openList();
      this.renderList();
      // the chosen item is where the keyboard starts from
      if (!this._typing) {
        const sel = (this._list || []).findIndex((it) => it.id === this.value);
        if (sel >= 0) this.setActive(sel);
      }
    }

    onQuery() {
      let q = this.input.value;
      // the field shows «code — name» until the user types — the filter must
      // only take what he typed AFTER the label, never the label itself
      if (this._label && q.indexOf(this._label) === 0) {
        q = q.slice(this._label.length);
        this.input.value = q;
      }
      this._label = '';
      this._needle = q;
      this._typing = true;
      this.openList();
      this.renderList();
    }

    toggleList() {
      if (this.pop && this.pop.style.display !== 'none') this.closeList();
      else this.openAll();
    }

    openList() {
      if (!this.pop) {
        this.pop = el('div', 'combo-pop');
        this.pop.addEventListener('mousedown', (e) => e.preventDefault());
        document.body.appendChild(this.pop);
      }
      // one list at a time — the old one goes away with the new one
      if (openCombo && openCombo !== this) openCombo.closeList();
      const r = this.input.getBoundingClientRect();
      this.pop.style.minWidth = `${Math.max(r.width, 220)}px`;
      // keep the list on screen when the field sits near the bottom edge
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const flip = spaceBelow < 260 && spaceAbove > spaceBelow;
      this.pop.style.left = `${r.left}px`;
      this.pop.style.maxHeight = `${Math.max(180, Math.min(320, flip ? spaceAbove - 16 : spaceBelow - 16))}px`;
      this.pop.style.top = flip ? 'auto' : `${r.bottom + 6}px`;
      this.pop.style.bottom = flip ? `${window.innerHeight - r.top + 6}px` : 'auto';
      this.pop.style.display = 'block';
      openCombo = this;
      this.root.classList.add('open');
      if (this.caret) this.caret.classList.add('up');
      this.renderList();
    }

    closeList() {
      if (this.pop) this.pop.style.display = 'none';
      if (openCombo === this) openCombo = null;
      this._typing = false;
      this._needle = '';
      this.root.classList.remove('open');
      if (this.caret) this.caret.classList.remove('up');
      this.renderLabel();
    }

    renderList() {
      if (!this.pop) return;
      const list = this.filtered();
      this._list = list;
      this.active = list.length ? 0 : -1;
      if (!list.length) {
        this.pop.innerHTML = `<div class="combo-empty">${esc(this.opts.emptyText || 'لا نتائج مطابقة')}</div>`;
        return;
      }
      this.pop.innerHTML = list
        .map((it, i) => `
          <div class="combo-opt ${it.id === this.value ? 'sel' : ''} ${i === this.active ? 'active' : ''}" data-i="${i}">
            ${it.code ? `<span class="code">${esc(it.code)}</span>` : ''}
            <span class="label">${esc(it.label)}</span>
            ${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}
          </div>`)
        .join('');
      this.pop.querySelectorAll('.combo-opt').forEach((n) => {
        n.addEventListener('mouseenter', () => this.setActive(Number(n.dataset.i)));
        n.addEventListener('click', () => this.pick(Number(n.dataset.i)));
      });
    }

    setActive(i) {
      this.active = i;
      this.pop.querySelectorAll('.combo-opt').forEach((n) => n.classList.toggle('active', Number(n.dataset.i) === i));
      const node = this.pop.querySelector('.combo-opt.active');
      if (node) node.scrollIntoView({ block: 'nearest' });
    }

    pick(i) {
      const it = (this._list || [])[i];
      if (!it) return;
      this.setValue(it.id, true);
      // the list stays reachable — the customer must be able to CHANGE the
      // item straight away without clearing the field first
      this.closeList();
      this.renderLabel();
    }

    onKey(e) {
      const list = this._list || [];
      /* the field shows «code — name» — the first character the user types
         replaces it, so the filter only sees what he really wrote */
      if (this._label && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.input.value = '';
        this._label = '';
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!this.pop || this.pop.style.display === 'none') { this.openAll(); return; }
        this.setActive(Math.min(list.length - 1, this.active + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.setActive(Math.max(0, this.active - 1));
      } else if (e.key === 'Enter') {
        if (this.pop && this.pop.style.display !== 'none' && this.active >= 0) {
          e.preventDefault();
          this.pick(this.active);
        }
      } else if (e.key === 'Escape') {
        this.closeList();
      } else if (e.key === 'Backspace' && this.input.value === '') {
        this.setValue(null, true);
      }
    }

    setValue(id, notify) {
      this.value = id == null || id === '' ? null : id;
      this.hidden.value = this.value == null ? '' : this.value;
      this._typing = false;
      this._needle = '';
      this.renderLabel();
      if (notify && this.opts.onChange) this.opts.onChange(this.value);
    }

    getValue() {
      return this.value;
    }

    renderLabel() {
      const it = this.current();
      if (it && !this._typing) {
        this._label = it.code ? `${it.code} — ${it.label}` : it.label;
        this.input.value = this._label;
      } else if (!it) {
        if (!this._typing) { this._label = ''; this.input.value = ''; }
      }
      // a filled field gets a subtle highlight so the chosen item is obvious
      this.root.classList.toggle('filled', !!it && !this._typing);
    }

    focus() { this.input.focus(); }

    /** open the list on demand — used by the keyboard shortcut */
    open() { this.openAll(); }
  }

  function combo(root, opts) {
    return new Combo(root, opts);
  }

  SamUI.combo = combo;
  SamUI.normArabic = norm;
})(window);
