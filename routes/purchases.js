'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, nextDocNo, applyStockMovement, reverseStockForRef,
        addLedgerEntry, removeLedgerForRef, recomputeBalance,
        addAuditLog, toInt, toNum } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas, requireEditPermission, isOlderThan2Years } = require('../middleware/validate');
const _lockPurchase = requireEditPermission('purchases', 'purchase_date');

router.get('/', wrap(async (req, res) => {
  const search = req.query.search || '';
  const params = []; let i=1;
  let sql = `SELECT p.*, v.name AS vendor_name FROM purchases p JOIN vendors v ON v.id = p.vendor_id WHERE 1=1`;
  if (search) { sql += ` AND (p.purchase_no ILIKE $${i} OR v.name ILIKE $${i})`; params.push('%'+search+'%'); i++; }
  sql += ` ORDER BY p.id DESC LIMIT 500`;
  const r = await pool.query(sql, params);
  res.render('purchases/index', { page:'purchases', purchases: r.rows, search, ok: req.query.ok || null, err: req.query.err || null });
}));

router.get('/add', wrap(async (req, res) => {
  const [vendors, products, warehouses, transports] = await Promise.all([
    pool.query(`SELECT id, name FROM vendors WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name, qty_per_pack, cost_price AS rate, cost_price AS selling_price, stock, default_commission_rate FROM products WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)
  ]);
  res.render('purchases/form', { page:'purchases', purchase:null, items:[],
    vendors: vendors.rows, products: products.rows, warehouses: warehouses.rows, transports: transports.rows, edit:false });
}));

router.post('/add', validate(schemas.purchaseCreate), wrap(async (req, res) => {
  const v = req.valid; const items = v._items || [];
  if (!items.length) return res.redirect('/purchases/add?err=no_items');

  let subtotal = 0;
  for (const it of items) { it.amount = it.quantity * it.rate; subtotal += it.amount; }
  const discount = toNum(req.body.discount, 0);
  const deliveryCharges = toNum(req.body.delivery_charges, 0);
  const total = subtotal - discount + deliveryCharges;

  const newId = await tx(async (db) => {
    const purchaseNo = await nextDocNo(db, 'PUR', 'purchases', 'purchase_no');
    const ins = await db.run(`
      INSERT INTO purchases(purchase_no, vendor_id, warehouse_id, transport_id, bilty_no,
                            purchase_date, delivery_date,
                            subtotal, discount, delivery_charges, commission_amount, total, status, account_scope, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,'received',$12,$13) RETURNING id`,
      [purchaseNo, v.vendor_id, v.warehouse_id, v.transport_id, v.bilty_no,
       v.purchase_date, v.delivery_date,
       subtotal, discount, deliveryCharges, total,
       v.account_scope || 'plastic_markaz', v.notes]);
    const pid = ins.id;
    for (const it of items) {
      await db.run(`
        INSERT INTO purchase_items(purchase_id,product_id,packages,packaging,quantity,rate,amount,discount_per_pack,commission_pct,commission_amount)
        VALUES ($1,$2,COALESCE($3,0),COALESCE($4,1),$5,$6,$7,0,0,0)`,
        [pid, it.product_id, it.packages, it.packaging, it.quantity, it.rate, it.amount]);
      await applyStockMovement(db, it.product_id, v.warehouse_id, +it.quantity, 'purchase', pid, 'purchase', `Purchase ${purchaseNo}`);
      await db.run(`UPDATE products SET cost_price=$1 WHERE id=$2`, [it.rate, it.product_id]);
    }
    // Vendor CREDIT = purchase
    await addLedgerEntry(db, 'vendor', v.vendor_id, v.purchase_date, `Purchase ${purchaseNo}`, 0, total, 'purchase', pid, v.account_scope || 'plastic_markaz');
    await addAuditLog('create','purchases', pid, `Created purchase ${purchaseNo} total ${total}`);
    return pid;
  });

  res.redirect('/purchases/view/' + newId);
}));

router.get('/edit/:id', _lockPurchase, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const p = (await pool.query(`SELECT * FROM purchases WHERE id=$1`, [id])).rows[0];
  if (!p) return res.redirect('/purchases');
  const [items, vendors, products, warehouses, transports] = await Promise.all([
    pool.query(`SELECT pi.*, pr.name AS product_name FROM purchase_items pi JOIN products pr ON pr.id=pi.product_id WHERE pi.purchase_id=$1`, [id]),
    pool.query(`SELECT id, name FROM vendors WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name, qty_per_pack, cost_price AS rate, cost_price AS selling_price, stock, default_commission_rate FROM products WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
    pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)
  ]);
  res.render('purchases/form', { page:'purchases', purchase: p, items: items.rows,
    vendors: vendors.rows, products: products.rows, warehouses: warehouses.rows, transports: transports.rows, edit:true });
}));

