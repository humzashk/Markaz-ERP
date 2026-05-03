'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, nextDocNo, applyStockMovement, reverseStockForRef,
        addLedgerEntry, removeLedgerForRef, recomputeBalance,
        getProductCost, addAuditLog, toInt, toNum } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas, requireEditPermission } = require('../middleware/validate');
const _lockInvoice = requireEditPermission('invoices', 'invoice_date');

router.get('/', wrap(async (req, res) => {
  const status = req.query.status || '';
  const search = req.query.search || '';
  const params = []; let i = 1;
  let sql = `SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE 1=1`;
  if (status) { sql += ` AND i.status=$${i}`; params.push(status); i++; }
  if (search) { sql += ` AND (i.invoice_no ILIKE $${i} OR c.name ILIKE $${i})`; params.push('%'+search+'%'); i++; }
  sql += ` ORDER BY i.id DESC LIMIT 500`;
  const r = await pool.query(sql, params);
  res.render('invoices/index', { page:'invoices', invoices: r.rows, status, search, ok: req.query.ok || null, err: req.query.err || null });
}));

router.get('/add', wrap(async (req, res) => {
  const [customers, products, warehouses, transports] = await Promise.all([
    pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name, qty_per_pack, selling_price AS rate, stock, default_commission_rate FROM products WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)
  ]);
  let items = []; let linkedOrderIds = []; let presetCustomerId = null;
  if (req.query.from_orders) {
    const ids = String(req.query.from_orders).split(',').map(s => parseInt(s,10)).filter(Boolean);
    if (ids.length) {
      const orders = (await pool.query(`SELECT id, customer_id FROM orders WHERE id = ANY($1::int[])`, [ids])).rows;
      if (orders.length) {
        presetCustomerId = orders[0].customer_id;
        linkedOrderIds = orders.map(o => o.id);
        const raw = (await pool.query(`
          SELECT oi.product_id, oi.quantity, oi.rate, oi.amount,
                 COALESCE(oi.packages,0) AS packages,
                 COALESCE(oi.packaging,1) AS packaging,
                 COALESCE(oi.commission_pct,0) AS commission_pct,
                 0 AS discount_per_pack,
                 p.name AS product_name
          FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ANY($1::int[])`, [ids])).rows;
        // Merge same product+rate+packaging+commission rows
        const merged = {};
        for (const it of raw) {
          const k = `${it.product_id}|${it.rate}|${it.packaging}|${it.commission_pct}`;
          if (!merged[k]) merged[k] = { ...it, packages:Number(it.packages), quantity:Number(it.quantity), amount:Number(it.amount) };
          else { merged[k].packages += Number(it.packages); merged[k].quantity += Number(it.quantity); merged[k].amount += Number(it.amount); }
        }
        items = Object.values(merged);
      }
    }
  }
  const invoice = presetCustomerId ? { customer_id: presetCustomerId } : null;
  res.render('invoices/form', {
    page:'invoices', invoice, items,
    customers: customers.rows, products: products.rows, warehouses: warehouses.rows, transports: transports.rows,
    linkedOrderIds, edit:false
  });
}));

