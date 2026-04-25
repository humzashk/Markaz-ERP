const express = require('express');
const router = express.Router();
const { db } = require('../database');
const PDFDocument = require('pdfkit');

// Restrict financial / profit reports to SuperAdmin only
function superAdminOnly(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'superadmin') {
    return res.status(403).render('error', {
      page: 'error',
      message: 'Financial / profit reports are restricted to SuperAdmin only.',
      back: '/'
    });
  }
  next();
}
const FINANCIAL_PATHS = ['/profit-loss', '/balance-sheet', '/trial-balance', '/order-profit', '/profit', '/financial'];
router.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (FINANCIAL_PATHS.some(fp => p.startsWith(fp))) return superAdminOnly(req, res, next);
  next();
});

// Reports index
router.get('/', (req, res) => {
  res.render('reports/index', { page: 'reports', isSuperAdmin: req.user && req.user.role === 'superadmin' });
});

// ============ FINANCIAL REPORTS (SuperAdmin only) ============

router.get('/profit-loss', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];

  const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM invoices WHERE invoice_date BETWEEN ? AND ?`).get(from, to).val;
  const purchases = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM purchases WHERE purchase_date BETWEEN ? AND ?`).get(from, to).val;
  const expenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as val FROM expenses WHERE expense_date BETWEEN ? AND ?`).get(from, to).val;
  const freight = db.prepare(`SELECT COALESCE(SUM(freight_charges),0) as val FROM bilty WHERE bilty_date BETWEEN ? AND ?`).get(from, to).val;
  const breakageAdj = db.prepare(`SELECT COALESCE(SUM(adjustment_amount),0) as val FROM breakage WHERE claim_status='resolved' AND breakage_date BETWEEN ? AND ?`).get(from, to).val;

  const grossProfit = revenue - purchases;
  const netProfit = grossProfit - expenses - freight - breakageAdj;

  const expenseBreakdown = db.prepare(`
    SELECT category, SUM(amount) as total FROM expenses
    WHERE expense_date BETWEEN ? AND ?
    GROUP BY category ORDER BY total DESC
  `).all(from, to);

  res.render('reports/profit-loss', { page: 'reports', from, to, revenue, purchases, expenses, freight, breakageAdj, grossProfit, netProfit, expenseBreakdown });
});

router.get('/balance-sheet', (req, res) => {
  const asOf = req.query.date || new Date().toISOString().split('T')[0];

  const totalReceivable = db.prepare(`SELECT COALESCE(SUM(balance),0) as val FROM customers WHERE balance > 0`).get().val;
  const totalPayable = db.prepare(`SELECT COALESCE(SUM(ABS(balance)),0) as val FROM vendors WHERE balance < 0`).get().val;
  const inventoryValue = db.prepare(`SELECT COALESCE(SUM(stock * rate),0) as val FROM products WHERE status='active'`).get().val;
  const totalRevenue = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM invoices WHERE invoice_date <= ?`).get(asOf).val;
  const totalExpenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as val FROM expenses WHERE expense_date <= ?`).get(asOf).val;
  const totalPurchases = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM purchases WHERE purchase_date <= ?`).get(asOf).val;

  res.render('reports/balance-sheet', { page: 'reports', asOf, totalReceivable, totalPayable, inventoryValue, totalRevenue, totalExpenses, totalPurchases });
});

router.get('/trial-balance', (req, res) => {
  const customers = db.prepare(`SELECT name, balance FROM customers WHERE balance != 0 ORDER BY ABS(balance) DESC`).all();
  const vendors = db.prepare(`SELECT name, balance FROM vendors WHERE balance != 0 ORDER BY ABS(balance) DESC`).all();
  res.render('reports/trial-balance', { page: 'reports', customers, vendors });
});

// ============ SALES REPORTS ============

router.get('/sales-monthly', (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const monthlySales = db.prepare(`
    SELECT substr(invoice_date,1,7) as month, COUNT(*) as count, SUM(total) as total
    FROM invoices WHERE invoice_date LIKE ?
    GROUP BY month ORDER BY month
  `).all(year + '%');
  res.render('reports/sales-monthly', { page: 'reports', year, monthlySales });
});

