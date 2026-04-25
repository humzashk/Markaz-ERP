const express = require('express');
const router = express.Router();
const { db, logError } = require('../database');

// Per-request error collector populated by safe()
function makeSafe(errorsBag) {
  return function safe(fn, fallback, scope) {
    try {
      return fn();
    } catch (e) {
      try { logError('dashboard.' + (scope || 'query'), e); } catch (_) {}
      errorsBag.push({ scope: scope || 'query', message: e && e.message ? e.message : String(e) });
      // Return fallback but flag it so view can mark as errored
      if (fallback && typeof fallback === 'object') {
        try { Object.defineProperty(fallback, '__errored', { value: true, enumerable: false }); } catch (_) {}
      }
      return fallback;
    }
  };
}

// Dashboard widget keys (used in user_permissions for granular control)
const DASH_WIDGETS = ['dash.financials','dash.profit','dash.cash','dash.aging','dash.activity','dash.accounts','dash.charts','dash.stock','dash.customers','dash.products','dash.ai','dash.audit','dash.recent'];

// Helper: which widgets can current user see?
function visibleWidgets(req) {
  const role = req.user && req.user.role;
  if (role === 'superadmin') return DASH_WIDGETS.slice();
  // Admin and below: only widgets explicitly granted via user_permissions
  const mods = req.userModules || [];
  return DASH_WIDGETS.filter(w => mods.includes(w));
}

