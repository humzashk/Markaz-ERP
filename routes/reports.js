'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { wrap } = require('../middleware/errorHandler');

function superAdminOnly(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'superadmin') return res.status(403).render('error', { page:'error', message:'Restricted to SuperAdmin only.', back:'/' });
  next();
}
const FINANCIAL = ['/profit-loss','/balance-sheet','/trial-balance'];
router.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (FINANCIAL.some(fp => p.startsWith(fp))) return superAdminOnly(req, res, next);
  next();
});

router.get('/', (req, res) => res.render('reports/index', { page:'reports', isSuperAdmin: req.user && req.user.role==='superadmin' }));

const monthStart = () => new Date().toISOString().substring(0,7) + '-01';
const today = () => new Date().toISOString().split('T')[0];

router.get('/profit-loss', wrap(async (req, res) => {
  const from = req.query.from || monthStart();
  const to   = req.query.to   || today();
  const r = await pool.query(`
    SELECT
      (SELECT COALESCE(SUM(total),0) FROM invoices WHERE invoice_date BETWEEN $1 AND $2) AS revenue,
      (SELECT COALESCE(SUM(total),0) FROM purchases WHERE purchase_date BETWEEN $1 AND $2) AS purchases,
      (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date BETWEEN $1 AND $2) AS expenses,
      (SELECT COALESCE(SUM(freight_charges),0) FROM bilty WHERE bilty_date BETWEEN $1 AND $2) AS freight,
      (SELECT COALESCE(SUM(adjustment_amount),0) FROM breakage WHERE claim_status='resolved' AND breakage_date BETWEEN $1 AND $2) AS breakage
  `, [from, to]);
  const v = r.rows[0]; for (const k of Object.keys(v)) v[k] = Number(v[k]) || 0;
  // True profit uses cost_at_sale, not current cost_price
  const cogsR = await pool.query(`
    SELECT COALESCE(SUM(ii.quantity * ii.cost_at_sale),0) AS cogs
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date BETWEEN $1 AND $2`, [from, to]);
  const cogs = Number(cogsR.rows[0].cogs) || 0;
  const grossProfit = v.revenue - cogs;
  const netProfit   = grossProfit - v.expenses - v.freight - v.breakage;
  const expBreakdown = (await pool.query(`SELECT category, SUM(amount) AS total FROM expenses WHERE expense_date BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, [from, to])).rows;
  res.render('reports/profit-loss', { page:'reports', from, to, revenue: v.revenue, purchases: v.purchases, expenses: v.expenses, freight: v.freight, breakageAdj: v.breakage, cogs, grossProfit, netProfit, expenseBreakdown: expBreakdown });
}));

router.get('/balance-sheet', wrap(async (req, res) => {
  const asOf = req.query.date || today();
  const r = await pool.query(`
    SELECT
      (SELECT COALESCE(SUM(balance),0) FROM customers WHERE balance > 0) AS total_receivable,
      (SELECT COALESCE(SUM(ABS(balance)),0) FROM vendors WHERE balance < 0) AS total_payable,
      (SELECT COALESCE(SUM(stock * cost_price),0) FROM products WHERE status='active') AS inventory_value,
      (SELECT COALESCE(SUM(total),0) FROM invoices WHERE invoice_date <= $1) AS total_revenue,
      (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date <= $1) AS total_expenses,
      (SELECT COALESCE(SUM(total),0) FROM purchases WHERE purchase_date <= $1) AS total_purchases
  `, [asOf]);
  const v = r.rows[0]; for (const k of Object.keys(v)) v[k] = Number(v[k]) || 0;
  res.render('reports/balance-sheet', { page:'reports', asOf, totalReceivable: v.total_receivable, totalPayable: v.total_payable, inventoryValue: v.inventory_value, totalRevenue: v.total_revenue, totalExpenses: v.total_expenses, totalPurchases: v.total_purchases });
}));

router.get('/trial-balance', wrap(async (req, res) => {
  const customers = (await pool.query(`SELECT name, balance FROM customers WHERE balance <> 0 ORDER BY ABS(balance) DESC`)).rows;
  const vendors   = (await pool.query(`SELECT name, balance FROM vendors   WHERE balance <> 0 ORDER BY ABS(balance) DESC`)).rows;
  res.render('reports/trial-balance', { page:'reports', customers, vendors });
}));

router.get('/sales-monthly', wrap(async (req, res) => {
  const year = parseInt(req.query.year || new Date().getFullYear(), 10);
  const r = await pool.query(`
    SELECT to_char(invoice_date,'YYYY-MM') AS month, COUNT(*)::int AS count, SUM(total) AS total
    FROM invoices WHERE EXTRACT(YEAR FROM invoice_date)=$1
    GROUP BY 1 ORDER BY 1`, [year]);
  res.render('reports/sales-monthly', { page:'reports', year, monthlySales: r.rows });
}));

router.get('/product-sales', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const r = await pool.query(`
    SELECT p.name, SUM(ii.quantity)::int AS total_qty, SUM(ii.amount) AS total_amount
    FROM invoice_items ii JOIN products p ON p.id = ii.product_id
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date BETWEEN $1 AND $2
    GROUP BY p.id, p.name ORDER BY total_amount DESC`, [from, to]);
  res.render('reports/product-sales', { page:'reports', from, to, productSales: r.rows });
}));

router.get('/customer-analysis', wrap(async (req, res) => {
  const from = req.query.from || (new Date().getFullYear() + '-01-01');
  const to   = req.query.to   || today();
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
  const allCustomers = (await pool.query(`SELECT id, name FROM customers WHERE status='active' ORDER BY name`)).rows;
  let analysis = [], detail = null;
  if (customerId) {
    detail = (await pool.query(`SELECT * FROM customers WHERE id=$1`, [customerId])).rows[0];
    if (detail) {
      detail.invoices = (await pool.query(`SELECT id, invoice_no, invoice_date, total, status FROM invoices WHERE customer_id=$1 AND invoice_date BETWEEN $2 AND $3 ORDER BY invoice_date DESC`, [customerId, from, to])).rows;
      detail.payments = (await pool.query(`SELECT id, payment_date, amount, payment_method FROM payments WHERE entity_type='customer' AND entity_id=$1 AND payment_date BETWEEN $2 AND $3 ORDER BY payment_date DESC`, [customerId, from, to])).rows;
      detail.totalSales = detail.invoices.reduce((s, i) => s + Number(i.total||0), 0);
      detail.totalPaid  = detail.payments.reduce((s, p) => s + Number(p.amount||0), 0);
      detail.topProducts = (await pool.query(`
        SELECT p.name, SUM(ii.quantity) qty, SUM(ii.amount) amount
        FROM invoice_items ii JOIN products p ON p.id = ii.product_id
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.customer_id=$1 AND i.invoice_date BETWEEN $2 AND $3
        GROUP BY p.id, p.name ORDER BY amount DESC LIMIT 10`, [customerId, from, to])).rows;
    }
  } else {
    analysis = (await pool.query(`
      SELECT c.id, c.name, c.city, c.phone, COUNT(i.id)::int AS invoice_count,
             COALESCE(SUM(i.total),0) AS total_sales,
             COALESCE(AVG(i.total),0) AS avg_sale,
             MAX(i.invoice_date) AS last_sale, c.balance
      FROM customers c
      LEFT JOIN invoices i ON i.customer_id = c.id AND i.invoice_date BETWEEN $1 AND $2
      WHERE c.status='active'
      GROUP BY c.id ORDER BY total_sales DESC`, [from, to])).rows;
  }
  res.render('reports/customer-analysis', { page:'reports', from, to, analysis, allCustomers, customerId, detail });
}));

router.get('/sale-performance', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const daily = (await pool.query(`
    SELECT to_char(invoice_date,'YYYY-MM-DD') AS date, COUNT(*)::int AS count, SUM(total) AS total
    FROM invoices WHERE invoice_date BETWEEN $1 AND $2
    GROUP BY 1 ORDER BY 1`, [from, to])).rows.map(r => ({ ...r, total: Number(r.total)||0 }));
  const totalSales = daily.reduce((s,d) => s + d.total, 0);
  const avgDaily = daily.length ? totalSales/daily.length : 0;
  const last30 = new Date(Date.now() - 30*864e5).toISOString().split('T')[0];
  const sumR = (await pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date >= $1`, [last30])).rows[0];
  const dailyAvg30 = Number(sumR.v) / 30;
  const forecast7d = dailyAvg30 * 7, forecast30d = dailyAvg30 * 30;
  const periodDays = Math.max(1, Math.ceil((new Date(to) - new Date(from))/86400000) + 1);
  const priorEnd = new Date(new Date(from).getTime() - 86400000).toISOString().split('T')[0];
  const priorStart = new Date(new Date(priorEnd).getTime() - (periodDays-1)*86400000).toISOString().split('T')[0];
  const priorR = (await pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date BETWEEN $1 AND $2`, [priorStart, priorEnd])).rows[0];
  const priorSum = Number(priorR.v) || 0;
  const trendPct = priorSum > 0 ? ((totalSales - priorSum) / priorSum) * 100 : 0;
  const sorted = daily.slice().sort((a,b)=>b.total-a.total);
  const bestDay = sorted[0] || null, worstDay = sorted[sorted.length-1] || null;
  const fmtPKR = n => 'PKR ' + Number(n||0).toLocaleString('en-PK',{maximumFractionDigits:0});
  const insights = [];
  if (trendPct > 0) insights.push({ icon:'arrow-up-circle', color:'success', text:`Sales up ${trendPct.toFixed(1)}% vs prior ${periodDays}-day window (${fmtPKR(priorSum)} → ${fmtPKR(totalSales)})` });
  else if (trendPct < 0) insights.push({ icon:'arrow-down-circle', color:'danger', text:`Sales down ${Math.abs(trendPct).toFixed(1)}% vs prior period` });
  if (bestDay)  insights.push({ icon:'star', color:'info', text:`Best day: ${bestDay.date} → ${fmtPKR(bestDay.total)}` });
  if (worstDay && daily.length > 1) insights.push({ icon:'circle', color:'secondary', text:`Slowest day: ${worstDay.date} → ${fmtPKR(worstDay.total)}` });
  insights.push({ icon:'graph-up', color:'primary', text:`Forecast: 7d ≈ ${fmtPKR(forecast7d)}; 30d ≈ ${fmtPKR(forecast30d)} (avg ${fmtPKR(dailyAvg30)}/day)` });
  res.render('reports/sale-performance', { page:'reports', from, to, daily, totalSales, avgDaily, forecast7d, forecast30d, dailyAvg30, trendPct, bestDay, worstDay, insights, priorSum });
}));

router.get('/delivery-returns', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const r = await pool.query(`
    SELECT b.*, COALESCE(c.name, c2.name, '') AS customer_name
    FROM bilty b LEFT JOIN orders o ON o.id=b.order_id LEFT JOIN invoices i ON i.id=b.invoice_id
    LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN customers c2 ON c2.id=i.customer_id
    WHERE b.bilty_date BETWEEN $1 AND $2 ORDER BY b.bilty_date DESC`, [from, to]);
  res.render('reports/delivery-returns', { page:'reports', from, to, deliveries: r.rows });
}));

router.get('/purchase-invoices', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const r = await pool.query(`SELECT p.*, v.name AS vendor_name FROM purchases p JOIN vendors v ON v.id=p.vendor_id WHERE p.purchase_date BETWEEN $1 AND $2 ORDER BY p.purchase_date DESC`, [from, to]);
  res.render('reports/purchase-invoices', { page:'reports', from, to, purchases: r.rows });
}));

router.get('/vendor-payments', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const payments = (await pool.query(`SELECT p.*, v.name AS vendor_name FROM payments p JOIN vendors v ON v.id=p.entity_id WHERE p.entity_type='vendor' AND p.payment_date BETWEEN $1 AND $2 ORDER BY p.payment_date DESC`, [from, to])).rows;
  const vendorSummary = (await pool.query(`
    SELECT v.name, v.balance, COALESCE(SUM(p.amount),0) AS total_paid
    FROM vendors v LEFT JOIN payments p ON p.entity_type='vendor' AND p.entity_id=v.id AND p.payment_date BETWEEN $1 AND $2
    WHERE v.status='active' GROUP BY v.id, v.name, v.balance ORDER BY total_paid DESC`, [from, to])).rows;
  res.render('reports/vendor-payments', { page:'reports', from, to, payments, vendorSummary });
}));

const AGE_BUCKETS = [
  { key:'b15',  label:'0-15',    min:0,   max:15 },
  { key:'b30',  label:'16-30',   min:16,  max:30 },
  { key:'b45',  label:'31-45',   min:31,  max:45 },
  { key:'b60',  label:'46-60',   min:46,  max:60 },
  { key:'b90',  label:'61-90',   min:61,  max:90 },
  { key:'b120', label:'91-120',  min:91,  max:120 },
  { key:'b200', label:'121-200', min:121, max:200 },
  { key:'b365', label:'201-365', min:201, max:365 },
  { key:'b365p',label:'365+',    min:366, max:1e9 }
];
async function bucketize(party) {
  const b = {}; AGE_BUCKETS.forEach(x => b[x.key] = 0);
  const sql = party.entity_type === 'customer'
    ? `SELECT invoice_date AS d, (total - COALESCE(paid,0)) AS bal FROM invoices WHERE customer_id=$1 AND (total - COALESCE(paid,0)) > 0`
    : `SELECT purchase_date AS d, total AS bal FROM purchases WHERE vendor_id=$1`;
  const rows = (await pool.query(sql, [party.id])).rows;
  for (const r of rows) {
    if (!r.d || !r.bal) continue;
    const days = Math.floor((Date.now() - new Date(r.d).getTime())/86400000);
    const bk = AGE_BUCKETS.find(x => days >= x.min && days <= x.max);
    if (bk) b[bk.key] += Number(r.bal) || 0;
  }
  return b;
}
router.get('/aged-receivable', wrap(async (req, res) => {
  const customers = (await pool.query(`SELECT c.*, (SELECT MAX(txn_date) FROM ledger WHERE entity_type='customer' AND entity_id=c.id) AS last_txn FROM customers c WHERE c.balance > 0 ORDER BY c.balance DESC`)).rows;
  for (const c of customers) { c.entity_type = 'customer'; c.buckets = await bucketize(c); }
  res.render('reports/aged-receivable', { page:'reports', customers, AGE_BUCKETS });
}));
router.get('/aged-payable', wrap(async (req, res) => {
  const vendors = (await pool.query(`SELECT v.*, (SELECT MAX(txn_date) FROM ledger WHERE entity_type='vendor' AND entity_id=v.id) AS last_txn FROM vendors v WHERE v.balance < 0 ORDER BY v.balance ASC`)).rows;
  for (const v of vendors) { v.entity_type = 'vendor'; v.buckets = await bucketize(v); }
  res.render('reports/aged-payable', { page:'reports', vendors, AGE_BUCKETS });
}));

router.get('/customer-balances', wrap(async (req, res) => {
  const customers = (await pool.query(`SELECT id, name, city, phone, balance FROM customers WHERE status='active' ORDER BY name`)).rows;
  const totalDue = customers.filter(c => c.balance > 0).reduce((s,c) => s + Number(c.balance||0), 0);
  res.render('reports/customer-balances', { page:'reports', customers, totalDue });
}));

router.get('/vendor-balances', wrap(async (req, res) => {
  const vendors = (await pool.query(`SELECT id, name, city, phone, balance FROM vendors WHERE status='active' ORDER BY name`)).rows;
  const totalDue = vendors.filter(v => v.balance < 0).reduce((s,v) => s + Math.abs(Number(v.balance||0)), 0);
  res.render('reports/vendor-balances', { page:'reports', vendors, totalDue });
}));

router.get('/low-stock', wrap(async (req, res) => {
  const products = (await pool.query(`SELECT * FROM products WHERE stock <= COALESCE(min_stock,0) AND status='active' ORDER BY stock ASC`)).rows;
  res.render('reports/low-stock', { page:'reports', products });
}));

router.get('/stock-ledger', wrap(async (req, res) => {
  const productId = req.query.product_id || '';
  const products = (await pool.query(`SELECT id, name FROM products WHERE status='active' ORDER BY name`)).rows;
  let movements = [], product = null;
  if (productId) {
    product = (await pool.query(`SELECT * FROM products WHERE id=$1`, [productId])).rows[0];
    movements = (await pool.query(`
      SELECT to_char(ts,'YYYY-MM-DD') AS date, ref_type AS type, qty_delta AS quantity, ref_id, reason AS party
      FROM stock_ledger WHERE product_id=$1 ORDER BY id DESC`, [productId])).rows;
  }
  res.render('reports/stock-ledger', { page:'reports', products, productId, product, movements });
}));

router.get('/stock-valuation', wrap(async (req, res) => {
  const products = (await pool.query(`SELECT name, stock, cost_price AS rate, (stock * cost_price)::NUMERIC(14,2) AS value FROM products WHERE status='active' ORDER BY (stock * cost_price) DESC`)).rows;
  const totalValue = products.reduce((s,p) => s + Number(p.value||0), 0);
  res.render('reports/stock-valuation', { page:'reports', products, totalValue });
}));

router.get('/expense-report', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const byCategory = (await pool.query(`SELECT category, COUNT(*)::int AS count, SUM(amount) AS total FROM expenses WHERE expense_date BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, [from, to])).rows;
  const expenses = (await pool.query(`SELECT * FROM expenses WHERE expense_date BETWEEN $1 AND $2 ORDER BY expense_date DESC`, [from, to])).rows;
  const totalExp = expenses.reduce((s,e) => s + Number(e.amount||0), 0);
  res.render('reports/expense-report', { page:'reports', from, to, byCategory, expenses, totalExp });
}));

