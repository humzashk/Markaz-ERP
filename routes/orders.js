'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, nextDocNo, addAuditLog, toInt, toNum } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

// Orders DO NOT touch stock or ledger. They are draft sale agreements.
// Stock + ledger are committed when an invoice is generated.

// Helper: normalise bilty_no ("42" or "BLT42" → "BLT-0042")
function _normBilty(s) {
  if (!s) return s;
  const m = s.match(/^(?:BLT-?)?(\d+)$/i);
  return m ? 'BLT-' + String(parseInt(m[1], 10)).padStart(4, '0') : s.toUpperCase();
}

router.get('/', wrap(async (req, res) => {
  const search = req.query.search || '';
  const params = []; let i = 1;
  let sql = `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE 1=1`;
  if (search) { sql += ` AND (o.order_no ILIKE $${i} OR c.name ILIKE $${i})`; params.push('%'+search+'%'); i++; }
  sql += ` ORDER BY o.id DESC LIMIT 500`;
  const r = await pool.query(sql, params);
  res.render('orders/index', { page:'orders', orders: r.rows, search, ok: req.query.ok || null, err: req.query.err || null });
}));

router.get('/add', wrap(async (req, res) => {
  const [customers, products, warehouses, transports] = await Promise.all([
    pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name, qty_per_pack, selling_price AS rate, stock, default_commission_rate FROM products WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)
  ]);
  res.render('orders/form', {
    page:'orders', order:null, items:[],
    customers: customers.rows, products: products.rows, warehouses: warehouses.rows, transports: transports.rows,
    edit:false, today: new Date().toISOString().split('T')[0]
  });
}));

router.get('/api/stock/:product_id', wrap(async (req, res) => {
  const pid = parseInt(req.params.product_id, 10);
  const wid = req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null;
  const customerType = req.query.customer_type || 'retail';
  const p = await pool.query(`SELECT id, name, stock, qty_per_pack, selling_price, default_commission_rate FROM products WHERE id=$1`, [pid]);
  const prod = p.rows[0];
  if (!prod) return res.json({ stock:0, qty_per_pack:1, name:'', commission:0, rate:0 });
  let stockPcs = Number(prod.stock) || 0;
  if (wid) {
    const ws = await pool.query(`SELECT quantity FROM warehouse_stock WHERE product_id=$1 AND warehouse_id=$2`, [pid, wid]);
    stockPcs = ws.rows[0] ? Number(ws.rows[0].quantity) : 0;
  }
  let rate = Number(prod.selling_price) || 0;
  const rl = await pool.query(`SELECT rate FROM rate_list WHERE product_id=$1 AND customer_type=$2 AND effective_date <= CURRENT_DATE ORDER BY effective_date DESC, id DESC LIMIT 1`, [pid, customerType]);
  if (rl.rows[0] && rl.rows[0].rate != null) rate = Number(rl.rows[0].rate);
  const qpp = prod.qty_per_pack || 1;
  const unit = (prod.unit || '').toUpperCase().trim();
  const pcsUnits = new Set(['PCS','PIECE','PIECES','EA','EACH','NOS','NO']);
  const isPcsUnit = !unit || pcsUnits.has(unit);
  let qpp_warning = null;
  if (!qpp || qpp < 1)             qpp_warning = 'qty_per_pack is zero or missing — check product master';
  else if (qpp === 1 && !isPcsUnit) qpp_warning = 'Pcs/Ctn = 1 for non-piece unit — verify with product master';
  else if (qpp > 500)              qpp_warning = `Pcs/Ctn = ${qpp} is unusually high — verify with product master`;
  res.json({
    stock: stockPcs,
    stock_ctn: qpp > 0 ? Math.floor(stockPcs/qpp) : 0,
    stock_loose: qpp > 0 ? stockPcs % qpp : stockPcs,
    qty_per_pack: qpp,
    name: prod.name,
    commission: Number(prod.default_commission_rate) || 0,
    rate,
    qpp_warning
  });
}));