router.get('/from-orders', wrap(async (req, res) => {
  const customers = (await pool.query(`
    SELECT DISTINCT c.id, c.name FROM customers c
    JOIN orders o ON o.customer_id = c.id
    WHERE o.status IN ('pending','confirmed') AND c.status='active'
    ORDER BY c.name
  `)).rows;
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id,10) : null;
  let orders = [];
  if (customerId) {
    orders = (await pool.query(`
      SELECT o.id, o.order_no, o.order_date, o.total,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
      FROM orders o WHERE o.customer_id=$1 AND o.status IN ('pending','confirmed')
      ORDER BY o.order_date DESC
    `, [customerId])).rows;
  }
  res.render('invoices/from-orders', { page:'invoices', customers, orders, customerId });
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
  const rate = Number(prod.selling_price) || 0;
  const qpp = prod.qty_per_pack || 1;
  // Flag suspicious qty_per_pack for the frontend warning system
  const unit = (prod.unit || '').toUpperCase().trim();
  const pcsUnits = new Set(['PCS','PIECE','PIECES','EA','EACH','NOS','NO']);
  const isPcsUnit = !unit || pcsUnits.has(unit);
  let qpp_warning = null;
  if (!qpp || qpp < 1)           qpp_warning = 'qty_per_pack is zero or missing — check product master';
  else if (qpp === 1 && !isPcsUnit) qpp_warning = 'Pcs/Ctn = 1 for non-piece unit — verify with product master';
  else if (qpp > 500)            qpp_warning = `Pcs/Ctn = ${qpp} is unusually high — verify with product master`;
  res.json({ stock: stockPcs, stock_ctn: qpp>0?Math.floor(stockPcs/qpp):0, stock_loose: qpp>0?stockPcs%qpp:stockPcs, qty_per_pack: qpp, name: prod.name, commission: Number(prod.default_commission_rate)||0, rate, qpp_warning });
}));

// Helper: normalise bilty_no ("42" or "BLT42" → "BLT-0042")
function _normBilty(s) {
  if (!s) return s;
  const m = s.match(/^(?:BLT-?)?(\d+)$/i);
  return m ? 'BLT-' + String(parseInt(m[1], 10)).padStart(4, '0') : s.toUpperCase();
}

// CREATE: atomic — invoice + items + stock OUT + customer DR (sale)
router.post('/add', validate(schemas.invoiceCreate), wrap(async (req, res) => {
  const v = req.valid;
  if (v.bilty_no) v.bilty_no = _normBilty(v.bilty_no);
  const items = v._items || [];
  if (!items.length) return res.redirect('/invoices/add?err=no_items');

  let subtotal = 0, totalComm = 0;
  // Freeze cost_at_sale BEFORE the transaction so getProductCost reflects committed cost.
  for (const it of items) {
    it.amount = it.quantity * it.rate;
    it.commission_amount = it.amount * (it.commission_pct || 0) / 100;
    it.discount_per_pack = it.discount_per_pack || 0;
    it.cost_at_sale = await getProductCost(null, it.product_id);
    subtotal += it.amount; totalComm += it.commission_amount;
  }
  const transportCharges = toNum(req.body.transport_charges, 0);
  const total = subtotal + transportCharges - totalComm;

  const orderIds = req.body.order_ids ? (Array.isArray(req.body.order_ids) ? req.body.order_ids : [req.body.order_ids]).map(toInt).filter(Boolean) : [];

  const newId = await tx(async (db) => {
    const invoiceNo = await nextDocNo(db, 'INV', 'invoices', 'invoice_no');
    let resolvedTransporter = req.body.transporter_name || null;
    if (v.transport_id) {
      const t = await db.one(`SELECT name FROM transports WHERE id=$1`, [v.transport_id]);
      if (t) resolvedTransporter = t.name;
    }
    const ins = await db.run(`
      INSERT INTO invoices(invoice_no, order_id, customer_id, warehouse_id, transport_id, bilty_no, transporter_name,
                            invoice_date, due_date, delivery_date,
                            subtotal, commission_amount, transport_charges, total, paid,
                            status, account_scope, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,'unpaid',$15,$16) RETURNING id`,
      [invoiceNo, orderIds[0] || null, v.customer_id, v.warehouse_id, v.transport_id, v.bilty_no, resolvedTransporter,
       v.invoice_date, v.due_date, v.delivery_date,
       subtotal, totalComm, transportCharges, total,
       v.account_scope || 'plastic_markaz', v.notes]);
    const invId = ins.id;

    for (const it of items) {
      await db.run(`
        INSERT INTO invoice_items(invoice_id,product_id,packages,packaging,quantity,rate,amount,commission_pct,commission_amount,discount_per_pack,cost_at_sale)
        VALUES ($1,$2,COALESCE($3,0),COALESCE($4,1),$5,$6,$7,COALESCE($8,0),$9,COALESCE($10,0),$11)`,
        [invId, it.product_id, it.packages, it.packaging, it.quantity, it.rate, it.amount,
         it.commission_pct, it.commission_amount, it.discount_per_pack, it.cost_at_sale]);
      await applyStockMovement(db, it.product_id, v.warehouse_id, -it.quantity, 'invoice', invId, 'sale', `Invoice ${invoiceNo}`);
    }

    // Mark linked orders invoiced
    if (orderIds.length) {
      await db.run(`UPDATE orders SET status='invoiced' WHERE id = ANY($1::int[]) AND status IN ('pending','confirmed')`, [orderIds]);
    }

    // Customer DEBIT = sale
    await addLedgerEntry(db, 'customer', v.customer_id, v.invoice_date, `Invoice ${invoiceNo}`, total, 0, 'invoice', invId, v.account_scope || 'plastic_markaz');

    await addAuditLog('create','invoices', invId, `Created invoice ${invoiceNo} total ${total}`);
    return invId;
  });

  res.redirect('/invoices/view/' + newId);
}));

