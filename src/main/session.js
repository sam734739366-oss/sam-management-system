'use strict';

/**
 * src/main/session.js — authentication, roles and permission checks.
 *
 * Passwords are stored as scrypt(salt) hashes, never in clear text.
 * Permissions are enforced here in the main process, so hiding a button in
 * the UI is a convenience, not the security boundary.
 */

const crypto = require('crypto');
const db = require('./db');

const SCREEN_LABELS = {
  dashboard: 'لوحة التحكم',
  items: 'الأصناف',
  warehouses: 'المخازن',
  parties: 'العملاء والموردون',
  transactions: 'العمليات',
  production: 'الإنتاج',
  reports: 'التقارير',
  settings: 'الإعدادات'
};
const PERM_LABELS = { view: 'عرض', add: 'إضافة', edit: 'تعديل', delete: 'حذف نهائي' };
/**
 * screens that borrow another screen's permission.
 * The daily report is part of «التقارير» — it is not a separate
 * checkbox in the user screen, it follows the reports permission.
 */
const SCREEN_ALIASES = { daily: 'reports' };

let current = null;

function makeCredentials(password) {
  const pw = String(password == null ? '' : password);
  if (pw.length < 6) throw new Error('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}

function verify(password, salt, hash) {
  try {
    const cand = crypto.scryptSync(String(password == null ? '' : password), salt, 64);
    const real = Buffer.from(hash, 'hex');
    return cand.length === real.length && crypto.timingSafeEqual(cand, real);
  } catch (e) {
    return false;
  }
}

/** first run: create the default administrator so somebody can log in */
function ensureSeed() {
  if (db.userCount() > 0) return false;
  db.addUser({ username: 'admin', full_name: 'مدير النظام', role: 'admin' }, makeCredentials('admin123'));
  return true;
}

const publicUser = (u) => (u ? {
  id: u.id, username: u.username, full_name: u.full_name, role: u.role,
  screens: u.screens, perms: u.perms, is_active: !!u.is_active, last_login: u.last_login
} : null);

function login(username, password) {
  const u = db.getUserByUsername(username);
  if (!u) throw new Error('اسم المستخدم غير موجود');
  if (!u.is_active) throw new Error('هذا المستخدم موقوف — راجع المدير');
  if (!verify(password, u.salt, u.password_hash)) throw new Error('كلمة المرور غير صحيحة');
  db.touchLogin(u.id);
  current = publicUser(db.getUser(u.id));
  return current;
}

function logout() { current = null; }
function currentUser() { return current; }

function can(screen, action) {
  if (!current) return false;
  if (current.role === 'admin') return true;
  const s = SCREEN_ALIASES[screen] || screen;
  if (!current.screens.includes(s)) return false;
  if (action === 'manage') return false;
  return !!current.perms[action];
}

function assert(screen, action) {
  if (!can(screen, action)) {
    throw new Error(`لا تملك صلاحية «${PERM_LABELS[action] || action}» في «${SCREEN_LABELS[screen] || screen}»`);
  }
  return true;
}

/* ---------------- user management (admin only) ---------------- */

function listUsers() {
  assert('settings', 'manage');
  return db.listUsers().map(publicUser);
}

function saveUser(payload) {
  assert('settings', 'manage');
  const isNew = !payload.id;
  const creds = payload.password ? makeCredentials(payload.password) : null;
  if (isNew && !creds) throw new Error('كلمة المرور مطلوبة للمستخدم الجديد');
  if (!String(payload.username || '').trim()) throw new Error('اسم المستخدم مطلوب');
  const saved = isNew
    ? db.addUser(payload, creds)
    : db.updateUser(payload.id, payload, creds);
  if (!isNew && current && saved.id === current.id) current = publicUser(saved);
  return publicUser(saved);
}

function removeUser(id) {
  assert('settings', 'manage');
  if (current && id === current.id) throw new Error('لا يمكنك حذف حسابك الحالي');
  return db.deleteUser(id);
}

/** the signed-in user changing their own password */
function changeOwnPassword(oldPassword, newPassword) {
  if (!current) throw new Error('لا توجد جلسة');
  const u = db.getUser(current.id);
  if (!verify(oldPassword, u.salt, u.password_hash)) throw new Error('كلمة المرور الحالية غير صحيحة');
  db.updateUser(u.id, { username: u.username, full_name: u.full_name, role: u.role, screens: u.screens, perms: u.perms, is_active: u.is_active }, makeCredentials(newPassword));
  current = publicUser(db.getUser(u.id));
  return true;
}

module.exports = {
  SCREEN_LABELS,
  PERM_LABELS,
  ensureSeed,
  login,
  logout,
  currentUser,
  can,
  assert,
  listUsers,
  saveUser,
  removeUser,
  changeOwnPassword,
  makeCredentials
};
