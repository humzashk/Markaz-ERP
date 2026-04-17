# Plastic Markaz ERP

A lightweight, offline-capable ERP system built for **Plastic Markaz** — a plastic products trading business. Runs entirely on Node.js with a local SQLite database. No internet required.

---

## Features

| Module | Description |
|---|---|
| **Dashboard** | Live KPIs, charts, period filters, quick order/purchase buttons |
| **Orders** | Create/edit orders with commission % auto-loaded from customer |
| **Invoices** | Invoices with commission flow: Total → Less Commission → Gross |
| **Purchases** | Record vendor purchases, auto-update stock |
| **Customers** | Full ledger, commission %, category, region |
| **Vendors** | Vendor ledger, commission %, manufacturer linking |
| **Products** | Categories, Pcs/Ctn, manufacturer, rate history, bulk edit |
| **Rate List** | Per-customer-type rates with history & commission % |
| **Payments** | Receive from customers / pay vendors, link to invoices |
| **Ledger** | Auto-maintained double-entry ledger per customer/vendor |
| **Bilty** | Transport records linked to invoices |
| **Expenses** | 35+ categories, paid-to tracking |
| **Journal** | Manual double-entry journal entries |
| **Stock** | Warehouse stock, adjustments, transfers |
| **Reports** | P&L, balance sheet, sales, purchase, aging, audit log |
| **Import/Export** | Excel import/export for customers, vendors, products |
| **Settings** | Business info, currency, invoice terms |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
node index.js

# 3. Open in browser
http://localhost:3000
```

---

## Technology Stack

- **Backend:** Node.js + Express.js
- **Database:** SQLite via sql.js (no native compilation needed)
- **Templates:** EJS
- **UI:** Bootstrap 5 + Bootstrap Icons
- **Charts:** Chart.js
- **PDF:** PDFKit
- **Excel:** xlsx (SheetJS)

---

## Commission System

This system is built around a **commission-based profit model**:

1. Set commission % on each **Customer** profile
2. When creating an Order or Invoice, commission % is **auto-loaded** from the customer
3. The form shows: **Total → Less Commission → Gross Amount**
4. Commission amount is stored and visible throughout (list, view, print, PDF)

---

## Key Concepts

- **Ctns** = Cartons (packages)
- **Pcs/Ctn** = Pieces per Carton (packaging)
- **Total Pcs** = Ctns × Pcs/Ctn (auto-calculated)
- **Gross Amount** = Total − Commission

---

## Data Location

The SQLite database is stored at:
```
markaz_erp.db
```
Back this file up regularly to preserve all data.

---

## Default Port

The app runs on port **3000**. Change in `index.js` if needed.
