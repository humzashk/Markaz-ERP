'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { wrap } = require('../middleware/errorHandler');

router.get('/', wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const invoices  = (await pool.query(`SELECT i.id, i.invoice_no AS ref, c.name AS party, i.total AS amount FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.invoice_date=$1 ORDER BY i.id DESC`, [date])).rows;
  const purchases = (await pool.query(`SELECT p.id, p.purchase_no AS ref, v.name AS party, p.total AS amount FROM purchases p JOIN vendors v ON v.id=p.vendor_id WHERE p.purchase_date=$1 ORDER BY p.id DESC`, [date])).rows;
  const payments  = (await pool.query(`SELECT p.id, ('PMT-'||p.id) AS ref, p.entity_type, CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END AS party, p.amount, p.payment_method FROM payments p LEFT JOIN customers c ON p.entity_type='customer' AND c.id=p.entity_id LEFT JOIN vendors v ON p.entity_type='vendor' AND v.id=p.entity_id WHERE p.payment_date=$1 ORDER BY p.id DESC`, [date])).rows;
  const expenses  = (await pool.query(`SELECT id, category, amount, description FROM expenses WHERE expense_date=$1 ORDER BY id DESC`, [date])).rows;
  const creditNotes = (await pool.query(`
    SELECT cn.*, COALESCE(c.name, v.name) AS party_name
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.customer_id
    LEFT JOIN vendors v   ON v.id = cn.vendor_id
    WHERE cn.note_date=$1 ORDER BY cn.id DESC`, [date])).rows;
  const paymentsIn  = payments.filter(p => p.entity_type === 'customer');
  const paymentsOut = payments.filter(p => p.entity_type === 'vendor');
  const totalSales     = invoices.reduce((s,r)=>s+Number(r.amount||0),0);
  const totalPurchases = purchases.reduce((s,r)=>s+Number(r.amount||0),0);
  const totalIn        = paymentsIn.reduce((s,r)=>s+Number(r.amount||0),0);
  const totalOut       = paymentsOut.reduce((s,r)=>s+Number(r.amount||0),0);
  const totalExpenses  = expenses.reduce((s,r)=>s+Number(r.amount||0),0);
  // allEntries: combined list of every transaction for the "no activity" check
  const allEntries = [...invoices, ...purchases, ...payments, ...expenses, ...creditNotes];
  res.render('daybook/index', {
    page:'daybook', date,
    invoices, purchases, payments, paymentsIn, paymentsOut,
    expenses, creditNotes, allEntries,
    totalSales, totalPurchases, totalIn, totalOut, totalExpenses
  });
}));

module.exports = router;
