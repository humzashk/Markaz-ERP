# System Architecture & Design

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Web Browser (Bootstrap 5)                    │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP/HTTPS
┌────────────────────────▼────────────────────────────────────────┐
│                    Express.js Server                             │
├──────────────────────────────────────────────────────────────────┤
│  ✓ Authentication & Authorization (session-based)                │
│  ✓ Request Validation (schema-based middleware)                  │
│  ✓ Error Handling & Logging                                      │
│  ✓ CSRF Protection & Idempotency                                 │
│  ✓ Template Rendering (EJS)                                      │
└────────────────────────┬────────────────────────────────────────┘
                         │ SQL Queries (pg driver)
┌────────────────────────▼────────────────────────────────────────┐
│              PostgreSQL Database (markaz_erp)                    │
├──────────────────────────────────────────────────────────────────┤
│  ✓ Role-based access (users table)                               │
│  ✓ Double-entry accounting (transaction_ledger)                  │
│  ✓ Inventory management (warehouse_stock, stock_adjustments)     │
│  ✓ Master data (customers, vendors, products)                    │
│  ✓ Audit trail (audit_logs)                                      │
│  ✓ Multi-business support (account_scope enum)                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Request/Response Flow

### Typical POST Flow (Invoice Creation)

```
1. Browser Form Submission
   └─> POST /invoices/add
       ├─ Session middleware: req.user = loaded from session
       ├─ Validation middleware: validate(schemas.invoiceCreate)
       │   ├─ Parse form data (customer_id, date, items[])
       │   ├─ Check required fields
       │   ├─ Validate item-list (skipIf for blank rows)
       │   └─ res.valid = { customer_id, invoice_date, items: [...] }
       │
       ├─ Route handler: async (req, res) => {
       │   ├─ Generate invoice number: await nextDocNo(pool, 'INV', ...)
       │   ├─ Transaction: await tx(async (db) => {
       │   │   ├─ INSERT invoices → get invoice.id
       │   │   ├─ INSERT invoice_lines (items)
       │   │   ├─ LOOP: applyStockMovement (deduct warehouse_stock)
       │   │   ├─ INSERT transaction_ledger (customer balance updated)
       │   │   └─ INSERT audit_logs
       │   │ })
       │   └─ redirect('/invoices')
       │
       └─ Browser: Redirect → GET /invoices
           ├─ Re-render invoice list with flash message
           └─ New invoice visible in table
```

### Ledger Balance Lookup Flow

```
GET /ledger/customer/123
  ├─ Get customer: SELECT name, address, ... FROM customers WHERE id=123
  ├─ Calculate running balance:
  │   SELECT *, 
  │     SUM(debit - credit) OVER (ORDER BY id) AS balance
  │   FROM transaction_ledger
  │   WHERE entity_type='customer' AND entity_id=123
  │     AND entry_date BETWEEN $from AND $to
  │   ORDER BY id DESC
  │
  └─ Render ledger/detail.ejs with:
      ├─ entity (customer name, final balance)
      ├─ entries[] (transactions with running balance)
      └─ Sticky panel on right (transaction detail on click)
```

---

## Module Organization

### Route Modules (routes/*.js)

**Public Routes:**
- `routes/auth.js` - Login, logout, session management

**Protected Routes** (require authentication):

#### Core Master Data
- `routes/customers.js` - Customer CRUD, commission management
- `routes/vendors.js` - Vendor/supplier master
- `routes/products.js` - Product catalog, categories, bulk edit
- `routes/warehouses.js` - Warehouse locations

#### Transactions (Double-Entry)
- `routes/invoices.js` - Customer sales invoices
- `routes/purchases.js` - Vendor purchase orders
- `routes/payments.js` - Payment received/made
- `routes/expenses.js` - Expense tracking
- `routes/journal.js` - Manual journal entries
- `routes/breakage.js` - Stock loss/damage records

#### Inventory
- `routes/stock.js` - Stock adjustments, transfers
- `routes/stockinit.js` - Bulk opening stock entry
- `routes/ratelist.js` - Price list management

#### Logistics
- `routes/bilty.js` - Shipping documents
- `routes/transports.js` - Transport providers

#### Reporting & Admin
- `routes/ledger.js` - Customer/vendor statement
- `routes/daybook.js` - Daily transaction summary
- `routes/reports.js` - P&L, balance sheet, aging
- `routes/importexport.js` - CSV/Excel import/export
- `routes/settings.js` - System configuration
- `routes/users.js` - User management
- `routes/dashboard.js` - Dashboard & KPIs

### Middleware (middleware/*.js)

**Authentication & Authorization:**
- `auth.js` - Session loading, role-based guards
  - `loadUser(req, res, next)` - Load user from session
  - `requireRole(...roles)` - Guard routes by role
  - `autoGuard` - Redirect to /login if no user

