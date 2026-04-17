const express = require('express');
const router = express.Router();
const { db, addLedgerEntry, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const status = req.query.status || '';
  let sql = `SELECT br.*, p.name as product_name,
    COALESCE(c.name, '') as customer_name,
    COALESCE(v.name, '') as vendor_name,
    COALESCE(o.order_no, '') as order_no,
    COALESCE(i.invoice_no, '') as invoice_no
    FROM breakage br
    JOIN products p ON p.id = br.product_id
    LEFT JOIN customers c ON c.id = br.customer_id
    LEFT JOIN vendors v ON v.id = br.vendor_id
    LEFT JOIN orders o ON o.id = br.order_id
    LEFT JOIN invoices i ON i.id = br.invoice_id
    WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND br.claim_status = ?`; params.push(status); }
  sql += ` ORDER BY br.id DESC`;
  const breakages = db.prepare(sql).all(...params);
  res.render('breakage/index', { page: 'breakage', breakages, status });
});

router.get('/add', (req, res) => {
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, rate FROM products WHERE status = ? ORDER BY name').all('active');
  const orders = db.prepare(`SELECT o.id, o.order_no, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 50`).all();
  const invoices = db.prepare(`SELECT i.id, i.invoice_no, c.name as customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC LIMIT 50`).all();
  res.render('breakage/form', { page: 'breakage', breakage: null, customers, vendors, products, orders, invoices, edit: false });
});

router.post('/add', (req, res) => {
  const { order_id, invoice_id, customer_id, vendor_id, product_id, quantity, reason, claim_type, breakage_date, notes } = req.body;

  const product = db.prepare('SELECT rate FROM products WHERE id = ?').get(product_id);
  const adjAmount = (parseInt(quantity) || 0) * (product ? product.rate : 0);

  const result = db.prepare(
    `INSERT INTO breakage (order_id, invoice_id, customer_id, vendor_id, product_id, quantity, reason, claim_status, claim_type, adjustment_amount, breakage_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(order_id||null, invoice_id||null, customer_id||null, vendor_id||null, product_id, parseInt(quantity)||0, reason, claim_type||'customer', adjAmount, breakage_date, notes);

  // Adjust inventory (reduce stock for damaged goods)
  db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(parseInt(quantity)||0, product_id);

  addAuditLog('create', 'breakage', result.lastInsertRowid, `Breakage recorded: ${quantity} pcs`);
  res.redirect('/breakage');
});

router.get('/edit/:id', (req, res) => {
  const breakage = db.prepare('SELECT * FROM breakage WHERE id = ?').get(req.params.id);
  if (!breakage) return res.redirect('/breakage');
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, rate FROM products WHERE status = ? ORDER BY name').all('active');
  const orders = db.prepare(`SELECT o.id, o.order_no, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 50`).all();
  const invoices = db.prepare(`SELECT i.id, i.invoice_no, c.name as customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC LIMIT 50`).all();
  res.render('breakage/form', { page: 'breakage', breakage, customers, vendors, products, orders, invoices, edit: true });
});

router.post('/edit/:id', (req, res) => {
  const { order_id, invoice_id, customer_id, vendor_id, product_id, quantity, reason, claim_status, claim_type, breakage_date, notes } = req.body;

  const product = db.prepare('SELECT rate FROM products WHERE id = ?').get(product_id);
  const adjAmount = (parseInt(quantity) || 0) * (product ? product.rate : 0);

  db.prepare(
    `UPDATE breakage SET order_id=?, invoice_id=?, customer_id=?, vendor_id=?, product_id=?, quantity=?, reason=?, claim_status=?, claim_type=?, adjustment_amount=?, breakage_date=?, notes=? WHERE id=?`
  ).run(order_id||null, invoice_id||null, customer_id||null, vendor_id||null, product_id, parseInt(quantity)||0, reason, claim_status||'pending', claim_type||'customer', adjAmount, breakage_date, notes, req.params.id);

  res.redirect('/breakage');
});

// Resolve claim - adjusts ledger
router.post('/resolve/:id', (req, res) => {
  const breakage = db.prepare('SELECT * FROM breakage WHERE id = ?').get(req.params.id);
  if (!breakage) return res.redirect('/breakage');

  const today = new Date().toISOString().split('T')[0];

  db.transaction(() => {
    db.prepare('UPDATE breakage SET claim_status = ?, resolved_date = ? WHERE id = ?').run('resolved', today, req.params.id);

    // Adjust ledger - credit customer (reduce their dues) or debit vendor
    if (breakage.customer_id) {
      addLedgerEntry('customer', breakage.customer_id, today, `Breakage claim resolved - Credit Note`, 0, breakage.adjustment_amount, 'breakage', breakage.id);
    }
    if (breakage.vendor_id) {
      addLedgerEntry('vendor', breakage.vendor_id, today, `Breakage claim - Debit Note`, breakage.adjustment_amount, 0, 'breakage', breakage.id);
    }
  })();

  addAuditLog('update', 'breakage', req.params.id, `Resolved breakage claim Rs.${breakage.adjustment_amount}`);
  res.redirect('/breakage');
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM breakage WHERE id = ?').run(req.params.id);
  res.redirect('/breakage');
});

module.exports = router;