router.post('/add', validate(schemas.orderCreate), wrap(async (req, res) => {
  const v = req.valid;
  if (v.bilty_no) v.bilty_no = _normBilty(v.bilty_no);
  const items = v._items || [];
  if (!items.length) return res.redirect('/orders/add?err=no_items');

  let subtotal = 0, totalComm = 0;
  for (const it of items) {
    it.amount = it.quantity * it.rate;
    it.commission_amount = it.amount * (it.commission_pct || 0) / 100;
    subtotal += it.amount; totalComm += it.commission_amount;
  }
  const total = subtotal - totalComm;

  const orderId = await tx(async (db) => {
    const orderNo = await nextDocNo(db, 'ORD', 'orders', 'order_no');
    const r = await db.run(`
      INSERT INTO orders(order_no,customer_id,warehouse_id,transport_id,bilty_no,order_date,delivery_date,
                         subtotal,commission_amount,total,status,account_scope,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12) RETURNING id`,
      [orderNo, v.customer_id, v.warehouse_id, v.transport_id, v.bilty_no, v.order_date, v.delivery_date,
       subtotal, totalComm, total, v.account_scope || 'plastic_markaz', v.notes]);
    const id = r.id;
    for (const it of items) {
      await db.run(`
        INSERT INTO order_items(order_id, product_id, packages, packaging, quantity, rate, amount, commission_pct, commission_amount)
        VALUES ($1,$2,COALESCE($3,0),COALESCE($4,1),$5,$6,$7,COALESCE($8,0),$9)`,
        [id, it.product_id, it.packages, it.packaging, it.quantity, it.rate, it.amount, it.commission_pct, it.commission_amount]);
    }
    await addAuditLog('create','orders', id, `Created order ${orderNo} total ${total}`);
    return id;
  });

  res.redirect('/orders/view/' + orderId);
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const o = await pool.query(`SELECT * FROM orders WHERE id=$1`, [id]);
  if (!o.rows[0]) return res.redirect('/orders');
  const [items, customers, products, warehouses, transports] = await Promise.all([
    pool.query(`SELECT oi.*, p.name AS product_name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id=$1`, [id]),
    pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name, qty_per_pack, selling_price AS rate, stock, default_commission_rate FROM products WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)
  ]);
  res.render('orders/form', {
    page:'orders', order: o.rows[0], items: items.rows,
    customers: customers.rows, products: products.rows, warehouses: warehouses.rows, transports: transports.rows,
    edit:true, today: new Date().toISOString().split('T')[0]
  });
}));

router.post('/edit/:id', validate(schemas.orderCreate), wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const v = req.valid;
  if (v.bilty_no) v.bilty_no = _normBilty(v.bilty_no);
  const items = v._items || [];
  if (!items.length) return res.redirect('/orders/edit/' + id + '?err=no_items');
  let subtotal=0, totalComm=0;
  for (const it of items) {
    it.amount = it.quantity * it.rate;
    it.commission_amount = it.amount * (it.commission_pct || 0) / 100;
    subtotal += it.amount; totalComm += it.commission_amount;
  }
  const total = subtotal - totalComm;
  await tx(async (db) => {
    await db.run(`UPDATE orders SET customer_id=$1,warehouse_id=$2,transport_id=$3,bilty_no=$4,order_date=$5,delivery_date=$6,
                   subtotal=$7,commission_amount=$8,total=$9,account_scope=$10,notes=$11 WHERE id=$12`,
      [v.customer_id, v.warehouse_id, v.transport_id, v.bilty_no, v.order_date, v.delivery_date,
       subtotal, totalComm, total, v.account_scope || 'plastic_markaz', v.notes, id]);
    await db.run(`DELETE FROM order_items WHERE order_id=$1`, [id]);
    for (const it of items) {
      await db.run(`INSERT INTO order_items(order_id,product_id,packages,packaging,quantity,rate,amount,commission_pct,commission_amount)
                    VALUES ($1,$2,COALESCE($3,0),COALESCE($4,1),$5,$6,$7,COALESCE($8,0),$9)`,
        [id, it.product_id, it.packages, it.packaging, it.quantity, it.rate, it.amount, it.commission_pct, it.commission_amount]);
    }
    await addAuditLog('update','orders', id, `Updated order total ${total}`);
  });
  res.redirect('/orders/view/' + id);
}));

router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const order = (await pool.query(`SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address, c.city AS customer_city FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [id])).rows[0];
  if (!order) return res.redirect('/orders');
  const items = (await pool.query(`SELECT oi.*, p.name AS product_name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1`, [id])).rows;
  const invoice = (await pool.query(`SELECT * FROM invoices WHERE order_id=$1`, [id])).rows[0] || null;
  const dc = (await pool.query(`SELECT * FROM delivery_challans WHERE order_id=$1`, [id])).rows[0] || null;
  res.render('orders/view', { page:'orders', order, items, invoice, dc });
}));

router.get('/print/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const order = (await pool.query(`SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address, c.city AS customer_city FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [id])).rows[0];
  if (!order) return res.status(404).send('Order not found');
  const items = (await pool.query(`SELECT oi.*, p.name AS product_name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1`, [id])).rows;
  res.render('orders/print', { page:'orders', order, items, settings: res.locals.appSettings || {}, layout:false });
}));