router.post('/edit/:id', _lockPurchase, validate(schemas.purchaseCreate), wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const v = req.valid; const items = v._items || [];
  if (!items.length) return res.redirect('/purchases/edit/' + id + '?err=no_items');
  let subtotal=0; for (const it of items) { it.amount = it.quantity * it.rate; subtotal += it.amount; }
  const discount = toNum(req.body.discount, 0);
  const deliveryCharges = toNum(req.body.delivery_charges, 0);
  const total = subtotal - discount + deliveryCharges;

  await tx(async (db) => {
    const existing = await db.one(`SELECT * FROM purchases WHERE id=$1`, [id]);
    if (!existing) throw new Error('Purchase not found');
    await reverseStockForRef(db, 'purchase', id);
    await removeLedgerForRef(db, 'vendor', existing.vendor_id, 'purchase', id);
    await recomputeBalance(db, 'vendor', existing.vendor_id);

    await db.run(`UPDATE purchases SET vendor_id=$1, warehouse_id=$2, transport_id=$3, bilty_no=$4,
                    purchase_date=$5, delivery_date=$6, subtotal=$7, discount=$8, delivery_charges=$9, total=$10,
                    notes=$11, account_scope=$12 WHERE id=$13`,
      [v.vendor_id, v.warehouse_id, v.transport_id, v.bilty_no,
       v.purchase_date, v.delivery_date, subtotal, discount, deliveryCharges, total,
       v.notes, v.account_scope || existing.account_scope || 'plastic_markaz', id]);

    await db.run(`DELETE FROM purchase_items WHERE purchase_id=$1`, [id]);
    for (const it of items) {
      await db.run(`INSERT INTO purchase_items(purchase_id,product_id,packages,packaging,quantity,rate,amount,discount_per_pack,commission_pct,commission_amount)
                    VALUES ($1,$2,COALESCE($3,0),COALESCE($4,1),$5,$6,$7,0,0,0)`,
        [id, it.product_id, it.packages, it.packaging, it.quantity, it.rate, it.amount]);
      await applyStockMovement(db, it.product_id, v.warehouse_id, +it.quantity, 'purchase', id, 'purchase-edit', `Purchase ${existing.purchase_no} (edited)`);
      await db.run(`UPDATE products SET cost_price=$1 WHERE id=$2`, [it.rate, it.product_id]);
    }
    await addLedgerEntry(db, 'vendor', v.vendor_id, v.purchase_date, `Purchase ${existing.purchase_no}`, 0, total, 'purchase', id, v.account_scope || existing.account_scope || 'plastic_markaz');
    if (v.vendor_id !== existing.vendor_id) await recomputeBalance(db, 'vendor', existing.vendor_id);
    await addAuditLog('update','purchases', id, `Updated purchase ${existing.purchase_no} total ${total}`);
  });

  res.redirect('/purchases/view/' + id);
}));

router.post('/delete/:id', _lockPurchase, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const existing = await db.one(`SELECT * FROM purchases WHERE id=$1`, [id]);
    if (!existing) return;
    await reverseStockForRef(db, 'purchase', id);
    await removeLedgerForRef(db, 'vendor', existing.vendor_id, 'purchase', id);
    await recomputeBalance(db, 'vendor', existing.vendor_id);
    await db.run(`DELETE FROM purchase_items WHERE purchase_id=$1`, [id]);
    await db.run(`DELETE FROM purchases WHERE id=$1`, [id]);
    await addAuditLog('delete','purchases', id, `Deleted purchase ${existing.purchase_no}`);
  });
  res.redirect('/purchases');
}));

