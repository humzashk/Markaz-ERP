const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, generateNumber, addLedgerEntry, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const type = req.query.type || '';
  let sql = `
    SELECT cn.*,
      COALESCE(c.name, '') as customer_name,
      COALESCE(v.name, '') as vendor_name
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.customer_id
    LEFT JOIN vendors v ON v.id = cn.vendor_id
    WHERE 1=1
  `;
  const params = [];
  if (type) { sql += ` AND cn.note_type = ?`; params.push(type); }
  sql += ` ORDER BY cn.id DESC`;
  const notes = db.prepare(sql).all(...params);
  res.render('creditnotes/index', { page: 'creditnotes', notes, type });
});

router.get('/add', (req, res) => {
  const noteType = req.query.type || 'credit'; // credit = sales return, debit = purchase return
  const customers = db.prepare('SELECT id, name FROM customers WHERE status = ? ORDER BY name').all('active');
  const vendors = db.prepare('SELECT id, name FROM vendors WHERE status = ? ORDER BY name').all('active');
  // Credit/Debit note rate: prefer SELL price, fallback to legacy rate column. Manual override allowed in UI.
  const products = (() => {
    try {
      return db.prepare(`
        SELECT id, name,
               COALESCE(NULLIF(selling_price,0), NULLIF(rate,0), 0) as rate
        FROM products WHERE status = ? ORDER BY name
      `).all('active');
    } catch(e) {
      return db.prepare('SELECT id, name, rate FROM products WHERE status = ? ORDER BY name').all('active');
    }
  })();
  const invoices = db.prepare(`SELECT i.id, i.invoice_no, c.name as customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC LIMIT 50`).all();
  const purchases = db.prepare(`SELECT p.id, p.purchase_no, v.name as vendor_name FROM purchases p JOIN vendors v ON v.id = p.vendor_id ORDER BY p.id DESC LIMIT 50`).all();
  res.render('creditnotes/form', { page: 'creditnotes', note: null, noteType, customers, vendors, products, invoices, purchases, edit: false });
});

router.post('/add', validate(schemas.creditNoteCreate), (req, res) => {
  const { note_type, customer_id, vendor_id, invoice_id, purchase_id, note_date, reason, notes, product_id, quantity, rate } = req.body;

  const productIds = Array.isArray(product_id) ? product_id : [product_id];
  const quantities = Array.isArray(quantity) ? quantity : [quantity];
  const rates = Array.isArray(rate) ? rate : [rate];

  let totalAmount = 0;
  const items = [];
  for (let i = 0; i < productIds.length; i++) {
    if (!productIds[i]) continue;
    const qty = parseInt(quantities[i]) || 0;
    const r = parseFloat(rates[i]) || 0;
    const amt = qty * r;
    totalAmount += amt;
    items.push({ product_id: productIds[i], quantity: qty, rate: r, amount: amt });
  }

  const noteNo = generateNumber(note_type === 'credit' ? 'CN' : 'DN', 'credit_notes');

  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO credit_notes (note_no, note_type, customer_id, vendor_id, invoice_id, purchase_id, note_date, amount, reason, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(noteNo, note_type, customer_id || null, vendor_id || null, invoice_id || null, purchase_id || null, note_date, totalAmount, reason, notes);

    const noteId = result.lastInsertRowid;
    for (const item of items) {
      db.prepare('INSERT INTO credit_note_items (note_id, product_id, quantity, rate, amount) VALUES (?, ?, ?, ?, ?)').run(noteId, item.product_id, item.quantity, item.rate, item.amount);
      // Return stock for credit note (sales return = stock comes back)
      if (note_type === 'credit') {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
      }
    }
  })();

  addAuditLog('create', 'credit_notes', null, `${noteNo} Rs.${totalAmount}`);
  res.redirect('/creditnotes');
});

// Apply note (post to ledger)
router.post('/apply/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(req.params.id);
  if (!note || note.status === 'applied') return res.redirect('/creditnotes');

  db.transaction(() => {
    db.prepare('UPDATE credit_notes SET status = ? WHERE id = ?').run('applied', req.params.id);

    if (note.note_type === 'credit' && note.customer_id) {
      // Credit note to customer: reduce their balance (refund)
      addLedgerEntry('customer', note.customer_id, note.note_date, `Credit Note ${note.note_no} - ${note.reason || 'Sales Return'}`, 0, note.amount, 'credit_note', note.id);
    } else if (note.note_type === 'debit' && note.vendor_id) {
      // Debit note to vendor: reduces what we owe (vendor balance = credit - debit, so put in DEBIT)
      addLedgerEntry('vendor', note.vendor_id, note.note_date, `Debit Note ${note.note_no} - ${note.reason || 'Purchase Return'}`, note.amount, 0, 'debit_note', note.id);
    }
  })();

  res.redirect('/creditnotes');
});

router.get('/view/:id', (req, res) => {
  const note = db.prepare(`
    SELECT cn.*, COALESCE(c.name,'') as customer_name, COALESCE(v.name,'') as vendor_name
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.customer_id
    LEFT JOIN vendors v ON v.id = cn.vendor_id
    WHERE cn.id = ?
  `).get(req.params.id);
  if (!note) return res.redirect('/creditnotes');
  const items = db.prepare(`SELECT cni.*, p.name as product_name FROM credit_note_items cni JOIN products p ON p.id = cni.product_id WHERE cni.note_id = ?`).all(req.params.id);
  res.render('creditnotes/view', { page: 'creditnotes', note, items });
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM credit_note_items WHERE note_id = ?').run(req.params.id);
  db.prepare('DELETE FROM credit_notes WHERE id = ?').run(req.params.id);
  res.redirect('/creditnotes');
});

module.exports = router;
