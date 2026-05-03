'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, addLedgerEntry, removeLedgerForRef, recomputeBalance, addAuditLog, toInt, toNum } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas, requireEditPermission } = require('../middleware/validate');
const _lockPayment = requireEditPermission('payments', 'payment_date');

async function fetchPayments(type, from, to) {
  const params = [];
  let sql = `SELECT p.*, CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END AS entity_name
    FROM payments p
    LEFT JOIN customers c ON p.entity_type='customer' AND c.id = p.entity_id
    LEFT JOIN vendors v   ON p.entity_type='vendor'   AND v.id = p.entity_id
    WHERE 1=1`;
  if (type) { sql += ` AND p.entity_type=$${params.length+1}`; params.push(type); }
  if (from) { sql += ` AND p.payment_date>=$${params.length+1}`; params.push(from); }
  if (to)   { sql += ` AND p.payment_date<=$${params.length+1}`; params.push(to); }
  sql += ` ORDER BY p.id DESC LIMIT 500`;
  return (await pool.query(sql, params)).rows;
}

router.get('/', wrap(async (req, res) => {
  const type = req.query.type || '';
  const from = req.query.from || '';
  const to   = req.query.to   || '';
  const rows = await fetchPayments(type, from, to);
  const totalReceived = rows.filter(p => p.entity_type === 'customer').reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalPaid     = rows.filter(p => p.entity_type === 'vendor').reduce((s, p) => s + Number(p.amount || 0), 0);
  res.render('payments/index', { page:'payments', payments: rows, type, from, to, totalReceived, totalPaid });
}));

router.get('/received', wrap(async (req, res) => {
  const from = req.query.from || '';
  const to   = req.query.to   || '';
  const rows = await fetchPayments('customer', from, to);
  const totalReceived = rows.reduce((s, p) => s + Number(p.amount || 0), 0);
  res.render('payments/list', { page:'payments', title:'Payments Received', listType:'received', payments: rows, from, to, total: totalReceived });
}));

router.get('/paid', wrap(async (req, res) => {
  const from = req.query.from || '';
  const to   = req.query.to   || '';
  const rows = await fetchPayments('vendor', from, to);
  const totalPaid = rows.reduce((s, p) => s + Number(p.amount || 0), 0);
  res.render('payments/list', { page:'payments', title:'Payments Made', listType:'paid', payments: rows, from, to, total: totalPaid });
}));

// Individual payment detail
router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.redirect('/payments');

  const p = (await pool.query(`SELECT * FROM payments WHERE id=$1`, [id])).rows[0];
  if (!p) return res.redirect('/payments');

  // Fetch entity (customer or vendor)
  const entityTable = p.entity_type === 'customer' ? 'customers' : 'vendors';
  const entity = (await pool.query(`SELECT id, name, balance, phone FROM ${entityTable} WHERE id=$1`, [p.entity_id])).rows[0];

  // Fetch matching ledger entry for balance impact
  const ledgerRow = (await pool.query(
    `SELECT debit, credit FROM ledger WHERE entity_type=$1 AND entity_id=$2 AND reference_type='payment' AND reference_id=$3 LIMIT 1`,
    [p.entity_type, p.entity_id, id]
  )).rows[0];

  res.render('payments/detail', {
    page: 'payments',
    payment: p,
    entity: entity || null,
    ledgerRow: ledgerRow || null,
    ok:  req.query.ok  || null,
    err: req.query.err || null
  });
}));

// /payments/add?type=customer|vendor&entity_id=X  → redirect to correct form
router.get('/add', (req, res) => {
  const type = req.query.type || '';
  const id   = req.query.entity_id || '';
  if (type === 'vendor')   return res.redirect(`/payments/pay${id ? '?vendor_id='+id : ''}`);
  return res.redirect(`/payments/receive${id ? '?customer_id='+id : ''}`);
});

