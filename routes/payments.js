const express = require('express');
const router = express.Router();
const { db, addLedgerEntry, addAuditLog } = require('../database');

// ============ ALL PAYMENTS LIST ============
router.get('/', (req, res) => {
  const type = req.query.type || '';
  const from = req.query.from || '';
  const to = req.query.to || '';
  let sql = `
    SELECT p.*,
      CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END as entity_name
    FROM payments p
    LEFT JOIN customers c ON p.entity_type='customer' AND c.id = p.entity_id
    LEFT JOIN vendors v ON p.entity_type='vendor' AND v.id = p.entity_id
    WHERE 1=1
  `;
  const params = [];
  if (type) { sql += ` AND p.entity_type = ?`; params.push(type); }
  if (from) { sql += ` AND p.payment_date >= ?`; params.push(from); }
  if (to) { sql += ` AND p.payment_date <= ?`; params.push(to); }
  sql += ` ORDER BY p.id DESC`;

  const payments = db.prepare(sql).all(...params);
  const totalReceived = payments.filter(p => p.entity_type === 'customer').reduce((s, p) => s + p.amount, 0);
  const totalPaid = payments.filter(p => p.entity_type === 'vendor').reduce((s, p) => s + p.amount, 0);

  res.render('payments/index', { page: 'payments', payments, type, from, to, totalReceived, totalPaid });
});

// ============ RECEIVE PAYMENT (from Customer) ============
router.get('/receive', (req, res) => {
  const customerId = req.query.customer_id || '';
  const customers = db.prepare('SELECT id, name, balance FROM customers WHERE status = ? ORDER BY name').all('active');
  const accounts = db.prepare('SELECT id, account_name, account_type, balance FROM bank_accounts WHERE status = ? ORDER BY account_name').all('active');
  const selectedCustomer = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null;
  const unpaidInvoices = customerId
    ? db.prepare(`SELECT * FROM invoices WHERE customer_id = ? AND status != 'paid' ORDER BY invoice_date`).all(customerId)
    : [];
  res.render('payments/receive', { page: 'payments', customers, accounts, customerId, selectedCustomer, unpaidInvoices });
});

router.post('/receive', (req, res) => {
  const { customer_id, amount, payment_date, payment_method, account_id, reference, notes, invoice_id } = req.body;
  const amt = parseFloat(amount) || 0;

  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO payments (entity_type, entity_id, amount, payment_date, payment_method, reference, notes) VALUES ('customer', ?, ?, ?, ?, ?, ?)`
    ).run(customer_id, amt, payment_date, payment_method || 'cash', reference, notes);

    // Ledger: credit customer (reduce what they owe)
    addLedgerEntry('customer', customer_id, payment_date,
      `Payment received${payment_method ? ' - ' + payment_method : ''}${reference ? ' Ref:' + reference : ''}`,
      0, amt, 'payment', result.lastInsertRowid);

    // If linked to invoice, update it
    if (invoice_id) {
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice_id);
      if (inv) {
        const newPaid = (inv.paid || 0) + amt;
        const newStatus = newPaid >= inv.total ? 'paid' : 'partial';
        db.prepare('UPDATE invoices SET paid = ?, status = ? WHERE id = ?').run(newPaid, newStatus, invoice_id);
      }
    }

    // Bank account transaction
    if (account_id) {
      const acc = db.prepare('SELECT balance FROM bank_accounts WHERE id = ?').get(account_id);
      const newBal = (acc?.balance || 0) + amt;
      db.prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?').run(newBal, account_id);
      db.prepare(`INSERT INTO bank_transactions (account_id, txn_date, txn_type, amount, description, reference, balance, related_type, related_id) VALUES (?, ?, 'credit', ?, ?, ?, ?, 'payment', ?)`).run(account_id, payment_date, amt, `Customer payment received`, reference, newBal, result.lastInsertRowid);
    }
  })();

  addAuditLog('create', 'payments', null, `Received Rs.${amt} from customer ${customer_id}`);
  res.redirect(req.query.redirect || '/payments');
});

// ============ PAY VENDOR ============
router.get('/pay', (req, res) => {
  const vendorId = req.query.vendor_id || '';
  const vendors = db.prepare('SELECT id, name, balance FROM vendors WHERE status = ? ORDER BY name').all('active');
  const accounts = db.prepare('SELECT id, account_name, account_type, balance FROM bank_accounts WHERE status = ? ORDER BY account_name').all('active');
  const selectedVendor = vendorId ? db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendorId) : null;
  const pendingPurchases = vendorId
    ? db.prepare(`SELECT * FROM purchases WHERE vendor_id = ? AND status != 'paid' ORDER BY purchase_date`).all(vendorId)
    : [];
  res.render('payments/pay', { page: 'payments', vendors, accounts, vendorId, selectedVendor, pendingPurchases });
});

router.post('/pay', (req, res) => {
  const { vendor_id, amount, payment_date, payment_method, account_id, reference, notes, purchase_id } = req.body;
  const amt = parseFloat(amount) || 0;

  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO payments (entity_type, entity_id, amount, payment_date, payment_method, reference, notes) VALUES ('vendor', ?, ?, ?, ?, ?, ?)`
    ).run(vendor_id, amt, payment_date, payment_method || 'cash', reference, notes);

    // Ledger: debit vendor (reduce what we owe them)
    addLedgerEntry('vendor', vendor_id, payment_date,
      `Payment made${payment_method ? ' - ' + payment_method : ''}${reference ? ' Ref:' + reference : ''}`,
      amt, 0, 'payment', result.lastInsertRowid);

    // Bank account transaction
    if (account_id) {
      const acc = db.prepare('SELECT balance FROM bank_accounts WHERE id = ?').get(account_id);
      const newBal = (acc?.balance || 0) - amt;
      db.prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?').run(newBal, account_id);
      db.prepare(`INSERT INTO bank_transactions (account_id, txn_date, txn_type, amount, description, reference, balance, related_type, related_id) VALUES (?, ?, 'debit', ?, ?, ?, ?, 'payment', ?)`).run(account_id, payment_date, amt, `Payment to vendor`, reference, newBal, result.lastInsertRowid);
    }
  })();

  addAuditLog('create', 'payments', null, `Paid Rs.${amt} to vendor ${vendor_id}`);
  res.redirect(req.query.redirect || '/payments');
});

// Legacy route for backward compatibility
router.get('/add', (req, res) => {
  const type = req.query.type || 'customer';
  if (type === 'vendor') return res.redirect(`/payments/pay${req.query.entity_id ? '?vendor_id=' + req.query.entity_id : ''}`);
  return res.redirect(`/payments/receive${req.query.entity_id ? '?customer_id=' + req.query.entity_id : ''}`);
});

router.post('/add', (req, res) => {
  const { entity_type } = req.body;
  if (entity_type === 'vendor') {
    req.url = '/pay';
    return router.handle(req, res, () => {});
  }
  req.url = '/receive';
  return router.handle(req, res, () => {});
});

module.exports = router;
