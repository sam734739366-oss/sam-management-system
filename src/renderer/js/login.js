'use strict';

/* =====================================================================
   Login — V2: no intro timeline here any more.
   The screen paints instantly, validates, and hands over to the main
   window, which plays the one-shot premium transition (js/intro.js).
   ===================================================================== */

const $ = (id) => document.getElementById(id);

const form = $('loginForm');
const card = $('loginCard');
const btn = $('loginBtn');
const btnLabel = btn.querySelector('span');

$('btnMin').addEventListener('click', () => window.sam.win.minimize());
$('btnClose').addEventListener('click', () => window.sam.win.close());

$('pwToggle').addEventListener('click', () => {
  const pw = $('password');
  pw.type = pw.type === 'password' ? 'text' : 'password';
  pw.focus();
});

function fail(msg) {
  $('loginError').textContent = msg;
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
  setBusy(false);
}

function setBusy(on) {
  btn.disabled = on;
  const old = btn.querySelector('.spin');
  if (old) old.remove();
  btnLabel.textContent = on ? 'جارٍ التحقق…' : 'دخول النظام';
  if (on) {
    const s = document.createElement('span');
    s.className = 'spin';
    btn.insertBefore(s, btnLabel);
  }
}

let busy = false;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  const u = $('username').value.trim();
  const p = $('password').value;
  if (!u || !p) {
    busy = false;
    return fail('يرجى إدخال اسم المستخدم وكلمة المرور');
  }
  $('loginError').textContent = '';
  setBusy(true);
  let res;
  try {
    res = await window.sam.auth.login(u, p);
  } catch (err) {
    busy = false;
    return fail('تعذّر الاتصال بالنظام: ' + err.message);
  }
  if (!res || !res.ok) {
    busy = false;
    setBusy(false);
    return fail(res && res.error ? res.error : 'بيانات الدخول غير صحيحة');
  }
  // success: the main process loads app.html; it asks for a remember-me marker
  // so the transition only plays after a real login, never on a reload.
  try { sessionStorage.setItem('sam.justLoggedIn', '1'); } catch (e) { /* ignore */ }
  document.body.classList.add('leaving');
});

window.addEventListener('DOMContentLoaded', () => $('username').focus());
