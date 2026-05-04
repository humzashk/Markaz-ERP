# SYSTEM_OVERVIEW.md — Markaz ERP

## Modules
- **Orders** — draft sale agreements; no stock/ledger impact until invoiced
- **Invoices** — commits stock OUT + customer DR ledger entry
- **Purchases** — commits stock IN + vendor CR ledger entry
- **Payments** — customer CR (received) or vendor DR (paid) ledger entries
- **Credit/Debit Notes** — pending until Applied; only then hits ledger
- **Ledger** — party-level DR/CR register; running balance computed in JS
- **Stock** — append-only `stock_ledger`; `products.stock` is denormalized mirror
- **Breakage** — reduces global stock via `applyStockMovement`; no ledger impact
- **Journal** — manual general ledger entries (separate from party ledger)
- **Reports / Daybook** — read-only views; no data mutations

## Core Rules
- All stock changes MUST go through `applyStockMovement()` — never direct UPDATE
- All party balance changes MUST go through `addLedgerEntry()` — never direct UPDATE
- Every create/edit/delete runs inside `tx()` — atomic or fully rolled back
- `recomputeBalance()` recomputes from full ledger SUM after every change — no incremental math
- Orders do NOT touch stock or ledger; invoices do
- Credit/debit note stock is NOT reversed — returned goods do not re-enter inventory
- Data retention: all records permanent; edit lock enforced at 2 years via `enforceAgeRestriction()`
