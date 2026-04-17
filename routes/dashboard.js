const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.substring(0, 7) + '-01';
  const yearStart = today.substring(0, 4) + '-01-01';

  // Dashboard date range filter
  const period = req.query.period || 'month';
  let rangeStart, rangeEnd, rangeLabel;
  rangeEnd = req.query.to || today;

  if (period === 'today') {
    rangeStart = today; rangeLabel = 'Today';
  } else if (period === 'week') {
    const d = new Date(); d.setDate(d.getDate() - 6);
    rangeStart = d.toISOString().split('T')[0]; rangeLabel = 'Last 7 Days';
  } else if (period === 'month') {
    rangeStart = monthStart; rangeLabel = 'This Month';
  } else if (period === 'year') {
    rangeStart = yearStart; rangeLabel = 'This Year';
  } else if (period === 'custom') {
    rangeStart = req.query.from || monthStart;
    rangeEnd = req.query.to || today;
    rangeLabel = `${rangeStart} → ${rangeEnd}`;
  } else {
    rangeStart = monthStart; rangeLabel = 'This Month';
  }

  // Revenue for selected range
  const rangeRev = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM invoices WHERE invoice_date >= ? AND invoice_date <= ?`).get(rangeStart, rangeEnd).val;
  const rangeExp = db.prepare(`SELECT COALESCE(SUM(amount),0) as val FROM expenses WHERE expense_date >= ? AND expense_date <= ?`).get(rangeStart, rangeEnd).val;
  const rangePurchases = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM purchases WHERE purchase_date >= ? AND purchase_date <= ?`).get(rangeStart, rangeEnd).val;

  // Always show today/month/year for year overview
  const todayRev = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM invoices WHERE invoice_date = ?`).get(today).val;
  const monthRev = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM invoices WHERE invoice_date >= ?`).get(monthStart).val;
  const yearRev  = db.prepare(`SELECT COALESCE(SUM(total),0) as val FROM invoices WHERE invoice_date >= ?`).get(yearStart).val;
  const todayExp = db.prepare(`SELECT COALESCE(SUM(amount),0) as val FROM expenses WHERE expense_date = ?`).get(today).val;
  const monthExp = db.prepare(`SELECT COALESCE(SUM(amount),0) as val FROM expenses WHERE expense_date >= ?`).get(monthStart).val;
  const yearExp  = db.prepare(`SELECT COALESCE(SUM(amount),0) as val FROM expenses WHERE expense_date >= ?`).get(yearStart).val;

  const totalCustomers  = db.prepare(`SELECT COUNT(*) as cnt FROM customers WHERE status='active'`).get().cnt;
  const pendingOrders   = db.prepare(`SELECT COUNT(*) as cnt FROM orders WHERE status='pending'`).get().cnt;
  const unpaidInvoices  = db.prepare(`SELECT COUNT(*) as cnt FROM invoices WHERE status='unpaid'`).get().cnt;
  const unpaidAmount    = db.prepare(`SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) as val FROM invoices WHERE status != 'paid'`).get().val;
  const pendingClaims   = db.prepare(`SELECT COUNT(*) as cnt FROM breakage WHERE claim_status='pending'`).get().cnt;
  const totalReceivables= db.prepare(`SELECT COALESCE(SUM(balance),0) as val FROM customers WHERE status='active' AND balance > 0`).get().val;
  const totalPayables   = db.prepare(`SELECT COALESCE(SUM(balance),0) as val FROM vendors WHERE status='active' AND balance > 0`).get().val;
  const bankBalance     = db.prepare(`SELECT COALESCE(SUM(balance),0) as val FROM bank_accounts WHERE status='active'`).get().val;
  const overdueInvoices = db.prepare(`SELECT COUNT(*) as cnt FROM invoices WHERE due_date < ? AND status != 'paid'`).get(today).cnt;
  const overdueAmount   = db.prepare(`SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) as val FROM invoices WHERE due_date < ? AND status != 'paid'`).get(today).val;

  // Top Customers for selected range
  const topCustomers = db.prepare(`
    SELECT c.name, COALESCE(SUM(i.total),0) as total_sales
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.invoice_date >= ? AND i.invoice_date <= ?
    GROUP BY c.id ORDER BY total_sales DESC LIMIT 5
  `).all(rangeStart, rangeEnd);

  const topProducts = db.prepare(`
    SELECT p.name, COALESCE(SUM(ii.quantity),0) as total_qty
    FROM invoice_items ii JOIN products p ON p.id = ii.product_id
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date >= ? AND i.invoice_date <= ?
    GROUP BY p.id ORDER BY total_qty DESC LIMIT 5
  `).all(rangeStart, rangeEnd);

  const lowStock = db.prepare(`SELECT name, stock, min_stock FROM products WHERE stock <= min_stock AND status='active' ORDER BY stock ASC LIMIT 5`).all();

  const recentOrders = db.prepare(`
    SELECT o.*, c.name as customer_name FROM orders o
    JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 8
  `).all();

  const recentPayments = db.prepare(`
    SELECT p.*,
      CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END as entity_name
    FROM payments p
    LEFT JOIN customers c ON p.entity_type='customer' AND c.id = p.entity_id
    LEFT JOIN vendors v ON p.entity_type='vendor' AND v.id = p.entity_id
    ORDER BY p.id DESC LIMIT 5
  `).all();

  // Monthly chart data (last 6 months)
  const chartData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const m = d.toISOString().substring(0, 7);
    const rev = db.prepare(`SELECT COALESCE(SUM(total),0) as v FROM invoices WHERE invoice_date LIKE ?`).get(m + '%');
    const exp = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE expense_date LIKE ?`).get(m + '%');
    chartData.push({ month: d.toLocaleString('default', { month: 'short', year: '2-digit' }), revenue: rev.v, expense: exp.v });
  }

  // Rate fluctuations
  const rateChanges = db.prepare(`
    SELECT p.name, p.rate as current_rate, h.old_rate, h.new_rate, h.changed_at,
      ROUND(((h.new_rate - h.old_rate) / CASE WHEN h.old_rate=0 THEN 1 ELSE h.old_rate END) * 100, 1) as pct_change
    FROM product_rate_history h JOIN products p ON p.id = h.product_id
    ORDER BY h.id DESC LIMIT 8
  `).all();

  // Stock velocity
  const last30str = new Date(Date.now() - 30*864e5).toISOString().split('T')[0];
  const stockVelocity = db.prepare(`
    SELECT p.name, p.stock,
      COALESCE(SUM(ii.quantity), 0) as sold_30d,
      CASE WHEN COALESCE(SUM(ii.quantity), 0) > 0 THEN ROUND(p.stock / (COALESCE(SUM(ii.quantity), 0) / 30.0)) ELSE NULL END as days_left
    FROM products p
    LEFT JOIN invoice_items ii ON ii.product_id = p.id
    LEFT JOIN invoices inv ON inv.id = ii.invoice_id AND inv.invoice_date >= ?
    WHERE p.status = 'active'
    GROUP BY p.id HAVING sold_30d > 0 ORDER BY days_left ASC LIMIT 6
  `).all(last30str);

  res.render('dashboard', {
    page: 'dashboard',
    period, rangeStart, rangeEnd: req.query.to || today, rangeLabel,
    rangeRev, rangeExp, rangePurchases,
    rangeProfit: rangeRev - rangeExp,
    todayRev, monthRev, yearRev,
    todayExp, monthExp, yearExp,
    monthProfit: monthRev - monthExp,
    yearProfit: yearRev - yearExp,
    totalCustomers, pendingOrders, unpaidInvoices, unpaidAmount, pendingClaims,
    totalReceivables, totalPayables, bankBalance,
    overdueInvoices, overdueAmount,
    topCustomers, topProducts, lowStock, recentOrders, recentPayments, chartData,
    rateChanges, stockVelocity,
    monthPurchases: rangePurchases
  });
});

module.exports = router;
