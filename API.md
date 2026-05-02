# API Documentation

JSON API endpoints for programmatic access to Markaz ERP data. Read-only endpoints are available without authentication in development; all production use requires proper authentication.

---

## Authentication

All API endpoints require an authenticated session. Include session cookies automatically in AJAX requests.

```javascript
// Browser-based access (automatic)
fetch('/api/customers')
  .then(r => r.json())
  .then(data => console.log(data))
```

---

## Data Endpoints

### GET /api/customers

Fetch all active customers for dropdown/select fields.

**Parameters:**
- None

**Response:**
```json
[
  {
    "id": 3,
    "name": "Khadija Traders",
    "phone": "03001234567",
    "city": "Karachi",
    "balance": 15000
  },
  ...
]
```

**Use Cases:**
- Customer dropdown in invoice form
- Customer autocomplete
- Dashboard customer list

---

### GET /api/vendors

Fetch all active vendors.

**Parameters:**
- None

**Response:**
```json
[
  {
    "id": 1,
    "name": "Mohammad Plastic Co.",
    "phone": "03002345678",
    "city": "Lahore",
    "balance": 25000
  },
  ...
]
```

---

### GET /api/products

Fetch all active products with stock and pricing.

**Parameters:**
- None

**Response:**
```json
[
  {
    "id": 42,
    "name": "PLASTIC BAG TRANSPARENT",
    "category": "Bags",
    "qty_per_pack": 100,
    "stock": 5000,
    "unit": "PCS",
    "selling_price": 12,
    "cost_price": 8.5
  },
  ...
]
```

**Use Cases:**
- Product search in invoice lines
- Stock status dashboard
- Available products for purchase order

---

### GET /api/products/:id

Fetch single product details.

**Parameters:**
- `:id` (integer) - Product ID

**Response:**
```json
{
  "id": 42,
  "name": "PLASTIC BAG TRANSPARENT",
  "category": "Bags",
  "item_id": "PM-042",
  "unit": "PCS",
  "qty_per_pack": 100,
  "stock": 5000,
  "cost_price": 8.5,
  "selling_price": 12,
  "min_stock": 500,
  "status": "active",
  "created_at": "2024-01-15T10:30:00Z"
}
```

**Use Cases:**
- Populate product details when product selected in form
- Rate lookup for auto-fill
- Qty/Pack display

---

## Form Endpoints (Non-API)

For form submission and HTML page requests, use standard HTTP methods:

### POST /invoices/add

Create a new invoice.

**Request Body** (form-data):
```
customer_id: 3
invoice_date: 2026-05-02
due_date: 2026-06-01
delivery_date: 2026-05-02
warehouse_id: 1
bilty_no: "BLT-001"
transport_id: 2
transport_charges: 500
account_scope: "plastic_markaz"

product_id[]: [42, 45]
quantity[]: [100, 50]
rate[]: [12, 25]
commission_pct[]: [5, 3]
discount_per_pack[]: [0, 0]

notes: "Special order"
```

**Response:**
- Success: HTTP 302 redirect to `/invoices`
- Failure: HTTP 400 with form re-rendered + error messages

**Errors:**
```
{
  "customer_id": ["Customer is required"],
  "items": [
    {
      "index": 0,
      "product_id": ["Product is required"]
    }
  ]
}
```

---

### POST /purchases/add

Create a new purchase order.

**Request Body:**
```
vendor_id: 1
po_date: 2026-05-02
warehouse_id: 1
account_scope: "plastic_markaz"

product_id[]: [42, 45]
quantity[]: [1000, 500]
rate[]: [8.5, 20]
discount_per_pack[]: [0, 0.50]
```

**Response:**
- Success: HTTP 302 to `/purchases`
- Failure: HTTP 400 with validation errors

---

### POST /payments/receive

Record customer payment.

**Request Body:**
```
customer_id: 3
amount: 5000
payment_date: 2026-05-02
payment_method: "cash"
reference: "INV-0042"
account_scope: "plastic_markaz"
notes: "Full payment for invoice"
```

**Response:**
- Success: HTTP 302 to `/payments`

---

### POST /payments/pay

Record vendor payment.

