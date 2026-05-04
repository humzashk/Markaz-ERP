# LEDGER_LOGIC.md — Markaz ERP

## DR/CR Rules

| Event | Entity | Debit | Credit |
|---|---|---|---|
| Invoice created/edited | Customer | `total` | 0 |
| Payment received | Customer | 0 | `amount` |
| Credit note applied | Customer | 0 | `note.amount` |
| Purchase created/edited | Vendor | 0 | `total` |
| Payment made | Vendor | `amount` | 0 |
| Debit note applied | Vendor | `note.amount` | 0 |

- **Positive balance** = Receivable (customer owes) or Payable (we owe vendor)
- **Negative balance** = Advance (customer overpaid or vendor credit)
- Formula: `balance = SUM(debit) - SUM(credit)` across all ledger rows for entity

## Balance Logic
- `recomputeBalance()` recalculates from full SUM every time — no running total stored
- Row-level `SELECT ... FOR UPDATE` on customer/vendor prevents concurrent overwrites
- `removeLedgerForRef()` hard-DELETEs rows (not soft-delete) — used on document delete/edit
- `addLedgerEntry()` always calls `recomputeBalance()` after insert

## Date Filter Behavior
- Default view: last 30 days (`from = today-30d`, `to = today`)
- `openingBalance` = `SUM(debit - credit)` for all entries BEFORE `from` date
- Running balance displayed = `openingBalance + cumulative (debit - credit)` per row
- Ordering: `txn_date ASC, id ASC` — deterministic only if no two rows share date+id
- Closing balance = last running_balance value after all period entries applied
- `from=''` (all-time): `openingBalance = 0`; running starts from zero
