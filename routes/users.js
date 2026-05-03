'use strict';
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { requireRole, ALL_MODULES } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { DASH_WIDGETS } = require('./dashboard');

router.use(requireRole('superadmin','admin'));

router.get('/', wrap(async (req, res) => {
  const r = await pool.query(`SELECT id, username, name, email, role, status, created_at, last_login FROM users ORDER BY id`);
  res.render('users/index', { page:'users', users: r.rows, err: req.query.err || null, saved: req.query.saved || null });
}));

router.get('/new', (req, res) => res.redirect('/users/add'));
router.get('/add', (req, res) => {
  const blank = { id:null, name:'', email:'', role:'employee', status:'active', username:'' };
  res.render('users/form', { page:'users', editUser:null, user:blank, edit:false, isNew:true, ALL_MODULES, DASH_WIDGETS, perms: [] });
});

router.post('/add', validate(schemas.userCreate), wrap(async (req, res) => {
  const v = req.valid;
  const password = req.body.password || 'changeme';
  const hash = bcrypt.hashSync(password, 10);
  let r;
  try {
    r = await pool.query(`
      INSERT INTO users(username, name, email, password_hash, role, status, created_by)
      VALUES (LOWER($1),$2,$3,$4,$5,COALESCE($6,'active'),$7) RETURNING id`,
      [v.username, v.name || v.username, v.email, hash, v.role, v.status, req.user.id]);
  } catch(e) {
    // Unique constraint violation — username already taken
    if (e.code === '23505') {
      return res.redirect('/users/add?err=' + encodeURIComponent(`Username "${v.username}" is already taken`));
    }
    throw e;
  }
  const id = r.rows[0].id;
  if (v.role === 'employee') {
    const mods = req.body.modules ? (Array.isArray(req.body.modules) ? req.body.modules : [req.body.modules]) : [];
    for (const m of mods) await pool.query(`INSERT INTO user_permissions(user_id, module) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, m]);
  }
  await addAuditLog('create','users', id, `Created user ${v.username}`);
  res.redirect('/users?saved=1');
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const u = (await pool.query(`SELECT id, username, name, email, role, status FROM users WHERE id=$1`, [id])).rows[0];
  if (!u) return res.redirect('/users');
  const perms = (await pool.query(`SELECT module FROM user_permissions WHERE user_id=$1`, [id])).rows.map(r => r.module);
  res.render('users/form', { page:'users', editUser: u, user: u, edit:true, isNew:false, ALL_MODULES, DASH_WIDGETS, perms });
}));

router.post('/edit/:id', validate(schemas.userCreate), wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const v = req.valid;
  try {
    await pool.query(`UPDATE users SET username=LOWER($1), name=$2, email=$3, role=$4, status=COALESCE($5,'active') WHERE id=$6`,
      [v.username, v.name || v.username, v.email, v.role, v.status, id]);
  } catch(e) {
    if (e.code === '23505') {
      return res.redirect(`/users/edit/${id}?err=` + encodeURIComponent(`Username "${v.username}" is already taken`));
    }
    throw e;
  }
  if (req.body.password && req.body.password.length >= 6) {
    const hash = bcrypt.hashSync(req.body.password, 10);
    await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, id]);
  }
  await pool.query(`DELETE FROM user_permissions WHERE user_id=$1`, [id]);
  if (v.role === 'employee') {
    const mods = req.body.modules ? (Array.isArray(req.body.modules) ? req.body.modules : [req.body.modules]) : [];
    for (const m of mods) await pool.query(`INSERT INTO user_permissions(user_id, module) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, m]);
  }
  await addAuditLog('update','users', id, `Updated user ${v.username}`);
  res.redirect('/users');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (id === req.user.id) return res.redirect('/users?err=cannot_delete_self');
  await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  await addAuditLog('delete','users', id, 'Deleted');
  res.redirect('/users');
}));

router.post('/toggle/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (id === req.user.id) return res.redirect('/users?err=cannot_toggle_self');
  const user = (await pool.query(`SELECT status FROM users WHERE id=$1`, [id])).rows[0];
  if (!user) return res.redirect('/users?err=user_not_found');
  const newStatus = user.status === 'active' ? 'inactive' : 'active';
  await pool.query(`UPDATE users SET status=$1 WHERE id=$2`, [newStatus, id]);
  await addAuditLog('update','users', id, `Toggled status to ${newStatus}`);
  res.redirect('/users');
}));

module.exports = router;
