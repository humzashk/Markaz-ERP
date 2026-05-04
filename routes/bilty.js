'use strict';
const express = require('express');
const router = express.Router();
const { pool, addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const search = req.query.search || '';
  const params = []; let i=1;
  let sql = `
    SELECT b.*, o.order_no, i.invoice_no,
      COALESCE(c.name, c2.name, '') AS customer_name
    FROM bilty b
    LEFT JOIN orders o    ON o.id = b.order_id
    LEFT JOIN invoices i  ON i.id = b.invoice_id
    LEFT JOIN customers c  ON c.id  = o.customer_id
    LEFT JOIN customers c2 ON c2.id = i.customer_id
    WHERE 1=1`;
  if (search) { sql += ` AND (b.bilty_no ILIKE $${i} OR b.transport_name ILIKE $${i} OR b.to_city ILIKE $${i})`; params.push('%'+search+'%'); i++; }
  sql += ` ORDER BY b.id DESC LIMIT 500`;
  const r = await pool.query(sql, params);
  res.render('bilty/index', { page:'bilty', bilties: r.rows, search, ok: req.query.ok || null, err: req.query.err || null });
}));

router.get('/add', wrap(async (req, res) => {
  const orders   = (await pool.query(`SELECT o.id, o.order_no, o.bilty_no, c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC LIMIT 200`)).rows;
  const invoices = (await pool.query(`SELECT i.id, i.invoice_no, i.bilty_no, c.name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id ORDER BY i.id DESC LIMIT 200`)).rows;
  const transports = (await pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)).rows;
  res.render('bilty/form', { page:'bilty', bilty:null, orders, invoices, transports, edit:false });
}));

router.get('/api/search', wrap(async (req, res) => {
  const q = '%' + (req.query.q || '').replace(/[%_]/g,'') + '%';
  const orders   = (await pool.query(`SELECT o.id, o.order_no AS ref, 'order' AS type, o.bilty_no, c.name AS party, c.city AS to_city FROM orders o JOIN customers c ON c.id=o.customer_id WHERE (o.order_no ILIKE $1 OR COALESCE(o.bilty_no,'') ILIKE $1 OR c.name ILIKE $1) ORDER BY o.id DESC LIMIT 20`, [q])).rows;
  const invoices = (await pool.query(`SELECT i.id, i.invoice_no AS ref, 'invoice' AS type, i.bilty_no, c.name AS party, c.city AS to_city FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE (i.invoice_no ILIKE $1 OR COALESCE(i.bilty_no,'') ILIKE $1 OR c.name ILIKE $1) ORDER BY i.id DESC LIMIT 20`, [q])).rows;
  res.json([...orders, ...invoices]);
}));

router.post('/add', validate(schemas.biltyCreate), wrap(async (req, res) => {
  const v = req.valid;
  let resolvedName = v.transport_name || null;
  if (v.transport_id) {
    const t = (await pool.query(`SELECT name FROM transports WHERE id=$1`, [v.transport_id])).rows[0];
    if (t) resolvedName = t.name;
  }
  const r = await pool.query(`
    INSERT INTO bilty(order_id, invoice_id, transport_id, transport_name, bilty_no, from_city, to_city, bilty_date,
                      freight_charges, weight, packages_count, status, account_scope, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,0),$10,COALESCE($11,0),'in_transit',COALESCE($12,'plastic_markaz'),$13) RETURNING id`,
    [v.order_id, v.invoice_id, v.transport_id, resolvedName, v.bilty_no, v.from_city, v.to_city, v.bilty_date,
     v.freight_charges, v.weight, v.packages_count, req.body.account_scope, v.notes]);
  await addAuditLog('create','bilty', r.rows[0].id, `Created bilty ${v.bilty_no}`);
  res.redirect('/bilty');
}));

