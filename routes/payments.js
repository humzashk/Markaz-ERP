'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, addLedgerEntry, removeLedgerForRef, recomputeBalance, addAuditLog, toInt, toNum } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validate');

router.get('/', wrap(async (req, res) => {
  const r = await pool.query(`
    SELECT p.*, CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END AS entity_name
    FROM payments p
    LEFT JOIN customers c ON p.entity_type='customer' AND c.id = p.entity_id
    LEFT JOIN vendors v   ON p.entity_type='vendor'   AND v.id = p.entity_id
    ORDER BY p.id DESC LIMIT 500`);
  res.render('payments/index', { page:'payments', payments: r.rows });
}));

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
router.post('/receive', _adapt('customer'), validate(schemas.paymentCreate), wrap(async (req, res) => savePayment(req, res, '/payments/receive')));
router.post('/pay',     _adapt('vendor'),   validate(schemas.paymentCreate), wrap(async (req, res) => savePayment(req, res, '/payments/pay')));

async function savePayment(req, res, redirectBack) {
  const v = req.valid;
  await tx(async (db) => {
    const ins = await db.run(`
      INSERT INTO payments(entity_type,entity_id,amount,payment_date,payment_method,reference,notes,account_scope)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'plastic_markaz')) RETURNING id`,
      [v.entity_type, v.entity_id, v.amount, v.payment_date, v.payment_method, v.reference, v.notes, req.body.account_scope]);
    const pid = ins.id;
    if (v.entity_type === 'customer') {
      await addLedgerEntry(db, 'customer', v.entity_id, v.payment_date, `Payment received #${pid}`, 0, v.amount, 'payment', pid, req.body.account_scope || 'plastic_markaz');
    } else {
      await addLedgerEntry(db, 'vendor', v.entity_id, v.payment_date, `Payment made #${pid}`, v.amount, 0, 'payment', pid, req.body.account_scope || 'plastic_markaz');
    }
    await addAuditLog('create','payments', pid, `${v.entity_type} payment ${v.amount}`);
  });
  res.redirect(redirectBack + '?ok=1');
}

router.post('/save', validate(schemas.paymentCreate), wrap(async (req, res) => {
  const v = req.valid;
  await tx(async (db) => {
    const ins = await db.run(`
      INSERT INTO payments(entity_type,entity_id,amount,payment_date,payment_method,reference,notes,account_scope)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'plastic_markaz')) RETURNING id`,
      [v.entity_type, v.entity_id, v.amount, v.payment_date, v.payment_method, v.reference, v.notes, req.body.account_scope]);
    const pid = ins.id;

    // Customer payment → CREDIT customer (reduces what customer owes us)
    // Vendor payment   → DEBIT vendor   (reduces what we owe vendor)
    if (v.entity_type === 'customer') {
      await addLedgerEntry(db, 'customer', v.entity_id, v.payment_date, `Payment received #${pid}`, 0, v.amount, 'payment', pid, req.body.account_scope || 'plastic_markaz');
    } else {
      await addLedgerEntry(db, 'vendor', v.entity_id, v.payment_date, `Payment made #${pid}`, v.amount, 0, 'payment', pid, req.body.account_scope || 'plastic_markaz');
    }
    await addAuditLog('create','payments', pid, `${v.entity_type} payment ${v.amount}`);
  });
  res.redirect(v.entity_type === 'customer' ? '/payments/receive?ok=1' : '/payments/pay?ok=1');
}));

router.post('/delete/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    const p = await db.one(`SELECT * FROM payments WHERE id=$1`, [id]);
    if (!p) return;
    await removeLedgerForRef(db, p.entity_type, p.entity_id, 'payment', p.id);
    await recomputeBalance(db, p.entity_type, p.entity_id);
    await db.run(`DELETE FROM payments WHERE id=$1`, [id]);
    await addAuditLog('delete','payments', id, `Deleted payment ${p.amount}`);
  });
  res.redirect('/payments');
}));

module.exports = router;
