const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog, toInt, logError } = require('../database');

// Inline schema for transports (kept here so it stays beside the route)
const transportSchema = {
  required: { name: ['str', { max: 100, min: 1 }] },
  optional: {
    contact: ['str', { max: 100 }], phone: ['str', { max: 30 }],
    city: ['str', { max: 50 }], vehicle_no: ['str', { max: 50 }],
    driver_name: ['str', { max: 100 }], notes: ['str', { max: 500 }],
    status: ['oneOf', { choices: ['active','inactive'] }],
  }
};

router.get('/', (req, res) => {
  const search = req.query.search || '';
  let sql = 'SELECT * FROM transports WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND name LIKE ?'; params.push('%' + search + '%'); }
  sql += ' ORDER BY name';
  const transports = db.prepare(sql).all(...params);
  res.render('transports/index', { page: 'transports', transports, search });
});

router.get('/add', (req, res) => {
  res.render('transports/form', { page: 'transports', transport: null, edit: false });
});

router.post('/add', validate(transportSchema), (req, res) => {
  try {
    const v = req.valid;
    db.prepare(
      `INSERT INTO transports (name, contact, phone, city, vehicle_no, driver_name, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(v.name, v.contact, v.phone, v.city, v.vehicle_no, v.driver_name, v.notes, v.status || 'active');
    res.redirect('/transports');
  } catch (e) { logError('transports.create', e); res.redirect('/transports?err=server'); }
});

router.get('/edit/:id', (req, res) => {
  const transport = db.prepare('SELECT * FROM transports WHERE id = ?').get(toInt(req.params.id));
  if (!transport) return res.redirect('/transports');
  res.render('transports/form', { page: 'transports', transport, edit: true });
});

router.post('/edit/:id', validate(transportSchema), (req, res) => {
  try {
    const id = toInt(req.params.id);
    const v = req.valid;
    db.prepare(
      `UPDATE transports SET name=?, contact=?, phone=?, city=?, vehicle_no=?, driver_name=?, notes=?, status=? WHERE id=?`
    ).run(v.name, v.contact, v.phone, v.city, v.vehicle_no, v.driver_name, v.notes, v.status || 'active', id);
    res.redirect('/transports');
  } catch (e) { logError('transports.edit', e); res.redirect('/transports?err=server'); }
});

router.post('/delete/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM transports WHERE id = ?').run(toInt(req.params.id));
    res.redirect('/transports');
  } catch (e) { logError('transports.delete', e); res.redirect('/transports?err=server'); }
});

// Inline create endpoint (used by AJAX modal in invoice/order/bilty forms)
router.post('/api/quick-create', (req, res) => {
  try {
    const name = (req.body.name || '').toString().trim().substring(0, 100);
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const phone = (req.body.phone || '').toString().trim().substring(0, 30) || null;
    const result = db.prepare(`INSERT INTO transports (name, phone, status) VALUES (?, ?, 'active')`).run(name, phone);
    const row = db.prepare('SELECT * FROM transports WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, transport: row });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