router.get('/edit/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const bilty = (await pool.query(`SELECT * FROM bilty WHERE id=$1`, [id])).rows[0];
  if (!bilty) return res.redirect('/bilty');
  const orders   = (await pool.query(`SELECT o.id, o.order_no, o.bilty_no, c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC LIMIT 200`)).rows;
  const invoices = (await pool.query(`SELECT i.id, i.invoice_no, i.bilty_no, c.name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id ORDER BY i.id DESC LIMIT 200`)).rows;
  const transports = (await pool.query(`SELECT id, name FROM transports WHERE status='active' ORDER BY name`)).rows;
  res.render('bilty/form', { page:'bilty', bilty, orders, invoices, transports, edit:true });
}));

router.post('/edit/:id', validate(schemas.biltyCreate), wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const v = req.valid;
  let resolvedName = v.transport_name || null;
  if (v.transport_id) {
    const t = (await pool.query(`SELECT name FROM transports WHERE id=$1`, [v.transport_id])).rows[0];
    if (t) resolvedName = t.name;
  }
  await pool.query(`
    UPDATE bilty SET order_id=$1, invoice_id=$2, transport_id=$3, transport_name=$4, bilty_no=$5,
      from_city=$6, to_city=$7, bilty_date=$8, freight_charges=COALESCE($9,0), weight=$10, packages_count=COALESCE($11,0),
      status=COALESCE($12,'in_transit'), notes=$13, account_scope=COALESCE($14,'plastic_markaz')
    WHERE id=$15`,
    [v.order_id, v.invoice_id, v.transport_id, resolvedName, v.bilty_no, v.from_city, v.to_city, v.bilty_date,
     v.freight_charges, v.weight, v.packages_count, req.body.status, v.notes, req.body.account_scope, id]);
  res.redirect('/bilty');
}));

router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const bilty = (await pool.query(`
    SELECT b.*, o.order_no, o.order_date, o.notes AS order_notes,
           i.invoice_no, i.invoice_date,
           COALESCE(c.name, c2.name, '') AS customer_name,
           COALESCE(c.city, c2.city, '') AS customer_city
    FROM bilty b
    LEFT JOIN orders o   ON o.id  = b.order_id
    LEFT JOIN invoices i ON i.id  = b.invoice_id
    LEFT JOIN customers c  ON c.id = o.customer_id
    LEFT JOIN customers c2 ON c2.id= i.customer_id
    WHERE b.id=$1`, [id])).rows[0];
  if (!bilty) return res.redirect('/bilty');

  let orderItems = [];
  if (bilty.order_id) {
    orderItems = (await pool.query(`
      SELECT oi.quantity, oi.packages, oi.rate, oi.amount, oi.commission_pct,
             p.name AS product_name, p.unit
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id`, [bilty.order_id])).rows;
  } else if (bilty.invoice_id) {
    orderItems = (await pool.query(`
      SELECT ii.quantity, ii.packages, ii.rate, ii.amount, ii.commission_pct,
             p.name AS product_name, p.unit
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id`, [bilty.invoice_id])).rows;
  }

  res.render('bilty/view', { page:'bilty', bilty, orderItems });
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM bilty WHERE id=$1`, [req.params.id]);
  res.redirect('/bilty');
}));

// Bulk operations on bilty
router.post('/bulk', wrap(async (req, res) => {
  const action = req.body.action || '';
  const ids = (req.body.ids || '').split(',').map(s => toInt(s.trim())).filter(n => n > 0);
  if (!ids.length) return res.redirect('/bilty?err=' + encodeURIComponent('No bilty selected'));

  if (action === 'delete') {
    await pool.query(`DELETE FROM bilty WHERE id=ANY($1::int[])`, [ids]);
    await addAuditLog('delete', 'bilty', null, `Bulk deleted bilty: ${ids.join(',')}`);
    return res.redirect('/bilty?ok=' + encodeURIComponent(`${ids.length} bilty record(s) deleted`));
  }

  res.redirect('/bilty?err=' + encodeURIComponent('Unknown action'));
}));

module.exports = router;
