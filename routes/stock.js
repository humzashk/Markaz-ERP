const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middleware/validate');
const { db, addAuditLog, applyStockMovement, reverseStockForRef, toInt, logError } = require('../database');

// Adjustment types whose effect on stock is positive (+) vs negative (-)
const _addTypes = new Set(['add','return','transfer_in']);
function _signedDelta(type, qty) {
  return _addTypes.has(type) ? Math.abs(qty) : -Math.abs(qty);
}

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

router.post('/add', validate(schemas.stockAdjust), (req, res) => {
  try {
    const { product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes } = req.body;
    const qty = toInt(quantity);
    const pid = toInt(product_id);
    const wid = warehouse_id ? toInt(warehouse_id) : null;
    if (!pid || !qty || !adjustment_type || !adj_date) {
      return res.redirect('/stock/add?error=missing_fields');
    }
    let adjId = null;
    db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO stock_adjustments (product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(pid, wid, adjustment_type, Math.abs(qty), reason || '', reference || '', adj_date, notes || '');
      adjId = result.lastInsertRowid;
      const delta = _signedDelta(adjustment_type, qty);
      applyStockMovement(pid, wid, delta, 'stock_adjustment', adjId, adjustment_type, reason || notes || null);
      addAuditLog('create', 'stock_adjustments', adjId, `Stock ${adjustment_type}: ${qty} pcs for product ${pid}`);
    })();
    res.redirect('/stock');
  } catch (e) {
    logError('stock.adjustment.create', e, { body: req.body });
    res.redirect('/stock?err=server');
  }
});

// Edit stock adjustment
router.get('/edit/:id', (req, res) => {
  const adj = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(req.params.id);
  if (!adj) return res.redirect('/stock');
  const products = db.prepare('SELECT id, name, stock FROM products WHERE status = ? ORDER BY name').all('active');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  res.render('stock/edit', { page: 'stock', adj, products, warehouses });
});

router.post('/edit/:id', validate(schemas.stockAdjust), (req, res) => {
  try {
    const adjId = toInt(req.params.id);
    const old = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(adjId);
    if (!old) return res.redirect('/stock?err=notfound');
    const { product_id, warehouse_id, adjustment_type, quantity, reason, reference, adj_date, notes } = req.body;
    const qty = toInt(quantity);
    const pid = toInt(product_id);
    const wid = warehouse_id ? toInt(warehouse_id) : null;
    if (!pid || !qty || !adjustment_type || !adj_date) {
      return res.redirect('/stock/edit/' + adjId + '?error=missing_fields');
    }
    db.transaction(() => {
      // Reverse the previous movement(s) for this adjustment
      reverseStockForRef('stock_adjustment', adjId);
      // Update the adjustment row
      db.prepare(
        `UPDATE stock_adjustments SET product_id=?, warehouse_id=?, adjustment_type=?, quantity=?, reason=?, reference=?, adj_date=?, notes=? WHERE id=?`
      ).run(pid, wid, adjustment_type, Math.abs(qty), reason || '', reference || '', adj_date, notes || '', adjId);
      // Re-apply the (new) movement
      const delta = _signedDelta(adjustment_type, qty);
      applyStockMovement(pid, wid, delta, 'stock_adjustment', adjId, adjustment_type + '-edit', reason || notes || null);
      addAuditLog('update', 'stock_adjustments', adjId, 'Updated stock adjustment');
    })();
    res.redirect('/stock');
  } catch (e) {
    logError('stock.adjustment.edit', e, { id: req.params.id, body: req.body });
    res.redirect('/stock?err=server');
  }
});

router.post('/delete/:id', (req, res) => {
  try {
    const adjId = toInt(req.params.id);
    const old = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(adjId);
    if (!old) return res.redirect('/stock?err=notfound');
    db.transaction(() => {
      reverseStockForRef('stock_adjustment', adjId);
      db.prepare('DELETE FROM stock_adjustments WHERE id = ?').run(adjId);
      addAuditLog('delete', 'stock_adjustments', adjId, 'Deleted stock adjustment');
    })();
    res.redirect('/stock');
  } catch (e) {
    logError('stock.adjustment.delete', e, { id: req.params.id });
    res.redirect('/stock?err=server');
  }
});

router.get('/print/:id', (req, res) => {
  const adj = db.prepare(`
    SELECT sa.*, p.name as product_name, w.name as warehouse_name
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    WHERE sa.id = ?
  `).get(req.params.id);
  if (!adj) return res.redirect('/stock');
  res.render('stock/print', { adj, layout: false });
});