router.get('/edit/:id', _lockInvoice, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const inv = (await pool.query(`SELECT * FROM invoices WHERE id=$1`, [id])).rows[0];
  if (!inv) return res.redirect('/invoices');
  const [items, customers, products, warehouses, transports] = await Promise.all([
    pool.query(`SELECT ii.*, p.name AS product_name FROM invoice_items ii JOIN products p ON p.id=ii.product_id WHERE ii.invoice_id=$1`, [id]),
    pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name, qty_per_pack, selling_price AS rate, stock, default_commission_rate FROM products WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)
  ]);
  res.render('invoices/form', {
    page:'invoices', invoice: inv, items: items.rows,
    customers: customers.rows, products: products.rows, warehouses: warehouses.rows, transports: transports.rows,
    pendingOrders: [], edit:true
  });
}));

router.post('/edit/:id', _lockInvoice, validate(schemas.invoiceCreate), wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const v = req.valid;
  if (v.bilty_no) v.bilty_no = _normBilty(v.bilty_no);
  const items = v._items || [];
  if (!items.length) return res.redirect('/invoices/edit/' + id + '?err=no_items');
  const transportCharges = toNum(req.body.transport_charges, 0);

  await tx(async (db) => {
    const existing = await db.one(`SELECT * FROM invoices WHERE id=$1`, [id]);
    if (!existing) throw new Error('Invoice not found');

    // Snapshot existing cost_at_sale per product to preserve historic profit on edit
    const old = await db.many(`SELECT product_id, cost_at_sale FROM invoice_items WHERE invoice_id=$1`, [id]);
    const oldCost = {}; for (const r of old) oldCost[r.product_id] = Number(r.cost_at_sale) || 0;

    let subtotal=0, totalComm=0;
    for (const it of items) {
      it.amount = it.quantity * it.rate;
      it.commission_amount = it.amount * (it.commission_pct || 0) / 100;
      it.discount_per_pack = it.discount_per_pack || 0;
      it.cost_at_sale = (oldCost[it.product_id] != null) ? oldCost[it.product_id] : await getProductCost(db, it.product_id);
      subtotal += it.amount; totalComm += it.commission_amount;
    }
    const total = subtotal + transportCharges - totalComm;

    let resolvedTransporter = req.body.transporter_name || null;
    if (v.transport_id) {
      const t = await db.one(`SELECT name FROM transports WHERE id=$1`, [v.transport_id]);
      if (t) resolvedTransporter = t.name;
    }

    // Reverse stock + ledger then re-apply
    await reverseStockForRef(db, 'invoice', id);
    await removeLedgerForRef(db, 'customer', existing.customer_id, 'invoice', id);
    await recomputeBalance(db, 'customer', existing.customer_id);

    await db.run(`UPDATE invoices SET customer_id=$1,warehouse_id=$2,transport_id=$3,bilty_no=$4,transporter_name=$5,
                    invoice_date=$6,due_date=$7,delivery_date=$8,
                    subtotal=$9,commission_amount=$10,transport_charges=$11,total=$12,
                    notes=$13, account_scope=$14
                  WHERE id=$15`,
      [v.customer_id, v.warehouse_id, v.transport_id, v.bilty_no, resolvedTransporter,
       v.invoice_date, v.due_date, v.delivery_date,
       subtotal, totalComm, transportCharges, total,
       v.notes, v.account_scope || existing.account_scope || 'plastic_markaz', id]);

    await db.run(`DELETE FROM invoice_items WHERE invoice_id=$1`, [id]);
    for (const it of items) {
      await db.run(`INSERT INTO invoice_items(invoice_id,product_id,packages,packaging,quantity,rate,amount,commission_pct,commission_amount,discount_per_pack,cost_at_sale)
                    VALUES ($1,$2,COALESCE($3,0),COALESCE($4,1),$5,$6,$7,COALESCE($8,0),$9,COALESCE($10,0),$11)`,
        [id, it.product_id, it.packages, it.packaging, it.quantity, it.rate, it.amount, it.commission_pct, it.commission_amount, it.discount_per_pack, it.cost_at_sale]);
      await applyStockMovement(db, it.product_id, v.warehouse_id, -it.quantity, 'invoice', id, 'sale-edit', `Invoice ${existing.invoice_no} (edited)`);
    }

    await addLedgerEntry(db, 'customer', v.customer_id, v.invoice_date, `Invoice ${existing.invoice_no}`, total, 0, 'invoice', id, v.account_scope || existing.account_scope || 'plastic_markaz');
    if (v.customer_id !== existing.customer_id) await recomputeBalance(db, 'customer', existing.customer_id);

    await addAuditLog('update','invoices', id, `Updated invoice ${existing.invoice_no} new total ${total}`);
  });

  res.redirect('/invoices/view/' + id);
}));

