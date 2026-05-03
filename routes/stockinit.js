'use strict';
const express = require('express');
const router  = express.Router();
const { pool, tx, applyStockMovement, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');

// GET /stockinit?page=1&search=
router.get('/', wrap(async (req, res) => {
  const search  = (req.query.search || '').trim();
  const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit   = 50;
  const offset  = (page - 1) * limit;

  const whereSql = search
    ? `WHERE p.status='active' AND (p.name ILIKE $3 OR p.item_id ILIKE $3)`
    : `WHERE p.status='active'`;
  const params = search ? [limit, offset, `%${search}%`] : [limit, offset];

  const [prodR, warehR, countR] = await Promise.all([
    pool.query(`
      SELECT p.id, p.item_id, p.name, p.unit, p.qty_per_pack, p.stock,
             COALESCE(
               json_agg(json_build_object('wid', ws.warehouse_id, 'qty', ws.quantity))
               FILTER (WHERE ws.warehouse_id IS NOT NULL), '[]'
             ) AS wstock
      FROM products p
      LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
      ${whereSql}
      GROUP BY p.id
      ORDER BY p.name
      LIMIT $1 OFFSET $2`, params),
    pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
    pool.query(`SELECT COUNT(*) FROM products p ${whereSql}`,
               search ? [`%${search}%`] : []),
  ]);

  const total = parseInt(countR.rows[0].count, 10);
  const pages = Math.ceil(total / limit);

  res.render('stockinit/index', {
    page: 'stockinit',
    products:   prodR.rows,
    warehouses: warehR.rows,
    search, currentPage: page, pages, total,
    saved:      req.query.saved || null,
    err:        req.query.err   || null,
    rowErrors:  [],
  });
}));

// POST /stockinit/save  — bulk save with full validation
router.post('/save', wrap(async (req, res) => {
  const raw  = req.body.rows;
  const rows = Array.isArray(raw) ? raw : (raw ? [raw] : []);

  // ── Build active rows (non-blank) ──────────────────────────────────────────
  const active = [];
  for (const row of rows) {
    const productId   = toInt(row.product_id);
    const warehouseId = toInt(row.warehouse_id) || null;
    const ctn         = parseInt(row.ctn, 10) || 0;
    const pcs         = parseInt(row.pcs, 10) || 0;
    const qtyPerPack  = Math.max(1, parseInt(row.qty_per_pack, 10) || 1);
    const productName = (row.product_name || '').trim();

    if (!productId || row._sel !== '1' || (ctn === 0 && pcs === 0)) continue;
    active.push({ productId, warehouseId, ctn, pcs, qtyPerPack, productName });
  }

  if (!active.length) return res.redirect('/stockinit?err=no_rows');

  // ── Server-side validations ────────────────────────────────────────────────
  const rowErrors = [];

  // 1. Negative values
  for (const r of active) {
    if (r.ctn < 0 || r.pcs < 0)
      rowErrors.push({ name: r.productName, reason: 'Negative CTN or PCS is not allowed.' });
  }

  // 2. Duplicate product+warehouse combos
  const seen = new Map();
  for (const r of active) {
    const key = `${r.productId}|${r.warehouseId ?? 'null'}`;
    if (seen.has(key))
      rowErrors.push({ name: r.productName, reason: 'Duplicate entry for same product + warehouse.' });
    else
      seen.set(key, true);
  }

  // 3. Validate warehouses exist
  const wids = [...new Set(active.map(r => r.warehouseId).filter(Boolean))];
  if (wids.length) {
    const check    = await pool.query(`SELECT id FROM warehouses WHERE id = ANY($1::int[]) AND status='active'`, [wids]);
    const validSet = new Set(check.rows.map(r => r.id));
    for (const r of active) {
      if (r.warehouseId && !validSet.has(r.warehouseId))
        rowErrors.push({ name: r.productName, reason: `Warehouse ID ${r.warehouseId} not found or inactive.` });
    }
  }

  // 4. total_qty must be > 0
  for (const r of active) {
    const total = r.pcs + (r.ctn * r.qtyPerPack);
    if (total <= 0)
      rowErrors.push({ name: r.productName, reason: 'Total quantity must be greater than 0.' });
  }

  // If any validation failed → re-render with errors (no DB write)
  if (rowErrors.length) {
    const search = (req.body._search || '').trim();
    const page   = Math.max(1, parseInt(req.body._page, 10) || 1);
    const limit  = 50;
    const offset = (page - 1) * limit;
    const whereSql = search
      ? `WHERE p.status='active' AND (p.name ILIKE $3 OR p.item_id ILIKE $3)`
      : `WHERE p.status='active'`;
    const params = search ? [limit, offset, `%${search}%`] : [limit, offset];
    const [prodR, warehR, countR] = await Promise.all([
      pool.query(`SELECT p.id, p.item_id, p.name, p.unit, p.qty_per_pack, p.stock,
                  COALESCE(json_agg(json_build_object('wid',ws.warehouse_id,'qty',ws.quantity))
                  FILTER (WHERE ws.warehouse_id IS NOT NULL),'[]') AS wstock
                  FROM products p LEFT JOIN warehouse_stock ws ON ws.product_id=p.id
                  ${whereSql} GROUP BY p.id ORDER BY p.name LIMIT $1 OFFSET $2`, params),
      pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`),
      pool.query(`SELECT COUNT(*) FROM products p ${whereSql}`, search ? [`%${search}%`] : []),
    ]);
    const total = parseInt(countR.rows[0].count, 10);
    return res.render('stockinit/index', {
      page: 'stockinit',
      products:    prodR.rows,
      warehouses:  warehR.rows,
      search, currentPage: page, pages: Math.ceil(total / limit), total,
      saved: null, err: null, rowErrors,
    });
  }

  // ── All valid → commit in one transaction ──────────────────────────────────
  let saved = 0;
  await tx(async (db) => {
    for (const r of active) {
      const totalQty = r.pcs + (r.ctn * r.qtyPerPack);
      await applyStockMovement(
        db, r.productId, r.warehouseId, totalQty,
        'opening', null, 'opening', 'Opening stock initialization'
      );
      saved++;
    }
  });

  res.redirect(`/stockinit?saved=${saved}`);
}));

module.exports = router;
