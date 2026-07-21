/* ==========================================================================
 * auth.js — password hashing, JWT session cookie, role middleware
 * ========================================================================== */
'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const COOKIE = 'ph_session';
const ROLES = ['superadmin', 'admin_payroll', 'finance', 'supervisor', 'employee'];
// Roles allowed to see/administer full company payroll data.
const ADMIN_ROLES = ['superadmin', 'admin_payroll', 'finance'];

function hashPassword(pw) { return bcrypt.hashSync(String(pw), 10); }
function verifyPassword(pw, hash) { return bcrypt.compareSync(String(pw), hash); }

function issueToken(res, user) {
  const token = jwt.sign({ uid: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}
function clearToken(res) { res.clearCookie(COOKIE); }

// Populate req.user from the session cookie (if valid & active).
function authenticate(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
      if (user && user.status === 'active') req.user = user;
    } catch (e) { /* invalid/expired token → treated as anonymous */ }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}
function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
    if (roles.indexOf(req.user.role) < 0) return res.status(403).json({ error: 'Not allowed.' });
    next();
  };
}
const requireAdmin = requireRole(...ADMIN_ROLES);

// Short-lived token for password-reset links.
function makeResetToken(userId) {
  return jwt.sign({ uid: userId, purpose: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
}
function verifyResetToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return p && p.purpose === 'reset' ? p.uid : null;
  } catch (e) { return null; }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, fullName: u.full_name, role: u.role,
    status: u.status, employeeCode: u.employee_code
  };
}

module.exports = {
  ROLES, ADMIN_ROLES, COOKIE,
  hashPassword, verifyPassword, issueToken, clearToken,
  authenticate, requireAuth, requireRole, requireAdmin, publicUser,
  makeResetToken, verifyResetToken
};
