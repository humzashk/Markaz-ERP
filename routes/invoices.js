const express = require('express');
const router = express.Router();
const { db, generateNumber, addLedgerEntry, addAuditLog, getSettings,
        applyStockMovement, reverseStockForRef, removeLedgerForRef,
        recomputeBalance, getProductCost, toNum, toInt, logError } = require('../database');
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
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, qty_per_pack, selling_price as rate, stock, default_commission_rate FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');

  // Pre-load items if redirected from "Generate from Orders" flow
  let items = [];
  let linkedOrderIds = [];
  let presetCustomerId = null;
  if (req.query.from_orders) {
    const ids = String(req.query.from_orders).split(',').map(s => parseInt(s,10)).filter(Boolean);
    if (ids.length) {
      const placeholders = ids.map(()=>'?').join(',');
      const orders = db.prepare(`SELECT id, customer_id FROM orders WHERE id IN (${placeholders})`).all(...ids);
      if (orders.length) {
        presetCustomerId = orders[0].customer_id;
        linkedOrderIds = orders.map(o => o.id);
        items = db.prepare(`
          SELECT oi.product_id, oi.quantity, oi.rate, oi.amount,
                 COALESCE(oi.packages,0) as packages,
                 COALESCE(oi.packaging,1) as packaging,
                 COALESCE(oi.commission_pct,0) as commission_pct,
                 COALESCE(oi.discount_per_pack,0) as discount_per_pack,
                 p.name as product_name
          FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id IN (${placeholders})
        `).all(...ids);
      }
    }
  }

  const invoice = presetCustomerId ? { customer_id: presetCustomerId } : null;
  res.render('invoices/form', { page: 'invoices', invoice, items, customers, products, warehouses, linkedOrderIds, edit: false });
});

// Step 1: pick customer → list pending orders
router.get('/from-orders', (req, res) => {
  const customers = db.prepare(`
    SELECT DISTINCT c.id, c.name
    FROM customers c JOIN orders o ON o.customer_id = c.id
    WHERE o.status IN ('pending','confirmed') AND c.status = 'active'
    ORDER BY c.name
  `).all();
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id,10) : null;
  let orders = [];
  if (customerId) {
    orders = db.prepare(`
      SELECT o.id, o.order_no, o.order_date, o.total,
             (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
      FROM orders o
      WHERE o.customer_id = ? AND o.status IN ('pending','confirmed')
      ORDER BY o.order_date DESC
    `).all(customerId);
  }
  res.render('invoices/from-orders', { page: 'invoices', customers, orders, customerId });
});