**Request Body:**
```
vendor_id: 1
amount: 10000
payment_date: 2026-05-02
payment_method: "check"
check_number: "CHK12345"
bank_account: "BANK-001"
account_scope: "plastic_markaz"
notes: "Payment for PO-0015"
```

---

### POST /stock/add

Create stock adjustment (increase/reduce/transfer).

**Request Body:**
```
adjustment_type: "reduce"
product_id: 42
warehouse_id: 1
quantity: 100
adjustment_amount: 850
reason: "breakage"
notes: "Damaged during delivery"
```

---

### POST /stockinit/save

Initialize opening stock in bulk.

**Request Body:**
```
product_id[]: [42, 45, 48]
warehouse_id[]: [1, 1, 1]
ctn[]: [50, 25, 100]
pcs[]: [0, 50, 0]
```

**Calculation:**
- Total Qty = (CTN × product.qty_per_pack) + PCS
- Example: (50 × 100) + 0 = 5000 pieces

**Response:**
- Success: HTTP 302 to `/stockinit` with success message
- Validation failure: HTTP 400 with row errors
  ```json
  {
    "rowErrors": {
      "0": { "quantity": "Cannot be negative" },
      "1": { "duplicate": "Product already in this warehouse on this page" }
    }
  }
  ```

---

### POST /journal/add

Create manual journal entry (double-entry).

**Request Body:**
```
entry_date: 2026-05-02
description: "Opening balance adjustment"
reference: "JV-0001"
account_scope: "plastic_markaz"

account[]: ["Plastic Markaz", "Opening Balance"]
description[]: ["Customer A Opening", "Retained Earnings"]
debit[]: [10000, 0]
credit[]: [0, 10000]
```

**Validation:**
- Sum(debit) must equal Sum(credit) within 0.01 tolerance
- At least 2 line items required

---

## Session & Authentication

### GET /api/session/keepalive

Keep user session alive (called every 60 seconds by client).

**Response:**
```json
{
  "ok": true
}
```

If session expired:
```json
{
  "ok": false
}
```
Status: 401

---

## Error Handling

### Validation Errors (400)

```json
{
  "error": "Validation failed",
  "field": "customer_id",
  "message": "Customer is required",
  "status": 400
}
```

### Not Found (404)

```json
{
  "error": "Not found",
  "message": "Customer with ID 999 not found",
  "status": 404
}
```

### Unauthorized (401)

```json
{
  "error": "Unauthorized",
  "message": "Session expired",
  "status": 401
}
```

### Server Error (500)

```json
{
  "error": "Server error",
  "message": "Internal server error",
  "status": 500,
  "details": "PostgreSQL connection failed" // Dev only
}
```

---

## Rate Limiting

Currently: No rate limiting implemented.

Future: May implement per-IP rate limits:
- 100 requests/minute for API endpoints
- 10 requests/minute for sensitive operations (delete, payment)

---

## Data Types & Validation

### Numbers
- Integers: 0-2147483647 (32-bit signed)
- Decimals: 2 decimal places (NUMERIC in PostgreSQL)
- Validation: Must be valid number, no currency symbols

### Dates
- Format: ISO 8601 (YYYY-MM-DD)
- Examples: "2026-05-02", "2024-01-15"
- Validation: Must be valid date, not future

### Text
- Max length: depends on field (usually 255 chars)
- UTF-8 encoding
- Validation: Required fields must not be empty

### Enums
- **account_scope**: `plastic_markaz`, `wings_furniture`, `cooler`
- **payment_method**: `cash`, `check`, `bank_transfer`, `credit`
- **status**: `active`, `inactive`, `pending`, `paid`, `unpaid`, `partial`

---

## Examples

### Example 1: Create Invoice via JavaScript

```javascript
async function createInvoice(customerId, items) {
  const formData = new FormData();
  formData.append('customer_id', customerId);
  formData.append('invoice_date', new Date().toISOString().split('T')[0]);
  formData.append('due_date', '2026-06-01');
  formData.append('warehouse_id', 1);
  formData.append('account_scope', 'plastic_markaz');
  
  items.forEach((item, idx) => {
    formData.append(`product_id[]`, item.id);
    formData.append(`quantity[]`, item.qty);
    formData.append(`rate[]`, item.rate);
  });
  
  const response = await fetch('/invoices/add', {
    method: 'POST',
    body: formData
  });
  
  if (response.ok) {
    window.location.href = '/invoices';
  } else {
    const error = await response.json();
    console.error('Invoice creation failed:', error);
  }
}

// Usage
createInvoice(3, [
  { id: 42, qty: 100, rate: 12 },
  { id: 45, qty: 50, rate: 25 }
]);
```