router.get('/product-sales', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const productSales = db.prepare(`
    SELECT p.name, SUM(ii.quantity) as total_qty, SUM(ii.amount) as total_amount
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date BETWEEN ? AND ?
    GROUP BY p.id ORDER BY total_amount DESC
  `).all(from, to);
  res.render('reports/product-sales', { page: 'reports', from, to, productSales });
});

router.get('/customer-analysis', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 4) + '-01-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const analysis = db.prepare(`
    SELECT c.name, c.city, COUNT(i.id) as invoice_count, COALESCE(SUM(i.total),0) as total_sales, c.balance
    FROM customers c
    LEFT JOIN invoices i ON i.customer_id = c.id AND i.invoice_date BETWEEN ? AND ?
    WHERE c.status = 'active'
    GROUP BY c.id ORDER BY total_sales DESC
  `).all(from, to);
  res.render('reports/customer-analysis', { page: 'reports', from, to, analysis });
});

router.get('/sale-performance', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const daily = db.prepare(`
    SELECT invoice_date as date, COUNT(*) as count, SUM(total) as total
    FROM invoices WHERE invoice_date BETWEEN ? AND ?
    GROUP BY invoice_date ORDER BY invoice_date
  `).all(from, to);
  const totalSales = daily.reduce((s, d) => s + d.total, 0);
  const avgDaily = daily.length > 0 ? totalSales / daily.length : 0;
  res.render('reports/sale-performance', { page: 'reports', from, to, daily, totalSales, avgDaily });
});

router.get('/delivery-returns', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const deliveries = db.prepare(`
    SELECT b.*, COALESCE(c.name, '') as customer_name
    FROM bilty b
    LEFT JOIN orders o ON o.id = b.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE b.bilty_date BETWEEN ? AND ?
    ORDER BY b.bilty_date DESC
  `).all(from, to);
  res.render('reports/delivery-returns', { page: 'reports', from, to, deliveries });
});

// ============ PURCHASE REPORTS ============

router.get('/purchase-invoices', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const purchases = db.prepare(`
    SELECT p.*, v.name as vendor_name FROM purchases p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.purchase_date BETWEEN ? AND ?
    ORDER BY p.purchase_date DESC
  `).all(from, to);
  res.render('reports/purchase-invoices', { page: 'reports', from, to, purchases });
});

router.get('/vendor-payments', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const payments = db.prepare(`
    SELECT p.*, v.name as vendor_name FROM payments p
    JOIN vendors v ON v.id = p.entity_id
    WHERE p.entity_type = 'vendor' AND p.payment_date BETWEEN ? AND ?
    ORDER BY p.payment_date DESC
  `).all(from, to);
  const vendorSummary = db.prepare(`
    SELECT v.name, v.balance, COALESCE(SUM(p.amount),0) as total_paid
    FROM vendors v
    LEFT JOIN payments p ON p.entity_type='vendor' AND p.entity_id = v.id AND p.payment_date BETWEEN ? AND ?
    WHERE v.status = 'active'
    GROUP BY v.id ORDER BY total_paid DESC
  `).all(from, to);
  res.render('reports/vendor-payments', { page: 'reports', from, to, payments, vendorSummary });
});

// ============ ACCOUNTS REPORTS ============

router.get('/aged-receivable', (req, res) => {
  const customers = db.prepare(`
    SELECT c.*,
      (SELECT MAX(txn_date) FROM ledger WHERE entity_type='customer' AND entity_id=c.id) as last_txn
    FROM customers c WHERE c.balance > 0 ORDER BY c.balance DESC
  `).all();
  res.render('reports/aged-receivable', { page: 'reports', customers });
});

router.get('/aged-payable', (req, res) => {
  const vendors = db.prepare(`
    SELECT v.*,
      (SELECT MAX(txn_date) FROM ledger WHERE entity_type='vendor' AND entity_id=v.id) as last_txn
    FROM vendors v WHERE v.balance < 0 ORDER BY v.balance ASC
  `).all();
  res.render('reports/aged-payable', { page: 'reports', vendors });
});

router.get('/customer-balances', (req, res) => {
  const customers = db.prepare(`SELECT name, city, phone, balance FROM customers WHERE status='active' ORDER BY name`).all();
  const totalDue = customers.filter(c => c.balance > 0).reduce((s, c) => s + c.balance, 0);
  res.render('reports/customer-balances', { page: 'reports', customers, totalDue });
});

// ============ INVENTORY REPORTS ============

router.get('/low-stock', (req, res) => {
  const products = db.prepare(`SELECT * FROM products WHERE stock <= min_stock AND status='active' ORDER BY stock ASC`).all();
  res.render('reports/low-stock', { page: 'reports', products });
});

router.get('/stock-ledger', (req, res) => {
  const productId = req.query.product_id || '';
  const products = db.prepare('SELECT id, name FROM products WHERE status=? ORDER BY name').all('active');
  let movements = [];
  let product = null;
  if (productId) {
    product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    const sales = db.prepare(`
      SELECT i.invoice_date as date, 'Sale' as type, ii.quantity,
             i.invoice_no as ref, i.id as ref_id, 'invoice' as ref_type,
             COALESCE(c.name,'-') as party
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE ii.product_id = ?
    `).all(productId);
    const orders = db.prepare(`
      SELECT o.order_date as date, 'Order' as type, oi.quantity,
             o.order_no as ref, o.id as ref_id, 'order' as ref_type,
             COALESCE(c.name,'-') as party
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE oi.product_id = ? AND NOT EXISTS (SELECT 1 FROM invoices i2 WHERE i2.order_id = o.id)
    `).all(productId);
    const purchases = db.prepare(`
      SELECT p.purchase_date as date, 'Purchase' as type, pi.quantity,
             p.purchase_no as ref, p.id as ref_id, 'purchase' as ref_type,
             COALESCE(v.name,'-') as party
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      WHERE pi.product_id = ?
    `).all(productId);
    const breakages = db.prepare(`
      SELECT b.breakage_date as date, 'Breakage' as type, b.quantity,
             ('BRK-' || b.id) as ref, b.id as ref_id, 'breakage' as ref_type,
             COALESCE(c.name,'-') as party
      FROM breakage b
      LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.product_id = ?
    `).all(productId);
    movements = [...sales, ...orders, ...purchases, ...breakages].sort((a, b) => a.date > b.date ? -1 : 1);
  }
  res.render('reports/stock-ledger', { page: 'reports', products, productId, product, movements });
});

router.get('/stock-valuation', (req, res) => {
  const products = db.prepare(`SELECT name, stock, rate, (stock * rate) as value FROM products WHERE status='active' ORDER BY value DESC`).all();
  const totalValue = products.reduce((s, p) => s + p.value, 0);
  res.render('reports/stock-valuation', { page: 'reports', products, totalValue });
});

// ============ OTHER REPORTS ============

router.get('/expense-report', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count, SUM(amount) as total
    FROM expenses WHERE expense_date BETWEEN ? AND ?
    GROUP BY category ORDER BY total DESC
  `).all(from, to);
  const expenses = db.prepare(`SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC`).all(from, to);
  const totalExp = expenses.reduce((s, e) => s + e.amount, 0);
  res.render('reports/expense-report', { page: 'reports', from, to, byCategory, expenses, totalExp });
});