router.post('/add', (req, res) => {
  try {
    const { customer_id, invoice_date, due_date, warehouse_id, bilty_no, transporter_name, notes,
            product_id, packages, packaging, quantity, rate, commission_pct, discount_per_pack,
            transport_charges, account_scope, order_ids } = req.body;

    const cid = toInt(customer_id);
    if (!cid || !invoice_date) return res.redirect('/invoices?err=missing');
    const wid = warehouse_id ? toInt(warehouse_id) : null;
    const transportCharges = toNum(transport_charges, 0);
    const invoiceNo = generateNumber('INV', 'invoices');

    const productIds  = Array.isArray(product_id)        ? product_id        : [product_id];
    const packagesArr = Array.isArray(packages)          ? packages          : [packages];
    const packagingArr= Array.isArray(packaging)         ? packaging         : [packaging];
    const quantityArr = Array.isArray(quantity)          ? quantity          : [quantity];
    const rateArr     = Array.isArray(rate)              ? rate              : [rate];
    const commArr     = Array.isArray(commission_pct)    ? commission_pct    : [commission_pct];
    const discArr     = Array.isArray(discount_per_pack) ? discount_per_pack : [discount_per_pack];

    let subtotal = 0, totalCommission = 0;
    const itemsData = [];
    for (let i = 0; i < productIds.length; i++) {
      const pid = toInt(productIds[i]);
      if (!pid) continue;
      const qty = toInt(quantityArr[i]);
      const r   = toNum(rateArr[i]);
      const amt = qty * r;
      const commPct  = toNum(commArr[i]);
      const commAmt  = amt * commPct / 100;
      const discPack = toNum(discArr[i]);
      if (qty <= 0 || r < 0) continue; // skip invalid lines silently — input validated
      const costAtSale = getProductCost(pid); // freeze historic cost
      subtotal += amt;
      totalCommission += commAmt;
      itemsData.push({
        product_id: pid,
        packages: toInt(packagesArr[i], 0),
        packaging: toInt(packagingArr[i], 1) || 1,
        quantity: qty, rate: r, amount: amt,
        commission_pct: commPct, commission_amount: commAmt,
        discount_per_pack: discPack,
        cost_at_sale: costAtSale
      });
    }
    if (!itemsData.length) return res.redirect('/invoices/add?err=no_items');

    const total = subtotal + transportCharges;

    db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO invoices (invoice_no, customer_id, invoice_date, due_date, warehouse_id, bilty_no, transporter_name, subtotal, discount, transport_charges, total, commission_pct, commission_amount, status, notes, account_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, 'unpaid', ?, ?)`
      ).run(invoiceNo, cid, invoice_date, due_date||null, wid, bilty_no||null, transporter_name||null,
            subtotal, transportCharges, total, totalCommission, notes||null, account_scope || 'plastic_markaz');

      const invId = result.lastInsertRowid;

      if (order_ids) {
        const oids = (Array.isArray(order_ids) ? order_ids : [order_ids]).map(toInt).filter(Boolean);
        if (oids.length) {
          const upd = db.prepare("UPDATE orders SET status='invoiced' WHERE id=? AND status IN ('pending','confirmed')");
          for (const oid of oids) upd.run(oid);
          db.prepare('UPDATE invoices SET order_id=? WHERE id=?').run(oids[0], invId);
        }
      }

      const insertItem = db.prepare(
        `INSERT INTO invoice_items (invoice_id, product_id, packages, packaging, quantity, rate, amount, commission_pct, commission_amount, discount_per_pack, cost_at_sale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of itemsData) {
        insertItem.run(invId, item.product_id, item.packages, item.packaging, item.quantity, item.rate,
                       item.amount, item.commission_pct, item.commission_amount, item.discount_per_pack, item.cost_at_sale);
        // Stock OUT via ledger
        applyStockMovement(item.product_id, wid, -item.quantity, 'invoice', invId, 'sale', `Invoice ${invoiceNo}`);
      }

      addLedgerEntry('customer', cid, invoice_date, `Invoice ${invoiceNo}`, total, 0, 'invoice', invId);
      addAuditLog('create', 'invoices', invId, `Created invoice ${invoiceNo} total ${total}`);
    })();

    res.redirect('/invoices');
  } catch (e) {
    logError('invoices.create', e, { body: req.body });
    res.redirect('/invoices?err=server');
  }
});

router.get('/edit/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.redirect('/invoices');
  const items = db.prepare('SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON p.id = ii.product_id WHERE ii.invoice_id = ?').all(req.params.id);
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, qty_per_pack, selling_price as rate, stock, default_commission_rate FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  res.render('invoices/form', { page: 'invoices', invoice, items, customers, products, warehouses, pendingOrders: [], edit: true });
});

