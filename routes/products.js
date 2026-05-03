'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, applyStockMovement, addAuditLog, toInt, toNum } = require('../database');
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
  res.render('products/index', { page:'products', products: r.rows, vendors: v.rows, search, stock,
    ok: req.query.ok || null, err: req.query.err || null, error: req.query.err || null });
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

router.get('/bulk', wrap(async (req, res) => {
  res.render('products/bulk', { page: 'products' });
}));

// Bulk action from product list (inline action bar)
router.post('/bulk', wrap(async (req, res) => {
  const action = req.body.action || '';
  const ids = (req.body.ids || '').split(',')
    .map(s => toInt(s.trim())).filter(n => n > 0);
  const value = req.body.value || '';
  const numVal = toNum(value, 0);

  if (!ids.length) return res.redirect('/products?err=' + encodeURIComponent('No products selected'));

  let ok = '';
  switch (action) {
    case 'set_vendor': {
      // vendor_id can be empty (clear manufacturer)
      const vid = toInt(value) || null;
      const r = await pool.query(`UPDATE products SET vendor_id=$1 WHERE id=ANY($2::int[])`, [vid, ids]);
      ok = `${r.rowCount} product(s) updated`;
      break;
    }
    case 'set_category': {
      if (!value.trim()) return res.redirect('/products?err=' + encodeURIComponent('Category value required'));
      const r = await pool.query(`UPDATE products SET category=$1 WHERE id=ANY($2::int[])`, [value.trim(), ids]);
      ok = `${r.rowCount} product(s) category updated`;
      break;
    }
    case 'set_packaging': {
      const qpp = toInt(value);
      if (!qpp || qpp < 1) return res.redirect('/products?err=' + encodeURIComponent('Invalid Pcs/Ctn value'));
      const r = await pool.query(`UPDATE products SET qty_per_pack=$1 WHERE id=ANY($2::int[])`, [qpp, ids]);
      ok = `${r.rowCount} product(s) Pcs/Ctn updated`;
      break;
    }
    case 'set_rate': {
      if (numVal < 0) return res.redirect('/products?err=' + encodeURIComponent('Invalid rate value'));
      const r = await pool.query(`UPDATE products SET selling_price=$1 WHERE id=ANY($2::int[])`, [numVal, ids]);
      ok = `${r.rowCount} product(s) rate updated`;
      break;
    }
    case 'rate_by_pct': {
      if (numVal === 0) return res.redirect('/products?err=' + encodeURIComponent('Percentage cannot be zero'));
      const r = await pool.query(`UPDATE products SET selling_price = GREATEST(0, selling_price * (1 + $1/100)) WHERE id=ANY($2::int[])`, [numVal, ids]);
      ok = `${r.rowCount} product(s) rate adjusted by ${numVal}%`;
      break;
    }
    case 'stock_add': {
      const qty = toInt(value);
      if (!qty || qty < 1) return res.redirect('/products?err=' + encodeURIComponent('Invalid quantity'));
      await tx(async (db) => {
        const wh = await db.one(`SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1`);
        for (const pid of ids) {
          if (wh) await applyStockMovement(db, pid, wh.id, qty, 'adjustment', pid, 'bulk_add', 'Bulk stock add');
          else await db.run(`UPDATE products SET stock = stock + $1 WHERE id=$2`, [qty, pid]);
        }
      });
      ok = `Stock increased by ${qty} for ${ids.length} product(s)`;
      break;
    }
    case 'stock_sub': {
      const qty = toInt(value);
      if (!qty || qty < 1) return res.redirect('/products?err=' + encodeURIComponent('Invalid quantity'));
      await tx(async (db) => {
        const wh = await db.one(`SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1`);
        for (const pid of ids) {
          if (wh) await applyStockMovement(db, pid, wh.id, -qty, 'adjustment', pid, 'bulk_sub', 'Bulk stock reduce');
          else await db.run(`UPDATE products SET stock = stock - $1 WHERE id=$2`, [qty, pid]);
        }
      });
      ok = `Stock reduced by ${qty} for ${ids.length} product(s)`;
      break;
    }
    case 'delete': {
      // Deactivate rather than hard delete to preserve history
      const r = await pool.query(`UPDATE products SET status='inactive' WHERE id=ANY($1::int[])`, [ids]);
      ok = `${r.rowCount} product(s) deactivated`;
      break;
    }
    default:
      return res.redirect('/products?err=' + encodeURIComponent('Unknown action'));
  }

  await addAuditLog('update', 'products', null, `Bulk ${action} on ${ids.length} products`);
  res.redirect('/products?ok=' + encodeURIComponent(ok));
}));

