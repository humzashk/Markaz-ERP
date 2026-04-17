const express = require('express');
const router = express.Router();
const { db, generateNumber, addLedgerEntry, addAuditLog, getSettings } = require('../database');
const PDFDocument = require('pdfkit');

router.get('/', (req, res) => {
  const status = req.query.status || '';
  const search = req.query.search || '';
  let sql = `SELECT i.*, c.name as customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND i.status = ?`; params.push(status); }
  if (search) { sql += ` AND (i.invoice_no LIKE ? OR c.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
  sql += ` ORDER BY i.id DESC`;
  const invoices = db.prepare(sql).all(...params);
  res.render('invoices/index', { page: 'invoices', invoices, status, search });
});

router.get('/add', (req, res) => {
  const customers = db.prepare('SELECT id, name, commission FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, packaging, rate, stock FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('invoices/form', { page: 'invoices', invoice: null, items: [], customers, products, edit: false });
});

router.post('/add', (req, res) => {
  const { customer_id, invoice_date, due_date, commission_pct, notes, product_id, packages, packaging, quantity, rate } = req.body;
  const invoiceNo = generateNumber('INV', 'invoices');

  const productIds = Array.isArray(product_id) ? product_id : [product_id];
  const packagesArr = Array.isArray(packages) ? packages : [packages];
  const packagingArr = Array.isArray(packaging) ? packaging : [packaging];
  const quantityArr = Array.isArray(quantity) ? quantity : [quantity];
  const rateArr = Array.isArray(rate) ? rate : [rate];

  let subtotal = 0;
  const itemsData = [];
  for (let i = 0; i < productIds.length; i++) {
    if (!productIds[i]) continue;
    const qty = parseInt(quantityArr[i]) || 0;
    const r = parseFloat(rateArr[i]) || 0;
    const amt = qty * r;
    subtotal += amt;
    itemsData.push({ product_id: productIds[i], packages: parseInt(packagesArr[i])||0, packaging: parseInt(packagingArr[i])||1, quantity: qty, rate: r, amount: amt });
  }

  const commPct = parseFloat(commission_pct) || 0;
  const total = subtotal;
  const commission = total * commPct / 100;

  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO invoices (invoice_no, customer_id, invoice_date, due_date, subtotal, discount, total, commission_pct, commission_amount, status, notes) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'unpaid', ?)`
    ).run(invoiceNo, customer_id, invoice_date, due_date||null, subtotal, total, commPct, commission, notes);

    const invId = result.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO invoice_items (invoice_id, product_id, packages, packaging, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(invId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount);
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.product_id);
    }

    addLedgerEntry('customer', customer_id, invoice_date, `Invoice ${invoiceNo}`, total, 0, 'invoice', invId);
    addAuditLog('create', 'invoices', invId, `Created invoice ${invoiceNo}`);
  })();

  res.redirect('/invoices');
});

router.get('/edit/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.redirect('/invoices');
  const items = db.prepare('SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON p.id = ii.product_id WHERE ii.invoice_id = ?').all(req.params.id);
  const customers = db.prepare('SELECT id, name, commission FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, packaging, rate, stock FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('invoices/form', { page: 'invoices', invoice, items, customers, products, edit: true });
});

