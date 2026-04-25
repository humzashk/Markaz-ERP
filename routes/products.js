const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const search = req.query.search || '';
  const error = req.query.error || '';
  let products;
  if (search) {
    products = db.prepare(`SELECT p.*, v.name as vendor_name FROM products p LEFT JOIN vendors v ON p.vendor_id = v.id WHERE p.name LIKE ? OR p.category LIKE ? ORDER BY p.name`).all(`%${search}%`, `%${search}%`);
  } else {
    products = db.prepare(`SELECT p.*, v.name as vendor_name FROM products p LEFT JOIN vendors v ON p.vendor_id = v.id ORDER BY p.name`).all();
  }
  const vendors = db.prepare(`SELECT id, name FROM vendors WHERE status='active' ORDER BY name`).all();
  const allCats = db.prepare('SELECT name FROM product_categories ORDER BY sort_order, name').all().map(r => r.name);
  res.render('products/index', { page: 'products', products, search, vendors, allCats, error });
});

router.get('/add', (req, res) => {
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const allCats = db.prepare('SELECT name FROM product_categories ORDER BY sort_order, name').all().map(r => r.name);
  res.render('products/form', { page: 'products', product: null, edit: false, vendors, allCats });
});

router.post('/add', validate(schemas.productCreate), (req, res) => {
  const { name, category, qty_per_pack, stock, rate, min_stock, vendor_id } = req.body;
  const result = db.prepare(
    `INSERT INTO products (name, category, qty_per_pack, stock, rate, min_stock, vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(name, category, parseInt(qty_per_pack)||1, parseInt(stock)||0, parseFloat(rate)||0, parseInt(min_stock)||10, vendor_id || null);
  addAuditLog('create', 'products', result.lastInsertRowid, `Created product: ${name}`);
  res.redirect('/products');
});

router.get('/edit/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/products');
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const allCats = db.prepare('SELECT name FROM product_categories ORDER BY sort_order, name').all().map(r => r.name);
  res.render('products/form', { page: 'products', product, edit: true, vendors, allCats });
});

router.post('/edit/:id', validate(schemas.productCreate), (req, res) => {
  const { name, category, qty_per_pack, stock, rate, min_stock, status, vendor_id } = req.body;
  const newRate = parseFloat(rate) || 0;
  // Log rate change if rate changed
  const old = db.prepare('SELECT rate FROM products WHERE id = ?').get(req.params.id);
  if (old && old.rate !== newRate) {
    db.prepare('INSERT INTO product_rate_history (product_id, old_rate, new_rate, changed_at) VALUES (?, ?, ?, ?)').run(req.params.id, old.rate, newRate, new Date().toISOString().split('T')[0]);
  }
  db.prepare(
    `UPDATE products SET name=?, category=?, qty_per_pack=?, stock=?, rate=?, min_stock=?, status=?, vendor_id=? WHERE id=?`
  ).run(name, category, parseInt(qty_per_pack)||1, parseInt(stock)||0, newRate, parseInt(min_stock)||10, status||'active', vendor_id||null, req.params.id);
  addAuditLog('update', 'products', req.params.id, `Updated product: ${name}`);
  res.redirect('/products');
});

router.get('/view/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/products');
  const rates = db.prepare('SELECT * FROM rate_list WHERE product_id = ? ORDER BY effective_date DESC').all(req.params.id);

  // Fetch stock movements from orders (outbound to customers)
  const orderMovements = db.prepare(`
    SELECT
      oi.product_id,
      c.name as party_name,
      c.id as party_id,
      'Customer' as party_type,
      oi.quantity,
      o.order_date as movement_date,
      o.id as order_id,
      o.order_no as reference_number,
      'Order' as doc_type
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE oi.product_id = ?
  `).all(req.params.id);

  // Fetch stock movements from purchases (inbound from vendors)
  const purchaseMovements = db.prepare(`
    SELECT
      pi.product_id,
      v.name as party_name,
      v.id as party_id,
      'Vendor' as party_type,
      pi.quantity,
      pur.purchase_date as movement_date,
      pur.id as purchase_id,
      pur.purchase_no as reference_number,
      'Purchase' as doc_type
    FROM purchase_items pi
    JOIN purchases pur ON pur.id = pi.purchase_id
    JOIN vendors v ON v.id = pur.vendor_id
    WHERE pi.product_id = ?
  `).all(req.params.id);

  // Combine and sort by date descending
  const movements = [...orderMovements, ...purchaseMovements].sort((a, b) =>
    new Date(b.movement_date) - new Date(a.movement_date)
  );

  res.render('products/view', { page: 'products', product, rates, movements });
});

router.post('/delete/:id', (req, res) => {
  // Prevent deletion if product has order_items
  const linked = db.prepare('SELECT COUNT(*) as cnt FROM order_items WHERE product_id = ?').get(req.params.id);
  if (linked && linked.cnt > 0) {
    return res.redirect('/products?error=Product+is+linked+to+orders+and+cannot+be+deleted');
  }
  db.prepare('UPDATE products SET status = ? WHERE id = ?').run('inactive', req.params.id);
  addAuditLog('delete', 'products', req.params.id, 'Deactivated product');
  res.redirect('/products');
});

router.post('/bulk', (req, res) => {
  const { ids, action, value, value2 } = req.body;
  if (!ids || !action) return res.redirect('/products');
  const idList = ids.split(',').map(Number).filter(Boolean);
  if (!idList.length) return res.redirect('/products');

  if (action === 'delete') {
    idList.forEach(id => {
      const linked = db.prepare('SELECT COUNT(*) as cnt FROM order_items WHERE product_id = ?').get(id);
      if (!linked || linked.cnt === 0) {
        db.prepare('UPDATE products SET status = ? WHERE id = ?').run('inactive', id);
      }
    });
  } else if (action === 'set_vendor') {
    const stmt = db.prepare('UPDATE products SET vendor_id = ? WHERE id = ?');
    idList.forEach(id => stmt.run(value || null, id));
  } else if (action === 'set_category') {
    const stmt = db.prepare('UPDATE products SET category = ? WHERE id = ?');
    idList.forEach(id => stmt.run(value || '', id));
  } else if (action === 'set_packaging') {
    const pkg = parseInt(value) || 1;
    const stmt = db.prepare('UPDATE products SET qty_per_pack = ? WHERE id = ?');
    idList.forEach(id => stmt.run(pkg, id));
  } else if (action === 'set_rate') {
    const newRate = parseFloat(value) || 0;
    const stmt = db.prepare('UPDATE products SET rate = ? WHERE id = ?');
    idList.forEach(id => {
      const old = db.prepare('SELECT rate FROM products WHERE id = ?').get(id);
      if (old && old.rate !== newRate) {
        db.prepare('INSERT INTO product_rate_history (product_id, old_rate, new_rate, changed_at) VALUES (?, ?, ?, ?)').run(id, old.rate, newRate, new Date().toISOString().split('T')[0]);
      }
      stmt.run(newRate, id);
    });
  } else if (action === 'rate_by_pct') {
    const pct = parseFloat(value) || 0;
    idList.forEach(id => {
      const prod = db.prepare('SELECT rate FROM products WHERE id = ?').get(id);
      if (prod) {
        const newRate = Math.round((prod.rate * (1 + pct / 100)) * 100) / 100;
        db.prepare('INSERT INTO product_rate_history (product_id, old_rate, new_rate, changed_at) VALUES (?, ?, ?, ?)').run(id, prod.rate, newRate, new Date().toISOString().split('T')[0]);
        db.prepare('UPDATE products SET rate = ? WHERE id = ?').run(newRate, id);
      }
    });
  } else if (action === 'stock_add') {
    const qty = parseInt(value) || 0;
    const stmt = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    idList.forEach(id => stmt.run(qty, id));
  } else if (action === 'stock_sub') {
    const qty = parseInt(value) || 0;
    const stmt = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?');
    idList.forEach(id => stmt.run(qty, id));
  } else if (action === 'rename_prefix') {
    // value = prefix to add, value2 = suffix
    idList.forEach(id => {
      const p = db.prepare('SELECT name FROM products WHERE id = ?').get(id);
      if (p) {
        const newName = (value || '') + p.name + (value2 || '');
        db.prepare('UPDATE products SET name = ? WHERE id = ?').run(newName, id);
      }
    });
  }

  addAuditLog('update', 'products', null, `Bulk action: ${action} on ${idList.length} products`);
  res.redirect('/products');
});

module.exports = router;
