const express = require('express');
const router = express.Router();
const { db } = require('../database');
const PDFDocument = require('pdfkit');

router.get('/', (req, res) => {
  const customers = db.prepare('SELECT id, name, balance FROM customers WHERE status = ? ORDER BY name').all('active');
  const vendors = db.prepare('SELECT id, name, balance FROM vendors WHERE status = ? ORDER BY name').all('active');
  res.render('ledger/index', { page: 'ledger', customers, vendors });
});

router.get('/customer/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/ledger');
  const from = req.query.from || '';
  const to = req.query.to || '';
  let sql = `SELECT * FROM ledger WHERE entity_type = 'customer' AND entity_id = ?`;
  const params = [req.params.id];
  if (from) { sql += ` AND txn_date >= ?`; params.push(from); }
  if (to) { sql += ` AND txn_date <= ?`; params.push(to); }
  sql += ` ORDER BY id ASC`;
  const entries = db.prepare(sql).all(...params);
  res.render('ledger/detail', { page: 'ledger', entity: customer, entityType: 'customer', entries, from, to });
});

router.get('/vendor/:id', (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) return res.redirect('/ledger');
  const from = req.query.from || '';
  const to = req.query.to || '';
  let sql = `SELECT * FROM ledger WHERE entity_type = 'vendor' AND entity_id = ?`;
  const params = [req.params.id];
  if (from) { sql += ` AND txn_date >= ?`; params.push(from); }
  if (to) { sql += ` AND txn_date <= ?`; params.push(to); }
  sql += ` ORDER BY id ASC`;
  const entries = db.prepare(sql).all(...params);
  res.render('ledger/detail', { page: 'ledger', entity: vendor, entityType: 'vendor', entries, from, to });
});

// Print ledger
router.get('/print/:type/:id', (req, res) => {
  const { type, id } = req.params;
  const from = req.query.from || '';
  const to = req.query.to || '';
  const entity = type === 'customer'
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!entity) return res.redirect('/ledger');

  let sql = `SELECT * FROM ledger WHERE entity_type = ? AND entity_id = ?`;
  const params = [type, id];
  if (from) { sql += ` AND txn_date >= ?`; params.push(from); }
  if (to) { sql += ` AND txn_date <= ?`; params.push(to); }
  sql += ` ORDER BY id ASC`;
  const entries = db.prepare(sql).all(...params);
  res.render('ledger/print', { page: 'ledger', entity, entityType: type, entries, from, to, layout: false });
});

// PDF ledger
router.get('/pdf/:type/:id', (req, res) => {
  const { type, id } = req.params;
  const from = req.query.from || '';
  const to = req.query.to || '';
  const entity = type === 'customer'
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!entity) return res.status(404).send('Not found');

  let sql = `SELECT * FROM ledger WHERE entity_type = ? AND entity_id = ?`;
  const params = [type, id];
  if (from) { sql += ` AND txn_date >= ?`; params.push(from); }
  if (to) { sql += ` AND txn_date <= ?`; params.push(to); }
  sql += ` ORDER BY id ASC`;
  const entries = db.prepare(sql).all(...params);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=Ledger-${entity.name}.pdf`);
  doc.pipe(res);

  doc.fontSize(20).font('Helvetica-Bold').text('PLASTIC MARKAZ', { align: 'center' });
  doc.fontSize(14).text(`${type === 'customer' ? 'Customer' : 'Vendor'} Ledger`, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(11).font('Helvetica').text(`Name: ${entity.name}`);
  if (entity.phone) doc.text(`Phone: ${entity.phone}`);
  if (from || to) doc.text(`Period: ${from || 'Start'} to ${to || 'Present'}`);
  doc.moveDown(0.5);

  // Table
  const tableTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.rect(40, tableTop - 3, 515, 18).fill('#2c3e50');
  doc.fillColor('#fff');
  doc.text('Date', 45, tableTop, { width: 70 });
  doc.text('Description', 120, tableTop, { width: 180 });
  doc.text('Debit', 305, tableTop, { width: 70, align: 'right' });
  doc.text('Credit', 380, tableTop, { width: 70, align: 'right' });
  doc.text('Balance', 455, tableTop, { width: 95, align: 'right' });

  doc.fillColor('#000').font('Helvetica').fontSize(9);
  let y = tableTop + 20;
  entries.forEach((e, idx) => {
    if (y > 730) { doc.addPage(); y = 50; }
    if (idx % 2 === 0) doc.rect(40, y - 3, 515, 16).fill('#f8f9fa').fillColor('#000');
    doc.text(e.txn_date, 45, y, { width: 70 });
    doc.text(e.description || '', 120, y, { width: 180 });
    doc.text(e.debit > 0 ? e.debit.toFixed(2) : '-', 305, y, { width: 70, align: 'right' });
    doc.text(e.credit > 0 ? e.credit.toFixed(2) : '-', 380, y, { width: 70, align: 'right' });
    doc.text(e.balance.toFixed(2), 455, y, { width: 95, align: 'right' });
    y += 16;
  });

  y += 10;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text(`Current Balance: Rs. ${entity.balance.toFixed(2)}`, 40, y);
  if (entity.balance > 0) {
    doc.fillColor('#e74c3c').text(type === 'customer' ? '(Amount Due from Customer)' : '(Amount Payable to Vendor)', 40);
  }

  doc.end();
});

module.exports = router;
