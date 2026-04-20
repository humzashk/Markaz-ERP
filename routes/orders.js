const express = require('express');
const router = express.Router();
const { db, generateNumber, addLedgerEntry, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const status = req.query.status || '';
  const search = req.query.search || '';
  let sql = `SELECT o.*, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND o.status = ?`; params.push(status); }
  if (search) { sql += ` AND (o.order_no LIKE ? OR c.name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
  sql += ` ORDER BY o.id DESC`;
  const orders = db.prepare(sql).all(...params);
  res.render('orders/index', { page: 'orders', orders, status, search });
});

router.get('/add', (req, res) => {
  const customers = db.prepare('SELECT id, name, commission FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, packaging, rate, stock FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('orders/form', { page: 'orders', order: null, items: [], customers, products, edit: false });
});

router.post('/add', (req, res) => {
  const { customer_id, order_date, delivery_date, commission_pct, notes, product_id, packages, packaging, quantity, rate } = req.body;
  const orderNo = generateNumber('ORD', 'orders');

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
    itemsData.push({
      product_id: productIds[i],
      packages: parseInt(packagesArr[i]) || 0,
      packaging: parseInt(packagingArr[i]) || 1,
      quantity: qty,
      rate: r,
      amount: amt
    });
  }

  const commPct = parseFloat(commission_pct) || 0;
  const total = subtotal;
  const commission = total * commPct / 100;

  const insertOrder = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO orders (order_no, customer_id, order_date, delivery_date, status, subtotal, discount, total, commission_pct, commission_amount, notes) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`
    ).run(orderNo, customer_id, order_date, delivery_date || null, subtotal, total, commPct, commission, notes);

    const orderId = result.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, packages, packaging, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(orderId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount);
    }
    addAuditLog('create', 'orders', orderId, `Created order ${orderNo} for Rs.${total}`);
    return orderId;
  });

  insertOrder();
  res.redirect('/orders');
});

router.get('/edit/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/orders');
  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  const customers = db.prepare('SELECT id, name, commission FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, packaging, rate, stock FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('orders/form', { page: 'orders', order, items, customers, products, edit: true });
});

router.post('/edit/:id', (req, res) => {
  const { customer_id, order_date, delivery_date, commission_pct, notes, status, product_id, packages, packaging, quantity, rate } = req.body;

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
      `UPDATE orders SET customer_id=?, order_date=?, delivery_date=?, status=?, subtotal=?, discount=0, total=?, commission_pct=?, commission_amount=?, notes=? WHERE id=?`
    ).run(customer_id, order_date, delivery_date||null, status||'pending', subtotal, total, commPct, commission, notes, req.params.id);

    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, packages, packaging, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of itemsData) {
      insertItem.run(req.params.id, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount);
    }
  })();

  addAuditLog('update', 'orders', req.params.id, `Updated order`);
  res.redirect('/orders');
});

router.get('/view/:id', (req, res) => {
  const order = db.prepare('SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city, c.commission as customer_commission FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(req.params.id);
  if (!order) return res.redirect('/orders');
  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(req.params.id);
  const bilty = db.prepare('SELECT * FROM bilty WHERE order_id = ?').get(req.params.id);
  res.render('orders/view', { page: 'orders', order, items, invoice, bilty });
});

// Delivery Challan Print
router.get('/challan/:id', (req, res) => {
  const order = db.prepare('SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.city as customer_city FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const items = db.prepare('SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(req.params.id);
  items.forEach(item => { item.base_unit = 'PCS'; }); // Default unit
  const { getSettings } = require('../database');
  const settings = getSettings();
  res.render('orders/challan', { page: 'orders', order, items, settings, layout: false });
});

// Generate Invoice from Order — show editable preview first
router.get('/generate-invoice/:id', (req, res) => {
  const order = db.prepare(`SELECT o.*, c.name as customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(req.params.id);
  if (!order) return res.redirect('/orders');

  const existing = db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(req.params.id);
  if (existing) return res.redirect('/invoices/view/' + existing.id);

  const items = db.prepare(`SELECT oi.*, p.name as product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(req.params.id);
  const products = db.prepare('SELECT id, name, packaging, rate, stock FROM products WHERE status = ? ORDER BY name').all('active');
  const today = new Date().toISOString().split('T')[0];
  const { getSettings } = require('../database');
  const settings = getSettings();
  const dueDays = parseInt(settings.default_due_days) || 30;
  const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + dueDays);
  const dueDateStr = dueDate.toISOString().split('T')[0];

  res.render('orders/generate-invoice', { page: 'orders', order, items, products, today, dueDateStr });
});

// Confirm and create invoice from order
router.post('/generate-invoice/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/orders');

  const existing = db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(req.params.id);
  if (existing) return res.redirect('/invoices/view/' + existing.id);

  const { invoice_date, due_date, commission_pct, notes, product_id, packages, packaging, quantity, rate } = req.body;
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
  const commPct = parseFloat(commission_pct) || order.commission_pct || 0;
  const total = subtotal;
  const commission = total * commPct / 100;
  const invoiceNo = generateNumber('INV', 'invoices');

  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO invoices (invoice_no, order_id, customer_id, invoice_date, due_date, subtotal, discount, total, commission_pct, commission_amount, status, notes) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'unpaid', ?)`
    ).run(invoiceNo, order.id, order.customer_id, invoice_date, due_date||null, subtotal, total, commPct, commission, notes||'');

    const invId = result.lastInsertRowid;
    for (const item of itemsData) {
      db.prepare(`INSERT INTO invoice_items (invoice_id, product_id, packages, packaging, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(invId, item.product_id, item.packages, item.packaging, item.quantity, item.rate, item.amount);
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('confirmed', order.id);
    addLedgerEntry('customer', order.customer_id, invoice_date, `Invoice ${invoiceNo}`, total, 0, 'invoice', invId);
    addAuditLog('create', 'invoices', invId, `Generated invoice ${invoiceNo} from order ${order.order_no}`);
  })();

  res.redirect('/invoices/view/' + db.prepare('SELECT id FROM invoices WHERE invoice_no = ?').get(invoiceNo).id);
});

router.post('/delete/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  })();
  addAuditLog('delete', 'orders', req.params.id, 'Deleted order');
  res.redirect('/orders');
});

router.post('/bulk', (req, res) => {
  const { action, ids } = req.body;
  if (!ids || !action) return res.redirect('/orders');
  const idList = ids.split(',').map(Number).filter(Boolean);
  if (!idList.length) return res.redirect('/orders');

  const statusMap = { confirm: 'confirmed', deliver: 'delivered', cancel: 'cancelled' };
  if (statusMap[action]) {
    const stmt = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
    idList.forEach(id => stmt.run(statusMap[action], id));
  } else if (action === 'delete') {
    db.transaction(() => {
      idList.forEach(id => {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
        db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      });
    })();
  }
  res.redirect('/orders');
});

module.exports = router;
