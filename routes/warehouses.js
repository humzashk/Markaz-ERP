'use strict';
const express = require('express');
const router = express.Router();
const { pool, addAuditLog } = require('../database');
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