router.get('/audit-log', wrap(async (req, res) => {
  const module = req.query.module || ''; const search = (req.query.search || '').trim();
  const params = []; const parts = ['1=1']; let i = 1;
  if (module) { parts.push(`al.module = $${i}`); params.push(module); i++; }
  if (search) { parts.push(`(al.details ILIKE $${i} OR u.name ILIKE $${i} OR u.username ILIKE $${i})`); params.push('%'+search+'%'); i++; }
  const r = await pool.query(`
    SELECT al.id, al.action, al.module, al.record_id, al.details, al.created_at,
           u.username, u.name AS user_name, u.role,
           CASE
             WHEN al.module='invoices'    THEN (SELECT invoice_no  FROM invoices  WHERE id = al.record_id)
             WHEN al.module='orders'      THEN (SELECT order_no    FROM orders    WHERE id = al.record_id)
             WHEN al.module='purchases'   THEN (SELECT purchase_no FROM purchases WHERE id = al.record_id)
             WHEN al.module='bilty'       THEN (SELECT bilty_no    FROM bilty     WHERE id = al.record_id)
             WHEN al.module='credit_notes' OR al.module='creditnotes' THEN (SELECT note_no FROM credit_notes WHERE id = al.record_id)
             WHEN al.module='customers'   THEN (SELECT name FROM customers WHERE id = al.record_id)
             WHEN al.module='vendors'     THEN (SELECT name FROM vendors   WHERE id = al.record_id)
             WHEN al.module='products'    THEN (SELECT name FROM products  WHERE id = al.record_id)
             ELSE NULL END AS ref_no
    FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    WHERE ${parts.join(' AND ')} ORDER BY al.id DESC LIMIT 500`, params);
  const modules = (await pool.query(`SELECT DISTINCT module FROM audit_log ORDER BY module`)).rows.map(r => r.module);
  res.render('reports/audit-log', { page:'reports', logs: r.rows, modules, module, search });
}));