router.get('/audit-log', (req, res) => {
  const module = req.query.module || '';
  let sql = `SELECT * FROM audit_log WHERE 1=1`;
  const params = [];
  if (module) { sql += ` AND module = ?`; params.push(module); }
  sql += ` ORDER BY id DESC LIMIT 200`;
  const logs = db.prepare(sql).all(...params);
  const modules = db.prepare('SELECT DISTINCT module FROM audit_log ORDER BY module').all().map(r => r.module);
  res.render('reports/audit-log', { page: 'reports', logs, modules, module });
});

router.get('/breakage-report', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const breakages = db.prepare(`
    SELECT br.*, p.name as product_name,
      COALESCE(c.name, '') as customer_name,
      COALESCE(v.name, '') as vendor_name
    FROM breakage br
    JOIN products p ON p.id = br.product_id
    LEFT JOIN customers c ON c.id = br.customer_id
    LEFT JOIN vendors v ON v.id = br.vendor_id
    WHERE br.breakage_date BETWEEN ? AND ?
    ORDER BY br.breakage_date DESC
  `).all(from, to);
  const totalQty = breakages.reduce((s, b) => s + b.quantity, 0);
  const totalAdj = breakages.reduce((s, b) => s + b.adjustment_amount, 0);
  res.render('reports/breakage-report', { page: 'reports', from, to, breakages, totalQty, totalAdj });
});

