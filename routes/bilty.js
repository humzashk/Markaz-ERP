const express = require('express');
const router = express.Router();
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
  res.render('bilty/form', { page: 'bilty', bilty: null, orders, invoices, edit: false });
});

router.post('/add', (req, res) => {
  const { order_id, invoice_id, transport_name, bilty_no, from_city, to_city, bilty_date, freight_charges, weight, packages_count, notes } = req.body;
  const result = db.prepare(
    `INSERT INTO bilty (order_id, invoice_id, transport_name, bilty_no, from_city, to_city, bilty_date, freight_charges, weight, packages_count, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit', ?)`
  ).run(order_id||null, invoice_id||null, transport_name, bilty_no, from_city, to_city, bilty_date, parseFloat(freight_charges)||0, weight, parseInt(packages_count)||0, notes);
  addAuditLog('create', 'bilty', result.lastInsertRowid, `Created bilty ${bilty_no}`);
  res.redirect('/bilty');
});

router.get('/edit/:id', (req, res) => {
  const bilty = db.prepare('SELECT * FROM bilty WHERE id = ?').get(req.params.id);
  if (!bilty) return res.redirect('/bilty');
  const orders = db.prepare(`SELECT o.id, o.order_no, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC`).all();
  const invoices = db.prepare(`SELECT i.id, i.invoice_no, c.name as customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC`).all();
  res.render('bilty/form', { page: 'bilty', bilty, orders, invoices, edit: true });
});

router.post('/edit/:id', (req, res) => {
  const { order_id, invoice_id, transport_name, bilty_no, from_city, to_city, bilty_date, freight_charges, weight, packages_count, status, notes } = req.body;
  db.prepare(
    `UPDATE bilty SET order_id=?, invoice_id=?, transport_name=?, bilty_no=?, from_city=?, to_city=?, bilty_date=?, freight_charges=?, weight=?, packages_count=?, status=?, notes=? WHERE id=?`
  ).run(order_id||null, invoice_id||null, transport_name, bilty_no, from_city, to_city, bilty_date, parseFloat(freight_charges)||0, weight, parseInt(packages_count)||0, status||'in_transit', notes, req.params.id);
  res.redirect('/bilty');
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
