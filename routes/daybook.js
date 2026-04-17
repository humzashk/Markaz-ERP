const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  // All transactions for the day
  const invoices = db.prepare(`SELECT i.invoice_no as ref, c.name as party, i.total as amount, 'Sale' as type, 'invoices' as module, i.id
    FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.invoice_date = ?`).all(date);

  const purchases = db.prepare(`SELECT p.purchase_no as ref, v.name as party, p.total as amount, 'Purchase' as type, 'purchases' as module, p.id
    FROM purchases p JOIN vendors v ON v.id = p.vendor_id WHERE p.purchase_date = ?`).all(date);

  const paymentsIn = db.prepare(`SELECT 'PMT-' || p.id as ref, COALESCE(c.name,'') as party, p.amount, 'Payment In' as type, 'payments' as module, p.id
    FROM payments p LEFT JOIN customers c ON c.id = p.entity_id WHERE p.entity_type = 'customer' AND p.payment_date = ?`).all(date);

  const paymentsOut = db.prepare(`SELECT 'PMT-' || p.id as ref, COALESCE(v.name,'') as party, p.amount, 'Payment Out' as type, 'payments' as module, p.id
    FROM payments p LEFT JOIN vendors v ON v.id = p.entity_id WHERE p.entity_type = 'vendor' AND p.payment_date = ?`).all(date);

  const expenses = db.prepare(`SELECT 'EXP-' || e.id as ref, e.category as party, e.amount, 'Expense' as type, 'expenses' as module, e.id
    FROM expenses e WHERE e.expense_date = ?`).all(date);

  const creditNotes = db.prepare(`SELECT cn.note_no as ref, COALESCE(c.name,'') as party, cn.amount, cn.note_type || ' Note' as type, 'creditnotes' as module, cn.id
    FROM credit_notes cn LEFT JOIN customers c ON c.id = cn.customer_id WHERE cn.note_date = ?`).all(date);

  const allEntries = [...invoices, ...purchases, ...paymentsIn, ...paymentsOut, ...expenses, ...creditNotes];

  const totalIn = invoices.reduce((s, e) => s + e.amount, 0)
    + paymentsIn.reduce((s, e) => s + e.amount, 0)
    + creditNotes.filter(n => n.type === 'debit Note').reduce((s, e) => s + e.amount, 0);

  const totalOut = purchases.reduce((s, e) => s + e.amount, 0)
    + paymentsOut.reduce((s, e) => s + e.amount, 0)
    + expenses.reduce((s, e) => s + e.amount, 0);

  res.render('daybook/index', { page: 'daybook', date, allEntries, invoices, purchases, paymentsIn, paymentsOut, expenses, creditNotes, totalIn, totalOut });
});

module.exports = router;