router.post('/delivery-challan/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const order = (await pool.query(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0];
  if (!order) return res.status(404).json({ error:'Order not found' });
  const ex = (await pool.query(`SELECT * FROM delivery_challans WHERE order_id=$1`, [id])).rows[0];
  if (ex) return res.json({ id: ex.id, dc_no: ex.dc_no });
  const result = await tx(async (db) => {
    const dcNo = await nextDocNo(db, 'DC', 'delivery_challans', 'dc_no');
    const r = await db.run(`INSERT INTO delivery_challans(dc_no, order_id, dc_date) VALUES ($1,$2,CURRENT_DATE) RETURNING id`, [dcNo, id]);
    return { id: r.id, dc_no: dcNo };
  });
  await addAuditLog('create','delivery_challans', result.id, `Generated DC ${result.dc_no}`);
  res.json(result);
}));

router.get('/challan/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const order = (await pool.query(`SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address, c.city AS customer_city FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [id])).rows[0];
  if (!order) return res.status(404).send('Order not found');
  const items = (await pool.query(`SELECT oi.*, p.name AS product_name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1`, [id])).rows;
  const dc = (await pool.query(`SELECT * FROM delivery_challans WHERE order_id=$1`, [id])).rows[0] || null;
  res.render('orders/challan', { page:'orders', order, items, dc, settings: res.locals.appSettings || {}, layout:false });
}));

router.post('/delete/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    await db.run(`DELETE FROM order_items WHERE order_id=$1`, [id]);
    await db.run(`DELETE FROM orders WHERE id=$1`, [id]);
  });
  await addAuditLog('delete','orders', id, 'Deleted');
  res.redirect('/orders');
}));

// Bulk operations on orders
router.post('/bulk', wrap(async (req, res) => {
  const action = req.body.action || '';
  const ids = (req.body.ids || '').split(',').map(s => toInt(s.trim())).filter(n => n > 0);
  if (!ids.length) return res.redirect('/orders?err=' + encodeURIComponent('No orders selected'));

  if (action === 'delete') {
    await tx(async (db) => {
      await db.run(`DELETE FROM order_items WHERE order_id=ANY($1::int[])`, [ids]);
      await db.run(`DELETE FROM orders WHERE id=ANY($1::int[])`, [ids]);
    });
    await addAuditLog('delete', 'orders', null, `Bulk deleted orders: ${ids.join(',')}`);
    return res.redirect('/orders?ok=' + encodeURIComponent(`${ids.length} order(s) deleted`));
  }

  if (action === 'mark_invoiced') {
    const r = await pool.query(`UPDATE orders SET status='invoiced' WHERE id=ANY($1::int[])`, [ids]);
    await addAuditLog('update', 'orders', null, `Bulk marked invoiced: ${ids.join(',')}`);
    return res.redirect('/orders?ok=' + encodeURIComponent(`${r.rowCount} order(s) updated`));
  }

  if (action === 'mark_pending') {
    const r = await pool.query(`UPDATE orders SET status='pending' WHERE id=ANY($1::int[])`, [ids]);
    await addAuditLog('update', 'orders', null, `Bulk marked pending: ${ids.join(',')}`);
    return res.redirect('/orders?ok=' + encodeURIComponent(`${r.rowCount} order(s) updated`));
  }

  res.redirect('/orders?err=' + encodeURIComponent('Unknown action'));
}));

// Generate invoice from single order
router.get('/generate-invoice/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const order = (await pool.query(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0];
  if (!order) return res.redirect('/orders');
  res.redirect(`/invoices/from-orders?customer_id=${order.customer_id}&from_orders=${id}`);
}));

router.post('/generate-invoice/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const order = (await pool.query(`SELECT customer_id FROM orders WHERE id=$1`, [id])).rows[0];
  if (!order) return res.redirect('/orders');
  res.redirect(`/invoices/from-orders?customer_id=${order.customer_id}&from_orders=${id}`);
}));

module.exports = router;
