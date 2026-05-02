'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { wrap } = require('../middleware/errorHandler');

router.get('/', wrap(async (req, res) => {
  const productCats   = (await pool.query(`SELECT * FROM product_categories ORDER BY sort_order, name`)).rows;
  const expenseCats   = (await pool.query(`SELECT * FROM expense_categories ORDER BY sort_order, name`)).rows;
  const partyCats     = (await pool.query(`SELECT * FROM party_categories ORDER BY cat_group, sort_order, name`)).rows;
  const customerTypes = partyCats.filter(c => c.cat_group === 'type' && (c.applies_to === 'customer' || c.applies_to === 'both'));
  const vendorTypes   = partyCats.filter(c => c.cat_group === 'type' && (c.applies_to === 'vendor'   || c.applies_to === 'both'));
  const regionCats    = partyCats.filter(c => c.cat_group === 'region');
  res.render('categories/index', { page:'categories', productCats, expenseCats, partyCats, customerTypes, vendorTypes, regionCats });
}));

router.post('/product/add', wrap(async (req, res) => {
  const name = (req.body.name || '').trim(); if (!name) return res.redirect('/categories');
  await pool.query(`INSERT INTO product_categories(name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
  res.redirect('/categories');
}));
router.post('/product/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM product_categories WHERE id=$1`, [req.params.id]); res.redirect('/categories');
}));

router.post('/expense/add', wrap(async (req, res) => {
  const name = (req.body.name || '').trim(); if (!name) return res.redirect('/categories');
  await pool.query(`INSERT INTO expense_categories(name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
  res.redirect('/categories');
}));
router.post('/expense/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM expense_categories WHERE id=$1`, [req.params.id]); res.redirect('/categories');
}));

router.post('/party/add', wrap(async (req, res) => {
  const { name, cat_group, applies_to, color } = req.body;
  if (!name || !cat_group) return res.redirect('/categories');
  await pool.query(`INSERT INTO party_categories(name, cat_group, applies_to, color) VALUES ($1,$2,COALESCE($3,'both'),COALESCE($4,'secondary'))`,
    [name, cat_group, applies_to, color]);
  res.redirect('/categories');
}));
router.post('/party/delete/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM party_categories WHERE id=$1`, [req.params.id]); res.redirect('/categories');
}));

module.exports = router;
