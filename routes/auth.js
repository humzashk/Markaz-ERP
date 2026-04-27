'use strict';
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../database');
const { wrap } = require('../middleware/errorHandler');

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const error = req.query.timeout ? 'Session expired due to inactivity. Please log in again.' : (req.query.err || null);
  res.render('auth/login', { error, username: req.query.u || '' });
});

router.post('/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) return res.redirect('/login?err=missing');
  const r = await pool.query(`SELECT * FROM users WHERE LOWER(username)=$1`, [username]);
  const u = r.rows[0];
  if (!u || u.status !== 'active') return res.redirect('/login?err=invalid&u=' + encodeURIComponent(username));
  if (!bcrypt.compareSync(password, u.password_hash || '')) return res.redirect('/login?err=invalid&u=' + encodeURIComponent(username));
  req.session.userId = u.id;
  req.session.lastActivity = Date.now();
  await pool.query(`UPDATE users SET last_login = NOW() WHERE id=$1`, [u.id]).catch(()=>{});
  res.redirect('/');
}));

router.get('/logout',  (req, res) => req.session ? req.session.destroy(() => res.redirect('/login')) : res.redirect('/login'));
router.post('/logout', (req, res) => req.session ? req.session.destroy(() => res.redirect('/login')) : res.redirect('/login'));

router.get('/profile', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('auth/profile', { page:'profile', msg: req.query.msg || null, err: req.query.err || null });
});

router.post('/profile/password', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const cur = String(req.body.current || '');
  const np  = String(req.body.new_password || '');
  const cp  = String(req.body.confirm || '');
  if (!np || np.length < 6) return res.redirect('/profile?err=short');
  if (np !== cp) return res.redirect('/profile?err=mismatch');
  const r = await pool.query(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id]);
  if (!r.rows[0] || !bcrypt.compareSync(cur, r.rows[0].password_hash || '')) return res.redirect('/profile?err=wrong');
  const hash = bcrypt.hashSync(np, 10);
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, req.user.id]);
  res.redirect('/profile?msg=updated');
}));

module.exports = router;