router.get('/breakage-report', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const breakages = (await pool.query(`
    SELECT br.*, p.name AS product_name, COALESCE(c.name,'') AS customer_name, COALESCE(v.name,'') AS vendor_name
    FROM breakage br JOIN products p ON p.id=br.product_id
    LEFT JOIN customers c ON c.id=br.customer_id LEFT JOIN vendors v ON v.id=br.vendor_id
    WHERE br.breakage_date BETWEEN $1 AND $2 ORDER BY br.breakage_date DESC`, [from, to])).rows;
  const totalQty = breakages.reduce((s,b) => s + Number(b.quantity||0), 0);
  const totalAdj = breakages.reduce((s,b) => s + Number(b.adjustment_amount||0), 0);
  res.render('reports/breakage-report', { page:'reports', from, to, breakages, totalQty, totalAdj });
}));

router.get('/bilty-report', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const bilties = (await pool.query(`
    SELECT b.*, COALESCE(o.order_no,'') AS order_no, COALESCE(i.invoice_no,'') AS invoice_no,
      COALESCE(c.name, c2.name, '') AS customer_name
    FROM bilty b
    LEFT JOIN orders o ON o.id=b.order_id LEFT JOIN invoices i ON i.id=b.invoice_id
    LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN customers c2 ON c2.id=i.customer_id
    WHERE b.bilty_date BETWEEN $1 AND $2 ORDER BY b.bilty_date DESC`, [from, to])).rows;
  const totalFreight = bilties.reduce((s,b) => s + Number(b.freight_charges||0), 0);
  res.render('reports/bilty-report', { page:'reports', from, to, bilties, totalFreight });
}));

