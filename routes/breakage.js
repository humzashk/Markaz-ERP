const express = require('express');
const router = express.Router();
const { db, generateNumber, addLedgerEntry, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const sql = `SELECT br.*, p.name as product_name,
    COALESCE(c.name, '') as party_name,
    COALESCE(cn.note_no, '') as credit_note
    FROM breakage br
    JOIN products p ON p.id = br.product_id
    LEFT JOIN customers c ON c.id = br.customer_id
    LEFT JOIN credit_notes cn ON cn.id = br.credit_note_id
    ORDER BY br.id DESC`;
  const breakages = db.prepare(sql).all();
  res.render('breakage/index', { page: 'breakage', breakages });
});

router.get('/add', (req, res) => {
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const products = db.prepare('SELECT id, name, rate FROM products WHERE status = ? ORDER BY name').all('active');
  res.render('breakage/form', { page: 'breakage', breakage: null, customers, products, edit: false });
});

router.post('/add', (req, res) => {
  const { customer_id, product_id, quantity, amount, breakage_date, notes } = req.body;

  const qty = parseInt(quantity) || 0;
  const amt = parseFloat(amount) || 0;

  db.transaction(() => {
    // Create breakage record
    const breakageResult = db.prepare(
      `INSERT INTO breakage (customer_id, product_id, quantity, adjustment_amount, breakage_date, notes) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(customer_id, product_id, qty, amt, breakage_date, notes);

    const breakageId = breakageResult.lastInsertRowid;

    // Generate credit note
    const creditNoteNo = generateNumber('CN', 'credit_notes');
    const creditNoteResult = db.prepare(
      `INSERT INTO credit_notes (note_no, note_type, customer_id, note_date, amount, reason, status) VALUES (?, 'breakage', ?, ?, ?, ?, 'issued')`
    ).run(creditNoteNo, customer_id, breakage_date, amt, `Breakage - ${notes || ''}`);

    const creditNoteId = creditNoteResult.lastInsertRowid;

    // Update breakage with credit note reference
    db.prepare('UPDATE breakage SET credit_note_id = ? WHERE id = ?').run(creditNoteId, breakageId);

    // Adjust ledger immediately - credit customer (reduce their dues)
    addLedgerEntry('customer', customer_id, breakage_date, `Breakage Credit Note #${creditNoteNo}`, 0, amt, 'breakage', breakageId);

    addAuditLog('create', 'breakage', breakageId, `Breakage recorded: ${qty} pcs, Rs.${amt}`);
  })();

  res.redirect('/breakage');
});

router.get('/view/:id', (req, res) => {
  const breakage = db.prepare(`
    SELECT br.*, p.name as product_name, c.name as customer_name,
    cn.note_no as credit_note_no
    FROM breakage br
    JOIN products p ON p.id = br.product_id
    JOIN customers c ON c.id = br.customer_id
    LEFT JOIN credit_notes cn ON cn.id = br.credit_note_id
    WHERE br.id = ?
  `).get(req.params.id);
  if (!breakage) return res.redirect('/breakage');
  res.render('breakage/view', { page: 'breakage', breakage });
});

router.get('/challan/:id', (req, res) => {
  const breakage = db.prepare(`
    SELECT br.*, p.name as product_name, c.name as customer_name
    FROM breakage br
    JOIN products p ON p.id = br.product_id
    JOIN customers c ON c.id = br.customer_id
    WHERE br.id = ?
  `).get(req.params.id);
  if (!breakage) return res.status(404).send('Breakage record not found');
  res.render('breakage/challan', { page: 'breakage', breakage, layout: false });
});

router.get('/credit-note/:id', (req, res) => {
  const breakage = db.prepare(`
    SELECT br.*, p.name as product_name, c.name as customer_name,
    cn.note_no as credit_note_no
    FROM breakage br
    JOIN products p ON p.id = br.product_id
    JOIN customers c ON c.id = br.customer_id
    LEFT JOIN credit_notes cn ON cn.id = br.credit_note_id
    WHERE br.id = ?
  `).get(req.params.id);
  if (!breakage) return res.status(404).send('Breakage record not found');
  res.render('breakage/credit-note', { page: 'breakage', breakage, layout: false });
});

router.post('/delete/:id', (req, res) => {
  const breakage = db.prepare('SELECT * FROM breakage WHERE id = ?').get(req.params.id);
  if (!breakage) return res.redirect('/breakage');

  db.transaction(() => {
    // Delete credit note if exists
    if (breakage.credit_note_id) {
      db.prepare('DELETE FROM credit_notes WHERE id = ?').run(breakage.credit_note_id);
    }
    // Delete breakage record
    db.prepare('DELETE FROM breakage WHERE id = ?').run(req.params.id);
  })();

  addAuditLog('delete', 'breakage', req.params.id, 'Deleted breakage record');
  res.redirect('/breakage');
});

module.exports = router;
