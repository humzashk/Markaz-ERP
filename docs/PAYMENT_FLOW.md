# PAYMENT_FLOW.md — Markaz ERP

## Payment → Ledger → Balance

### Customer Payment (Receive)
1. POST `/payments/receive` → `_adapt('customer')` maps `customer_id` → `entity_type/entity_id`
2. `validate(schemas.paymentCreate)` runs
3. Inside `tx()`: INSERT into `payments` table → get `pid`
4. `addLedgerEntry(db, 'customer', entity_id, date, desc, 0, amount, 'payment', pid)` → CR customer
5. `recomputeBalance()` called inside `addLedgerEntry` → updates `customers.balance`
6. Redirect to `/payments/view/:pid`

### Vendor Payment (Pay)
1. POST `/payments/pay` → `_adapt('vendor')` maps `vendor_id` → `entity_type/entity_id`
2. Same flow as customer; `addLedgerEntry` with `debit=amount, credit=0` → DR vendor

### Payment Delete
1. POST `/payments/delete/:id` → `_lockPayment` (2-year age check)
2. Inside `tx()`: `removeLedgerForRef()` → hard-DELETE ledger rows for this payment
3. `recomputeBalance()` → recomputes balance from remaining ledger rows
4. `DELETE FROM payments WHERE id=$1`
5. Redirect to entity ledger page

## Key Rules
- Payment creates exactly ONE ledger entry (no invoice linkage in ledger — payment is stand-alone)
- No matching against specific invoices — customer balance is aggregate; partial payments reduce overall balance
- `invoices.paid` column tracks paid amount separately (updated via invoice status flow, NOT by payment route)
- Double-submit protection: in-memory dedup (8s window) — NOT database-level
- `account_scope` propagated from form → stored in both `payments` and `ledger` rows
