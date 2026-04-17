# Excel Import Guide

## How to Import Data

Go to **Import/Export** in the sidebar → Upload your Excel file → Select data type.

---

## Supported Import Types

### Customers

| Column Name | Required | Notes |
|---|---|---|
| name | ✅ | Customer full name |
| phone | | Contact number |
| email | | Email address |
| address | | Street address |
| city | | City name |
| commission | | Commission % (e.g. 5 for 5%) |
| category | | e.g. wholesale, retail |
| notes | | Any remarks |

### Vendors

| Column Name | Required | Notes |
|---|---|---|
| name | ✅ | Vendor/supplier name |
| phone | | Contact number |
| email | | Email address |
| address | | Address |
| city | | City |
| commission | | Commission % |
| notes | | Remarks |

### Products

| Column Name | Required | Notes |
|---|---|---|
| name | ✅ | Product name |
| category | | Product category |
| rate | | Price per piece (Rs.) |
| packaging | | Pieces per carton |
| stock | | Current stock (pcs) |
| min_stock | | Minimum stock alert level |

---

## Tips

- Column names are case-insensitive (NAME = name = Name)
- Leave optional columns blank — they'll be imported as empty
- Duplicate names will be flagged in the import result
- Unrecognized categories will be noted but still imported
- Download a sample template from the Import/Export page first

---

## Export

Go to **Import/Export** → Select what to export → Click **Export Excel**

Exported files can be re-imported after editing.
