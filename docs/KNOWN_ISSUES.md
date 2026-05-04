# KNOWN_ISSUES.md — Markaz ERP

## Critical

- **Bulk delete bypasses age lock** — `/orders/bulk`, `/purchases/bulk`, `/creditnotes/bulk` have no `requireEditPermission` guard; records > 2 years can be bulk-deleted by any user
- **Ledger is not append-only** — `removeLedgerForRef()` hard-DELETEs rows on invoice/purchase delete or edit; financial history is permanently destroyed on allowed deletes
- **Credit note rate is user-supplied** — only `commission_pct` is fetched server-side; `rate` comes from the POST body and can be manipulated

## High Risk

- **Purchase edit corrupts `products.cost_price`** — editing any historical purchase overwrites the product's current cost price with the historical rate
- **No UNIQUE constraint on ledger `(entity_id, reference_type, reference_id)`** — concurrent POST requests can create duplicate ledger entries for the same document
- **Payment double-submit guard is in-memory only** — server restart between user double-click allows two payments to be saved to DB
- **`discount` and `delivery_charges` in purchases bypass schema validation** — read directly from `req.body` after validate(); unvalidated values affect stored totals and ledger

## Silent Drift

- **`products.stock` may diverge from `stock_ledger` SUM** — denormalized counter; no periodic reconciliation job exists
- **`stock_adjustments.quantity` is Ctns; `stock_ledger.qty_delta` is PCS** — direct JOIN comparisons produce wrong numbers without conversion
- **`/orders/bulk mark_invoiced`** — sets `status='invoiced'` with no actual invoice created; order becomes locked and appears invoiced but has no `invoices` row
- **Pending credit notes** — visible in UI, not reflected in customer/vendor balance until manually Applied