router.get('/receive', wrap(async (req, res) => {
  const customerId = toInt(req.query.customer_id) || null;
  const customers = (await pool.query(`SELECT id, name, balance FROM customers WHERE status='active' ORDER BY name`)).rows;
  let selectedCustomer = null, unpaidInvoices = [];
  if (customerId) {
    selectedCustomer = (await pool.query(`SELECT * FROM customers WHERE id=$1`, [customerId])).rows[0] || null;
    unpaidInvoices = (await pool.query(`SELECT id, invoice_no, invoice_date, due_date, total, paid, (total - COALESCE(paid,0)) AS due FROM invoices WHERE customer_id=$1 AND status <> 'paid' ORDER BY invoice_date`, [customerId])).rows;
  }
  res.render('payments/receive', { page:'payments-receive', customers, customerId, selectedCustomer, unpaidInvoices, accounts: [], payment:null });
}));

router.get('/pay', wrap(async (req, res) => {
  const vendorId = toInt(req.query.vendor_id) || null;
  const vendors = (await pool.query(`SELECT id, name, balance FROM vendors WHERE status='active' ORDER BY name`)).rows;
  let selectedVendor = null, unpaidPurchases = [];
  if (vendorId) {
    selectedVendor = (await pool.query(`SELECT * FROM vendors WHERE id=$1`, [vendorId])).rows[0] || null;
    unpaidPurchases = (await pool.query(`SELECT id, purchase_no, purchase_date, total FROM purchases WHERE vendor_id=$1 ORDER BY purchase_date DESC LIMIT 50`, [vendorId])).rows;
  }
  res.render('payments/pay', { page:'payments-pay', vendors, vendorId, selectedVendor, unpaidPurchases, accounts: [], payment:null });
}));

// Adapter: form posts customer_id/vendor_id; map to entity_type/entity_id then validate
function _adapt(entityType) {
  return (req, res, next) => {
    req.body.entity_type = entityType;
    req.body.entity_id = entityType === 'customer' ? req.body.customer_id : req.body.vendor_id;
    next();
  };
}
router.post('/receive', _adapt('customer'), validate(schemas.paymentCreate), wrap(async (req, res) => savePayment(req, res)));
router.post('/pay',     _adapt('vendor'),   validate(schemas.paymentCreate), wrap(async (req, res) => savePayment(req, res)));
router.post('/save',                        validate(schemas.paymentCreate), wrap(async (req, res) => savePayment(req, res)));

async function savePayment(req, res) {
  const v = req.valid;
  let pid;
  await tx(async (db) => {
    const ins = await db.run(`
      INSERT INTO payments(entity_type,entity_id,amount,payment_date,payment_method,reference,notes,account_scope)
      VALUES ($1,$2,$3,$4,$5::payment_method_t,$6,$7,COALESCE($8,'plastic_markaz')::account_scope_t) RETURNING id`,
      [v.entity_type, v.entity_id, v.amount, v.payment_date, v.payment_method, v.reference, v.notes, req.body.account_scope]);
    pid = ins.id;
    if (v.entity_type === 'customer') {
      await addLedgerEntry(db, 'customer', v.entity_id, v.payment_date, `Payment received #${pid}`, 0, v.amount, 'payment', pid, req.body.account_scope || 'plastic_markaz');
    } else {
      await addLedgerEntry(db, 'vendor', v.entity_id, v.payment_date, `Payment made #${pid}`, v.amount, 0, 'payment', pid, req.body.account_scope || 'plastic_markaz');
    }
    await addAuditLog('create', 'payments', pid, `${v.entity_type} payment ${v.amount}`);
  });
  res.redirect(`/payments/view/${pid}?ok=1`);
}

router.post('/delete/:id', _lockPayment, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  let entityType, entityId;
  await tx(async (db) => {
    const p = await db.one(`SELECT * FROM payments WHERE id=$1`, [id]);
    if (!p) return;
    entityType = p.entity_type;
    entityId   = p.entity_id;
    await removeLedgerForRef(db, p.entity_type, p.entity_id, 'payment', p.id);
    await recomputeBalance(db, p.entity_type, p.entity_id);
    await db.run(`DELETE FROM payments WHERE id=$1`, [id]);
    await addAuditLog('delete', 'payments', id, `Deleted payment ${p.amount}`);
  });
  if (entityType && entityId) return res.redirect(`/ledger/${entityType}/${entityId}?ok=${encodeURIComponent('Payment deleted')}`);
  res.redirect('/payments');
}));

module.exports = router;
