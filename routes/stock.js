'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, applyStockMovement, addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

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
  const products = (await pool.query(`SELECT id, name, unit, stock FROM products WHERE status='active' ORDER BY name`)).rows;
  const warehouses = (await pool.query(`SELECT id, name FROM warehouses WHERE status='active' ORDER BY name`)).rows;
  res.render('stock/form', { page:'stock', products, warehouses, edit:false, adj:null, adjType: req.query.type || '' });
}));

router.post('/add', validate(schemas.stockAdjust), wrap(async (req, res) => {
  const v = req.valid;
  await tx(async (db) => {
    const ins = await db.run(`
      INSERT INTO stock_adjustments(product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [v.product_id, v.warehouse_id, v.adjustment_type, v.quantity, v.reason, v.reference, v.adj_date, v.notes]);
    const positive = ['add','return','transfer_in'].includes(v.adjustment_type);
    const delta = positive ? +v.quantity : -v.quantity;
    await applyStockMovement(db, v.product_id, v.warehouse_id, delta, 'stock_adjustment', ins.id, v.adjustment_type, v.reason || null);
    await addAuditLog('create','stock_adjustments', ins.id, `${v.adjustment_type} ${v.quantity}`);
  });
  res.redirect('/stock');
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
    movements = (await pool.query(`
      SELECT sl.*, w.name AS warehouse_name
      FROM stock_ledger sl LEFT JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE sl.product_id=$1 ORDER BY sl.id DESC LIMIT 500`, [productId])).rows;
  }
  res.render('stock/ledger', { page:'stock', products, productId, product, movements });
}));

module.exports = router;
