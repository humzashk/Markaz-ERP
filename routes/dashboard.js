'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { wrap } = require('../middleware/errorHandler');

const DASH_WIDGETS = ['dash.financials','dash.charts','dash.recent','dash.stock'];

// Date helpers
function dayBounds(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}
function weekBounds(offsetWeeks) {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun
  const mon = new Date(now); mon.setDate(now.getDate() - ((dow + 6) % 7) + offsetWeeks * 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [mon.toISOString().split('T')[0], sun.toISOString().split('T')[0]];
}
function monthBounds(offsetMonths) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + offsetMonths;
  const start = new Date(y, m, 1).toISOString().split('T')[0];
  const end   = new Date(y, m + 1, 0).toISOString().split('T')[0];
  return [start, end];
}

router.get('/', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const today      = dayBounds(0);
  const yesterday  = dayBounds(-1);
  const monthStart = today.substring(0,7) + '-01';
  const last30     = new Date(Date.now() - 30*864e5).toISOString().split('T')[0];
  const [thisWeekS, thisWeekE]   = weekBounds(0);
  const [lastWeekS, lastWeekE]   = weekBounds(-1);
  const [thisMonthS, thisMonthE] = monthBounds(0);
  const [lastMonthS, lastMonthE] = monthBounds(-1);

  // ── Core metrics (existing) ──────────────────────────────────────────────
  const [
    todayRevR, monthRevR, todayExpR, monthExpR,
    recvR, payR, lowCntR, ordTodayR
  ] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date=$1`,      [today]),
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date>=$1`,     [monthStart]),
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date=$1`,     [today]),
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date>=$1`,    [monthStart]),
    pool.query(`SELECT COALESCE(SUM(balance),0) v FROM customers WHERE balance>0`),
    pool.query(`SELECT COALESCE(SUM(ABS(balance)),0) v FROM vendors WHERE balance<0`),
    pool.query(`SELECT COUNT(*)::int c FROM products WHERE stock<=COALESCE(min_stock,0) AND status='active'`),
    pool.query(`SELECT COUNT(*)::int c FROM orders WHERE order_date=$1`,                   [today])
  ]);

  const todayRevV      = Number(todayRevR.rows[0].v)  || 0;
  const monthRevV      = Number(monthRevR.rows[0].v)  || 0;
  const todayProfit    = todayRevV - (Number(todayExpR.rows[0].v) || 0);
  const monthProfit    = monthRevV - (Number(monthExpR.rows[0].v) || 0);
  const totalReceivables = Number(recvR.rows[0].v)    || 0;
  const totalPayables    = Number(payR.rows[0].v)     || 0;
  const netReceivable    = totalReceivables - totalPayables;
  const lowStockCount    = lowCntR.rows[0].c;

  // ── Health score (reuse above data) ──────────────────────────────────────
  let healthScore = 0; // 0=red, 1=yellow, 2=green
  // Cash: today revenue covers today expenses
  if (todayRevV > 0 && todayRevV >= (Number(todayExpR.rows[0].v)||0)) healthScore++;
  // Overdue: net receivable positive (owe us more than we owe)
  if (netReceivable >= 0) healthScore++;
  // Stock: low stock count manageable
  if (lowStockCount <= 3) healthScore++;
  // healthScore: 3=green, 2=green, 1=yellow, 0=red
  const health = healthScore >= 2 ? 'green' : healthScore === 1 ? 'yellow' : 'red';
  const healthLabel = health === 'green' ? 'Healthy' : health === 'yellow' ? 'Moderate Risk' : 'Needs Attention';

  // ── Comparison data (day/week/month) ─────────────────────────────────────
  const [
    todSalesR, yestSalesR,
    twSalesR,  lwSalesR,
    tmSalesR,  lmSalesR,
    todCashR,  yestCashR,
    twCashR,   lwCashR,
    tmCashR,   lmCashR,
    todOrdR,   yestOrdR,
    twOrdR,    lwOrdR,
    tmOrdR,    lmOrdR
  ] = await Promise.all([
    // Sales (invoice totals)
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date=$1`,                        [today]),
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date=$1`,                        [yesterday]),
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date BETWEEN $1 AND $2`,         [thisWeekS, thisWeekE]),
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date BETWEEN $1 AND $2`,         [lastWeekS, lastWeekE]),
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date BETWEEN $1 AND $2`,         [thisMonthS, thisMonthE]),
    pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date BETWEEN $1 AND $2`,         [lastMonthS, lastMonthE]),
    // Cash received (customer payments)
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE entity_type='customer' AND payment_date=$1`,                    [today]),
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE entity_type='customer' AND payment_date=$1`,                    [yesterday]),
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE entity_type='customer' AND payment_date BETWEEN $1 AND $2`,     [thisWeekS, thisWeekE]),
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE entity_type='customer' AND payment_date BETWEEN $1 AND $2`,     [lastWeekS, lastWeekE]),
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE entity_type='customer' AND payment_date BETWEEN $1 AND $2`,     [thisMonthS, thisMonthE]),
    pool.query(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE entity_type='customer' AND payment_date BETWEEN $1 AND $2`,     [lastMonthS, lastMonthE]),
    // Orders count
    pool.query(`SELECT COUNT(*)::int v FROM orders WHERE order_date=$1`,                                     [today]),
    pool.query(`SELECT COUNT(*)::int v FROM orders WHERE order_date=$1`,                                     [yesterday]),
    pool.query(`SELECT COUNT(*)::int v FROM orders WHERE order_date BETWEEN $1 AND $2`,                      [thisWeekS, thisWeekE]),
    pool.query(`SELECT COUNT(*)::int v FROM orders WHERE order_date BETWEEN $1 AND $2`,                      [lastWeekS, lastWeekE]),
    pool.query(`SELECT COUNT(*)::int v FROM orders WHERE order_date BETWEEN $1 AND $2`,                      [thisMonthS, thisMonthE]),
    pool.query(`SELECT COUNT(*)::int v FROM orders WHERE order_date BETWEEN $1 AND $2`,                      [lastMonthS, lastMonthE])
  ]);

  const cmp = {
    day:   { sales: [Number(todSalesR.rows[0].v)||0, Number(yestSalesR.rows[0].v)||0], cash: [Number(todCashR.rows[0].v)||0,  Number(yestCashR.rows[0].v)||0],  orders: [todOrdR.rows[0].v||0,  yestOrdR.rows[0].v||0]  },
    week:  { sales: [Number(twSalesR.rows[0].v)||0,  Number(lwSalesR.rows[0].v)||0],  cash: [Number(twCashR.rows[0].v)||0,   Number(lwCashR.rows[0].v)||0],   orders: [twOrdR.rows[0].v||0,   lwOrdR.rows[0].v||0]   },
    month: { sales: [Number(tmSalesR.rows[0].v)||0,  Number(lmSalesR.rows[0].v)||0],  cash: [Number(tmCashR.rows[0].v)||0,   Number(lmCashR.rows[0].v)||0],   orders: [tmOrdR.rows[0].v||0,   lmOrdR.rows[0].v||0]   }
  };

  // ── Fast movers (qty sold, 3 periods) ────────────────────────────────────
  const fmQ = (s, e) => pool.query(`
    SELECT p.name, SUM(ii.quantity)::int qty
    FROM invoice_items ii
    JOIN products p ON p.id=ii.product_id
    JOIN invoices i ON i.id=ii.invoice_id
    WHERE i.invoice_date BETWEEN $1 AND $2
    GROUP BY p.id, p.name ORDER BY qty DESC LIMIT 5
  `, [s, e]);

  const [fmDay, fmWeek, fmMonth] = await Promise.all([
    fmQ(today, today),
    fmQ(thisWeekS, thisWeekE),
    fmQ(thisMonthS, thisMonthE)
  ]);

  const fastMovers = {
    day:   fmDay.rows,
    week:  fmWeek.rows,
    month: fmMonth.rows
  };

  // ── Top products chart (last 30 days) ────────────────────────────────────
  const topProductsR = await pool.query(`
    SELECT p.name, COALESCE(SUM(ii.amount),0) revenue
    FROM invoice_items ii JOIN products p ON p.id=ii.product_id
    JOIN invoices i ON i.id=ii.invoice_id
    WHERE i.invoice_date>=$1
    GROUP BY p.id ORDER BY revenue DESC LIMIT 5
  `, [last30]);

  // ── Recent tables ────────────────────────────────────────────────────────
  const [recentOrdersR, recentPaymentsR, lowStockR] = await Promise.all([
    pool.query(`SELECT o.id,o.order_no,o.order_date,o.total,o.status,c.name customer_name FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC LIMIT 8`),
    pool.query(`SELECT p.id,p.amount,p.payment_date,p.payment_method,p.entity_type, CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END entity_name FROM payments p LEFT JOIN customers c ON p.entity_type='customer' AND c.id=p.entity_id LEFT JOIN vendors v ON p.entity_type='vendor' AND v.id=p.entity_id ORDER BY p.id DESC LIMIT 6`),
    pool.query(`SELECT id,name,stock,min_stock FROM products WHERE stock<=COALESCE(min_stock,0) AND status='active' ORDER BY stock ASC LIMIT 8`)
  ]);

  res.render('dashboard', {
    page: 'dashboard',
    isSuperadmin: req.user.role === 'superadmin',
    todayRev: todayRevV, monthRev: monthRevV, todayProfit, monthProfit,
    totalReceivables, totalPayables, netReceivable,
    lowStockCount, ordersToday: ordTodayR.rows[0].c,
    health, healthLabel, healthScore,
    cmp, fastMovers,
    topProducts:    topProductsR.rows.map(r => ({ name: r.name, revenue: Number(r.revenue)||0 })),
    recentOrders:   recentOrdersR.rows,
    recentPayments: recentPaymentsR.rows,
    lowStock:       lowStockR.rows
  });
}));

module.exports = router;
module.exports.DASH_WIDGETS = DASH_WIDGETS;