router.get('/transactions', wrap(async (req, res) => {
  const from = req.query.from || monthStart(), to = req.query.to || today();
  const scope = (req.query.scope || '').replace(/[^a-z_]/g, '');
  const sf = scope ? ` AND account_scope = '${scope}'` : '';
  const orders   = (await pool.query(`SELECT 'order' AS type, o.id AS ref_id, o.order_no AS ref, o.order_date AS date, COALESCE(c.name,'-') AS party, o.total AS amount, o.account_scope FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.order_date BETWEEN $1 AND $2 ${sf}`, [from, to])).rows;
  const invoices = (await pool.query(`SELECT 'invoice' AS type, i.id AS ref_id, i.invoice_no AS ref, i.invoice_date AS date, COALESCE(c.name,'-') AS party, i.total AS amount, i.account_scope FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.invoice_date BETWEEN $1 AND $2 ${sf}`, [from, to])).rows;
  const purchases= (await pool.query(`SELECT 'purchase' AS type, p.id AS ref_id, p.purchase_no AS ref, p.purchase_date AS date, COALESCE(v.name,'-') AS party, p.total AS amount, p.account_scope FROM purchases p LEFT JOIN vendors v ON v.id=p.vendor_id WHERE p.purchase_date BETWEEN $1 AND $2 ${sf}`, [from, to])).rows;
  const payments = (await pool.query(`SELECT 'payment' AS type, p.id AS ref_id, ('PMT-'||p.id) AS ref, p.payment_date AS date, CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END AS party, p.amount, p.account_scope FROM payments p LEFT JOIN customers c ON p.entity_type='customer' AND c.id=p.entity_id LEFT JOIN vendors v ON p.entity_type='vendor' AND v.id=p.entity_id WHERE p.payment_date BETWEEN $1 AND $2 ${sf}`, [from, to])).rows;
  const all = [...orders, ...invoices, ...purchases, ...payments].sort((a,b) => (a.date > b.date ? -1 : 1));
  res.render('reports/transactions', { page:'reports', from, to, scope, all });
}));

module.exports = router;
