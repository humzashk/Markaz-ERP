const express = require('express');
const router = express.Router();
const { db, generateNumber, addLedgerEntry, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const search = req.query.search || '';
  let sql = `SELECT p.*, v.name as vendor_name FROM purchases p JOIN vendors v ON v.id = p.vendor_id WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (p.purchase_no LIKE ? OR v.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
  sql += ` ORDER BY p.id DESC`;
  const purchases = db.prepare(sql).all(...params);
  res.render('purchases/index', { page: 'purchases', purchases, search });
});

router.get('/add', (req, res) => {
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, packaging, rate FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('purchases/form', { page: 'purchases', purchase: null, items: [], vendors, products, edit: false });
});

router.post('/add', (req, res) => {
  const { vendor_id, purchase_date, discount, notes, product_id, packages, packaging, quantity, rate } = req.body;
  const purchaseNo = generateNumber('PUR', 'purchases');

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

  const disc = parseFloat(discount) || 0;
  const total = subtotal - disc;

  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO purchases (purchase_no, vendor_id, purchase_date, status, subtotal, discount, total, notes) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).run(purchaseNo, vendor_id, purchase_date, subtotal, disc, total, notes);

    const purId = result.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO purchase_items (purchase_id, product_id, packages, packaging, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(purId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount);
      // Add stock
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }

    // Ledger: credit vendor (we owe them)
    addLedgerEntry('vendor', vendor_id, purchase_date, `Purchase ${purchaseNo}`, 0, total, 'purchase', purId);
    addAuditLog('create', 'purchases', purId, `Created purchase ${purchaseNo}`);
  })();

  res.redirect('/purchases');
});

router.get('/edit/:id', (req, res) => {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!purchase) return res.redirect('/purchases');
  const items = db.prepare('SELECT pi.*, p.name as product_name FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ?').all(req.params.id);
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, packaging, rate FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('purchases/form', { page: 'purchases', purchase, items, vendors, products, edit: true });
});

router.post('/edit/:id', (req, res) => {
  const { vendor_id, purchase_date, discount, notes, status, product_id, packages, packaging, quantity, rate } = req.body;

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

  const disc = parseFloat(discount) || 0;
  const total = subtotal - disc;

  db.transaction(() => {
    db.prepare(
      `UPDATE purchases SET vendor_id=?, purchase_date=?, status=?, subtotal=?, discount=?, total=?, notes=? WHERE id=?`
    ).run(vendor_id, purchase_date, status||'pending', subtotal, disc, total, notes, req.params.id);

    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(req.params.id);
    const insertItem = db.prepare(
      `INSERT INTO purchase_items (purchase_id, product_id, packages, packaging, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(req.params.id, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount);
    }
  })();

  res.redirect('/purchases');
});

router.get('/view/:id', (req, res) => {
  const purchase = db.prepare(`
    SELECT p.*, v.name as vendor_name, v.phone as vendor_phone, v.address as vendor_address, v.city as vendor_city
    FROM purchases p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?
  `).get(req.params.id);
  if (!purchase) return res.redirect('/purchases');
  const items = db.prepare('SELECT pi.*, p.name as product_name FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ?').all(req.params.id);
  res.render('purchases/view', { page: 'purchases', purchase, items });
});

router.post('/delete/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(req.params.id);
    db.prepare('DELETE FROM purchases WHERE id = ?').run(req.params.id);
  })();
  res.redirect('/purchases');
});

module.exports = router;
