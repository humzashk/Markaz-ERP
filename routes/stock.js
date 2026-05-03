'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, applyStockMovement, reverseStockForRef, addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas, requireEditPermission } = require('../middleware/validate');
const _lockStock = requireEditPermission('stock_adjustments', 'adj_date');

router.get('/', wrap(async (req, res) => {
  const search = req.query.search || '';
  const type = req.query.type || '';
  const params = [];
  let sql = `SELECT sa.*, p.name AS product_name, p.unit, w.name AS warehouse_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    WHERE 1=1`;
  if (search) { sql += ` AND p.name ILIKE $${params.length + 1}`; params.push('%'+search+'%'); }
  if (type) { sql += ` AND sa.adjustment_type = $${params.length + 1}`; params.push(type); }
  sql += ` ORDER BY sa.id DESC LIMIT 500`;
  const r = await pool.query(sql, params);
  res.render('stock/index', { page:'stock', adjustments: r.rows, search, type });
}));

router.get('/add', wrap(async (req, res) => {
  const products = (await pool.query(`SELECT id, name, unit, qty_per_pack, stock FROM products WHERE status='active' ORDER BY name`)).rows;
  const warehouses = (await pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`)).rows;
  res.render('stock/form', { page:'stock', products, warehouses, edit:false, adj:null, adjType: req.query.type || '' });
}));

router.post('/add', validate(schemas.stockAdjust), wrap(async (req, res) => {
  const v = req.valid;
  await tx(async (db) => {
    // v.quantity is in Ctn — convert to PCS for stock movement
    const prod = await db.one(`SELECT qty_per_pack FROM products WHERE id=$1`, [v.product_id]);
    const qpp = Math.max(1, prod ? (prod.qty_per_pack || 1) : 1);
    const deltaPcs = v.quantity * qpp;           // PCS for stock ledger
    const positive = ['add','return','transfer_in'].includes(v.adjustment_type);
    const ins = await db.run(`
      INSERT INTO stock_adjustments(product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [v.product_id, v.warehouse_id, v.adjustment_type, v.quantity, v.reason, v.reference, v.adj_date, v.notes]);
    // quantity stored in stock_adjustments is Ctn (user-facing); stock ledger uses PCS
    await applyStockMovement(db, v.product_id, v.warehouse_id, positive ? deltaPcs : -deltaPcs, 'stock_adjustment', ins.id, v.adjustment_type, v.reason || null);
    await addAuditLog('create','stock_adjustments', ins.id, `${v.adjustment_type} ${v.quantity} Ctn`);
  });
  res.redirect('/stock');
}));

router.get('/edit/:id', _lockStock, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const adj = (await pool.query(`
    SELECT sa.*, p.name AS product_name, w.name AS warehouse_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    WHERE sa.id = $1`, [id])).rows[0];
  if (!adj) return res.redirect('/stock');
  // Normalise adj_date to YYYY-MM-DD string for <input type="date">
  if (adj.adj_date) adj.adj_date = new Date(adj.adj_date).toISOString().split('T')[0];
  const products   = (await pool.query(`SELECT id, name, unit, qty_per_pack, stock FROM products WHERE status='active' ORDER BY name`)).rows;
  const warehouses = (await pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`)).rows;
  res.render('stock/edit', { page:'stock', adj, products, warehouses });
}));

router.post('/edit/:id', _lockStock, validate(schemas.stockAdjust), wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const v  = req.valid;
  await tx(async (db) => {
    const existing = await db.one(`SELECT * FROM stock_adjustments WHERE id=$1`, [id]);
    if (!existing) throw new Error('Adjustment not found');
    // v.quantity is in Ctn — convert to PCS for stock movement
    const prod = await db.one(`SELECT qty_per_pack FROM products WHERE id=$1`, [v.product_id]);
    const qpp = Math.max(1, prod ? (prod.qty_per_pack || 1) : 1);
    const deltaPcs = v.quantity * qpp;
    const positive = ['add','return','transfer_in'].includes(v.adjustment_type);
    // Reverse the old stock movement then re-apply with new values
    await reverseStockForRef(db, 'stock_adjustment', id);
    await db.run(`
      UPDATE stock_adjustments
      SET product_id=$1, warehouse_id=$2, adjustment_type=$3, quantity=$4,
          reason=$5, reference=$6, adj_date=$7, notes=$8
      WHERE id=$9`,
      [v.product_id, v.warehouse_id, v.adjustment_type, v.quantity,
       v.reason, v.reference, v.adj_date, v.notes, id]);
    await applyStockMovement(db, v.product_id, v.warehouse_id, positive ? deltaPcs : -deltaPcs, 'stock_adjustment', id, v.adjustment_type, v.reason || null);
    await addAuditLog('update','stock_adjustments', id, `Edited: ${v.adjustment_type} ${v.quantity} Ctn`);
  });
  res.redirect('/stock');
}));

router.post('/delete/:id', _lockStock, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const existing = await db.one(`SELECT * FROM stock_adjustments WHERE id=$1`, [id]);
    if (!existing) return;
    await reverseStockForRef(db, 'stock_adjustment', id);
    await db.run(`DELETE FROM stock_adjustments WHERE id=$1`, [id]);
    await addAuditLog('delete','stock_adjustments', id, `Deleted adjustment`);
  });
  res.redirect('/stock');
}));

router.get('/print/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const adj = (await pool.query(`
    SELECT sa.*, p.name AS product_name, p.unit, w.name AS warehouse_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    WHERE sa.id = $1`, [id])).rows[0];
  if (!adj) return res.status(404).send('Adjustment not found');
  res.render('stock/print', {
    page:'stock', adj,
    settings: res.locals.appSettings || {}, layout: false
  });
}));

router.get('/position', wrap(async (req, res) => {
  const warehouseId = toInt(req.query.warehouse_id) || null;
  const warehouses = (await pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`)).rows;
  let sql, params;
  if (warehouseId) {
    sql = `SELECT p.id, p.name, p.unit, p.min_stock, p.qty_per_pack,
             COALESCE(ws.quantity,0) AS stock,
             (COALESCE(ws.quantity,0) * p.cost_price)::NUMERIC(14,2) AS stock_value
           FROM products p
           LEFT JOIN warehouse_stock ws ON ws.product_id=p.id AND ws.warehouse_id=$1
           WHERE p.status='active' ORDER BY p.name`;
    params = [warehouseId];
  } else {
    sql = `SELECT p.id, p.name, p.unit, p.stock, p.min_stock, p.qty_per_pack,
             (p.stock * p.cost_price)::NUMERIC(14,2) AS stock_value
           FROM products p WHERE p.status='active' ORDER BY p.name`;
    params = [];
  }
  const products = (await pool.query(sql, params)).rows;
  res.render('stock/position', { page:'stock-position', products, position: products, warehouses, warehouseId });
}));

