const express = require('express');
const router = express.Router();
const { db, generateNumber, addLedgerEntry, addAuditLog,
        applyStockMovement, reverseStockForRef, removeLedgerForRef,
        recomputeBalance, toNum, toInt, logError } = require('../database');

router.get('/', (req, res) => {
  const search = req.query.search || '';
  let sql = `SELECT p.*, v.name as vendor_name FROM purchases p JOIN vendors v ON v.id = p.vendor_id WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (p.purchase_no LIKE ? OR v.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
  sql += ` ORDER BY p.id DESC`;
  const purchases = db.prepare(sql).all(...params);
  res.render('purchases/index', { page: 'purchases', purchases, search, mode: 'voucher' });
});

// Purchase Invoice — same data as purchases, presented as invoice format
router.get('/invoice', (req, res) => {
  const search = req.query.search || '';
  let sql = `SELECT p.*, v.name as vendor_name FROM purchases p JOIN vendors v ON v.id = p.vendor_id WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (p.purchase_no LIKE ? OR v.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
  sql += ` ORDER BY p.id DESC`;
  const purchases = db.prepare(sql).all(...params);
  res.render('purchases/index', { page: 'purchase-invoice', purchases, search, mode: 'invoice' });
});

router.get('/add', (req, res) => {
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, qty_per_pack, rate FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  res.render('purchases/form', { page: 'purchases', purchase: null, items: [], vendors, products, warehouses, edit: false });
});

router.post('/add', (req, res) => {
  try {
    const { vendor_id, purchase_date, warehouse_id, bilty_no, discount, notes,
            product_id, packages, packaging, quantity, rate, discount_per_pack } = req.body;
    const vid = toInt(vendor_id);
    if (!vid || !purchase_date) return res.redirect('/purchases?err=missing');
    const wid = warehouse_id ? toInt(warehouse_id) : null;
    const purchaseNo = generateNumber('PUR', 'purchases');
    const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
    const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : 'plastic_markaz';

    const productIds  = Array.isArray(product_id)        ? product_id        : [product_id];
    const packagesArr = Array.isArray(packages)          ? packages          : [packages];
    const packagingArr= Array.isArray(packaging)         ? packaging         : [packaging];
    const quantityArr = Array.isArray(quantity)          ? quantity          : [quantity];
    const rateArr     = Array.isArray(rate)              ? rate              : [rate];
    const discArr     = Array.isArray(discount_per_pack) ? discount_per_pack : [discount_per_pack];

    let subtotal = 0;
    const itemsData = [];
    for (let i = 0; i < productIds.length; i++) {
      const pid = toInt(productIds[i]);
      if (!pid) continue;
      const qty = toInt(quantityArr[i]);
      const r   = toNum(rateArr[i]);
      const amt = qty * r;
      const discPack = toNum(discArr[i]);
      if (qty <= 0 || r < 0) continue;
      subtotal += amt;
      itemsData.push({
        product_id: pid,
        packages: toInt(packagesArr[i], 0),
        packaging: toInt(packagingArr[i], 1) || 1,
        quantity: qty, rate: r, amount: amt, discount_per_pack: discPack
      });
    }
    if (!itemsData.length) return res.redirect('/purchases/add?err=no_items');

    const disc = toNum(discount, 0);
    const total = subtotal - disc;

    db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO purchases (purchase_no, vendor_id, purchase_date, warehouse_id, bilty_no, status, subtotal, discount, total, notes, account_scope)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
      ).run(purchaseNo, vid, purchase_date, wid, bilty_no||null, subtotal, disc, total, notes||null, account_scope);

      const purId = result.lastInsertRowid;
      const insertItem = db.prepare(
        `INSERT INTO purchase_items (purchase_id, product_id, packages, packaging, quantity, rate, amount, discount_per_pack)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of itemsData) {
        insertItem.run(purId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount, item.discount_per_pack);
        // Stock IN via ledger
        applyStockMovement(item.product_id, wid, item.quantity, 'purchase', purId, 'purchase', `Purchase ${purchaseNo}`);
        // Update last cost on product (so future invoices freeze the right cost)
        db.prepare('UPDATE products SET cost_price = ?, purchase_price = ? WHERE id = ?').run(item.rate, item.rate, item.product_id);
      }

      addLedgerEntry('vendor', vid, purchase_date, `Purchase ${purchaseNo}`, 0, total, 'purchase', purId);
      addAuditLog('create', 'purchases', purId, `Created purchase ${purchaseNo} total ${total}`);
    })();

    res.redirect('/purchases');
  } catch (e) {
    logError('purchases.create', e, { body: req.body });
    res.redirect('/purchases?err=server');
  }
});

router.get('/edit/:id', (req, res) => {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!purchase) return res.redirect('/purchases');
  const items = db.prepare('SELECT pi.*, p.name as product_name FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ?').all(req.params.id);
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, qty_per_pack, rate FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  res.render('purchases/form', { page: 'purchases', purchase, items, vendors, products, warehouses, edit: true });
});

router.post('/edit/:id', (req, res) => {
  try {
    const purId = toInt(req.params.id);
    const existing = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purId);
    if (!existing) return res.redirect('/purchases?err=notfound');

    const { vendor_id, purchase_date, warehouse_id, bilty_no, discount, notes, status,
            product_id, packages, packaging, quantity, rate, discount_per_pack } = req.body;
    const vid = toInt(vendor_id) || existing.vendor_id;
    const wid = warehouse_id ? toInt(warehouse_id) : null;
    const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
    const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : (existing.account_scope || 'plastic_markaz');

    const productIds  = Array.isArray(product_id)        ? product_id        : [product_id];
    const packagesArr = Array.isArray(packages)          ? packages          : [packages];
    const packagingArr= Array.isArray(packaging)         ? packaging         : [packaging];
    const quantityArr = Array.isArray(quantity)          ? quantity          : [quantity];
    const rateArr     = Array.isArray(rate)              ? rate              : [rate];
    const discArr     = Array.isArray(discount_per_pack) ? discount_per_pack : [discount_per_pack];

    let subtotal = 0;
    const itemsData = [];
    for (let i = 0; i < productIds.length; i++) {
      const pid = toInt(productIds[i]);
      if (!pid) continue;
      const qty = toInt(quantityArr[i]);
      const r   = toNum(rateArr[i]);
      const amt = qty * r;
      const discPack = toNum(discArr[i]);
      if (qty <= 0 || r < 0) continue;
      subtotal += amt;
      itemsData.push({
        product_id: pid,
        packages: toInt(packagesArr[i], 0),
        packaging: toInt(packagingArr[i], 1) || 1,
        quantity: qty, rate: r, amount: amt, discount_per_pack: discPack
      });
    }
    if (!itemsData.length) return res.redirect('/purchases/edit/' + purId + '?err=no_items');

    const disc = toNum(discount, 0);
    const total = subtotal - disc;

    db.transaction(() => {
      // Reverse previous stock IN
      reverseStockForRef('purchase', purId);
      // Reverse previous vendor ledger
      removeLedgerForRef('vendor', existing.vendor_id, 'purchase', purId);
      recomputeBalance('vendor', existing.vendor_id);

      db.prepare(
        `UPDATE purchases SET vendor_id=?, purchase_date=?, warehouse_id=?, bilty_no=?, status=?,
         subtotal=?, discount=?, total=?, notes=?, account_scope=? WHERE id=?`
      ).run(vid, purchase_date, wid, bilty_no||null, status || existing.status || 'pending',
            subtotal, disc, total, notes||null, account_scope, purId);

      db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(purId);
      const insertItem = db.prepare(
        `INSERT INTO purchase_items (purchase_id, product_id, packages, packaging, quantity, rate, amount, discount_per_pack)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of itemsData) {
        insertItem.run(purId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount, item.discount_per_pack);
        applyStockMovement(item.product_id, wid, item.quantity, 'purchase', purId, 'purchase-edit', `Purchase ${existing.purchase_no} (edited)`);
      }

      addLedgerEntry('vendor', vid, purchase_date, `Purchase ${existing.purchase_no}`, 0, total, 'purchase', purId);
      if (vid !== existing.vendor_id) recomputeBalance('vendor', existing.vendor_id);

      addAuditLog('update', 'purchases', purId, `Updated purchase ${existing.purchase_no} new total ${total}`);
    })();

    res.redirect('/purchases');
  } catch (e) {
    logError('purchases.edit', e, { id: req.params.id, body: req.body });
    res.redirect('/purchases?err=server');
  }
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
  try {
    const purId = toInt(req.params.id);
    const existing = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purId);
    if (!existing) return res.redirect('/purchases?err=notfound');
    db.transaction(() => {
      reverseStockForRef('purchase', purId);
      removeLedgerForRef('vendor', existing.vendor_id, 'purchase', purId);
      recomputeBalance('vendor', existing.vendor_id);
      db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(purId);
      db.prepare('DELETE FROM purchases WHERE id = ?').run(purId);
      addAuditLog('delete', 'purchases', purId, `Deleted purchase ${existing.purchase_no}`);
    })();
    res.redirect('/purchases');
  } catch (e) {
    logError('purchases.delete', e, { id: req.params.id });
    res.redirect('/purchases?err=server');
  }
});

module.exports = router;
