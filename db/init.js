#!/usr/bin/env node
// Reset + create the Postgres schema, then seed defaults.
// Usage: node db/init.js  (or `npm run db:reset`)
'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'markaz_erp',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[init] applying schema…');
  await pool.query(sql);

  console.log('[init] seeding settings…');
  const defaults = [
    ['business_name', 'PLASTIC MARKAZ'],
    ['business_tagline', 'Plastic Products & Trading'],
    ['currency_symbol', 'PKR'],
    ['session_timeout_minutes', '15'],
    ['invoice_terms', 'Payment due within 30 days.'],
    ['invoice_footer', 'Thank you for your business!'],
    ['low_stock_threshold', '10'],
  ];
  for (const [k, v] of defaults) {
    await pool.query(
      `INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
      [k, v]
    );
  }

  console.log('[init] seeding party/expense/product categories…');
  const partyCats = [
    ['Local','region','both','success',1],
    ['Upcountry','region','both','info',2],
    ['Karachi','region','both','primary',3],
    ['Lahore','region','both','warning',4],
    ['Retail','type','customer','secondary',1],
    ['Wholesale','type','customer','dark',2],
    ['Distributor','type','customer','success',4],
    ['Manufacturer','type','vendor','dark',1],
    ['Importer','type','vendor','info',2],
  ];
  for (const [n, g, a, c, o] of partyCats) {
    await pool.query(`INSERT INTO party_categories(name,cat_group,applies_to,color,sort_order) VALUES ($1,$2,$3,$4,$5)`, [n,g,a,c,o]);
  }
  const expCats = ['Rent','Electricity','Salary','Transport / Freight','Fuel','Bank Charges','Tea & Refreshments','Maintenance','Tax','Miscellaneous'];
  for (let i = 0; i < expCats.length; i++) {
    await pool.query(`INSERT INTO expense_categories(name, sort_order) VALUES ($1,$2)`, [expCats[i], i+1]);
  }
  const prodCats = ['Containers','Buckets & Tubs','Household Items','Hangers','Bags & Packaging','Crates','Pipes & Fittings','Miscellaneous Plastic'];
  for (let i = 0; i < prodCats.length; i++) {
    await pool.query(`INSERT INTO product_categories(name, sort_order) VALUES ($1,$2)`, [prodCats[i], i+1]);
  }

  console.log('[init] seeding admin user…');
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(adminPass, 10);
  await pool.query(
    `INSERT INTO users(username,name,email,password_hash,role,status)
     VALUES ($1,$2,$3,$4,'superadmin','active')
     ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='superadmin', status='active'`,
    [adminUser, 'Super Administrator', 'admin@markaz.local', hash]
  );

  console.log('[init] seeding default warehouse…');
  await pool.query(`INSERT INTO warehouses(name, status) VALUES ('Main Warehouse','active') ON CONFLICT DO NOTHING`);

  console.log('[init] DONE. Login as:', adminUser, '/', adminPass);
}

run().then(() => pool.end()).catch(e => { console.error('[init] FAILED:', e.message); pool.end(); process.exit(1); });
