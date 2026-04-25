const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, generateNumber, addLedgerEntry, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const search = req.query.search || '';
  let sql = `SELECT o.*, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (o.order_no LIKE ? OR c.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
  sql += ` ORDER BY o.id DESC`;
  const orders = db.prepare(sql).all(...params);
  res.render('orders/index', { page: 'orders', orders, search });
});

router.get('/add', (req, res) => {
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, qty_per_pack, selling_price as rate, stock, default_commission_rate FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const transports = db.prepare("SELECT id, name FROM transports WHERE status='active' ORDER BY name").all();
  const today = new Date().toISOString().split('T')[0];
  res.render('orders/form', { page: 'orders', order: null, items: [], customers, products, warehouses, transports, edit: false, today });
});

// Stock + best sell-rate lookup. Pass ?warehouse_id= to scope stock; falls back to total.
router.get('/api/stock/:product_id', (req, res) => {
  const pid = parseInt(req.params.product_id, 10);
  const wid = req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null;
  const customerType = req.query.customer_type || 'retail';
  const prod = db.prepare('SELECT id, name, stock, qty_per_pack, selling_price, default_commission_rate FROM products WHERE id = ?').get(pid);
  if (!prod) return res.json({ stock: 0, qty_per_pack: 1, name: '', commission: 0, rate: 0 });
  let stockPcs = prod.stock;
  if (wid) {
    const ws = db.prepare('SELECT quantity FROM warehouse_stock WHERE product_id = ? AND warehouse_id = ?').get(pid, wid);
    stockPcs = ws ? ws.quantity : 0;
  }
  // Latest active rate from rate_list overrides product.selling_price
  let rate = prod.selling_price || 0;
  try {
    const rl = db.prepare(
      `SELECT rate FROM rate_list WHERE product_id = ? AND customer_type = ? AND effective_date <= date('now') ORDER BY effective_date DESC, id DESC LIMIT 1`
    ).get(pid, customerType);
    if (rl && rl.rate != null) rate = rl.rate;
  } catch (_) {}
  const qpp = prod.qty_per_pack || 1;
  res.json({
    stock: stockPcs,
    stock_ctn: qpp > 0 ? Math.floor(stockPcs / qpp) : 0,
    stock_loose: qpp > 0 ? stockPcs % qpp : stockPcs,
    qty_per_pack: qpp,
    name: prod.name,
    commission: prod.default_commission_rate || 0,
    rate
  });
});

router.post('/add', validate(schemas.orderCreate), (req, res) => {
  try {
    const { customer_id, order_date, delivery_date, warehouse_id, transport_id, bilty_no, notes,
            product_id, packages, packaging, quantity, rate, commission_pct } = req.body;
    const orderNo = generateNumber('ORD', 'orders');
    const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
    const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : 'plastic_markaz';

    const productIds  = Array.isArray(product_id)     ? product_id     : [product_id];
    const packagesArr = Array.isArray(packages)       ? packages       : [packages];
    const packagingArr= Array.isArray(packaging)      ? packaging      : [packaging];
    const quantityArr = Array.isArray(quantity)       ? quantity       : [quantity];
    const rateArr     = Array.isArray(rate)           ? rate           : [rate];
    const commArr     = Array.isArray(commission_pct) ? commission_pct : [commission_pct];

    let subtotal = 0, totalCommission = 0;
    const itemsData = [];
    for (let i = 0; i < productIds.length; i++) {
      if (!productIds[i]) continue;
      const qty = parseInt(quantityArr[i]) || 0;
      const r   = parseFloat(rateArr[i]) || 0;
      const amt = qty * r;
      const commPct = parseFloat(commArr[i]) || 0;
      const commAmt = amt * commPct / 100;
      if (qty <= 0 || r < 0) continue;
      subtotal += amt; totalCommission += commAmt;
      itemsData.push({
        product_id: productIds[i],
        packages: parseInt(packagesArr[i]) || 0,
        packaging: parseInt(packagingArr[i]) || 1,
        quantity: qty, rate: r, amount: amt,
        commission_pct: commPct, commission_amount: commAmt
      });
    }
    if (!itemsData.length) return res.redirect('/orders/add?err=no_items');

    // Order total: subtotal MINUS commission (commission replaces discount in orders)
    const total = subtotal - totalCommission;
    const tid = transport_id ? parseInt(transport_id, 10) : null;

    db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO orders (order_no, customer_id, order_date, delivery_date, warehouse_id, transport_id, bilty_no, subtotal, discount, total, commission_pct, commission_amount, notes, account_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`
      ).run(orderNo, customer_id, order_date, delivery_date || null, warehouse_id || null, tid, bilty_no || null, subtotal, total, totalCommission, notes, account_scope);

      const orderId = result.lastInsertRowid;
      const insertItem = db.prepare(
        `INSERT INTO order_items (order_id, product_id, packages, packaging, quantity, rate, amount, commission_pct, commission_amount, discount_per_pack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      );
      for (const item of itemsData) {
        insertItem.run(orderId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount, item.commission_pct, item.commission_amount);
      }
      addAuditLog('create', 'orders', orderId, `Created order ${orderNo} total ${total}`);
    })();

    res.redirect('/orders');
  } catch (e) {
    require('../database').logError('orders.create', e, { body: req.body });
    res.redirect('/orders?err=' + encodeURIComponent(e.message || 'server'));
  }
});

router.get('/edit/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/orders');
  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, qty_per_pack, selling_price as rate, stock, default_commission_rate FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const transports = db.prepare("SELECT id, name FROM transports WHERE status='active' ORDER BY name").all();
  const today = new Date().toISOString().split('T')[0];
  res.render('orders/form', { page: 'orders', order, items, customers, products, warehouses, transports, edit: true, today });
});

router.post('/edit/:id', validate(schemas.orderCreate), (req, res) => {
  try {
    const { customer_id, order_date, delivery_date, warehouse_id, transport_id, bilty_no, notes,
            product_id, packages, packaging, quantity, rate, commission_pct } = req.body;
    const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
    const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : 'plastic_markaz';

    const productIds  = Array.isArray(product_id)     ? product_id     : [product_id];
    const packagesArr = Array.isArray(packages)       ? packages       : [packages];
    const packagingArr= Array.isArray(packaging)      ? packaging      : [packaging];
    const quantityArr = Array.isArray(quantity)       ? quantity       : [quantity];
    const rateArr     = Array.isArray(rate)           ? rate           : [rate];
    const commArr     = Array.isArray(commission_pct) ? commission_pct : [commission_pct];

    let subtotal = 0, totalCommission = 0;
    const itemsData = [];
    for (let i = 0; i < productIds.length; i++) {
      if (!productIds[i]) continue;
      const qty = parseInt(quantityArr[i]) || 0;
      const r   = parseFloat(rateArr[i]) || 0;
      const amt = qty * r;
      const commPct = parseFloat(commArr[i]) || 0;
      const commAmt = amt * commPct / 100;
      if (qty <= 0 || r < 0) continue;
      subtotal += amt; totalCommission += commAmt;
      itemsData.push({
        product_id: productIds[i],
        packages: parseInt(packagesArr[i]) || 0,
        packaging: parseInt(packagingArr[i]) || 1,
        quantity: qty, rate: r, amount: amt,
        commission_pct: commPct, commission_amount: commAmt
      });
    }
    if (!itemsData.length) return res.redirect('/orders/edit/' + req.params.id + '?err=no_items');

    const total = subtotal - totalCommission;
    const tid = transport_id ? parseInt(transport_id, 10) : null;

    db.transaction(() => {
      db.prepare(
        `UPDATE orders SET customer_id=?, order_date=?, delivery_date=?, warehouse_id=?, transport_id=?, bilty_no=?, subtotal=?, discount=0, total=?, commission_pct=0, commission_amount=?, notes=?, account_scope=? WHERE id=?`
      ).run(customer_id, order_date, delivery_date || null, warehouse_id || null, tid, bilty_no || null, subtotal, total, totalCommission, notes, account_scope, req.params.id);

      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
      const insertItem = db.prepare(
        `INSERT INTO order_items (order_id, product_id, packages, packaging, quantity, rate, amount, commission_pct, commission_amount, discount_per_pack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      );
      for (const item of itemsData) {
        insertItem.run(req.params.id, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount, item.commission_pct, item.commission_amount);
      }
      addAuditLog('update', 'orders', req.params.id, 'Updated order');
    })();

    res.redirect('/orders');
  } catch (e) {
    require('../database').logError('orders.edit', e, { id: req.params.id });
    res.redirect('/orders?err=' + encodeURIComponent(e.message || 'server'));
  }
});