### Example 2: Fetch and Populate Dropdown

```javascript
async function populateCustomers(selectId) {
  const response = await fetch('/api/customers');
  const customers = await response.json();
  
  const select = document.getElementById(selectId);
  customers.forEach(c => {
    const option = document.createElement('option');
    option.value = c.id;
    option.textContent = `${c.name} (${c.city})`;
    select.appendChild(option);
  });
}

populateCustomers('customer_dropdown');
```

### Example 3: Real-time Stock Check

```javascript
async function checkStock(productId) {
  const response = await fetch(`/api/products/${productId}`);
  const product = await response.json();
  
  const stockStatus = product.stock > product.min_stock ? 'OK' : 'LOW';
  console.log(`${product.name}: ${product.stock} pcs (${stockStatus})`);
  
  return product;
}
```

### Example 4: Bulk Stock Initialization

```javascript
async function initializeStock(entries) {
  // entries = [{ product_id, warehouse_id, ctn, pcs }, ...]
  
  const formData = new FormData();
  entries.forEach((e, idx) => {
    formData.append(`product_id[]`, e.product_id);
    formData.append(`warehouse_id[]`, e.warehouse_id);
    formData.append(`ctn[]`, e.ctn);
    formData.append(`pcs[]`, e.pcs);
  });
  
  const response = await fetch('/stockinit/save', {
    method: 'POST',
    body: formData
  });
  
  if (response.ok) {
    alert('Opening stock initialized');
  } else {
    const errors = await response.json();
    console.error('Validation errors:', errors.rowErrors);
  }
}
```

---

## CORS & Security

**CORS:** Not enabled by default (same-origin only).

**CSRF Protection:** All POST requests must include valid form or session (handled by Express middleware).

**SQL Injection:** Prevented via parameterized queries (pg driver with $1, $2, etc).

**XSS:** Prevented via EJS HTML escaping (default) and CSP headers (if enabled).

**Password Security:** bcryptjs with 10-round hash (PBKDF2 equivalent).

---

## WebSocket / Real-time (Future)

Planned enhancement: WebSocket support for:
- Real-time inventory updates
- Concurrent user notifications (who's viewing what)
- Live dashboard KPI updates
- Order status notifications

Currently: Server-sent events (SSE) via `/api/session/keepalive` polling.

---

## Backwards Compatibility

The API is stable but subject to change. Breaking changes will be announced in release notes.

**Current Version:** 1.0 (implied)

No version header required at present. Future versions may use:
- `Accept: application/vnd.markaz+json;version=2`
- Or URL versioning: `/api/v2/customers`

---

## Testing the API

### Using cURL

```bash
# Fetch customers
curl -b cookies.txt http://localhost:3000/api/customers

# Create invoice
curl -b cookies.txt -X POST http://localhost:3000/invoices/add \
  -d "customer_id=3&invoice_date=2026-05-02&warehouse_id=1" \
  -d "product_id[]=42&quantity[]=100&rate[]=12"

# Fetch product details
curl http://localhost:3000/api/products/42
```

### Using Postman

1. Create collection: "Markaz ERP"
2. Add requests:
   - GET /api/customers
   - GET /api/products
   - POST /invoices/add (with form-data body)
3. Set up environment variables:
   - `{{base_url}}` = http://localhost:3000
   - `{{customer_id}}` = 3
   - `{{warehouse_id}}` = 1
4. Export/share collection with team

### Using JavaScript Fetch

See Examples section above for complete code samples.

---

## Changelog

### v1.0 (Current)
- Customers, Vendors, Products API
- Invoice, Purchase, Payment creation
- Stock adjustment and initialization
- Journal entry creation
- Session keepalive endpoint
- Full validation and error handling