**Request Validation:**
- `validate.js` - Schema-based validation
  - `validate(schema)` - Parse & validate request
  - `preventDoubleSubmit` - Idempotency tokens

**Error Handling:**
- `errorHandler.js` - Catch errors, log, render error pages
  - `wrap(fn)` - Async error wrapper
  - `globalErrorHandler` - Final error handler

### Utilities (database.js)

**Core Functions:**
- `pool` - PostgreSQL connection pool
- `tx(fn)` - Transaction wrapper (BEGIN/COMMIT/ROLLBACK)
- `addAuditLog(action, table, id, description)` - Log user actions
- `nextDocNo(db, prefix, table, field)` - Generate document numbers
- `applyStockMovement(...)` - Atomic stock updates
- `toInt()`, `toNum()` - Type conversion with defaults

---

## Data Flow: Invoice to Ledger

### Step 1: Invoice Creation Form
```
GET /invoices/add
  ├─ Fetch customers: SELECT id, name, commission FROM customers
  ├─ Fetch warehouses: SELECT id, name FROM warehouses
  ├─ Render form with dropdowns + empty line item rows
  └─ User enters: customer, date, items[], warehouse, etc.
```

### Step 2: Form Submission & Validation
```
POST /invoices/add
  ├─ Validation schema checks:
  │   ├─ customer_id: required, number
  │   ├─ invoice_date: required, valid date
  │   └─ items: skipIf all blank, else:
  │       ├─ product_id: required
  │       ├─ quantity: required, ≥ 1
  │       ├─ rate: required
  │       └─ commission_pct: optional
  │
  └─ req.valid = { customer_id, invoice_date, items: [...] }
```

### Step 3: Database Transaction
```
BEGIN TRANSACTION

1. Generate invoice number
   nextDocNo(pool, 'INV', 'invoices', 'invoice_no')
   → 'INV-0042'

2. INSERT invoices
   INSERT INTO invoices(invoice_no, customer_id, ..., amount_total, amount_net)
   RETURNING id → invoice_id = 15

3. INSERT invoice_lines (for each item)
   INSERT INTO invoice_lines(invoice_id, product_id, quantity, rate, ...)

4. Deduct warehouse stock (for each line item)
   applyStockMovement(
     pool, product_id, warehouse_id, -qty,
     'invoice', invoice_id, 'sales'
   )
   ├─ UPDATE warehouse_stock SET quantity = quantity - qty
   ├─ UPDATE products SET stock = (sum of all warehouses)
   └─ INSERT stock_adjustments

5. Record ledger entry (customer balance update)
   INSERT INTO transaction_ledger(
     entity_type='customer', entity_id=customer_id,
     debit=amount_net, credit=0,
     txn_type='invoice', txn_id=invoice_id,
     description, reference=invoice_no
   )

6. Log audit trail
   INSERT INTO audit_logs(action='create', table='invoices', ...)

COMMIT TRANSACTION
```

### Step 4: Customer Ledger Balance Update
```
Automatic: When transaction_ledger updated, customer balance recalculated on next query

SELECT SUM(debit - credit) FROM transaction_ledger 
WHERE entity_type='customer' AND entity_id=customer_id
```

---

## Stock Management Flow

### Stock Adjustment Process

```
1. User Action (Invoice, Purchase, Manual Adjustment)
   └─ applyStockMovement() called with quantity delta

2. Atomic Updates:
   ├─ LOCK warehouse_stock row (prevent concurrent modification)
   ├─ UPDATE warehouse_stock.quantity (add/subtract qty)
   ├─ RECALCULATE products.stock = SUM(warehouse_stock.quantity)
   │   └─ Trigger: after warehouse_stock update
   └─ INSERT stock_adjustments (audit trail)

3. Ledger Impact:
   ├─ For purchases: warehouse_stock increases, transaction_ledger debit
   ├─ For invoices: warehouse_stock decreases, transaction_ledger credit
   └─ For adjustments: stock_adjustments reason field explains change

4. Visibility:
   ├─ Products page shows products.stock (global)
   ├─ Stock module shows warehouse-by-warehouse breakdown
   └─ Reports include stock value by location
```

### Stock Initialization (`/stockinit`)

```
GET /stockinit?page=1
  ├─ FETCH products (paginated, 50 per page)
  ├─ LEFT JOIN warehouse_stock (show existing quantities)
  ├─ Render form with:
  │   ├─ Product list (CTN + PCS inputs)
  │   ├─ Warehouse selector (apply-to-all button)
  │   └─ Live validation (red/yellow highlight)
  │
  └─ User enters opening stock quantities

POST /stockinit/save
  ├─ Validate all rows (no negatives, no duplicate product+warehouse)
  ├─ Show confirmation modal (summary table)
  ├─ User confirms
  │
  └─ Transaction: For each row
      ├─ Fetch current warehouse_stock.quantity
      ├─ Calculate delta = new_qty - current_qty
      ├─ applyStockMovement(product, warehouse, delta, 'adjustment', null, 'initialization')
      │   └─ Updates warehouse_stock + products.stock
      └─ INSERT stock_adjustments with reason='initialization'
```

