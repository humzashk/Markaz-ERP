const express = require('express');
const router = express.Router();
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const category = req.query.category || '';
  const from = req.query.from || '';
  const to = req.query.to || '';
  let sql = `SELECT * FROM expenses WHERE 1=1`;
  const params = [];
  if (category) { sql += ` AND category = ?`; params.push(category); }
  if (from) { sql += ` AND expense_date >= ?`; params.push(from); }
  if (to) { sql += ` AND expense_date <= ?`; params.push(to); }
  sql += ` ORDER BY expense_date DESC, id DESC`;
  const expenses = db.prepare(sql).all(...params);
  const totalAmount = expenses.reduce((s, e) => s + e.amount, 0);
  const categories = db.prepare('SELECT DISTINCT category FROM expenses ORDER BY category').all().map(r => r.category);
  res.render('expenses/index', { page: 'expenses', expenses, totalAmount, categories, category, from, to });
});

router.get('/add', (req, res) => {
  const allCats = db.prepare('SELECT name FROM expense_categories ORDER BY sort_order, name').all().map(r => r.name);
  res.render('expenses/form', { page: 'expenses', expense: null, edit: false, allCats });
});

router.post('/add', (req, res) => {
  const { category, description, amount, expense_date, payment_method, reference, paid_to } = req.body;
  const result = db.prepare(
    `INSERT INTO expenses (category, description, amount, expense_date, payment_method, reference, paid_to) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(category, description, parseFloat(amount), expense_date, payment_method || 'cash', reference, paid_to || '');
  addAuditLog('create', 'expenses', result.lastInsertRowid, `Added expense: ${category} Rs.${amount}`);
  res.redirect('/expenses');
});

router.get('/edit/:id', (req, res) => {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!expense) return res.redirect('/expenses');
  const allCats = db.prepare('SELECT name FROM expense_categories ORDER BY sort_order, name').all().map(r => r.name);
  res.render('expenses/form', { page: 'expenses', expense, edit: true, allCats });
});

router.post('/edit/:id', (req, res) => {
  const { category, description, amount, expense_date, payment_method, reference, paid_to } = req.body;
  db.prepare(
    `UPDATE expenses SET category=?, description=?, amount=?, expense_date=?, payment_method=?, reference=?, paid_to=? WHERE id=?`
  ).run(category, description, parseFloat(amount), expense_date, payment_method, reference, paid_to || '', req.params.id);
  res.redirect('/expenses');
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.redirect('/expenses');
});

module.exports = router;