router.get('/bilty-report', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const bilties = db.prepare(`
    SELECT b.*, COALESCE(o.order_no, '') as order_no, COALESCE(i.invoice_no, '') as invoice_no,
      COALESCE(c.name, c2.name, '') as customer_name
    FROM bilty b
    LEFT JOIN orders o ON o.id = b.order_id
    LEFT JOIN invoices i ON i.id = b.invoice_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN customers c2 ON c2.id = i.customer_id
    WHERE b.bilty_date BETWEEN ? AND ?
    ORDER BY b.bilty_date DESC
  `).all(from, to);
  const totalFreight = bilties.reduce((s, b) => s + b.freight_charges, 0);
  res.render('reports/bilty-report', { page: 'reports', from, to, bilties, totalFreight });
});

// ============ ALL TRANSACTIONS (unified, linked to source) ============
router.get('/transactions', (req, res) => {
  const from = req.query.from || new Date().toISOString().substring(0, 7) + '-01';
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const scope = req.query.scope || '';

  const scopeFilter = scope ? ` AND account_scope = '${scope.replace(/'/g,"")}'` : '';

  const orders = db.prepare(`SELECT 'order' as type, o.id as ref_id, o.order_no as ref, o.order_date as date, COALESCE(c.name,'-') as party, o.total as amount, o.account_scope FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.order_date BETWEEN ? AND ?${scopeFilter}`).all(from, to);
  const invoices = db.prepare(`SELECT 'invoice' as type, i.id as ref_id, i.invoice_no as ref, i.invoice_date as date, COALESCE(c.name,'-') as party, i.total as amount, i.account_scope FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.invoice_date BETWEEN ? AND ?${scopeFilter}`).all(from, to);
  const purchases = db.prepare(`SELECT 'purchase' as type, p.id as ref_id, p.purchase_no as ref, p.purchase_date as date, COALESCE(v.name,'-') as party, p.total as amount, p.account_scope FROM purchases p LEFT JOIN vendors v ON v.id=p.vendor_id WHERE p.purchase_date BETWEEN ? AND ?${scopeFilter}`).all(from, to);
  const payments = db.prepare(`SELECT 'payment' as type, p.id as ref_id, ('PMT-'||p.id) as ref, p.payment_date as date, CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END as party, p.amount, p.account_scope FROM payments p LEFT JOIN customers c ON p.entity_type='customer' AND c.id=p.entity_id LEFT JOIN vendors v ON p.entity_type='vendor' AND v.id=p.entity_id WHERE p.payment_date BETWEEN ? AND ?${scopeFilter}`).all(from, to);

  const all = [...orders, ...invoices, ...purchases, ...payments]
    .sort((a,b) => (a.date > b.date ? -1 : 1));

  res.render('reports/transactions', { page: 'reports', from, to, scope, all });
});

// Generic PDF for any report (print-friendly page approach)
router.get('/print/:report', (req, res) => {
  // Redirect to the report with print=1 query
  const query = { ...req.query, print: '1' };
  const qs = Object.entries(query).map(([k,v]) => `${k}=${v}`).join('&');
  res.redirect(`/reports/${req.params.report}?${qs}`);
});

module.exports = router;