---

## Commission Calculation

### Invoice Commission Flow

```
Form Display:
  ├─ Customer selected → auto-load customer.commission % (backend)
  └─ Show in form: "Commission %: 5%"

Line Item Calculation (JavaScript):
  for each line:
    amount = quantity × rate
    commission = amount × commission_pct / 100
    display: "Less Commission: 5.00"

Invoice Total Calculation:
  subtotal = SUM(quantity × rate for all items)
  total_commission = SUM(amount × commission_pct / 100 for all items)
  total = subtotal - total_commission - discount + transport_charges

Database Storage:
  ├─ invoice_lines.commission_pct (stored per line)
  └─ invoices.commission_amount (calculated total)

Ledger Entry:
  transaction_ledger.debit = invoice amount_net (already commission deducted)
```

### Per-Line Commission Override

```
User can edit commission_pct for each product on same invoice:
  ├─ Product A: 5% commission
  ├─ Product B: 3% commission (overridden)
  └─ Total commission = (A_amount × 0.05) + (B_amount × 0.03)

This is fully supported by the invoice_lines.commission_pct column.
```

---

## Multi-Business Support (account_scope)

### Scope Isolation

```
account_scope enum: 'plastic_markaz', 'wings_furniture', 'cooler'

Each transaction tagged with scope:
  ├─ invoices.account_scope = 'plastic_markaz'
  ├─ purchases.account_scope = 'wings_furniture'
  └─ Reports filtered by scope

Dashboard:
  ├─ Dropdown selector: "View: Plastic Markaz | Wings Furniture | Cooler"
  └─ All KPIs, charts, totals filtered by selected scope

Reporting:
  ├─ P&L Statement: shows per-scope breakdown
  ├─ Balance Sheet: separate per scope
  └─ Ledgers: customer/vendor balance per scope
```

### Shared vs Scope-Specific Masters

```
Shared across all scopes:
  ├─ customers (but with account_scope column)
  ├─ vendors (but with account_scope column)
  ├─ products (shared catalog)
  ├─ warehouses (shared locations)
  └─ users (system-wide)

Scope-specific:
  ├─ invoices (tagged with scope)
  ├─ purchases (tagged with scope)
  ├─ payments (tagged with scope)
  ├─ expenses (tagged with scope)
  └─ transaction_ledger (tagged with scope)
```

---

## Authentication & Authorization

### Session-Based Authentication

```
Login Flow:
  POST /login
    ├─ Hash password: bcrypt.compareSync(inputPassword, user.password_hash)
    ├─ Create session: req.session.userId = user.id
    ├─ Store in database (if using persistent sessions)
    └─ redirect('/dashboard')

Session Middleware:
  Every request:
    ├─ loadUser() - fetch user from session.userId
    ├─ Check session timeout (default 8 hours)
    └─ Set res.locals.req.user for EJS

Logout Flow:
  GET /logout
    ├─ req.session.destroy()
    └─ redirect('/login')

Session Timeout:
  ├─ Config: SESSION_SECRET in .env
  ├─ Auto-timeout: 8 hours by default
  └─ Configurable in Settings (session_timeout_minutes)
```

### Role-Based Access Control

```
Roles:
  ├─ 'superadmin' - all routes, user management
  ├─ 'admin' - all routes except user management
  ├─ 'user' - restricted routes (controlled per module)
  └─ 'viewer' - read-only access (dashboard, reports)

Route Protection:
  router.use(requireRole('admin', 'superadmin'))
  // All routes under this router require admin+ role

  router.get('/delete/:id', requireRole('superadmin'), (req, res) => {
    // Only superadmin can delete
  })

ALL_MODULES:
  ├─ Array of module objects (hardcoded in routes/dashboard.js)
  ├─ Passed to /users/add form for permission selection
  └─ user_permissions table tracks which modules user can access
```

---

## Error Handling

### Validation Errors

```
Form validation fails:
  ├─ Validation middleware catches error
  ├─ Re-render form with:
  │   ├─ req.body (original input, except passwords)
  │   ├─ req.errors (validation error objects)
  │   └─ req.valid (validated portion if partial)
  └─ User sees red highlights on invalid fields + error messages
```

### Database Errors

```
SQL error (enum casting, constraint violation, etc.):
  ├─ Thrown by await pool.query()
  ├─ Caught by wrap() middleware
  ├─ Logged to audit_logs
  └─ globalErrorHandler renders error page with:
      ├─ Status code (400, 409, 500, etc.)
      ├─ User-friendly message
      ├─ Back button to previous page
      └─ Stack trace (hidden in production)
```

