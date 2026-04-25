const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const search = req.query.search || '';
  let sql = `SELECT b.*, o.order_no, i.invoice_no,
    COALESCE(c.name, '') as customer_name
    FROM bilty b
    LEFT JOIN orders o ON o.id = b.order_id
    LEFT JOIN invoices i ON i.id = b.invoice_id
    LEFT JOIN customers c ON c.id = COALESCE(o.customer_id, i.customer_id)
    WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (b.bilty_no LIKE ? OR b.transport_name LIKE ? OR b.to_city LIKE ?)`; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ` ORDER BY b.id DESC`;
  const bilties = db.prepare(sql).all(...params);
  res.render('bilty/index', { page: 'bilty', bilties, search });
});

router.get('/add', (req, res) => {
  const orders = db.prepare(`SELECT o.id, o.order_no, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC`).all();
  const invoices = db.prepare(`SELECT i.id, i.invoice_no, c.name as customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC`).all();
  const transports = db.prepare("SELECT id, name FROM transports WHERE status='active' ORDER BY name").all();
  res.render('bilty/form', { page: 'bilty', bilty: null, orders, invoices, transports, edit: false });
});

router.post('/add', validate(schemas.biltyCreate), (req, res) => {
  try {
    const { order_id, invoice_id, transport_id, transport_name, bilty_no, from_city, to_city, bilty_date, freight_charges, weight, packages_count, notes } = req.body;
    const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
    const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : 'plastic_markaz';
    let resolvedName = transport_name || null;
    if (transport_id) {
      const t = db.prepare('SELECT name FROM transports WHERE id = ?').get(parseInt(transport_id, 10));
      if (t) resolvedName = t.name;
    }
    const result = db.prepare(
      `INSERT INTO bilty (order_id, invoice_id, transport_id, transport_name, bilty_no, from_city, to_city, bilty_date, freight_charges, weight, packages_count, status, notes, account_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit', ?, ?)`
    ).run(order_id||null, invoice_id||null, transport_id||null, resolvedName, bilty_no, from_city, to_city, bilty_date, parseFloat(freight_charges)||0, weight||null, parseInt(packages_count)||0, notes||null, account_scope);
    addAuditLog('create', 'bilty', result.lastInsertRowid, `Created bilty ${bilty_no}`);
    res.redirect('/bilty');
  } catch (e) {
    require('../database').logError('bilty.create', e);
    res.redirect('/bilty?err=' + encodeURIComponent(e.message || 'server'));
  }
});

router.get('/edit/:id', (req, res) => {
  const bilty = db.prepare('SELECT * FROM bilty WHERE id = ?').get(req.params.id);
  if (!bilty) return res.redirect('/bilty');
  const orders = db.prepare(`SELECT o.id, o.order_no, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC`).all();
  const invoices = db.prepare(`SELECT i.id, i.invoice_no, c.name as customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC`).all();
  const transports = db.prepare("SELECT id, name FROM transports WHERE status='active' ORDER BY name").all();
  res.render('bilty/form', { page: 'bilty', bilty, orders, invoices, transports, edit: true });
});

router.post('/edit/:id', validate(schemas.biltyCreate), (req, res) => {
  try {
    const { order_id, invoice_id, transport_id, transport_name, bilty_no, from_city, to_city, bilty_date, freight_charges, weight, packages_count, status, notes } = req.body;
    const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
    const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : 'plastic_markaz';
    let resolvedName = transport_name || null;
    if (transport_id) {
      const t = db.prepare('SELECT name FROM transports WHERE id = ?').get(parseInt(transport_id, 10));
      if (t) resolvedName = t.name;
    }
    db.prepare(
      `UPDATE bilty SET order_id=?, invoice_id=?, transport_id=?, transport_name=?, bilty_no=?, from_city=?, to_city=?, bilty_date=?, freight_charges=?, weight=?, packages_count=?, status=?, notes=?, account_scope=? WHERE id=?`
    ).run(order_id||null, invoice_id||null, transport_id||null, resolvedName, bilty_no, from_city, to_city, bilty_date, parseFloat(freight_charges)||0, weight||null, parseInt(packages_count)||0, status||'in_transit', notes||null, account_scope, req.params.id);
    res.redirect('/bilty');
  } catch (e) {
    require('../database').logError('bilty.edit', e);
    res.redirect('/bilty?err=' + encodeURIComponent(e.message || 'server'));
  }
});

router.get('/view/:id', (req, res) => {
  const bilty = db.prepare(`
    SELECT b.*, o.order_no, i.invoice_no,
    COALESCE(c.name, c2.name, '') as customer_name
    FROM bilty b
    LEFT JOIN orders o ON o.id = b.order_id
    LEFT JOIN invoices i ON i.id = b.invoice_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN customers c2 ON c2.id = i.customer_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!bilty) return res.redirect('/bilty');
  res.render('bilty/view', { page: 'bilty', bilty });
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM bilty WHERE id = ?').run(req.params.id);
  res.redirect('/bilty');
});

module.exports = router;
