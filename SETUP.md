# Setup & Configuration Guide

## Requirements

- **Node.js** v18 or later — [Download](https://nodejs.org)
- **npm** (comes with Node.js)
- **PostgreSQL** 12 or later — [Download](https://www.postgresql.org/download/)
- Windows / macOS / Linux

---

## Installation

```bash
cd "Markaz ERP"
npm install
```

This installs all dependencies listed in `package.json`.

---

## PostgreSQL Setup

### Windows

1. Download and run PostgreSQL installer from [postgresql.org](https://www.postgresql.org/download/windows/)
2. During installation:
   - Set **postgres** user password (remember this for connection)
   - Port: **5432** (default)
   - Locale: Select your region
3. After installation, open **pgAdmin** or **psql** to verify connection:
   ```bash
   psql -U postgres
   ```
4. Create the database:
   ```sql
   CREATE DATABASE markaz_erp;
   ```

### macOS / Linux

```bash
# Install PostgreSQL
brew install postgresql  # macOS
sudo apt-get install postgresql postgresql-contrib  # Ubuntu/Debian

# Start PostgreSQL service
brew services start postgresql  # macOS
sudo systemctl start postgresql  # Linux

# Create database
createdb markaz_erp

# Verify connection
psql -d markaz_erp
```

### Environment Configuration

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/markaz_erp
SESSION_SECRET=your-random-secret-key-here
PORT=3000
```

Replace `YOUR_PASSWORD` with the postgres user password set during installation.

---

## First Run

1. **Create database schema** (one-time setup):
   ```bash
   npm run db:reset
   ```
   This drops/recreates all tables and seed data in PostgreSQL.

2. **Start the server**:
   ```bash
   node index.js
   ```

3. **Open in browser**:
   http://localhost:3000

4. **Default login**:
   - Username: `admin`
   - Password: `changeme`
   
   ⚠️ **Change this password immediately in Settings > Users**

---

## Settings

Go to **Settings** in the sidebar to configure:

| Setting | Description |
|---|---|
| Business Name | Appears on invoices and PDFs |
| Business Tagline | Sub-title on prints |
| Address / City / Phone / Email | Contact info on invoices |
| Currency Symbol | Default: `Rs.` |
| Invoice Terms | Payment terms text |
| Invoice Footer | Thank-you message |
| Default Due Days | Auto-set due date on invoices |

---

## Database Backup & Restore

### Backup

```bash
# Full database backup (includes all data and schema)
pg_dump -U postgres -d markaz_erp -F c -f markaz_erp.backup

# SQL text format (human-readable)
pg_dump -U postgres -d markaz_erp > markaz_erp.sql
```

Store the backup file on an external drive or cloud storage.

### Restore

```bash
# From custom format backup
pg_restore -U postgres -d markaz_erp markaz_erp.backup

# From SQL text format
psql -U postgres -d markaz_erp < markaz_erp.sql
```

**Important:** Stop the server before restoring to avoid connection conflicts.

---

## Running on Startup (Windows)

Create a shortcut to this batch file:

```batch
@echo off
cd /d "C:\Path\To\Markaz ERP"
node index.js
pause
```

Or use **PM2** for background running:
```bash
npm install -g pm2
pm2 start index.js --name "markaz-erp"
pm2 startup
pm2 save
```

---

## Changing Port

Edit `index.js`, find:
```js
const PORT = 3000;
```
Change to your desired port number.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Port already in use" | Kill the process using port 3000, or change port |
| Blank page | Check console for errors, restart server |
| Data not saving | Check disk space, ensure `markaz_erp.db` is not read-only |
| Import fails | Ensure Excel columns match expected names (see IMPORT.md) |
