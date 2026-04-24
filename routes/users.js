const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { ALL_MODULES, requireRole } = require('../middleware/auth');

// Only SuperAdmin + Admin can manage users
router.use(requireRole('superadmin', 'admin'));

// LIST
router.get('/', (req, res) => {
  let users;
  if (req.user.role === 'superadmin') {
    users = db.prepare(
      `SELECT u.*, (SELECT name FROM users WHERE id = u.created_by) AS created_by_name
       FROM users u ORDER BY u.id ASC`
    ).all();
  } else {
    // admin sees only employees they created (or any employee)
    users = db.prepare(
      `SELECT u.*, (SELECT name FROM users WHERE id = u.created_by) AS created_by_name
       FROM users u WHERE u.role = 'employee' ORDER BY u.id ASC`
    ).all();
  }
  res.render('users/index', {
    page: 'users',
    users,
    saved: req.query.saved,
    err: req.query.err
  });
});

// NEW FORM
router.get('/new', (req, res) => {
  res.render('users/form', {
    page: 'users',
    user: { status: 'active', role: 'employee' },
    perms: [],
    ALL_MODULES,
    isNew: true,
    err: req.query.err
  });
});

// EDIT FORM
router.get('/edit/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.redirect('/users?err=notfound');
  // admins can only edit employees; superadmin can edit anyone except themselves via this flow
  if (req.user.role === 'admin' && u.role !== 'employee') return res.redirect('/users?err=forbidden');
  const perms = db.prepare('SELECT module FROM user_permissions WHERE user_id = ?').all(u.id).map(r => r.module);
  res.render('users/form', {
    page: 'users',
    user: u,
    perms,
    ALL_MODULES,
    isNew: false,
    err: req.query.err
  });
});

function sanitizeRole(currentUserRole, requestedRole) {
  // superadmin may create admin OR employee (NOT another superadmin through UI)
  // admin may create only employee
  if (currentUserRole === 'superadmin') {
    if (requestedRole === 'admin' || requestedRole === 'employee') return requestedRole;
    return 'employee';
  }
  return 'employee';
}

function modulesFromBody(body) {
  let mods = body.modules;
  if (!mods) return [];
  if (!Array.isArray(mods)) mods = [mods];
  return mods.filter(m => ALL_MODULES.includes(m));
}

// CREATE
router.post('/', (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const name     = String(req.body.name || '').trim();
    const email    = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const role     = sanitizeRole(req.user.role, String(req.body.role || 'employee'));
    const status   = req.body.status === 'inactive' ? 'inactive' : 'active';

    if (!username || !name || !password || password.length < 6) {
      return res.redirect('/users/new?err=invalid');
    }
    const exists = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(username);
    if (exists) return res.redirect('/users/new?err=dup');

    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      `INSERT INTO users (username, name, email, password_hash, role, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(username, name, email, hash, role, status, req.user.id);

    const newId = result.lastInsertRowid;
    // save permissions (only relevant for employee; admin/superadmin get full by role)
    if (role === 'employee') {
      const mods = modulesFromBody(req.body);
      for (const m of mods) {
        try { db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, module) VALUES (?, ?)').run(newId, m); } catch(e){}
      }
    }
    res.redirect('/users?saved=1');
  } catch (e) {
    console.error('create user error:', e.message);
    res.redirect('/users/new?err=server');
  }
});

// UPDATE
router.post('/edit/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.redirect('/users?err=notfound');
    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.redirect('/users?err=forbidden');
    }
    // prevent self-demotion from superadmin
    if (target.id === req.user.id && req.user.role === 'superadmin' && req.body.role !== 'superadmin') {
      return res.redirect('/users/edit/' + id + '?err=self_role');
    }

    const name   = String(req.body.name || target.name).trim();
    const email  = String(req.body.email || '').trim();
    const status = req.body.status === 'inactive' ? 'inactive' : 'active';

    let role = target.role;
    if (req.user.role === 'superadmin' && target.role !== 'superadmin') {
      role = sanitizeRole('superadmin', String(req.body.role || target.role));
    }

    db.prepare(
      'UPDATE users SET name = ?, email = ?, role = ?, status = ? WHERE id = ?'
    ).run(name, email, role, status, id);

    // optional password reset
    const np = String(req.body.new_password || '');
    if (np) {
      if (np.length < 6) return res.redirect('/users/edit/' + id + '?err=short');
      const hash = bcrypt.hashSync(np, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    }

    // rewrite permissions for employees
    if (role === 'employee') {
      db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
      const mods = modulesFromBody(req.body);
      for (const m of mods) {
        try { db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, module) VALUES (?, ?)').run(id, m); } catch(e){}
      }
    } else {
      // role escalated or stayed admin/superadmin → wipe explicit perms (they have implicit all)
      db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
    }

    res.redirect('/users?saved=1');
  } catch (e) {
    console.error('update user error:', e.message);
    res.redirect('/users?err=server');
  }
});

// TOGGLE STATUS
router.post('/toggle/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.redirect('/users?err=notfound');
  if (u.id === req.user.id) return res.redirect('/users?err=self');
  if (req.user.role === 'admin' && u.role !== 'employee') return res.redirect('/users?err=forbidden');
  const newStatus = u.status === 'active' ? 'inactive' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, id);
  res.redirect('/users?saved=1');
});

// DELETE
router.post('/delete/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.redirect('/users?err=notfound');
  if (u.id === req.user.id) return res.redirect('/users?err=self');
  if (u.role === 'superadmin') return res.redirect('/users?err=protected');
  if (req.user.role === 'admin' && u.role !== 'employee') return res.redirect('/users?err=forbidden');
  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.redirect('/users?saved=1');
});

module.exports = router;
