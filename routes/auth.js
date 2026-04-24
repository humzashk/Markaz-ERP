const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('auth/login', { error: req.query.err || null, username: req.query.u || '' });
});

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) return res.redirect('/login?err=missing');
  try {
    const u = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(username);
    if (!u || u.status !== 'active') return res.redirect('/login?err=invalid&u=' + encodeURIComponent(username));
    const ok = bcrypt.compareSync(password, u.password_hash || '');
    if (!ok) return res.redirect('/login?err=invalid&u=' + encodeURIComponent(username));
    req.session.userId = u.id;
    try { db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(u.id); } catch(e){}
    res.redirect('/');
  } catch (e) {
    console.error('login error:', e.message);
    res.redirect('/login?err=server');
  }
});

router.get('/logout', (req, res) => {
  if (req.session) req.session.destroy(() => res.redirect('/login'));
  else res.redirect('/login');
});

router.post('/logout', (req, res) => {
  if (req.session) req.session.destroy(() => res.redirect('/login'));
  else res.redirect('/login');
});

// Current user profile — change password
router.get('/profile', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('auth/profile', { page: 'profile', msg: req.query.msg || null, err: req.query.err || null });
});

router.post('/profile/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const cur = String(req.body.current || '');
  const np  = String(req.body.new_password || '');
  const cp  = String(req.body.confirm || '');
  if (!np || np.length < 6) return res.redirect('/profile?err=short');
  if (np !== cp) return res.redirect('/profile?err=mismatch');
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!u || !bcrypt.compareSync(cur, u.password_hash || '')) return res.redirect('/profile?err=wrong');
  const hash = bcrypt.hashSync(np, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.redirect('/profile?msg=updated');
});

module.exports = router;