router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const purchase = (await pool.query(`SELECT p.*, v.name AS vendor_name, v.phone AS vendor_phone, v.address AS vendor_address, v.city AS vendor_city FROM purchases p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=$1`, [id])).rows[0];
  if (!purchase) return res.redirect('/purchases');
  const items = (await pool.query(`SELECT pi.*, pr.name AS product_name FROM purchase_items pi JOIN products pr ON pr.id=pi.product_id WHERE pi.purchase_id=$1`, [id])).rows;
  res.render('purchases/view', { page:'purchases', purchase, items });
}));

router.get('/print/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const purchase = (await pool.query(`
    SELECT p.*, v.name AS vendor_name, v.phone AS vendor_phone,
           v.address AS vendor_address, v.city AS vendor_city, v.ntn AS vendor_ntn
    FROM purchases p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=$1`, [id])).rows[0];
  if (!purchase) return res.status(404).send('Purchase not found');
  const items = (await pool.query(`SELECT pi.*, pr.name AS product_name, pr.unit FROM purchase_items pi JOIN products pr ON pr.id=pi.product_id WHERE pi.purchase_id=$1`, [id])).rows;
  res.render('purchases/print', {
    page:'purchases', purchase, items,
    settings: res.locals.appSettings || {}, layout: false
  });
}));

// Bulk operations on purchases
router.post('/bulk', wrap(async (req, res) => {
  const action = req.body.action || '';
  const ids = (req.body.ids || '').split(',').map(s => toInt(s.trim())).filter(n => n > 0);
  if (!ids.length) return res.redirect('/purchases?err=' + encodeURIComponent('No purchases selected'));

  if (action === 'delete') {
    // Age-gate each record before bulk delete
    const rows = (await pool.query(`SELECT id, vendor_id, purchase_no, purchase_date FROM purchases WHERE id=ANY($1::int[])`, [ids])).rows;
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const locked = rows.filter(r => isOlderThan2Years(r.purchase_date));
    if (locked.length && !isSuperadmin) {
      return res.redirect('/purchases?err=' + encodeURIComponent(
        `${locked.length} purchase(s) are older than 2 years and cannot be deleted`));
    }
    // Log superadmin override for every locked record before proceeding
    for (const r of locked) {
      await addAuditLog('superadmin_override', 'purchases', r.id,
        `Superadmin bulk-deleted purchase older than 2 years (purchase_date: ${r.purchase_date})`,
        req.user && req.user.id, r, null);
    }
    await tx(async (db) => {
      for (const p of rows) {
        await reverseStockForRef(db, 'purchase', p.id);
        await removeLedgerForRef(db, 'vendor', p.vendor_id, 'purchase', p.id);
        await recomputeBalance(db, 'vendor', p.vendor_id);
        await db.run(`DELETE FROM purchase_items WHERE purchase_id=$1`, [p.id]);
        await db.run(`DELETE FROM purchases WHERE id=$1`, [p.id]);
      }
    });
    await addAuditLog('delete', 'purchases', null, `Bulk deleted purchases: ${ids.join(',')}`);
    return res.redirect('/purchases?ok=' + encodeURIComponent(`${ids.length} purchase(s) deleted`));
  }

  if (action === 'mark_paid') {
    const r = await pool.query(`UPDATE purchases SET status='paid' WHERE id=ANY($1::int[])`, [ids]);
    await addAuditLog('update', 'purchases', null, `Bulk marked paid: ${ids.join(',')}`);
    return res.redirect('/purchases?ok=' + encodeURIComponent(`${r.rowCount} purchase(s) updated`));
  }

  if (action === 'mark_unpaid') {
    const r = await pool.query(`UPDATE purchases SET status='unpaid' WHERE id=ANY($1::int[])`, [ids]);
    await addAuditLog('update', 'purchases', null, `Bulk marked unpaid: ${ids.join(',')}`);
    return res.redirect('/purchases?ok=' + encodeURIComponent(`${r.rowCount} purchase(s) updated`));
  }

  res.redirect('/purchases?err=' + encodeURIComponent('Unknown action'));
}));

module.exports = router;