// Stock Movements - Combined view of all stock movements
router.get('/movements', (req, res) => {
  const search = req.query.search || '';
  const type = req.query.type || '';

  let movements = [];

  // Fetch order movements (outbound to customers)
  if (!type || type === 'outbound') {
    const orderSql = `
      SELECT
        oi.product_id,
        p.name as product_name,
        c.name as party_name,
        'Customer' as party_type,
        oi.quantity,
        o.order_date as movement_date,
        o.id as order_id,
        o.order_no as reference_number,
        'Order' as doc_type
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = oi.product_id
      ${search ? 'WHERE p.name LIKE ?' : ''}
    `;
    const orderMovements = search
      ? db.prepare(orderSql).all(`%${search}%`)
      : db.prepare(orderSql).all();
    movements = [...movements, ...orderMovements];
  }

  // Fetch purchase movements (inbound from vendors)
  if (!type || type === 'inbound') {
    const purchaseSql = `
      SELECT
        pi.product_id,
        p.name as product_name,
        v.name as party_name,
        'Vendor' as party_type,
        pi.quantity,
        pur.purchase_date as movement_date,
        pur.id as purchase_id,
        pur.purchase_no as reference_number,
        'Purchase' as doc_type
      FROM purchase_items pi
      JOIN purchases pur ON pur.id = pi.purchase_id
      JOIN vendors v ON v.id = pur.vendor_id
      JOIN products p ON p.id = pi.product_id
      ${search ? 'WHERE p.name LIKE ?' : ''}
    `;
    const purchaseMovements = search
      ? db.prepare(purchaseSql).all(`%${search}%`)
      : db.prepare(purchaseSql).all();
    movements = [...movements, ...purchaseMovements];
  }

  movements.sort((a, b) => new Date(b.movement_date) - new Date(a.movement_date));

  res.render('stock/movements', { page: 'stock', movements, search, type });
});

router.get('/ledger', (req, res) => {
  const productId = req.query.product_id || '';
  const products = db.prepare('SELECT id, name FROM products WHERE status=? ORDER BY name').all('active');
  let movements = [];
  let product = null;
  if (productId) {
    product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (product) {
      const adjs = db.prepare('SELECT id, adjustment_type, quantity, reason, reference, COALESCE(adj_date, created_at) as txn_date FROM stock_adjustments WHERE product_id = ? ORDER BY COALESCE(adj_date, created_at) ASC').all(productId);
      let runningBal = product.stock;
      movements = adjs.map(a => ({
        type: a.adjustment_type === 'add' ? '+' : '-',
        source_type: 'adjustment',
        source_id: a.id,
        quantity: a.quantity,
        reason: a.reason,
        reference: a.reference,
        txn_date: a.txn_date,
        balance: (runningBal += (a.adjustment_type === 'add' ? a.quantity : -a.quantity))
      }));
    }
  }
  res.render('stock/ledger', { page: 'stock-ledger', products, productId, product, movements });
});

router.get('/position', (req, res) => {
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE status = ? ORDER BY name').all('active');
  const warehouseId = req.query.warehouse_id || '';
  let position = [];

  // pcs_per_carton = qty_per_pack || packaging || 1
  if (warehouseId) {
    position = db.prepare(`
      SELECT
        p.id,
        p.name,
        COALESCE(p.unit,'PCS') as unit,
        COALESCE(NULLIF(p.qty_per_pack,0), NULLIF(p.packaging,0), 1) as pcs_per_carton,
        ws.quantity as wh_qty,
        p.stock as total_qty
      FROM warehouse_stock ws
      JOIN products p ON p.id = ws.product_id
      WHERE ws.warehouse_id = ? AND p.status = ?
      ORDER BY p.name
    `).all(warehouseId, 'active');
  } else {
    position = db.prepare(`
      SELECT
        p.id,
        p.name,
        COALESCE(p.unit,'PCS') as unit,
        COALESCE(NULLIF(p.qty_per_pack,0), NULLIF(p.packaging,0), 1) as pcs_per_carton,
        p.stock,
        (SELECT COUNT(DISTINCT warehouse_id) FROM warehouse_stock WHERE product_id = p.id) as warehouse_count
      FROM products p
      WHERE p.status = ?
      ORDER BY p.name
    `).all('active');
  }

  // Compute cartons & loose pcs per row + grand totals
  let totalPcs = 0, totalCartons = 0, totalLoose = 0;
  position.forEach(r => {
    const pcs = Number(r.wh_qty != null ? r.wh_qty : r.stock) || 0;
    const ppc = Number(r.pcs_per_carton) || 1;
    r.pcs = pcs;
    r.cartons = ppc > 1 ? Math.floor(pcs / ppc) : 0;
    r.loose = ppc > 1 ? pcs % ppc : pcs;
    totalPcs += pcs;
    totalCartons += r.cartons;
    totalLoose += r.loose;
  });

  res.render('stock/position', { page: 'stock-position', warehouses, warehouseId, position, totalPcs, totalCartons, totalLoose });
});

module.exports = router;
