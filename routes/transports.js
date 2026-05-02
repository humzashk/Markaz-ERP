'use strict';
const express = require('express');
const router = express.Router();
const { pool, addAuditLog } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const search = req.query.search || '';
  const params = [];
  let sql = `SELECT * FROM transports WHERE 1=1`;
  if (search) { sql += ` AND (name ILIKE $1 OR city ILIKE $1 OR vehicle_no ILIKE $1)`; params.push('%'+search+'%'); }
  sql += ` ORDER BY id DESC`;
  const r = await pool.query(sql, params);
  res.render('transports/index', { page:'transports', transports: r.rows, search });
}));

router.get('/add', (req, res) => res.render('transports/form', { page:'transports', transport:null, edit:false }));

router.post('/add', validate(schemas.transportCreate), wrap(async (req, res) => {
  const v = req.valid;
  const r = await pool.query(`
    INSERT INTO transports(name,contact,phone,city,vehicle_no,driver_name,status)
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'active')::active_status_t) RETURNING id`,
    [v.name, v.contact, v.phone, v.city, v.vehicle_no, v.driver_name, v.status]);
  await addAuditLog('create','transports', r.rows[0].id, `Created ${v.name}`);
  res.redirect('/transports');
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const r = await pool.query(`SELECT * FROM transports WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.redirect('/transports');
  res.render('transports/form', { page:'transports', transport: r.rows[0], edit:true });
}));

router.post('/edit/:id', validate(schemas.transportCreate), wrap(async (req, res) => {
  const v = req.valid;
  await pool.query(`UPDATE transports SET name=$1,contact=$2,phone=$3,city=$4,vehicle_no=$5,driver_name=$6,status=COALESCE($7,'active')::active_status_t WHERE id=$8`,
    [v.name, v.contact, v.phone, v.city, v.vehicle_no, v.driver_name, v.status, req.params.id]);
  res.redirect('/transports');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM transports WHERE id=$1`, [req.params.id]);
  res.redirect('/transports');
}));

router.post('/api/quick-create', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok:false, error:'name required' });
  const r = await pool.query(`INSERT INTO transports(name) VALUES ($1) RETURNING id, name`, [name]);
  res.json({ ok:true, transport: r.rows[0] });
}));

module.exports = router;