router.post('/delete/:id', _lockInvoice, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const existing = await db.one(`SELECT * FROM invoices WHERE id=$1`, [id]);
    if (!existing) return;
    await reverseStockForRef(db, 'invoice', id);
    await removeLedgerForRef(db, 'customer', existing.customer_id, 'invoice', id);
    await recomputeBalance(db, 'customer', existing.customer_id);
    await db.run(`DELETE FROM invoice_items WHERE invoice_id=$1`, [id]);
    await db.run(`DELETE FROM invoices WHERE id=$1`, [id]);
    await addAuditLog('delete','invoices', id, `Deleted invoice ${existing.invoice_no}`);
  });
  res.redirect('/invoices');
}));

router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const inv = (await pool.query(`
    SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address, c.city AS customer_city, c.default_commission_rate AS customer_commission
    FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [id])).rows[0];
  if (!inv) return res.redirect('/invoices');
  const items = (await pool.query(`SELECT ii.*, p.name AS product_name FROM invoice_items ii JOIN products p ON p.id=ii.product_id WHERE ii.invoice_id=$1`, [id])).rows;
  const bilty = (await pool.query(`SELECT * FROM bilty WHERE invoice_id=$1`, [id])).rows[0] || null;
  res.render('invoices/view', { page:'invoices', invoice: inv, items, bilty });
}));

// Bulk operations: status update, mark paid, etc.
router.get('/bulk', wrap(async (req, res) => {
  const customers = (await pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`)).rows;
  res.render('invoices/bulk', {
    page: 'invoices',
    customers,
    result: null
  });
}));

