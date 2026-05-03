'use strict';
const express = require('express');
const router = express.Router();
const { pool, addAuditLog, toInt } = require('../database');
const { wrap } = require('../middleware/errorHandler');
const { validate, schemas, requireEditPermission } = require('../middleware/validate');
const _lockExpense = requireEditPermission('expenses', 'expense_date');

router.get('/', wrap(async (req, res) => {
  const category = req.query.category || '';
  const from = req.query.from || '';
  const to = req.query.to || '';
  const params = [];
  let sql = `SELECT * FROM expenses WHERE 1=1`;
  if (category) { sql += ` AND category=$${params.length+1}`; params.push(category); }
  if (from)     { sql += ` AND expense_date>=$${params.length+1}`; params.push(from); }
  if (to)       { sql += ` AND expense_date<=$${params.length+1}`; params.push(to); }
  sql += ` ORDER BY id DESC LIMIT 500`;
  const r = await pool.query(sql, params);
  const catsR = (await pool.query(`SELECT name FROM expense_categories ORDER BY sort_order, name`)).rows;
  const cats = catsR.map(c => c.name);
  const totalAmount = r.rows.reduce((s, e) => s + Number(e.amount || 0), 0);
  res.render('expenses/index', { page:'expenses', expenses: r.rows, categories: cats, category, from, to, totalAmount });
}));

router.get('/add', wrap(async (req, res) => {
  const catsR = (await pool.query(`SELECT name FROM expense_categories ORDER BY sort_order, name`)).rows;
  const cats = catsR.map(c => c.name);
  res.render('expenses/form', { page:'expenses', expense:null, categories: cats, edit:false });
}));

router.post('/add', validate(schemas.expenseCreate), wrap(async (req, res) => {
  const v = req.valid;
  const r = await pool.query(`
    INSERT INTO expenses(category, description, amount, expense_date, payment_method, reference, paid_to, account_scope)
    VALUES ($1,$2,$3,$4,COALESCE($5,'cash')::payment_method_t,$6,$7,COALESCE($8,'plastic_markaz')::account_scope_t) RETURNING id`,
    [v.category, v.description, v.amount, v.expense_date, v.payment_method, req.body.reference, req.body.paid_to, v.account_scope]);
  await addAuditLog('create','expenses', r.rows[0].id, `${v.category} ${v.amount}`);
  res.redirect('/expenses');
}));

router.get('/edit/:id', _lockExpense, wrap(async (req, res) => {
  const r = await pool.query(`SELECT * FROM expenses WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.redirect('/expenses');
  const catsR = (await pool.query(`SELECT name FROM expense_categories ORDER BY sort_order, name`)).rows;
  const cats = catsR.map(c => c.name);
  res.render('expenses/form', { page:'expenses', expense: r.rows[0], categories: cats, edit:true });
}));

router.post('/edit/:id', _lockExpense, validate(schemas.expenseCreate), wrap(async (req, res) => {
  const v = req.valid;
  await pool.query(`UPDATE expenses SET category=$1, description=$2, amount=$3, expense_date=$4, payment_method=COALESCE($5,'cash')::payment_method_t,
                    reference=$6, paid_to=$7, account_scope=COALESCE($8,'plastic_markaz')::account_scope_t WHERE id=$9`,
    [v.category, v.description, v.amount, v.expense_date, v.payment_method, req.body.reference, req.body.paid_to, v.account_scope, req.params.id]);
  res.redirect('/expenses');
}));

router.post('/delete/:id', _lockExpense, wrap(async (req, res) => {
  await pool.query(`DELETE FROM expenses WHERE id=$1`, [req.params.id]);
  res.redirect('/expenses');
}));

module.exports = router;
