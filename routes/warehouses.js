'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, applyStockMovement, addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const r = await pool.query(`SELECT * FROM warehouses ORDER BY id DESC`);
  res.render('warehouses/index', { page:'warehouses', warehouses: r.rows });
}));

router.get('/add', (req, res) => res.render('warehouses/form', { page:'warehouses', warehouse:null, edit:false }));

router.post('/add', validate(schemas.warehouseCreate), wrap(async (req, res) => {
  const v = req.valid;
  const r = await pool.query(`
    INSERT INTO warehouses(name,location,address,city,manager,phone,status)
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'active')::active_status_t) RETURNING id`,
    [v.name, v.location, v.address, v.city, v.manager, v.phone, v.status]);
  await addAuditLog('create','warehouses', r.rows[0].id, `Created ${v.name}`);
  res.redirect('/warehouses');
}));

router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const warehouse = (await pool.query(`SELECT * FROM warehouses WHERE id=$1`, [id])).rows[0];
  if (!warehouse) return res.redirect('/warehouses');

  const stock = (await pool.query(`
    SELECT ws.quantity, ws.product_id,
           p.name AS product_name, p.category, p.cost_price AS rate, p.min_stock,
           (ws.quantity * p.cost_price)::NUMERIC(14,2) AS value
    FROM warehouse_stock ws
    JOIN products p ON p.id = ws.product_id
    WHERE ws.warehouse_id = $1 AND ws.quantity > 0
    ORDER BY p.name`, [id])).rows;

  const adjustments = (await pool.query(`
    SELECT sa.adj_date, sa.adjustment_type, sa.quantity, sa.reason,
           p.name AS product_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    WHERE sa.warehouse_id = $1
    ORDER BY sa.id DESC LIMIT 50`, [id])).rows;

  res.render('warehouses/view', { page:'warehouses', warehouse, stock, adjustments });
}));

router.get('/transfer', wrap(async (req, res) => {
  const warehouses = (await pool.query(`SELECT id, name, location FROM warehouses WHERE status='active' ORDER BY name`)).rows;
  const products   = (await pool.query(`SELECT id, name, stock FROM products WHERE status='active' ORDER BY name`)).rows;
  res.render('warehouses/transfer', { page:'warehouses', warehouses, products });
}));

router.post('/transfer', wrap(async (req, res) => {
  const fromId     = toInt(req.body.from_warehouse_id);
  const toId       = toInt(req.body.to_warehouse_id);
  const productId  = toInt(req.body.product_id);
  const quantity   = Math.abs(toInt(req.body.quantity) || 0);
  const notes      = (req.body.notes || '').trim() || null;

  if (!fromId || !toId || !productId || quantity < 1)
    return res.redirect('/warehouses/transfer?err=invalid');
  if (fromId === toId)
    return res.redirect('/warehouses/transfer?err=same_warehouse');

  await tx(async (db) => {
    const src = await db.one(`SELECT quantity FROM warehouse_stock WHERE warehouse_id=$1 AND product_id=$2`, [fromId, productId]);
    const available = Number(src && src.quantity) || 0;
    if (available < quantity) throw new Error(`Insufficient stock: ${available} pcs available`);

    await applyStockMovement(db, productId, fromId, -quantity, 'transfer_out', null, 'transfer_out', notes);
    await applyStockMovement(db, productId, toId,   +quantity, 'transfer_in',  null, 'transfer_in',  notes);
    await addAuditLog('create', 'warehouses', fromId,
      `Transfer ${quantity} pcs of product ${productId} from warehouse ${fromId} to ${toId}`);
  });

  res.redirect('/warehouses?ok=' + encodeURIComponent(`${quantity} pcs transferred successfully`));
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const r = await pool.query(`SELECT * FROM warehouses WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.redirect('/warehouses');
  res.render('warehouses/form', { page:'warehouses', warehouse: r.rows[0], edit:true });
}));

router.post('/edit/:id', validate(schemas.warehouseCreate), wrap(async (req, res) => {
  const v = req.valid;
  await pool.query(`UPDATE warehouses SET name=$1,location=$2,address=$3,city=$4,manager=$5,phone=$6,status=COALESCE($7,'active')::active_status_t WHERE id=$8`,
    [v.name, v.location, v.address, v.city, v.manager, v.phone, v.status, req.params.id]);
  await addAuditLog('update','warehouses', req.params.id, `Updated ${v.name}`);
  res.redirect('/warehouses');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM warehouses WHERE id=$1`, [req.params.id]);
  await addAuditLog('delete','warehouses', req.params.id, 'Deleted');
  res.redirect('/warehouses');
}));

module.exports = router;
