const express = require('express');
const router = express.Router();
const { db, addAuditLog } = require('../database');

router.get('/', (req, res) => {
  const search = req.query.search || '';
  const type = req.query.type || '';
  let sql = `
    SELECT sa.*, p.name as product_name, w.name as warehouse_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    WHERE 1=1
  `;
  const params = [];
  if (search) { sql += ` AND p.name LIKE ?`; params.push(`%${search}%`); }
  if (type) { sql += ` AND sa.adjustment_type = ?`; params.push(type); }
  sql += ` ORDER BY sa.id DESC`;
  const adjustments = db.prepare(sql).all(...params);
  res.render('stock/index', { page: 'stock', adjustments, search, type });
});

router.get('/add', (req, res) => {
  const products = db.prepare('SELECT id, name, stock FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const adjType = req.query.type || 'add';
  res.render('stock/form', { page: 'stock', products, warehouses, adjType });
});

router.post('/add', (req, res) => {
  const { product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes } = req.body;
  const qty = parseInt(quantity) || 0;

  db.transaction(() => {
    // Update main product stock
    if (adjustment_type === 'add' || adjustment_type === 'return' || adjustment_type === 'transfer_in') {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, product_id);
    } else if (adjustment_type === 'reduce' || adjustment_type === 'damage' || adjustment_type === 'transfer_out') {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, product_id);
    }

    // Update warehouse stock if warehouse selected
    if (warehouse_id) {
      const existing = db.prepare('SELECT id FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?').get(warehouse_id, product_id);
      if (existing) {
        if (adjustment_type === 'add' || adjustment_type === 'return' || adjustment_type === 'transfer_in') {
          db.prepare('UPDATE warehouse_stock SET quantity = quantity + ? WHERE warehouse_id = ? AND product_id = ?').run(qty, warehouse_id, product_id);
        } else {
          db.prepare('UPDATE warehouse_stock SET quantity = quantity - ? WHERE warehouse_id = ? AND product_id = ?').run(qty, warehouse_id, product_id);
        }
      } else {
        const whQty = (adjustment_type === 'add' || adjustment_type === 'return') ? qty : -qty;
        db.prepare('INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)').run(warehouse_id, product_id, Math.max(0, whQty));
      }
    }

    db.prepare(
      `INSERT INTO stock_adjustments (product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(product_id, warehouse_id || null, adjustment_type, qty, reason, reference, adj_date, notes);
  })();

  addAuditLog('create', 'stock_adjustments', null, `Stock ${adjustment_type}: ${qty} pcs for product ${product_id}`);
  res.redirect('/stock');
});

module.exports = router;