router.get('/view/:id', (req, res) => {
  const order = db.prepare('SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(req.params.id);
  if (!order) return res.redirect('/orders');
  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(req.params.id);
  const dc = db.prepare('SELECT * FROM delivery_challans WHERE order_id = ?').get(req.params.id);
  res.render('orders/view', { page: 'orders', order, items, invoice, dc });
});

router.get('/print/:id', (req, res) => {
  const order = db.prepare('SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  const { getSettings } = require('../database');
  const settings = getSettings();
  res.render('orders/print', { page: 'orders', order, items, settings, layout: false });
});

router.post('/delivery-challan/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const existing = db.prepare('SELECT * FROM delivery_challans WHERE order_id = ?').get(req.params.id);
  if (existing) return res.json({ id: existing.id, dc_no: existing.dc_no });

  const dcNo = generateNumber('DC', 'delivery_challans');
  const dcDate = new Date().toISOString().split('T')[0];

  const result = db.prepare(
    `INSERT INTO delivery_challans (dc_no, order_id, dc_date) VALUES (?, ?, ?)`
  ).run(dcNo, req.params.id, dcDate);

  addAuditLog('create', 'delivery_challans', result.lastInsertRowid, `Generated DC ${dcNo} for order ${order.order_no}`);
  res.json({ id: result.lastInsertRowid, dc_no: dcNo });
});

router.get('/challan/:id', (req, res) => {
  const order = db.prepare('SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(req.params.id);
  if (!order) return res.status(404).send('Order not found');

  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  const dc = db.prepare('SELECT * FROM delivery_challans WHERE order_id = ?').get(req.params.id);

  const { getSettings } = require('../database');
  const settings = getSettings();
  res.render('orders/challan', { page: 'orders', order, items, dc, settings, layout: false });
});

router.post('/delete/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  })();
  addAuditLog('delete', 'orders', req.params.id, 'Deleted order');
  res.redirect('/orders');
});

module.exports = router;
