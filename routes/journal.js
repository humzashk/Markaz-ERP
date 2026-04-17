const express = require('express');
const router = express.Router();
const { db, addAuditLog } = require('../database');

const ACCOUNTS = [
  'Cash in Hand', 'Bank Account', 'Accounts Receivable', 'Accounts Payable',
  'Sales Revenue', 'Purchase Account', 'Sales Returns', 'Purchase Returns',
  'Stock / Inventory', 'Cost of Goods Sold',
  'Rent Expense', 'Salary Expense', 'Utilities Expense', 'Transport Expense',
  'Commission Expense', 'Commission Income', 'Freight Charges',
  'Bank Charges', 'Loan Account', 'Capital Account', 'Drawings',
  'Depreciation', 'Other Income', 'Other Expense', 'Suspense Account'
];

router.get('/', (req, res) => {
  const from = req.query.from || '';
  const to = req.query.to || '';
  let sql = `SELECT * FROM journal_entries WHERE 1=1`;
  const params = [];
  if (from) { sql += ` AND entry_date >= ?`; params.push(from); }
  if (to) { sql += ` AND entry_date <= ?`; params.push(to); }
  sql += ` ORDER BY entry_date DESC, id DESC`;
  const entries = db.prepare(sql).all(...params);

  // Attach lines
  entries.forEach(e => {
    e.lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(e.id);
    e.totalDebit = e.lines.reduce((s, l) => s + (l.debit || 0), 0);
    e.totalCredit = e.lines.reduce((s, l) => s + (l.credit || 0), 0);
  });

  res.render('journal/index', { page: 'daybook', entries, from, to });
});

router.get('/add', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.render('journal/form', { page: 'daybook', entry: null, lines: [], edit: false, today, accounts: ACCOUNTS });
});

router.post('/add', (req, res) => {
  const { entry_date, description, reference, account, line_description, debit, credit } = req.body;
  const accounts = Array.isArray(account) ? account : [account];
  const descs = Array.isArray(line_description) ? line_description : [line_description];
  const debits = Array.isArray(debit) ? debit : [debit];
  const credits = Array.isArray(credit) ? credit : [credit];

  const totalDebit = debits.reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const totalCredit = credits.reduce((s, v) => s + (parseFloat(v) || 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return res.send('<script>alert("Debit and Credit must be equal! Debit: ' + totalDebit.toFixed(2) + ', Credit: ' + totalCredit.toFixed(2) + '");history.back();</script>');
  }

  const entryNo = 'JE-' + (db.prepare('SELECT COUNT(*) as cnt FROM journal_entries').get().cnt + 1).toString().padStart(5, '0');

  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO journal_entries (entry_no, entry_date, description, reference, status) VALUES (?, ?, ?, ?, 'posted')`
    ).run(entryNo, entry_date, description, reference || '');
    const entryId = result.lastInsertRowid;
    for (let i = 0; i < accounts.length; i++) {
      if (!accounts[i]) continue;
      db.prepare(
        `INSERT INTO journal_lines (entry_id, account, description, debit, credit) VALUES (?, ?, ?, ?, ?)`
      ).run(entryId, accounts[i], descs[i] || '', parseFloat(debits[i]) || 0, parseFloat(credits[i]) || 0);
    }
    addAuditLog('create', 'journal', entryId, `Journal entry ${entryNo}`);
  })();

  res.redirect('/journal');
});

router.get('/view/:id', (req, res) => {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.redirect('/journal');
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(req.params.id);
  res.render('journal/view', { page: 'daybook', entry, lines, accounts: ACCOUNTS });
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(req.params.id);
  db.prepare('DELETE FROM journal_entries WHERE id = ?').run(req.params.id);
  res.redirect('/journal');
});

module.exports = router;
