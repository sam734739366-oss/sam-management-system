/* =====================================================================
   SamUI.combo — searchable dropdown (autocomplete) used instead of <select>
   everywhere an Item or a Party has to be picked, and in long filter lists.

   - type a few letters (Arabic-insensitive: تخطيط/همزة/تاء مربوطة/ياء)
   - instant filtering, keyboard driven: ↑ ↓ Enter Esc, plus mouse
   - optional [+] button to create a record without leaving the form
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
      this.build();
      if (opts.items) this.setItems(opts.items);
      if (opts.value != null) this.setValue(opts.value, false);
    }

    build() {
      this.root.classList.add('combo');
      this.root.innerHTML = `
        <div class="combo-field">
          <input class="input combo-input" type="text" autocomplete="off" spellcheck="false"
                 placeholder="${esc(this.opts.placeholder || 'ابحث…')}" />
          <span class="combo-caret"></span>
          ${this.opts.onAdd ? '<button type="button" class="combo-plus" title="إضافة سريعة">+</button>' : ''}
        </div>
        <input type="hidden" class="combo-value" />`;
      this.input = this.root.querySelector('.combo-input');
      this.hidden = this.root.querySelector('.combo-value');
      this.input.addEventListener('input', () => this.onQuery());
      this.input.addEventListener('focus', () => { this.openList(); this.onQuery(); });
      this.input.addEventListener('keydown', (e) => this.onKey(e));
      this.input.addEventListener('blur', () => setTimeout(() => this.renderLabel(), 60));
      if (this.opts.onAdd) {
        this.root.querySelector('.combo-plus').addEventListener('click', (e) => {
          e.preventDefault();
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

    filtered() {
      const q = this.input.value;
      const search = this._typing ? q : '';
      const list = !search ? this.items : this.items
        .map((it) => ({ it, s: Math.max(score(it.label, search), score(it.code, search) * 0.95, score(it.sub, search) * 0.7) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s || norm(a.it.label).localeCompare(norm(b.it.label)))
        .map((r) => r.it);
      return list.slice(0, this.opts.limit || 50);
    }

    onQuery() {
      this._typing = true;
      this.openList();
      this.renderList();
    }

    openList() {
      if (!this.pop) {
        this.pop = el('div', 'combo-pop');
        this.pop.addEventListener('mousedown', (e) => e.preventDefault());
        document.body.appendChild(this.pop);
      }
      const r = this.input.getBoundingClientRect();
      this.pop.style.minWidth = `${Math.max(r.width, 220)}px`;
      this.pop.style.left = `${r.left}px`;
      this.pop.style.top = `${r.bottom + 6}px`;
      this.pop.style.display = 'block';
      openCombo = this;
      this.renderList();
    }

    closeList() {
      if (this.pop) this.pop.style.display = 'none';
      if (openCombo === this) openCombo = null;
      this._typing = false;
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
      this.closeList();
    }

    onKey(e) {
      const list = this._list || [];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!this.pop || this.pop.style.display === 'none') { this.openList(); return; }
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
      this.renderLabel();
      if (notify && this.opts.onChange) this.opts.onChange(this.value);
    }

    getValue() {
      return this.value;
    }

    renderLabel() {
      const it = this.items.find((x) => x.id === this.value);
      if (it && !this._typing) this.input.value = it.code ? `${it.code} — ${it.label}` : it.label;
      else if (!it) { if (!this._typing) this.input.value = ''; }
    }

    focus() { this.input.focus(); }
  }

  function combo(root, opts) {
    return new Combo(root, opts);
  }

  SamUI.combo = combo;
  SamUI.normArabic = norm;
})(window);