### Idempotency (Prevent Double-Submit)

```
Form Submission:
  1. Browser generates fingerprint: MD5(form data)
  2. Check session storage: fingerprints[formId] === current
  3. If match: reject request (duplicate submission)
  4. If new: store fingerprint, allow request, clear after 10 seconds

This prevents:
  ├─ Accidental double-clicks from creating duplicate invoices
  ├─ Browser back/forward creating duplicate entries
  └─ Form refresh submitting twice
```

---

## Testing Data Flow (Example: Create Invoice)

### User Action Sequence

```
1. Click "New Invoice" → GET /invoices/add

2. Form appears with:
   ├─ Customer dropdown (loaded from customers table)
   ├─ Warehouse selector
   ├─ Empty line items table

3. User enters:
   ├─ Customer: "Khadija Traders"
   ├─ Invoice Date: 2026-05-02
   ├─ Items:
   │   ├─ Product: "PLASTIC BAG" | Qty: 100 | Rate: 12 | Commission: 5%
   │   └─ Product: "BOX" | Qty: 50 | Rate: 25 | Commission: 3%

4. JavaScript calculates (real-time):
   ├─ Line 1: 100 × 12 = 1,200 - (1,200 × 0.05) = 1,140
   ├─ Line 2: 50 × 25 = 1,250 - (1,250 × 0.03) = 1,212.50
   ├─ Subtotal: 2,450
   ├─ Commission: 80.50
   └─ Total: 2,369.50

5. User clicks "Create Invoice" → POST /invoices/add
   ├─ Request body: { customer_id: 3, items: [...], ... }
   └─ Validation passes ✓

6. Server Transaction:
   ├─ Generate invoice_no = "INV-0042"
   ├─ INSERT invoices: amount_net = 2,369.50
   ├─ INSERT invoice_lines × 2 (store commission_pct per line)
   ├─ applyStockMovement × 2 (deduct inventory)
   │   ├─ UPDATE warehouse_stock: plastic_bag qty -100
   │   ├─ UPDATE warehouse_stock: box qty -50
   │   ├─ UPDATE products: plastic_bag stock -100
   │   └─ UPDATE products: box stock -50
   ├─ INSERT transaction_ledger:
   │   ├─ entity_type='customer', entity_id=3
   │   ├─ debit=2,369.50 (amount owed by customer)
   │   └─ description="INV-0042 Plastic Bag + Box"
   ├─ INSERT audit_logs: "Created invoice INV-0042"
   └─ COMMIT ✓

7. Browser redirected → GET /invoices
   ├─ Database query fetches invoices (with transaction_ledger.balance)
   ├─ "INV-0042" appears in list with status "unpaid"
   └─ Running balance updated: Khadija Traders owes 2,369.50

8. User clicks invoice to view:
   ├─ GET /invoices/view/15
   ├─ Render with commission breakdown visible
   ├─ Options: "Edit", "Delete", "Print", "Email PDF"
   └─ Ledger shows transaction with running balance
```

---

## Performance Considerations

### Database Query Optimization

```
Slow Query Pattern (❌):
  SELECT * FROM transaction_ledger 
  WHERE entity_id = 3
  -- N+1 problem: 1000s of rows fetched, then filtered in app

Fast Pattern (✅):
  SELECT * FROM transaction_ledger
  WHERE entity_type = 'customer' 
    AND entity_id = 3
    AND txn_date BETWEEN $from AND $to
  LIMIT 500
  -- Filtered at database, uses index
```

### Index Usage

All critical queries use indexes:
- `transaction_ledger(entity_type, entity_id, txn_date)`
- `invoice_lines(invoice_id)`
- `warehouse_stock(product_id, warehouse_id)`
- `customers(status)`, `vendors(status)`, etc

### Window Functions

Ledger running balance calculated in one query using window functions:

```sql
-- Fast: Single query, one pass through data
SELECT *,
  SUM(debit - credit) OVER (ORDER BY id) AS balance
FROM transaction_ledger
WHERE entity_type='customer' AND entity_id=3

-- Slow: Would require application-level calculation loop
SELECT * FROM transaction_ledger WHERE entity_id=3
-- Then loop: balance = 0; for each row: balance += debit - credit
```

---

## Future Enhancements

### Planned Features
- Multi-user real-time collaboration (WebSocket notifications)
- Bank reconciliation module
- Recurring invoice/purchase templates
- API endpoint expansion (for mobile/external tools)
- Machine learning forecasting (demand/stock optimization)
- Mobile app (React Native)
- Cloud backup integration (AWS S3, Google Drive)

### Performance Roadmap
- Database query caching (Redis)
- Pagination on all list views (currently loads all)
- Lazy loading for charts/reports
- Audit log archival (separate table per year)