router.post('/edit/:id', (req, res) => {
  try {
    const invId = toInt(req.params.id);
    const existing = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invId);
    if (!existing) return res.redirect('/invoices?err=notfound');

    const { customer_id, invoice_date, due_date, warehouse_id, bilty_no, transporter_name, notes, status,
            product_id, packages, packaging, quantity, rate, commission_pct, discount_per_pack,
            transport_charges, account_scope } = req.body;

    const cid = toInt(customer_id) || existing.customer_id;
    const wid = warehouse_id ? toInt(warehouse_id) : null;
    const transportCharges = toNum(transport_charges, 0);

    const productIds  = Array.isArray(product_id)        ? product_id        : [product_id];
    const packagesArr = Array.isArray(packages)          ? packages          : [packages];
    const packagingArr= Array.isArray(packaging)         ? packaging         : [packaging];
    const quantityArr = Array.isArray(quantity)          ? quantity          : [quantity];
    const rateArr     = Array.isArray(rate)              ? rate              : [rate];
    const commArr     = Array.isArray(commission_pct)    ? commission_pct    : [commission_pct];
    const discArr     = Array.isArray(discount_per_pack) ? discount_per_pack : [discount_per_pack];

    // Snapshot existing items to preserve cost_at_sale (NEVER recompute on edit — preserves historic profit)
    const oldItems = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invId);
    const oldCostByProduct = {};
    oldItems.forEach(oi => { if (oi.product_id && oi.cost_at_sale != null) oldCostByProduct[oi.product_id] = oi.cost_at_sale; });

    let subtotal = 0, totalCommission = 0;
    const itemsData = [];
    for (let i = 0; i < productIds.length; i++) {
      const pid = toInt(productIds[i]);
      if (!pid) continue;
      const qty = toInt(quantityArr[i]);
      const r   = toNum(rateArr[i]);
      const amt = qty * r;
      const commPct  = toNum(commArr[i]);
      const commAmt  = amt * commPct / 100;
      const discPack = toNum(discArr[i]);
      if (qty <= 0 || r < 0) continue;
      // Preserve original cost_at_sale if this product was already on the invoice
      const costAtSale = (oldCostByProduct[pid] != null) ? oldCostByProduct[pid] : getProductCost(pid);
      subtotal += amt;
      totalCommission += commAmt;
      itemsData.push({
        product_id: pid,
        packages: toInt(packagesArr[i], 0),
        packaging: toInt(packagingArr[i], 1) || 1,
        quantity: qty, rate: r, amount: amt,
        commission_pct: commPct, commission_amount: commAmt,
        discount_per_pack: discPack,
        cost_at_sale: costAtSale
      });
    }
    if (!itemsData.length) return res.redirect('/invoices/edit/' + invId + '?err=no_items');

    const total = subtotal + transportCharges;

    db.transaction(() => {
      // 1) Reverse previous stock movements for this invoice
      reverseStockForRef('invoice', invId);

      // 2) Reverse previous ledger entry for this invoice and recompute customer balance
      removeLedgerForRef('customer', existing.customer_id, 'invoice', invId);
      recomputeBalance('customer', existing.customer_id);

      // 3) Update invoice header
      db.prepare(
        `UPDATE invoices SET customer_id=?, invoice_date=?, due_date=?, warehouse_id=?, bilty_no=?, transporter_name=?,
         subtotal=?, discount=0, transport_charges=?, total=?, commission_pct=0, commission_amount=?,
         status=?, notes=?, account_scope=? WHERE id=?`
      ).run(cid, invoice_date, due_date||null, wid, bilty_no||null, transporter_name||null,
            subtotal, transportCharges, total, totalCommission,
            status || existing.status || 'unpaid', notes||null,
            account_scope || existing.account_scope || 'plastic_markaz', invId);

      // 4) Replace items
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invId);
      const insertItem = db.prepare(
        `INSERT INTO invoice_items (invoice_id, product_id, packages, packaging, quantity, rate, amount, commission_pct, commission_amount, discount_per_pack, cost_at_sale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of itemsData) {
        insertItem.run(invId, item.product_id, item.packages, item.packaging, item.quantity, item.rate,
                       item.amount, item.commission_pct, item.commission_amount, item.discount_per_pack, item.cost_at_sale);
        // 5) Re-apply stock OUT via ledger
        applyStockMovement(item.product_id, wid, -item.quantity, 'invoice', invId, 'sale-edit', `Invoice ${existing.invoice_no} (edited)`);
      }

      // 6) Re-post customer ledger entry
      addLedgerEntry('customer', cid, invoice_date, `Invoice ${existing.invoice_no}`, total, 0, 'invoice', invId);
      // If customer changed, also recompute previous customer (already cleared above)
      if (cid !== existing.customer_id) recomputeBalance('customer', existing.customer_id);

      addAuditLog('update', 'invoices', invId, `Updated invoice ${existing.invoice_no} new total ${total}`);
    })();

    res.redirect('/invoices');
  } catch (e) {
    logError('invoices.edit', e, { id: req.params.id, body: req.body });
    res.redirect('/invoices?err=server');
  }
});

// DELETE invoice — atomic: reverse stock, reverse ledger, remove rows
router.post('/delete/:id', (req, res) => {
  try {
    const invId = toInt(req.params.id);
    const existing = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invId);
    if (!existing) return res.redirect('/invoices?err=notfound');
    db.transaction(() => {
      reverseStockForRef('invoice', invId);
      removeLedgerForRef('customer', existing.customer_id, 'invoice', invId);
      recomputeBalance('customer', existing.customer_id);
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invId);
      db.prepare('DELETE FROM invoices WHERE id = ?').run(invId);
      addAuditLog('delete', 'invoices', invId, `Deleted invoice ${existing.invoice_no}`);
    })();
    res.redirect('/invoices');
  } catch (e) {
    logError('invoices.delete', e, { id: req.params.id });
    res.redirect('/invoices?err=server');
  }
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