router.post('/edit/:id', (req, res) => {
  const { customer_id, invoice_date, due_date, commission_pct, notes, status, product_id, packages, packaging, quantity, rate } = req.body;

  const productIds = Array.isArray(product_id) ? product_id : [product_id];
  const packagesArr = Array.isArray(packages) ? packages : [packages];
  const packagingArr = Array.isArray(packaging) ? packaging : [packaging];
  const quantityArr = Array.isArray(quantity) ? quantity : [quantity];
  const rateArr = Array.isArray(rate) ? rate : [rate];

  let subtotal = 0;
  const itemsData = [];
  for (let i = 0; i < productIds.length; i++) {
    if (!productIds[i]) continue;
    const qty = parseInt(quantityArr[i]) || 0;
    const r = parseFloat(rateArr[i]) || 0;
    const amt = qty * r;
    subtotal += amt;
    itemsData.push({ product_id: productIds[i], packages: parseInt(packagesArr[i])||0, packaging: parseInt(packagingArr[i])||1, quantity: qty, rate: r, amount: amt });
  }

  const commPct = parseFloat(commission_pct) || 0;
  const total = subtotal;
  const commission = total * commPct / 100;

  db.transaction(() => {
    db.prepare(
      `UPDATE invoices SET customer_id=?, invoice_date=?, due_date=?, subtotal=?, discount=0, total=?, commission_pct=?, commission_amount=?, status=?, notes=? WHERE id=?`
    ).run(customer_id, invoice_date, due_date||null, subtotal, total, commPct, commission, status||'unpaid', notes, req.params.id);

    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(req.params.id);
    const insertItem = db.prepare(
      `INSERT INTO invoice_items (invoice_id, product_id, packages, packaging, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(req.params.id, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount);
    }
  })();

  addAuditLog('update', 'invoices', req.params.id, 'Updated invoice');
  res.redirect('/invoices');
});

router.get('/view/:id', (req, res) => {
  const invoice = db.prepare(`
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city, c.commission as customer_commission
    FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?
  `).get(req.params.id);
  if (!invoice) return res.redirect('/invoices');
  const items = db.prepare('SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON p.id = ii.product_id WHERE ii.invoice_id = ?').all(req.params.id);
  const bilty = db.prepare('SELECT * FROM bilty WHERE invoice_id = ?').get(req.params.id);
  res.render('invoices/view', { page: 'invoices', invoice, items, bilty });
});

// Print-friendly invoice
router.get('/print/:id', (req, res) => {
  const invoice = db.prepare(`
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city, c.category as customer_category, c.commission as customer_commission
    FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?
  `).get(req.params.id);
  if (!invoice) return res.redirect('/invoices');
  const items = db.prepare('SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON p.id = ii.product_id WHERE ii.invoice_id = ?').all(req.params.id);
  const bilty = db.prepare('SELECT * FROM bilty WHERE invoice_id = ?').get(req.params.id);
  const settings = getSettings();
  res.render('invoices/print', { page: 'invoices', invoice, items, bilty, settings, layout: false });
});

// PDF Invoice
router.get('/pdf/:id', (req, res) => {
  const invoice = db.prepare(`
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city
    FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?
  `).get(req.params.id);
  if (!invoice) return res.status(404).send('Invoice not found');
  const items = db.prepare('SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON p.id = ii.product_id WHERE ii.invoice_id = ?').all(req.params.id);
  const bilty = db.prepare('SELECT * FROM bilty WHERE invoice_id = ?').get(req.params.id);
  const settings = getSettings();

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=Invoice-${invoice.invoice_no}.pdf`);
  doc.pipe(res);

  // Header
  doc.fontSize(22).font('Helvetica-Bold').text(settings.business_name || 'PLASTIC MARKAZ', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(settings.business_tagline || 'Plastic Products & Trading', { align: 'center' });
  if (settings.business_phone || settings.business_city) {
    doc.fontSize(9).text([settings.business_address, settings.business_city, settings.business_phone].filter(Boolean).join('  |  '), { align: 'center' });
  }
  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#333');
  doc.moveDown(0.5);

  // Invoice details
  doc.fontSize(16).font('Helvetica-Bold').text('INVOICE', { align: 'center' });
  doc.moveDown(0.5);

  doc.fontSize(10).font('Helvetica');
  const startY = doc.y;
  doc.text(`Invoice No: ${invoice.invoice_no}`, 40, startY);
  doc.text(`Date: ${invoice.invoice_date}`, 40);
  if (invoice.due_date) doc.text(`Due Date: ${invoice.due_date}`, 40);
  doc.text(`Status: ${invoice.status.toUpperCase()}`, 40);

  doc.text(`Customer: ${invoice.customer_name}`, 300, startY);
  if (invoice.customer_phone) doc.text(`Phone: ${invoice.customer_phone}`, 300);
  if (invoice.customer_address) doc.text(`Address: ${invoice.customer_address}`, 300);
  if (invoice.customer_city) doc.text(`City: ${invoice.customer_city}`, 300);

  doc.moveDown(1.5);
  doc.y = Math.max(doc.y, startY + 70);

  // Table header
  const tableTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.rect(40, tableTop - 3, 515, 20).fill('#2c3e50');
  doc.fillColor('#fff');
  doc.text('#', 45, tableTop, { width: 25 });
  doc.text('Product', 70, tableTop, { width: 150 });
  doc.text('Pkg(Ctn)', 220, tableTop, { width: 50, align: 'right' });
  doc.text('Pcs/Ctn', 270, tableTop, { width: 50, align: 'right' });
  doc.text('Qty(Pcs)', 320, tableTop, { width: 55, align: 'right' });
  doc.text('Rate', 380, tableTop, { width: 60, align: 'right' });
  doc.text('Amount', 450, tableTop, { width: 100, align: 'right' });

  doc.fillColor('#000').font('Helvetica').fontSize(9);
  let y = tableTop + 22;
  items.forEach((item, idx) => {
    if (idx % 2 === 0) doc.rect(40, y - 3, 515, 18).fill('#f8f9fa').fillColor('#000');
    doc.text(idx + 1, 45, y, { width: 25 });
    doc.text(item.product_name, 70, y, { width: 150 });
    doc.text(item.packages.toString(), 220, y, { width: 50, align: 'right' });
    doc.text(item.packaging.toString(), 270, y, { width: 50, align: 'right' });
    doc.text(item.quantity.toString(), 320, y, { width: 55, align: 'right' });
    doc.text(item.rate.toFixed(2), 380, y, { width: 60, align: 'right' });
    doc.text(item.amount.toFixed(2), 450, y, { width: 100, align: 'right' });
    y += 18;
  });

  // Totals
  y += 5;
  doc.moveTo(40, y).lineTo(555, y).stroke('#333');
  y += 10;
  doc.font('Helvetica').fontSize(10);
  doc.text('Subtotal:', 380, y); doc.text(`Rs. ${invoice.subtotal.toFixed(2)}`, 450, y, { width: 100, align: 'right' });
  y += 18;
  if (invoice.discount > 0) {
    doc.text('Discount:', 380, y); doc.text(`Rs. ${invoice.discount.toFixed(2)}`, 450, y, { width: 100, align: 'right' });
    y += 18;
  }
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text('TOTAL:', 380, y); doc.text(`Rs. ${invoice.total.toFixed(2)}`, 450, y, { width: 100, align: 'right' });

  // Bilty info
  if (bilty) {
    y += 30;
    doc.font('Helvetica-Bold').fontSize(11).text('Transport Details', 40, y);
    y += 15;
    doc.font('Helvetica').fontSize(9);
    doc.text(`Transport: ${bilty.transport_name}  |  Bilty No: ${bilty.bilty_no || '-'}  |  From: ${bilty.from_city}  To: ${bilty.to_city}  |  Freight: Rs. ${bilty.freight_charges.toFixed(2)}`, 40, y);
  }

  // Terms and footer
  if (settings.invoice_terms) {
    y += 25;
    doc.font('Helvetica').fontSize(8).fillColor('#888').text(`Terms: ${settings.invoice_terms}`, 40, y);
  }
  doc.fontSize(8).font('Helvetica').fillColor('#888').text(settings.invoice_footer || 'Thank you for your business!', 40, 750, { align: 'center' });
  doc.text(`${settings.business_name || 'PLASTIC MARKAZ'} — All rights reserved`, 40, 762, { align: 'center' });

  doc.end();
});

router.post('/delete/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(req.params.id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  })();
  addAuditLog('delete', 'invoices', req.params.id, 'Deleted invoice');
  res.redirect('/invoices');
});

router.post('/bulk', (req, res) => {
  const { action, ids } = req.body;
  if (!ids || !action) return res.redirect('/invoices');
  const idList = ids.split(',').map(Number).filter(Boolean);
  if (!idList.length) return res.redirect('/invoices');

  if (action === 'mark_paid') {
    const stmt = db.prepare('UPDATE invoices SET status = ? WHERE id = ?');
    idList.forEach(id => stmt.run('paid', id));
  } else if (action === 'mark_unpaid') {
    const stmt = db.prepare('UPDATE invoices SET status = ? WHERE id = ?');
    idList.forEach(id => stmt.run('unpaid', id));
  } else if (action === 'delete') {
    db.transaction(() => {
      idList.forEach(id => {
        db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
        db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
      });
    })();
  }
  res.redirect('/invoices');
});

module.exports = router;
