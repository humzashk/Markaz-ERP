# STOCK_SYSTEM.md — Markaz ERP

## stock_ledger Role
- Append-only log of every PCS-level stock movement
- Columns: `product_id, warehouse_id, qty_delta (PCS), ref_type, ref_id, reason, user_id, note`
- `qty_delta` is negative for outbound (invoice, breakage), positive for inbound (purchase, return)
- Reversals written as new rows with `reason='reverse'` — original rows never modified

## applyStockMovement() Rule
- **All** stock changes MUST use this function — never direct `UPDATE products SET stock`
- Writes to `stock_ledger`, updates `products.stock` counter, updates `warehouse_stock` if `warehouse_id` provided
- `products.stock` = global total PCS; `warehouse_stock.quantity` = per-warehouse PCS
- Dual representation — `products.stock` must equal `SUM(stock_ledger.qty_delta)` for each product

## Stock Derivation
- `products.stock` = denormalized running total (may drift from ledger under direct DB manipulation)
- Authoritative source: `SUM(stock_ledger.qty_delta) WHERE product_id=$1`
- `stock_adjustments.quantity` is stored in **Ctns** (user-facing); `stock_ledger.qty_delta` is in **PCS**
- Conversion: `PCS = Ctns × qty_per_pack` — applied in route before calling `applyStockMovement()`
- Warehouse position: read from `warehouse_stock` table (maintained by `applyStockMovement`)
- Global position: read from `products.stock` OR computed via SUM of `stock_ledger`
- `reverseStockForRef()` idempotency: checks for existing `reason='reverse'` row before applying — skips entire ref if any reversal exists
- Credit/debit notes do NOT reverse stock — returned goods are written off, not restocked
