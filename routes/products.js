'use strict';
const express = require('express');
const router = express.Router();
const { pool, addAuditLog } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const search = req.query.search || '';
  const stock  = req.query.stock || '';
  const params = []; let i = 1;
  let sql = `SELECT *, selling_price AS rate FROM products WHERE 1=1`;
  if (search) { sql += ` AND (name ILIKE $${i} OR item_id ILIKE $${i} OR category ILIKE $${i})`; params.push('%'+search+'%'); i++; }
  if (stock === 'low')      sql += ` AND stock <= COALESCE(min_stock,0)`;
  else if (stock === 'out') sql += ` AND stock <= 0`;
  else if (stock === 'negative') sql += ` AND stock < 0`;
  sql += ` ORDER BY id DESC`;
  const r = await pool.query(sql, params);
  const v = await pool.query(`SELECT id, name FROM vendors WHERE status='active' ORDER BY name`);
  res.render('products/index', { page:'products', products: r.rows, vendors: v.rows, search, stock });
}));

router.get('/add', wrap(async (req, res) => {
  const c = await pool.query(`SELECT name FROM product_categories ORDER BY sort_order, name`);
  const v = await pool.query(`SELECT id, name FROM vendors WHERE status='active' ORDER BY name`);
  res.render('products/form', { page:'products', product:null, categories: c.rows, vendors: v.rows, edit:false });
}));

router.post('/add', validate(schemas.productCreate), wrap(async (req, res) => {
  const v = req.valid;
  // Form uses `rate` for sell price (legacy alias)
  const sellPrice = v.selling_price != null ? v.selling_price : (req.body.rate != null ? Number(req.body.rate) || 0 : 0);
  const r = await pool.query(`
    INSERT INTO products(item_id,name,category,unit,qty_per_pack,cost_price,selling_price,default_commission_rate,stock,min_stock,status)
    VALUES ($1,$2,$3,COALESCE($4,'PCS'),COALESCE($5,1),COALESCE($6,0),COALESCE($7,0),COALESCE($8,0),COALESCE($9,0),COALESCE($10,0),COALESCE($11,'active'))
    RETURNING id`,
    [v.item_id, v.name, v.category, v.unit, v.qty_per_pack, v.cost_price, sellPrice, v.default_commission_rate, v.stock, v.min_stock, v.status]
  );
  await addAuditLog('create','products', r.rows[0].id, `Created ${v.name}`);
  res.redirect('/products');
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const p = await pool.query(`SELECT *, selling_price AS rate FROM products WHERE id=$1`, [req.params.id]);
  if (!p.rows[0]) return res.redirect('/products');
  const c = await pool.query(`SELECT name FROM product_categories ORDER BY sort_order, name`);
  const v = await pool.query(`SELECT id, name FROM vendors WHERE status='active' ORDER BY name`);
  res.render('products/form', { page:'products', product: p.rows[0], categories: c.rows, vendors: v.rows, edit:true });
}));

router.post('/edit/:id', validate(schemas.productCreate), wrap(async (req, res) => {
  const v = req.valid;
  const sellPrice = v.selling_price != null ? v.selling_price : (req.body.rate != null ? Number(req.body.rate) || 0 : 0);
  await pool.query(`
    UPDATE products SET item_id=$1, name=$2, category=$3, unit=COALESCE($4,'PCS'),
      qty_per_pack=COALESCE($5,1), cost_price=COALESCE($6,0), selling_price=COALESCE($7,0),
      default_commission_rate=COALESCE($8,0), min_stock=COALESCE($9,0), status=COALESCE($10,'active')
    WHERE id=$11`,
    [v.item_id, v.name, v.category, v.unit, v.qty_per_pack, v.cost_price, sellPrice, v.default_commission_rate, v.min_stock, v.status, req.params.id]
  );
  await addAuditLog('update','products', req.params.id, `Updated ${v.name}`);
  res.redirect('/products');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM products WHERE id=$1`, [req.params.id]);
  await addAuditLog('delete','products', req.params.id, 'Deleted');
  res.redirect('/products');
}));

module.exports = router;