router.post('/bulk', wrap(async (req, res) => {
  const returnTo = req.body.return_to || '/invoices/bulk';
  const backOk  = (msg) => res.redirect(returnTo + '?ok='  + encodeURIComponent(msg));
  const backErr = (msg) => res.redirect(returnTo + '?err=' + encodeURIComponent(msg));

  const ids = (req.body.ids || '').split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
  if (!ids.length) return backErr('No invoices selected');

  const action = req.body.action || '';
  let updated = 0;

  if (action === 'mark_paid') {
    await tx(async (db) => {
      // Fetch invoices to be marked paid (only unpaid ones)
      const invs = await db.many(
        `SELECT id, customer_id, total, invoice_date, invoice_no, account_scope FROM invoices WHERE id = ANY($1::int[]) AND status != 'paid'`,
        [ids]
      );

      // For each invoice, create a payment ledger entry
      for (const inv of invs) {
        await addLedgerEntry(db, 'customer', inv.customer_id, inv.invoice_date,
          `Payment for invoice ${inv.invoice_no}`, 0, inv.total, 'invoice', inv.id, inv.account_scope || 'plastic_markaz');
      }

      // Now mark all invoices as paid
      const r = await db.run(
        `UPDATE invoices SET status='paid', paid=total WHERE id = ANY($1::int[]) AND status != 'paid'`,
        [ids]
      );
      updated = r.rowCount;
    });
    await addAuditLog('update', 'invoices', null, `Bulk marked paid: ${ids.join(',')}`);
  } else if (action === 'mark_unpaid') {
    await tx(async (db) => {
      // Fetch invoices that will be marked unpaid (currently paid ones)
      const invs = await db.many(
        `SELECT id, customer_id, status FROM invoices WHERE id = ANY($1::int[]) AND status = 'paid'`,
        [ids]
      );

      // Remove payment ledger entries for these invoices
      for (const inv of invs) {
        await removeLedgerForRef(db, 'customer', inv.customer_id, 'invoice', inv.id);
      }

      // Now mark all invoices as unpaid, reset paid to 0
      const r = await db.run(
        `UPDATE invoices SET status='unpaid', paid=0 WHERE id = ANY($1::int[])`,
        [ids]
      );
      updated = r.rowCount;
    });
    await addAuditLog('update', 'invoices', null, `Bulk marked unpaid: ${ids.join(',')}`);
  } else if (action === 'mark_cancelled') {
    await tx(async (db) => {
      // Fetch invoices being cancelled to remove any ledger entries
      const invs = await db.many(
        `SELECT id, customer_id FROM invoices WHERE id = ANY($1::int[])`,
        [ids]
      );

      // Remove invoice and payment ledger entries
      for (const inv of invs) {
        await removeLedgerForRef(db, 'customer', inv.customer_id, 'invoice', inv.id);
      }

      // Mark all invoices as cancelled
      const r = await db.run(
        `UPDATE invoices SET status='cancelled' WHERE id = ANY($1::int[])`,
        [ids]
      );
      updated = r.rowCount;
    });
    await addAuditLog('update', 'invoices', null, `Bulk cancelled: ${ids.join(',')}`);
  }

  else if (action === 'delete') {
    await tx(async (db) => {
      const invs = await db.many(
        `SELECT id, customer_id, invoice_no FROM invoices WHERE id = ANY($1::int[])`,
        [ids]
      );
      for (const inv of invs) {
        await reverseStockForRef(db, 'invoice', inv.id);
        await removeLedgerForRef(db, 'customer', inv.customer_id, 'invoice', inv.id);
        await recomputeBalance(db, 'customer', inv.customer_id);
        await db.run(`DELETE FROM invoice_items WHERE invoice_id=$1`, [inv.id]);
        await db.run(`DELETE FROM invoices WHERE id=$1`, [inv.id]);
      }
      updated = invs.length;
    });
    await addAuditLog('delete', 'invoices', null, `Bulk deleted invoices: ${ids.join(',')}`);
  }

  backOk(`${updated} invoice(s) updated`);
}));

router.get('/print/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const inv = (await pool.query(`
    SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address, c.city AS customer_city, c.category AS customer_category, c.default_commission_rate AS customer_commission
    FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [id])).rows[0];
  if (!inv) return res.redirect('/invoices');
  const items = (await pool.query(`SELECT ii.*, p.name AS product_name FROM invoice_items ii JOIN products p ON p.id=ii.product_id WHERE ii.invoice_id=$1`, [id])).rows;
  const bilty = (await pool.query(`SELECT * FROM bilty WHERE invoice_id=$1`, [id])).rows[0] || null;
  res.render('invoices/print', { page:'invoices', invoice: inv, items, bilty, settings: res.locals.appSettings || {}, layout:false });
}));

module.exports = router;
