const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const accounts = db.prepare('SELECT * FROM bank_accounts ORDER BY account_type, account_name').all();
  const totalBalance = accounts.filter(a => a.status === 'active').reduce((s, a) => s + a.balance, 0);
  res.render('bank/index', { page: 'bank', accounts, totalBalance });
});

router.get('/add', (req, res) => {
  res.render('bank/form', { page: 'bank', account: null, edit: false });
});

router.post('/add', validate(schemas.bankCreate), (req, res) => {
  const { account_name, bank_name, account_number, account_type, opening_balance } = req.body;
  const bal = parseFloat(opening_balance) || 0;
  const result = db.prepare(
    `INSERT INTO bank_accounts (account_name, bank_name, account_number, account_type, opening_balance, balance) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(account_name, bank_name, account_number, account_type || 'bank', bal, bal);
  addAuditLog('create', 'bank_accounts', result.lastInsertRowid, `Added account: ${account_name}`);
  res.redirect('/bank');
});

router.get('/edit/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.redirect('/bank');
  res.render('bank/form', { page: 'bank', account, edit: true });
});

router.post('/edit/:id', validate(schemas.bankCreate), (req, res) => {
  const { account_name, bank_name, account_number, account_type, status } = req.body;
  db.prepare(
    `UPDATE bank_accounts SET account_name=?, bank_name=?, account_number=?, account_type=?, status=? WHERE id=?`
  ).run(account_name, bank_name, account_number, account_type, status || 'active', req.params.id);
  res.redirect('/bank');
});

router.get('/view/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.redirect('/bank');
  const from = req.query.from || '';
  const to = req.query.to || '';
  let sql = `SELECT * FROM bank_transactions WHERE account_id = ?`;
  const params = [req.params.id];
  if (from) { sql += ` AND txn_date >= ?`; params.push(from); }
  if (to) { sql += ` AND txn_date <= ?`; params.push(to); }
  sql += ` ORDER BY id ASC`;
  const transactions = db.prepare(sql).all(...params);
  res.render('bank/view', { page: 'bank', account, transactions, from, to });
});

// Manual deposit/withdrawal
router.post('/transaction', (req, res) => {
  const { account_id, txn_type, amount, txn_date, description, reference } = req.body;
  const amt = parseFloat(amount) || 0;

  const acc = db.prepare('SELECT balance FROM bank_accounts WHERE id = ?').get(account_id);
  const newBal = txn_type === 'credit' ? (acc?.balance || 0) + amt : (acc?.balance || 0) - amt;

  db.prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?').run(newBal, account_id);
  db.prepare(`INSERT INTO bank_transactions (account_id, txn_date, txn_type, amount, description, reference, balance) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(account_id, txn_date, txn_type, amt, description, reference, newBal);

  res.redirect('/bank/view/' + account_id);
});

module.exports = router;
