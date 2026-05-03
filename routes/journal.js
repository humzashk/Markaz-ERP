'use strict';
const express = require('express');
const router = express.Router();
const { pool, tx, nextDocNo, addAuditLog, toInt, toNum } = require('../database');
const { requireEditPermission } = require('../middleware/validate');
const _lockJournal = requireEditPermission('journal_entries', 'entry_date');
const { wrap } = require('../middleware/errorHandler');

router.get('/', wrap(async (req, res) => {
  const from = req.query.from || '';
  const to = req.query.to || '';
  const params = [];
  let sql = `SELECT * FROM journal_entries WHERE 1=1`;
  if (from) { sql += ` AND entry_date >= $${params.length + 1}`; params.push(from); }
  if (to) { sql += ` AND entry_date <= $${params.length + 1}`; params.push(to); }
  sql += ` ORDER BY id DESC LIMIT 200`;
  const r = await pool.query(sql, params);
  res.render('journal/index', { page:'journal', entries: r.rows, from, to });
}));

router.get('/add', wrap(async (req, res) => {
  const accsR = await pool.query(`SELECT DISTINCT account FROM journal_lines ORDER BY account`);
  const accounts = accsR.rows.map(r => r.account);
  res.render('journal/form', { page:'journal', entry:null, lines:[], edit:false, today: new Date().toISOString().split('T')[0], accounts });
}));

router.post('/add', wrap(async (req, res) => {
  const { entry_date, description, reference, account, line_description, debit, credit } = req.body;
  if (!entry_date || !description) return res.redirect('/journal/add?err=missing');
  const accs   = Array.isArray(account)          ? account          : [account];
  const lds    = Array.isArray(line_description) ? line_description : [line_description];
  const debits = Array.isArray(debit)            ? debit            : [debit];
  const credits= Array.isArray(credit)           ? credit           : [credit];
  let totalDr=0, totalCr=0;
  const lines = [];
  for (let i = 0; i < accs.length; i++) {
    if (!accs[i]) continue;
    const dr = toNum(debits[i], 0), cr = toNum(credits[i], 0);
    if (dr === 0 && cr === 0) continue;
    totalDr += dr; totalCr += cr;
    lines.push({ account: accs[i], description: lds[i] || null, debit: dr, credit: cr });
  }
  if (!lines.length) return res.redirect('/journal/add?err=no_lines');
  if (Math.abs(totalDr - totalCr) > 0.01) return res.redirect('/journal/add?err=unbalanced');

  await tx(async (db) => {
    const entryNo = await nextDocNo(db, 'JV', 'journal_entries', 'entry_no');
    const ins = await db.run(`INSERT INTO journal_entries(entry_no, entry_date, description, reference) VALUES ($1,$2,$3,$4) RETURNING id`,
      [entryNo, entry_date, description, reference || null]);
    for (const l of lines) {
      await db.run(`INSERT INTO journal_lines(entry_id, account, description, debit, credit) VALUES ($1,$2,$3,$4,$5)`,
        [ins.id, l.account, l.description, l.debit, l.credit]);
    }
    await addAuditLog('create','journal', ins.id, `${entryNo} ${totalDr}`);
  });
  res.redirect('/journal');
}));

router.get('/view/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const entry = (await pool.query(`SELECT * FROM journal_entries WHERE id=$1`, [id])).rows[0];
  if (!entry) return res.redirect('/journal');
  const lines = (await pool.query(`SELECT * FROM journal_lines WHERE entry_id=$1 ORDER BY id`, [id])).rows;
  res.render('journal/view', { page:'journal', entry, lines });
}));

router.post('/delete/:id', _lockJournal, wrap(async (req, res) => {
  const id = toInt(req.params.id);
  await tx(async (db) => {
    await db.run(`DELETE FROM journal_lines WHERE entry_id=$1`, [id]);
    await db.run(`DELETE FROM journal_entries WHERE id=$1`, [id]);
  });
  await addAuditLog('delete','journal', id, 'Deleted journal entry');
  res.redirect('/journal');
}));

module.exports = router;
