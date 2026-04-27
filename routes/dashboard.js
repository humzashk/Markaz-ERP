'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { wrap } = require('../middleware/errorHandler');

const DASH_WIDGETS = ['dash.financials','dash.charts','dash.recent','dash.stock'];

router.get('/', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.substring(0,7) + '-01';
  const last30 = new Date(Date.now() - 30*864e5).toISOString().split('T')[0];

  const todayRevQ = pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date = $1`, [today]);
  const monthRevQ = pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date >= $1`, [monthStart]);
  const todayExpQ = pool.query(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date = $1`, [today]);
  const monthExpQ = pool.query(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date >= $1`, [monthStart]);
  const recvQ     = pool.query(`SELECT COALESCE(SUM(balance),0) v FROM customers WHERE balance > 0`);
  const payQ      = pool.query(`SELECT COALESCE(SUM(ABS(balance)),0) v FROM vendors WHERE balance < 0`);
  const lowCntQ   = pool.query(`SELECT COUNT(*)::int c FROM products WHERE stock <= COALESCE(min_stock,0) AND status='active'`);
  const ordTodayQ = pool.query(`SELECT COUNT(*)::int c FROM orders WHERE order_date = $1`, [today]);

  const [todayRev, monthRev, todayExp, monthExp, recv, pay, lowCnt, ordToday] = await Promise.all([
    todayRevQ, monthRevQ, todayExpQ, monthExpQ, recvQ, payQ, lowCntQ, ordTodayQ
  ]);

  const todayRevV = Number(todayRev.rows[0].v) || 0;
  const monthRevV = Number(monthRev.rows[0].v) || 0;
  const todayProfit = todayRevV - (Number(todayExp.rows[0].v) || 0);
  const monthProfit = monthRevV - (Number(monthExp.rows[0].v) || 0);
  const totalReceivables = Number(recv.rows[0].v) || 0;
  const totalPayables = Number(pay.rows[0].v) || 0;
  const netReceivable = totalReceivables - totalPayables;

  // 6-month chart
  const chartData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    const r1 = await pool.query(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE invoice_date BETWEEN $1 AND $2`, [start, end]);
    const r2 = await pool.query(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_date BETWEEN $1 AND $2`, [start, end]);
    chartData.push({ month: d.toLocaleString('default',{ month:'short' }), revenue: Number(r1.rows[0].v)||0, expenses: Number(r2.rows[0].v)||0 });
  }

  const topProductsR = await pool.query(`
    SELECT p.name, COALESCE(SUM(ii.amount),0) revenue
    FROM invoice_items ii JOIN products p ON p.id = ii.product_id
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_date >= $1
    GROUP BY p.id ORDER BY revenue DESC LIMIT 5
  `, [last30]);

  const recentOrdersR = await pool.query(`
    SELECT o.id, o.order_no, o.order_date, o.total, o.status, c.name as customer_name
    FROM orders o JOIN customers c ON c.id = o.customer_id
    ORDER BY o.id DESC LIMIT 8
  `);
  const recentPaymentsR = await pool.query(`
    SELECT p.id, p.amount, p.payment_date, p.payment_method, p.entity_type,
           CASE WHEN p.entity_type='customer' THEN c.name ELSE v.name END AS entity_name
    FROM payments p
    LEFT JOIN customers c ON p.entity_type='customer' AND c.id = p.entity_id
    LEFT JOIN vendors v   ON p.entity_type='vendor'   AND v.id = p.entity_id
    ORDER BY p.id DESC LIMIT 6
  `);
  const lowStockR = await pool.query(`
    SELECT id, name, stock, min_stock FROM products
    WHERE stock <= COALESCE(min_stock,0) AND status='active'
    ORDER BY stock ASC LIMIT 8
  `);

  res.render('dashboard', {
    page: 'dashboard',
    isSuperadmin: req.user.role === 'superadmin',
    todayRev: todayRevV, monthRev: monthRevV, todayProfit, monthProfit,
    totalReceivables, totalPayables, netReceivable,
    lowStockCount: lowCnt.rows[0].c,
    ordersToday:   ordToday.rows[0].c,
    chartData,
    topProducts:   topProductsR.rows.map(r => ({ name: r.name, revenue: Number(r.revenue)||0 })),
    recentOrders:  recentOrdersR.rows,
    recentPayments:recentPaymentsR.rows,
    lowStock:      lowStockR.rows
  });
}));

module.exports = router;
module.exports.DASH_WIDGETS = DASH_WIDGETS;