// Bulk price update (all active or by category)
router.post('/bulk-price', wrap(async (req, res) => {
  const { scope, category, field, adj_type, adj_value } = req.body;
  const val = parseFloat(adj_value);
  if (!Number.isFinite(val) || val < 0) return res.redirect('/products/bulk?err=' + encodeURIComponent('Invalid adjustment value'));
  const col = field === 'cost_price' ? 'cost_price' : 'selling_price';
  let expr;
  if      (adj_type === 'pct_increase') expr = `${col} * (1 + ${val}/100)`;
  else if (adj_type === 'pct_decrease') expr = `${col} * (1 - ${val}/100)`;
  else                                  expr = `${val}`;
  let sql = `UPDATE products SET ${col} = GREATEST(0, ${expr}) WHERE status='active'`;
  const params = [];
  if (scope === 'category' && category && category.trim()) {
    sql += ` AND category ILIKE $1`;
    params.push('%' + category.trim() + '%');
  }
  const r = await pool.query(sql, params);
  await addAuditLog('update', 'products', null, `Bulk price ${adj_type} ${val} on ${col}: ${r.rowCount} products`);
  res.redirect('/products?ok=' + encodeURIComponent(`${r.rowCount} product price(s) updated`));
}));

// Bulk status / category update
router.post('/bulk-update', wrap(async (req, res) => {
  const ids = (req.body.ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  if (!ids.length) return res.redirect('/products/bulk?err=' + encodeURIComponent('No product IDs provided'));
  const sets = [], params = [];
  if (req.body.status && ['active','inactive'].includes(req.body.status)) {
    params.push(req.body.status); sets.push(`status=$${params.length}`);
  }
  if (req.body.category && req.body.category.trim()) {
    params.push(req.body.category.trim()); sets.push(`category=$${params.length}`);
  }
  if (!sets.length) return res.redirect('/products/bulk?err=' + encodeURIComponent('No changes selected'));
  params.push(ids);
  const r = await pool.query(`UPDATE products SET ${sets.join(',')} WHERE id=ANY($${params.length}::int[])`, params);
  await addAuditLog('update', 'products', null, `Bulk updated ${r.rowCount} products`);
  res.redirect('/products?ok=' + encodeURIComponent(`${r.rowCount} product(s) updated`));
}));

// Fix NULL / 0 qty_per_pack → 1
router.post('/bulk-fix-qpp', wrap(async (req, res) => {
  const r = await pool.query(`UPDATE products SET qty_per_pack=1 WHERE qty_per_pack IS NULL OR qty_per_pack < 1`);
  await addAuditLog('update', 'products', null, `Bulk fix qty_per_pack: ${r.rowCount} products set to 1`);
  res.redirect('/products?ok=' + encodeURIComponent(`${r.rowCount} product(s) fixed (qty_per_pack = 1)`));
}));

// Set specific qty_per_pack for listed IDs
router.post('/bulk-set-qpp', wrap(async (req, res) => {
  const ids = (req.body.ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  const qpp = parseInt(req.body.qty_per_pack, 10);
  if (!ids.length || !Number.isFinite(qpp) || qpp < 1)
    return res.redirect('/products/bulk?err=' + encodeURIComponent('Invalid IDs or Pcs/Ctn value'));
  const r = await pool.query(`UPDATE products SET qty_per_pack=$1 WHERE id=ANY($2::int[])`, [qpp, ids]);
  await addAuditLog('update', 'products', null, `Bulk set qty_per_pack=${qpp} for ${r.rowCount} products`);
  res.redirect('/products?ok=' + encodeURIComponent(`${r.rowCount} product(s) updated (Pcs/Ctn = ${qpp})`));
}));

module.exports = router;