router.get('/', (req, res) => {
  // ===== ACCESS CONTROL =====
  if (!req.user) return res.redirect('/login');
  const isSuperadmin = req.user.role === 'superadmin';
  const widgets = visibleWidgets(req);
  const can = (w) => widgets.includes(w);

  // Non-superadmin without any dashboard widgets → restricted page
  if (!isSuperadmin && widgets.length === 0) {
    return res.render('dashboard-restricted', { page: 'dashboard' });
  }

  // Per-request dashboard error collector (visible to view)
  const dashboardErrors = [];
  const safe = makeSafe(dashboardErrors);

  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.substring(0, 7) + '-01';
  const yearStart = today.substring(0, 4) + '-01-01';
  const lastYearStart = (parseInt(today.substring(0,4)) - 1) + '-01-01';
  const lastYearEnd   = (parseInt(today.substring(0,4)) - 1) + '-12-31';
  const last7  = new Date(Date.now() - 7*864e5).toISOString().split('T')[0];
  const last30 = new Date(Date.now() - 30*864e5).toISOString().split('T')[0];
  const last90 = new Date(Date.now() - 90*864e5).toISOString().split('T')[0];
  const quarterStart = (() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().split('T')[0]; })();

  const period = req.query.period || 'month';
  const accountFilter = req.query.account || '';
  let rangeStart, rangeEnd, rangeLabel;
  rangeEnd = req.query.to || today;

  if (period === 'today') { rangeStart = today; rangeLabel = 'Today'; }
  else if (period === 'week') { rangeStart = last7; rangeLabel = 'Last 7 Days'; }
  else if (period === 'month') { rangeStart = monthStart; rangeLabel = 'This Month'; }
  else if (period === 'year') { rangeStart = yearStart; rangeLabel = 'This Year'; }
  else if (period === 'lastyear') { rangeStart = lastYearStart; rangeEnd = lastYearEnd; rangeLabel = 'Last Year'; }
  else if (period === 'all') { rangeStart = '1970-01-01'; rangeLabel = 'All Time'; }
  else if (period === 'custom') { rangeStart = req.query.from || monthStart; rangeEnd = req.query.to || today; rangeLabel = `${rangeStart} → ${rangeEnd}`; }
  else { rangeStart = monthStart; rangeLabel = 'This Month'; }

  const accClause = accountFilter ? ` AND account_scope = '${accountFilter.replace(/[^a-z_]/g,'')}'` : '';

  // ===== CORE FINANCIALS =====
  const rangeRev       = safe(() => db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date BETWEEN ? AND ?${accClause}`).get(rangeStart, rangeEnd).v, 0);
  const rangeExp       = safe(() => db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date BETWEEN ? AND ?`).get(rangeStart, rangeEnd).v, 0);
  const rangePurchases = safe(() => db.prepare(`SELECT COALESCE(SUM(total),0) v FROM purchases WHERE purchase_date BETWEEN ? AND ?${accClause}`).get(rangeStart, rangeEnd).v, 0);
  const rangeCommission= safe(() => db.prepare(`SELECT COALESCE(SUM(commission_amount),0) v FROM invoices WHERE invoice_date BETWEEN ? AND ?${accClause}`).get(rangeStart, rangeEnd).v, 0);
  const rangeDelivery  = safe(() => db.prepare(`SELECT COALESCE(SUM(transport_charge),0) v FROM invoices WHERE invoice_date BETWEEN ? AND ?${accClause}`).get(rangeStart, rangeEnd).v, 0);
  const rangeCOGS      = safe(() => db.prepare(`
    SELECT COALESCE(SUM(ii.quantity * COALESCE(p.cost_price, p.purchase_rate, 0)), 0) v
    FROM invoice_items ii JOIN products p ON p.id = ii.product_id
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date BETWEEN ? AND ?
  `).get(rangeStart, rangeEnd).v, 0);

  const rangeProfit = rangeRev - rangeCOGS - rangeCommission - rangeDelivery - rangeExp;
  const rangeMargin = rangeRev > 0 ? ((rangeProfit / rangeRev) * 100).toFixed(1) : 0;

  const todayRev = safe(() => db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date = ?`).get(today).v, 0);
  const monthRev = safe(() => db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date >= ?`).get(monthStart).v, 0);
  const yearRev  = safe(() => db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date >= ?`).get(yearStart).v, 0);
  const todayExp = safe(() => db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date = ?`).get(today).v, 0);
  const monthExp = safe(() => db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date >= ?`).get(monthStart).v, 0);
  const yearExp  = safe(() => db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date >= ?`).get(yearStart).v, 0);
  const todayProfit = todayRev - todayExp;
  const monthProfit = monthRev - monthExp;
  const yearProfit  = yearRev - yearExp;

  // ===== CASH VS CREDIT =====
  const totalReceivables = safe(() => db.prepare(`SELECT COALESCE(SUM(balance),0) v FROM customers WHERE balance > 0`).get().v, 0);
  const totalPayables    = safe(() => db.prepare(`SELECT COALESCE(SUM(balance),0) v FROM vendors WHERE balance > 0`).get().v, 0);
  const bankBalance      = safe(() => db.prepare(`SELECT COALESCE(SUM(balance),0) v FROM bank_accounts WHERE status='active'`).get().v, 0);
  const cashPosition     = bankBalance + totalReceivables - totalPayables;

  // ===== AGING BUCKETS - link to filtered invoice list =====
  const aging30 = safe(() => db.prepare(`SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) v, COUNT(*) c FROM invoices WHERE due_date < ? AND due_date >= ? AND status != 'paid'`).get(today, new Date(Date.now()-30*864e5).toISOString().split('T')[0]), {v:0,c:0});
  const aging60 = safe(() => db.prepare(`SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) v, COUNT(*) c FROM invoices WHERE due_date < ? AND due_date >= ? AND status != 'paid'`).get(new Date(Date.now()-30*864e5).toISOString().split('T')[0], new Date(Date.now()-60*864e5).toISOString().split('T')[0]), {v:0,c:0});
  const aging90 = safe(() => db.prepare(`SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) v, COUNT(*) c FROM invoices WHERE due_date < ? AND status != 'paid'`).get(new Date(Date.now()-90*864e5).toISOString().split('T')[0]), {v:0,c:0});

  // ===== ACTIVITY =====
  const totalCustomers  = safe(() => db.prepare(`SELECT COUNT(*) c FROM customers WHERE status='active'`).get().c, 0);
  const pendingOrders   = safe(() => db.prepare(`SELECT COUNT(*) c FROM orders WHERE status='pending'`).get().c, 0);
  const unpaidInvoices  = safe(() => db.prepare(`SELECT COUNT(*) c FROM invoices WHERE status='unpaid'`).get().c, 0);
  const unpaidAmount    = safe(() => db.prepare(`SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) v FROM invoices WHERE status != 'paid'`).get().v, 0);
  const overdueInvoices = safe(() => db.prepare(`SELECT COUNT(*) c FROM invoices WHERE due_date < ? AND status != 'paid'`).get(today).c, 0);
  const overdueAmount   = safe(() => db.prepare(`SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) v FROM invoices WHERE due_date < ? AND status != 'paid'`).get(today).v, 0);
  const totalOrders     = safe(() => db.prepare(`SELECT COUNT(*) c FROM orders WHERE order_date BETWEEN ? AND ?`).get(rangeStart, rangeEnd).c, 0);
  const totalInvoices   = safe(() => db.prepare(`SELECT COUNT(*) c FROM invoices WHERE invoice_date BETWEEN ? AND ?`).get(rangeStart, rangeEnd).c, 0);
  const conversionRate  = totalOrders > 0 ? Math.round((totalInvoices / totalOrders) * 100) : 0;

  // ===== STOCK =====
  const stockValue = safe(() => db.prepare(`SELECT COALESCE(SUM(stock * COALESCE(cost_price, purchase_rate, rate, 0)),0) v FROM products WHERE status='active'`).get().v, 0);
  const lowStock = safe(() => db.prepare(`SELECT id, name, stock, min_stock FROM products WHERE stock <= COALESCE(min_stock,0) AND stock >= 0 AND status='active' ORDER BY stock ASC LIMIT 8`).all(), []);
  const negativeStock = safe(() => db.prepare(`SELECT id, name, stock FROM products WHERE stock < 0 AND status='active' ORDER BY stock ASC LIMIT 5`).all(), []);
  const outOfStockCount = safe(() => db.prepare(`SELECT COUNT(*) c FROM products WHERE stock <= 0 AND status='active'`).get().c, 0);

  // ===== TOP CUSTOMERS - with IDs for linking =====
  const topCustomersMonth = safe(() => db.prepare(`
    SELECT c.id, c.name, COALESCE(SUM(i.total),0) sales, COUNT(i.id) cnt
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.invoice_date >= ? GROUP BY c.id ORDER BY sales DESC LIMIT 5
  `).all(monthStart), []);
  const topCustomersQuarter = safe(() => db.prepare(`
    SELECT c.id, c.name, COALESCE(SUM(i.total),0) sales
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.invoice_date >= ? GROUP BY c.id ORDER BY sales DESC LIMIT 5
  `).all(quarterStart), []);
  const topCustomersYear = safe(() => db.prepare(`
    SELECT c.id, c.name, COALESCE(SUM(i.total),0) sales
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.invoice_date >= ? GROUP BY c.id ORDER BY sales DESC LIMIT 5
  `).all(yearStart), []);
  const topCustomersAllTime = safe(() => db.prepare(`
    SELECT c.id, c.name, COALESCE(SUM(i.total),0) sales
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    GROUP BY c.id ORDER BY sales DESC LIMIT 5
  `).all(), []);

  // ===== TOP PRODUCTS BY PROFIT =====
  const topProductsByProfit = safe(() => db.prepare(`
    SELECT p.id, p.name,
      COALESCE(SUM(ii.quantity),0) qty,
      COALESCE(SUM(ii.quantity * ii.rate),0) revenue,
      COALESCE(SUM(ii.quantity * (ii.rate - COALESCE(p.cost_price, p.purchase_rate, 0))),0) profit
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date BETWEEN ? AND ?
    GROUP BY p.id ORDER BY profit DESC LIMIT 8
  `).all(rangeStart, rangeEnd), []);

  // ===== ACCOUNT PERFORMANCE =====
  const accountPerf = safe(() => db.prepare(`
    SELECT COALESCE(account_scope, 'plastic_markaz') scope,
      COALESCE(SUM(total), 0) revenue, COUNT(*) invoices
    FROM invoices WHERE invoice_date BETWEEN ? AND ?
    GROUP BY COALESCE(account_scope, 'plastic_markaz')
  `).all(rangeStart, rangeEnd), []);
  const accountMap = { plastic_markaz: { name: 'Plastic Markaz', revenue: 0, invoices: 0 }, wings_furniture: { name: 'Wings Furniture', revenue: 0, invoices: 0 }, cooler: { name: 'Cooler', revenue: 0, invoices: 0 } };
  accountPerf.forEach(a => { if (accountMap[a.scope]) { accountMap[a.scope].revenue = a.revenue; accountMap[a.scope].invoices = a.invoices; } });
  const accountList = Object.keys(accountMap).map(k => ({ scope: k, ...accountMap[k] }));

  // ===== RECENT ACTIVITY =====
  const recentOrders = safe(() => db.prepare(`
    SELECT o.*, c.name as customer_name FROM orders o
    JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 6
  `).all(), []);
  const recentPayments = safe(() => db.prepare(`
    SELECT p.*, CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END as entity_name
    FROM payments p
    LEFT JOIN customers c ON p.entity_type='customer' AND c.id = p.entity_id
    LEFT JOIN vendors v ON p.entity_type='vendor' AND v.id = p.entity_id
    ORDER BY p.id DESC LIMIT 5
  `).all(), []);

  // ===== 6-MONTH CHART =====
  const chartData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const m = d.toISOString().substring(0, 7);
    const rev = safe(() => db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date LIKE ?`).get(m + '%').v, 0);
    const exp = safe(() => db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date LIKE ?`).get(m + '%').v, 0);
    chartData.push({ month: d.toLocaleString('default', { month: 'short', year: '2-digit' }), revenue: rev, expense: exp });
  }

  // ===== RATE CHANGES (with product_id link) =====
  const rateChanges = safe(() => db.prepare(`
    SELECT p.id as product_id, p.name, h.old_rate, h.new_rate, h.changed_at,
      ROUND(((h.new_rate - h.old_rate) / CASE WHEN h.old_rate=0 THEN 1 ELSE h.old_rate END) * 100, 1) as pct_change
    FROM product_rate_history h JOIN products p ON p.id = h.product_id
    ORDER BY h.id DESC LIMIT 6
  `).all(), []);

  // ===== STOCK FORECAST - only running items (sold within 90 days) =====
  const stockVelocity = safe(() => db.prepare(`
    SELECT p.id, p.name, p.stock,
      COALESCE(SUM(CASE WHEN inv.invoice_date >= ? THEN ii.quantity ELSE 0 END), 0) sold_30d,
      COALESCE(SUM(CASE WHEN inv.invoice_date >= ? THEN ii.quantity ELSE 0 END), 0) sold_90d,
      CASE WHEN COALESCE(SUM(CASE WHEN inv.invoice_date >= ? THEN ii.quantity ELSE 0 END), 0) > 0
        THEN ROUND(p.stock / (COALESCE(SUM(CASE WHEN inv.invoice_date >= ? THEN ii.quantity ELSE 0 END), 0) / 30.0))
        ELSE NULL END as days_left
    FROM products p
    LEFT JOIN invoice_items ii ON ii.product_id = p.id
    LEFT JOIN invoices inv ON inv.id = ii.invoice_id
    WHERE p.status = 'active'
    GROUP BY p.id
    HAVING sold_90d > 0
    ORDER BY days_left ASC LIMIT 12
  `).all(last30, last90, last30, last30), []);

  // ===== AI: SALES FORECAST =====
  const sales30dArr = safe(() => db.prepare(`SELECT invoice_date d, SUM(total) v FROM invoices WHERE invoice_date >= ? GROUP BY invoice_date`).all(last30), []);
  const sales30dTotal = sales30dArr.reduce((s,r) => s + (r.v||0), 0);
  const dailyAvg = sales30dArr.length ? sales30dTotal / 30 : 0;
  const forecast7d  = Math.round(dailyAvg * 7);
  const forecast30d = Math.round(dailyAvg * 30);

  // ===== AI: REORDER PREDICTION =====
  const reorderPredictions = safe(() => db.prepare(`
    SELECT c.id, c.name, c.phone, MAX(i.invoice_date) last_order,
      julianday('now') - julianday(MAX(i.invoice_date)) days_since,
      COUNT(i.id) order_cnt
    FROM customers c JOIN invoices i ON i.customer_id = c.id
    WHERE c.status='active'
    GROUP BY c.id
    HAVING order_cnt >= 2 AND days_since BETWEEN 30 AND 90
    ORDER BY days_since DESC LIMIT 8
  `).all(), []);

  // ===== AI: CREDIT RISK =====
  const creditRisk = safe(() => db.prepare(`
    SELECT c.id, c.name, c.balance,
      (SELECT COUNT(*) FROM invoices WHERE customer_id = c.id AND due_date < ? AND status != 'paid') overdue_cnt,
      (SELECT COALESCE(SUM(total - COALESCE(paid,0)),0) FROM invoices WHERE customer_id = c.id AND due_date < ? AND status != 'paid') overdue_amt
    FROM customers c
    WHERE c.balance > 0 AND c.status='active'
    ORDER BY overdue_amt DESC LIMIT 6
  `).all(today, today), []);
  const creditRiskScored = creditRisk.map(c => {
    let risk = 'low';
    if (c.overdue_cnt >= 3 || c.overdue_amt >= 50000) risk = 'high';
    else if (c.overdue_cnt >= 1 || c.overdue_amt > 0) risk = 'medium';
    return { ...c, risk };
  });

  // ===== AI: ANOMALIES =====
  const lowMarginInvoices = safe(() => db.prepare(`
    SELECT i.id, i.invoice_no, i.total, i.invoice_date, c.name customer_name, c.id customer_id,
      i.commission_amount, COALESCE(i.discount_amount,0) disc_amt
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.invoice_date >= ?
      AND ( (COALESCE(i.commission_amount,0) + COALESCE(i.discount_amount,0)) > i.total * 0.20 )
    ORDER BY i.id DESC LIMIT 5
  `).all(last30), []);

  // ===== AI: BOTTLENECKS =====
  const oldPendingOrders = safe(() => db.prepare(`
    SELECT o.id, o.order_no, o.order_date, c.name customer_name, c.id customer_id,
      o.total, julianday('now') - julianday(o.order_date) days_pending
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status = 'pending' AND julianday('now') - julianday(o.order_date) >= 7
    ORDER BY o.order_date ASC LIMIT 5
  `).all(), []);

  // ===== AI: USER MONITORING (audit log w/ party + amount) =====
  // audit_log actual schema: action, module, record_id, details, created_at, user_id
  const userEdits = safe(() => db.prepare(`
    SELECT al.id, al.action, al.module as entity_type, al.record_id as entity_id,
           al.details as note, al.created_at, al.user_id,
      u.username, u.name as user_name, u.role,
      CASE
        WHEN al.module='invoices'         THEN (SELECT invoice_no FROM invoices WHERE id = al.record_id)
        WHEN al.module='orders'           THEN (SELECT order_no FROM orders WHERE id = al.record_id)
        WHEN al.module='purchases'        THEN (SELECT purchase_no FROM purchases WHERE id = al.record_id)
        WHEN al.module='payments'         THEN (SELECT 'PAY-' || id FROM payments WHERE id = al.record_id)
        WHEN al.module='customers'        THEN (SELECT name FROM customers WHERE id = al.record_id)
        WHEN al.module='vendors'          THEN (SELECT name FROM vendors WHERE id = al.record_id)
        WHEN al.module='products'         THEN (SELECT name FROM products WHERE id = al.record_id)
        WHEN al.module='stock_adjustments'THEN (SELECT 'ADJ-' || id FROM stock_adjustments WHERE id = al.record_id)
        WHEN al.module='breakage'         THEN (SELECT 'BR-' || id FROM breakage WHERE id = al.record_id)
        WHEN al.module='bilty'            THEN (SELECT bilty_no FROM bilty WHERE id = al.record_id)
        WHEN al.module='creditnotes'      THEN (SELECT note_no FROM credit_notes WHERE id = al.record_id)
        ELSE NULL END as ref_no,
      CASE
        WHEN al.module='invoices'  THEN (SELECT (SELECT name FROM customers WHERE id = invoices.customer_id) FROM invoices WHERE id = al.record_id)
        WHEN al.module='orders'    THEN (SELECT (SELECT name FROM customers WHERE id = orders.customer_id) FROM orders WHERE id = al.record_id)
        WHEN al.module='purchases' THEN (SELECT (SELECT name FROM vendors WHERE id = purchases.vendor_id) FROM purchases WHERE id = al.record_id)
        ELSE NULL END as party_name,
      CASE
        WHEN al.module='invoices'  THEN (SELECT total FROM invoices WHERE id = al.record_id)
        WHEN al.module='orders'    THEN (SELECT total FROM orders WHERE id = al.record_id)
        WHEN al.module='purchases' THEN (SELECT total FROM purchases WHERE id = al.record_id)
        WHEN al.module='payments'  THEN (SELECT amount FROM payments WHERE id = al.record_id)
        WHEN al.module='expenses'  THEN (SELECT amount FROM expenses WHERE id = al.record_id)
        ELSE NULL END as amount
    FROM audit_log al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE al.created_at >= ?
    ORDER BY al.id DESC LIMIT 25
  `).all(last7 + ' 00:00:00'), []);

  // Map module → URL prefix (must match `addAuditLog(module=...)` calls in routes)
  const linkMap = {
    invoices: '/invoices/view/',
    orders: '/orders/view/',
    purchases: '/purchases/view/',
    payments: '/payments/',
    customers: '/customers/edit/',
    vendors: '/vendors/edit/',
    products: '/products/edit/',
    stock_adjustments: '/stock/',
    breakage: '/breakage/',
    bilty: '/bilty/view/',
    creditnotes: '/creditnotes/view/',
    expenses: '/expenses/'
  };
  userEdits.forEach(u => {
    u.link = (linkMap[u.entity_type] && u.entity_id) ? (linkMap[u.entity_type] + u.entity_id) : null;
    u.user_link = u.user_id ? '/users/edit/' + u.user_id : null;
  });

  // ===== AI: SMART SUGGESTIONS - with action links =====
  const suggestions = [];
  if (overdueInvoices > 0) suggestions.push({ icon: 'exclamation-triangle', color: 'danger', text: `Follow up on ${overdueInvoices} overdue invoice(s) totaling Rs. ${(overdueAmount).toLocaleString()}`, link: '/invoices?status=overdue' });
  if (negativeStock.length > 0) suggestions.push({ icon: 'dash-circle', color: 'danger', text: `${negativeStock.length} product(s) have negative stock — investigate immediately`, link: '/stock' });
  if (lowStock.length >= 3) suggestions.push({ icon: 'box', color: 'warning', text: `${lowStock.length} products below minimum stock — reorder soon`, link: '/reports/low-stock' });
  if (oldPendingOrders.length > 0) suggestions.push({ icon: 'clock', color: 'warning', text: `${oldPendingOrders.length} pending order(s) older than 7 days`, link: '/orders?status=pending' });
  if (reorderPredictions.length > 0) suggestions.push({ icon: 'arrow-repeat', color: 'info', text: `${reorderPredictions.length} customer(s) likely due to reorder — call them`, link: '/customers' });
  if (lowMarginInvoices.length > 0) suggestions.push({ icon: 'graph-down', color: 'warning', text: `${lowMarginInvoices.length} invoice(s) had >20% commission/discount`, link: '/invoices' });
  if (rangeMargin < 10 && rangeRev > 0) suggestions.push({ icon: 'cash-stack', color: 'warning', text: `Profit margin is low (${rangeMargin}%) — review costs and rates`, link: '/reports' });
  if (cashPosition < 0) suggestions.push({ icon: 'bank', color: 'danger', text: `Negative cash position — payables exceed cash + receivables`, link: '/reports' });

  const stockOutRisk = stockVelocity.filter(s => s.days_left !== null && s.days_left <= 14);

  const profitLeakage = safe(() => db.prepare(`
    SELECT p.id, p.name,
      COALESCE(SUM(ii.quantity * ii.rate),0) revenue,
      COALESCE(SUM(ii.quantity * COALESCE(p.cost_price, p.purchase_rate, 0)),0) cost,
      COALESCE(SUM(ii.quantity * (ii.rate - COALESCE(p.cost_price, p.purchase_rate, 0))),0) profit
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date >= ?
    GROUP BY p.id
    HAVING revenue > 0 AND profit < (revenue * 0.05)
    ORDER BY revenue DESC LIMIT 5
  `).all(last30), []);

  res.render('dashboard', {
    page: 'dashboard',
    isSuperadmin, can, widgets,
    period, accountFilter,
    rangeStart, rangeEnd, rangeLabel,
    rangeRev, rangeExp, rangePurchases, rangeCommission, rangeDelivery, rangeCOGS, rangeProfit, rangeMargin,
    todayRev, monthRev, yearRev, todayExp, monthExp, yearExp,
    todayProfit, monthProfit, yearProfit,
    totalReceivables, totalPayables, bankBalance, cashPosition,
    aging30, aging60, aging90,
    totalCustomers, pendingOrders, unpaidInvoices, unpaidAmount,
    overdueInvoices, overdueAmount, totalOrders, totalInvoices, conversionRate,
    stockValue, lowStock, negativeStock, outOfStockCount,
    topCustomersMonth, topCustomersQuarter, topCustomersYear, topCustomersAllTime,
    topProductsByProfit,
    accountList,
    recentOrders, recentPayments, chartData,
    rateChanges, stockVelocity,
    forecast7d, forecast30d, dailyAvg,
    reorderPredictions, creditRiskScored, lowMarginInvoices, oldPendingOrders, userEdits,
    suggestions, stockOutRisk, profitLeakage,
    monthPurchases: rangePurchases,
    dashboardErrors
  });
});

module.exports = router;
module.exports.DASH_WIDGETS = DASH_WIDGETS;