router.get('/ledger', wrap(async (req, res) => {
  const productId = toInt(req.query.product_id);
  const products = (await pool.query(`SELECT id, name FROM products WHERE status='active' ORDER BY name`)).rows;
  let movements = []; let product = null;
  if (productId) {
    product = (await pool.query(`SELECT * FROM products WHERE id=$1`, [productId])).rows[0];
    // Include running balance and qty_per_pack for Ctn conversion
    movements = (await pool.query(`
      SELECT sl.*, w.name AS warehouse_name,
        SUM(sl.qty_delta) OVER (ORDER BY sl.id ROWS UNBOUNDED PRECEDING) AS running_balance_pcs
      FROM stock_ledger sl LEFT JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE sl.product_id=$1 ORDER BY sl.id DESC LIMIT 500`, [productId])).rows;
  }
  res.render('stock/ledger', { page:'stock', products, productId, product, movements });
}));

router.get('/movements', wrap(async (req, res) => {
  const search = req.query.search || '';
  const type   = req.query.type   || '';
  const params = [];
  const conditions = ['1=1'];

  if (search) {
    conditions.push(`p.name ILIKE $${params.length + 1}`);
    params.push('%' + search + '%');
  }
  if (type === 'inbound')  conditions.push(`sl.qty_delta > 0`);
  if (type === 'outbound') conditions.push(`sl.qty_delta < 0`);

  const sql = `
    SELECT
      sl.id,
      COALESCE(inv.invoice_date, pur.purchase_date, ord.order_date, CURRENT_DATE) AS movement_date,
      p.name  AS product_name,
      p.id    AS product_id,
      p.qty_per_pack,
      ABS(sl.qty_delta) AS quantity,
      sl.qty_delta,
      sl.ref_type,
      sl.ref_id,
      sl.reason,
      CASE
        WHEN sl.ref_type IN ('invoice','sale','sale-edit')       THEN 'Invoice'
        WHEN sl.ref_type IN ('purchase','purchase-edit')         THEN 'Purchase'
        WHEN sl.ref_type = 'order'                              THEN 'Order'
        WHEN sl.ref_type = 'credit_note'                        THEN 'Credit Note'
        WHEN sl.ref_type = 'debit_note'                         THEN 'Debit Note'
        WHEN sl.ref_type = 'stock_adjustment'                   THEN 'Adjustment'
        WHEN sl.ref_type = 'reverse'                            THEN 'Reversal'
        ELSE COALESCE(sl.ref_type, '-')
      END AS doc_type,
      COALESCE(c.name, v.name, '-')                             AS party_name,
      CASE WHEN c.id IS NOT NULL THEN 'Customer'
           WHEN v.id IS NOT NULL THEN 'Vendor'
           ELSE 'Internal' END                                   AS party_type,
      COALESCE(inv.invoice_no, pur.purchase_no, ord.order_no,
               CAST(sl.ref_id AS TEXT), '-')                    AS reference_number,
      inv.id   AS invoice_id,
      pur.id   AS purchase_id,
      ord.id   AS order_id,
      w.name   AS warehouse_name
    FROM stock_ledger sl
    JOIN    products   p   ON p.id  = sl.product_id
    LEFT JOIN warehouses w ON w.id  = sl.warehouse_id
    LEFT JOIN invoices  inv ON sl.ref_type IN ('invoice','sale','sale-edit')   AND inv.id = sl.ref_id
    LEFT JOIN orders    ord ON sl.ref_type = 'order'                           AND ord.id = sl.ref_id
    LEFT JOIN purchases pur ON sl.ref_type IN ('purchase','purchase-edit')     AND pur.id = sl.ref_id
    LEFT JOIN customers c   ON c.id = COALESCE(inv.customer_id, ord.customer_id)
    LEFT JOIN vendors   v   ON v.id = pur.vendor_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY sl.id DESC
    LIMIT 500`;

  const movements = (await pool.query(sql, params)).rows;
  res.render('stock/movements', { page:'stock', movements, search, type });
}));

module.exports = router;
