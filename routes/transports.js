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
  res.render('transports/index', { page:'transports', transports: r.rows, search, ok: req.query.ok || null, err: req.query.err || null });
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

// Bulk operations on transports
router.post('/bulk', wrap(async (req, res) => {
  const action = req.body.action || '';
  const ids = (req.body.ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  if (!ids.length) return res.redirect('/transports?err=' + encodeURIComponent('No transports selected'));

  if (action === 'delete') {
    await pool.query(`DELETE FROM transports WHERE id=ANY($1::int[])`, [ids]);
    await addAuditLog('delete', 'transports', null, `Bulk deleted transports: ${ids.join(',')}`);
    return res.redirect('/transports?ok=' + encodeURIComponent(`${ids.length} transport(s) deleted`));
  }

  if (action === 'set_active') {
    const r = await pool.query(`UPDATE transports SET status='active' WHERE id=ANY($1::int[])`, [ids]);
    return res.redirect('/transports?ok=' + encodeURIComponent(`${r.rowCount} transport(s) activated`));
  }

  if (action === 'set_inactive') {
    const r = await pool.query(`UPDATE transports SET status='inactive' WHERE id=ANY($1::int[])`, [ids]);
    return res.redirect('/transports?ok=' + encodeURIComponent(`${r.rowCount} transport(s) deactivated`));
  }

  res.redirect('/transports?err=' + encodeURIComponent('Unknown action'));
}));

router.post('/api/quick-create', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok:false, error:'name required' });
  const r = await pool.query(`INSERT INTO transports(name) VALUES ($1) RETURNING id, name`, [name]);
  res.json({ ok:true, transport: r.rows[0] });
}));

module.exports = router;
