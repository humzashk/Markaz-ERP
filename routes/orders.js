const express = require('express');
const router = express.Router();
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
  const today = new Date().toISOString().split('T')[0];
  res.render('orders/form', { page: 'orders', order: null, items: [], customers, products, warehouses, edit: false, today });
});

router.get('/api/stock/:product_id', (req, res) => {
  const prod = db.prepare('SELECT id, name, stock, qty_per_pack, default_commission_rate FROM products WHERE id = ?').get(req.params.product_id);
  if (prod) {
    res.json({ stock: prod.stock, qty_per_pack: prod.qty_per_pack || 1, name: prod.name, commission: prod.default_commission_rate || 0 });
  } else {
    res.json({ stock: 0, qty_per_pack: 1, name: '', commission: 0 });
  }
});

router.post('/add', (req, res) => {
  const { customer_id, order_date, delivery_date, warehouse_id, bilty_no, transporter_name, notes, product_id, packages, packaging, quantity, rate, commission_pct, discount_per_pack } = req.body;
  const orderNo = generateNumber('ORD', 'orders');
  const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
  const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : 'plastic_markaz';

  const productIds = Array.isArray(product_id) ? product_id : [product_id];
  const packagesArr = Array.isArray(packages) ? packages : [packages];
  const packagingArr = Array.isArray(packaging) ? packaging : [packaging];
  const quantityArr = Array.isArray(quantity) ? quantity : [quantity];
  const rateArr = Array.isArray(rate) ? rate : [rate];
  const commissionArr = Array.isArray(commission_pct) ? commission_pct : [commission_pct];
  const discountArr = Array.isArray(discount_per_pack) ? discount_per_pack : [discount_per_pack];

  let subtotal = 0;
  let totalCommission = 0;
  let totalDiscount = 0;
  const itemsData = [];

  for (let i = 0; i < productIds.length; i++) {
    if (!productIds[i]) continue;
    const qty = parseInt(quantityArr[i]) || 0;
    const r = parseFloat(rateArr[i]) || 0;
    const amt = qty * r;
    const commPct = parseFloat(commissionArr[i]) || 0;
    const commAmt = amt * commPct / 100;
    const discPack = parseFloat(discountArr[i]) || 0;
    const discAmt = qty * discPack;

    subtotal += amt;
    totalCommission += commAmt;
    totalDiscount += discAmt;
    itemsData.push({
      product_id: productIds[i],
      packages: parseInt(packagesArr[i]) || 0,
      packaging: parseInt(packagingArr[i]) || 1,
      quantity: qty,
      rate: r,
      amount: amt,
      commission_pct: commPct,
      commission_amount: commAmt,
      discount_per_pack: discPack
    });
  }

  const total = subtotal;
  const gross = subtotal - totalCommission;

  const insertOrder = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO orders (order_no, customer_id, order_date, delivery_date, warehouse_id, bilty_no, transporter_name, subtotal, discount, total, commission_pct, commission_amount, notes, account_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`
    ).run(orderNo, customer_id, order_date, delivery_date || null, warehouse_id||null, bilty_no||null, transporter_name||null, subtotal, total, totalCommission, notes, account_scope);

    const orderId = result.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, packages, packaging, quantity, rate, amount, commission_pct, commission_amount, discount_per_pack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(orderId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount, item.commission_pct, item.commission_amount, item.discount_per_pack);
    }
    addAuditLog('create', 'orders', orderId, `Created order ${orderNo}`);
    return orderId;
  });

  insertOrder();
  res.redirect('/orders');
});

router.get('/edit/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/orders');
  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, qty_per_pack, selling_price as rate, stock, default_commission_rate FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const today = new Date().toISOString().split('T')[0];
  res.render('orders/form', { page: 'orders', order, items, customers, products, warehouses, edit: true, today });
});

router.post('/edit/:id', (req, res) => {
  const { customer_id, order_date, delivery_date, warehouse_id, bilty_no, transporter_name, notes, product_id, packages, packaging, quantity, rate, commission_pct, discount_per_pack } = req.body;
  const allowedScopes = ['plastic_markaz','wings_furniture','cooler'];
  const account_scope = allowedScopes.includes(req.body.account_scope) ? req.body.account_scope : 'plastic_markaz';

  const productIds = Array.isArray(product_id) ? product_id : [product_id];
  const packagesArr = Array.isArray(packages) ? packages : [packages];
  const packagingArr = Array.isArray(packaging) ? packaging : [packaging];
  const quantityArr = Array.isArray(quantity) ? quantity : [quantity];
  const rateArr = Array.isArray(rate) ? rate : [rate];
  const commissionArr = Array.isArray(commission_pct) ? commission_pct : [commission_pct];
  const discountArr = Array.isArray(discount_per_pack) ? discount_per_pack : [discount_per_pack];

  let subtotal = 0;
  let totalCommission = 0;
  let totalDiscount = 0;
  const itemsData = [];

  for (let i = 0; i < productIds.length; i++) {
    if (!productIds[i]) continue;
    const qty = parseInt(quantityArr[i]) || 0;
    const r = parseFloat(rateArr[i]) || 0;
    const amt = qty * r;
    const commPct = parseFloat(commissionArr[i]) || 0;
    const commAmt = amt * commPct / 100;
    const discPack = parseFloat(discountArr[i]) || 0;
    const discAmt = qty * discPack;

    subtotal += amt;
    totalCommission += commAmt;
    totalDiscount += discAmt;
    itemsData.push({ product_id: productIds[i], packages: parseInt(packagesArr[i])||0, packaging: parseInt(packagingArr[i])||1, quantity: qty, rate: r, amount: amt, commission_pct: commPct, commission_amount: commAmt, discount_per_pack: discPack });
  }

  const total = subtotal;

  db.transaction(() => {
    db.prepare(
      `UPDATE orders SET customer_id=?, order_date=?, delivery_date=?, warehouse_id=?, bilty_no=?, transporter_name=?, subtotal=?, discount=0, total=?, commission_pct=0, commission_amount=?, notes=?, account_scope=? WHERE id=?`
    ).run(customer_id, order_date, delivery_date||null, warehouse_id||null, bilty_no||null, transporter_name||null, subtotal, total, totalCommission, notes, account_scope, req.params.id);

    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, packages, packaging, quantity, rate, amount, commission_pct, commission_amount, discount_per_pack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(req.params.id, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount, item.commission_pct, item.commission_amount, item.discount_per_pack);
    }
  })();

  addAuditLog('update', 'orders', req.params.id, `Updated order`);
  res.redirect('/orders');
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
